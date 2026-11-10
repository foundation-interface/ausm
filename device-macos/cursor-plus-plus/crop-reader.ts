/**
 * Crop Reader — Manages the Python crop_reader.py subprocess.
 *
 * Spawns a lightweight Python child process that reads display frames from
 * AUSM screen-stream shared memory (via screen_stream_reader), crops a
 * requested rect, and JPEG-encodes the result.
 *
 * Communication uses a JSON-line protocol over stdio, matching the same
 * pattern used by the material-manager's FrameReader — but without pHash
 * or deduplication (cursor-plus-plus only needs simple crops).
 */

import { ChildProcess, spawn } from 'child_process';
import { createInterface, Interface } from 'readline';
import path from 'path';
import fs from 'fs';

import type { DisplayStreamCrop } from './types';

export interface CropResult {
    data: Buffer;
    width: number;
    height: number;
}

export interface CropReaderConfig {
    debug?: boolean;
    pythonPath?: string;
    /** Path to the screen-stream-reader internal lib (added to PYTHONPATH) */
    screenStreamReaderPath?: string;
    /** Unix socket path for screen-stream (default: /tmp/ausm-frames.sock) */
    screenStreamSocketPath?: string;
}

interface CropResponse {
    requestId: string;
    ok: boolean;
    data?: string;
    width?: number;
    height?: number;
    error?: string;
}

const REQUEST_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 2_000;

interface PendingRequest {
    resolve: (value: CropResult) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
}

export class CropReader implements DisplayStreamCrop {
    /** The live subprocess (set as soon as it is spawned, before it is ready). */
    private child: ChildProcess | null = null;
    private readline: Interface | null = null;
    private ready = false;
    private startPromise: Promise<void> | null = null;
    private rejectStart: ((err: Error) => void) | null = null;
    private debug: boolean;
    private pythonPath: string;
    private screenStreamReaderPath: string | undefined;
    private screenStreamSocketPath: string;

    private pending = new Map<string, PendingRequest>();
    private nextId = 0;

    constructor(config: CropReaderConfig = {}) {
        this.debug = config.debug ?? false;
        this.pythonPath = config.pythonPath ?? 'python3';
        this.screenStreamReaderPath = config.screenStreamReaderPath;
        this.screenStreamSocketPath = config.screenStreamSocketPath ?? '/tmp/ausm-frames.sock';
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    /** Spawn the Python subprocess; resolves once it reports ready. The subprocess exits on
     *  its own when its stdin closes (i.e. when this process dies). */
    start(): Promise<void> {
        if (this.startPromise) return this.startPromise;
        this.startPromise = new Promise<void>((resolve, reject) => {
            this.rejectStart = reject;
            const scriptPath = path.resolve(__dirname, '..', 'py', 'crop_reader.py');
            const altScriptPath = path.resolve(__dirname, 'py', 'crop_reader.py');
            const resolvedScript = fs.existsSync(scriptPath) ? scriptPath : altScriptPath;

            const env = { ...process.env };
            if (this.screenStreamReaderPath) {
                const existing = env.PYTHONPATH ?? '';
                env.PYTHONPATH = existing
                    ? `${this.screenStreamReaderPath}:${existing}`
                    : this.screenStreamReaderPath;
            }

            this.logDebug(`Spawning: ${this.pythonPath} ${resolvedScript}`);

            let child: ChildProcess;
            try {
                child = spawn(
                    this.pythonPath,
                    [resolvedScript, `--socket=${this.screenStreamSocketPath}`],
                    { stdio: ['pipe', 'pipe', 'pipe'], env },
                );
            } catch (err) {
                this.startPromise = null;
                reject(new Error(`Crop reader failed to start: ${(err as Error).message}`));
                return;
            }
            this.child = child;

            const fail = (reason: string) => {
                if (this.child !== child) return;
                if (!this.ready) reject(new Error(reason));
                this.rejectAll(new Error(reason));
                this.cleanup();
            };

            child.on('error', (err) => {
                this.logDebug(`Subprocess error: ${err.message}`);
                fail(`Crop reader failed: ${err.message}`);
            });

            child.on('exit', (code, signal) => {
                this.logDebug(`Subprocess exited (code=${code}, signal=${signal})`);
                fail(this.ready ? 'Crop reader subprocess exited' : `Crop reader exited before ready (code=${code})`);
            });

            // Without a handler, EPIPE on a dead subprocess's stdin is an uncaught exception.
            child.stdin?.on('error', (err) => {
                this.logDebug(`stdin error: ${err.message}`);
            });

            child.stderr?.on('data', (chunk: Buffer) => {
                if (this.debug) {
                    process.stderr.write(`[crop-reader] ${chunk.toString()}`);
                }
            });

            if (child.stdout) {
                const rl = createInterface({ input: child.stdout });
                rl.on('line', (line) => {
                    if (this.child !== child || !line.trim()) return;
                    let data: unknown;
                    try {
                        data = JSON.parse(line);
                    } catch {
                        this.logDebug(`Failed to parse response (${line.length} chars)`);
                        return;
                    }
                    if (!data || typeof data !== 'object') return;
                    if ((data as { type?: unknown }).type === 'ready') {
                        if (!this.ready) {
                            this.ready = true;
                            this.logDebug('Crop reader subprocess ready');
                            resolve();
                        }
                        return;
                    }
                    this.handleResponse(data as CropResponse);
                });
                this.readline = rl;
            }
        });
        return this.startPromise;
    }

    stop(): void {
        const child = this.child;
        if (!this.ready) this.rejectStart?.(new Error('Crop reader stopped before ready'));
        this.rejectAll(new Error('Crop reader stopped'));
        this.cleanup();
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        this.logDebug('Stopping crop reader subprocess...');
        child.stdin?.end();
        const killTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, KILL_TIMEOUT_MS);
        killTimer.unref?.();
        child.once('exit', () => clearTimeout(killTimer));
        child.kill('SIGTERM');
    }

    isReady(): boolean {
        return this.ready && this.child !== null;
    }

    // ── DisplayStreamCrop interface ─────────────────────────────────────

    cropAtCursor(
        cursorX: number,
        cursorY: number,
        cropWidth: number,
        cropHeight: number,
        scaleFactor: number,
        jpegQuality: number,
    ): Promise<CropResult> {
        return new Promise((resolve, reject) => {
            const stdin = this.child?.stdin;
            if (!this.isReady() || !stdin || !stdin.writable) {
                reject(new Error('Crop reader not ready'));
                return;
            }

            const requestId = `req_${++this.nextId}`;

            const request = {
                cmd: 'crop',
                requestId,
                cursorX,
                cursorY,
                cropWidth,
                cropHeight,
                scaleFactor,
                jpegQuality,
            };

            const timer = setTimeout(() => {
                if (this.pending.delete(requestId)) {
                    reject(new Error(`Crop request timed out (${requestId})`));
                }
            }, REQUEST_TIMEOUT_MS);
            timer.unref?.();
            this.pending.set(requestId, { resolve, reject, timer });

            stdin.write(JSON.stringify(request) + '\n', (err) => {
                if (err) this.settle(requestId, new Error(`Failed to write to subprocess: ${err.message}`));
            });
        });
    }

    // ── Internal ─────────────────────────────────────────────────────────

    private handleResponse(resp: CropResponse): void {
        const requestId = resp.requestId;
        if (!this.pending.has(requestId)) {
            this.logDebug(`Response for unknown request: ${requestId}`);
            return;
        }
        if (!resp.ok) {
            this.settle(requestId, new Error(resp.error ?? 'Unknown error from crop reader'));
            return;
        }
        this.settle(requestId, {
            data: Buffer.from(resp.data ?? '', 'base64'),
            width: resp.width ?? 0,
            height: resp.height ?? 0,
        });
    }

    private settle(requestId: string, result: CropResult | Error): void {
        const p = this.pending.get(requestId);
        if (!p) return;
        this.pending.delete(requestId);
        clearTimeout(p.timer);
        if (result instanceof Error) p.reject(result);
        else p.resolve(result);
    }

    private rejectAll(err: Error): void {
        for (const id of [...this.pending.keys()]) this.settle(id, err);
    }

    private cleanup(): void {
        this.ready = false;
        this.child = null;
        this.startPromise = null;
        this.rejectStart = null;
        if (this.readline) {
            this.readline.close();
            this.readline = null;
        }
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[cursor-plus-plus:crop-reader]', message);
        }
    }
}
