/**
 * Frame Reader — Manages the Python frame_reader.py subprocess
 *
 * Spawns a Python child process that reads screen frames from AUSM
 * screen-stream shared memory, crops them to window bounds, computes
 * perceptual hashes for deduplication, and JPEG-encodes the results.
 *
 * Communication uses a JSON-line protocol over stdio (one JSON object
 * per line), the same pattern used by the viewport-manager Swift subprocess.
 */

import { ChildProcess, spawn } from 'child_process';
import { createInterface, Interface } from 'readline';
import fs from 'fs';
import path from 'path';

import type {
    Rect,
    FrameReaderRequest,
    FrameReaderResponse,
    MaterialManagerConfig,
} from './types';

/** Result of a crop request, with the base64 data decoded to a Buffer. */
export interface CropResult {
    /** JPEG-encoded frame data */
    data: Buffer;
    /** Frame width in pixels */
    width: number;
    /** Frame height in pixels */
    height: number;
    /** Perceptual hash of the frame (hex string) */
    hash: string;
    /**
     * Hamming distance vs previous hash.
     * -1 if no previous hash was supplied.
     */
    hammingDistance: number;
    /** Frame timestamp from the producer (ms) */
    frameTimestamp: number;
}

/** Result of analyzing an already-captured image (pHash only, no pixel data returned). */
export interface ImageAnalysisResult {
    /** Image width in pixels */
    width: number;
    /** Image height in pixels */
    height: number;
    /** Perceptual hash of the image (hex string) */
    hash: string;
    /** Hamming distance vs previous hash. -1 if no previous hash was supplied. */
    hammingDistance: number;
}

/** Per-request timeout (ms). */
const REQUEST_TIMEOUT_MS = 10_000;
/** How long to wait for the subprocess "ready" handshake (ms). */
const START_TIMEOUT_MS = 15_000;
/** Grace period between SIGTERM and SIGKILL on stop (ms). */
const KILL_GRACE_MS = 2_000;
/** Auto-restart back-off after an unexpected subprocess exit. */
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const MAX_CONSECUTIVE_RESTARTS = 5;

interface PendingRequest {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolve: (value: any) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Resolve the path of py/frame_reader.py.  The py/ folder sits at the
 * package root; __dirname is either the package root (running from source
 * via tsx) or <root>/dist (running the built bundle).
 */
export function resolveFrameReaderScript(baseDir: string = __dirname): string {
    const candidates = [
        path.resolve(baseDir, '..', 'py', 'frame_reader.py'),
        path.resolve(baseDir, 'py', 'frame_reader.py'),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

/**
 * FrameReader manages the Python subprocess lifecycle and provides
 * a Promise-based API for requesting cropped frames.
 *
 * If the subprocess dies unexpectedly after a successful start it is
 * restarted automatically with exponential back-off (up to
 * MAX_CONSECUTIVE_RESTARTS attempts).  Requests made while it is down
 * reject immediately with "Frame reader not ready".
 */
export class FrameReader {
    private process: ChildProcess | null = null;
    private readline: Interface | null = null;
    private ready = false;
    private debug: boolean;
    private pythonPath: string;
    private screenStreamReaderPath: string | undefined;
    private hashGrid: number;

    /** True between stop() and the next start(); suppresses auto-restart. */
    private stopping = false;
    private restartAttempts = 0;
    private restartTimer: ReturnType<typeof setTimeout> | null = null;

    /** Pending requests awaiting responses, keyed by requestId. */
    private pending = new Map<string, PendingRequest>();

    /** Monotonic counter for generating unique request IDs. */
    private nextId = 0;

    constructor(config: MaterialManagerConfig = {}) {
        this.debug = config.debug ?? false;
        this.pythonPath = config.pythonPath ?? 'python3';
        this.screenStreamReaderPath = config.screenStreamReaderPath;
        this.hashGrid = config.hashGrid ?? 4;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    /**
     * Start the Python subprocess.
     * Resolves when the subprocess signals "ready"; rejects if it exits,
     * fails to spawn, or does not become ready within START_TIMEOUT_MS.
     */
    start(): Promise<void> {
        this.stopping = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.process) return Promise.resolve();

        return new Promise((resolve, reject) => {
            const resolvedScript = resolveFrameReaderScript();

            // Build PYTHONPATH so the subprocess can find screen_stream_reader
            const env = { ...process.env };
            if (this.screenStreamReaderPath) {
                const existing = env.PYTHONPATH ?? '';
                env.PYTHONPATH = existing
                    ? `${this.screenStreamReaderPath}${path.delimiter}${existing}`
                    : this.screenStreamReaderPath;
            }
            // Unbuffered stdio so protocol lines are flushed promptly.
            env.PYTHONUNBUFFERED = '1';

            this.logDebug(`Spawning: ${this.pythonPath} ${resolvedScript}`);

            // argv array, no shell — paths are never interpreted by a shell.
            const child = spawn(this.pythonPath, [resolvedScript], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env,
            });
            this.process = child;

            let settled = false;
            const settle = (err?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(startTimer);
                if (err) reject(err);
                else resolve();
            };

            const startTimer = setTimeout(() => {
                if (this.ready || this.process !== child) return;
                this.logDebug('Subprocess did not become ready in time; killing');
                child.kill('SIGKILL');
                settle(new Error(`Frame reader did not become ready within ${START_TIMEOUT_MS}ms`));
            }, START_TIMEOUT_MS);

            child.on('error', (err) => {
                this.logDebug(`Subprocess error: ${err.message}`);
                settle(new Error(`Frame reader failed to start: ${err.message}`));
                if (this.process === child) this.cleanup();
            });

            child.on('exit', (code, signal) => {
                this.logDebug(`Subprocess exited (code=${code}, signal=${signal})`);
                const wasReady = this.ready && this.process === child;
                settle(new Error(`Frame reader exited before ready (code=${code}, signal=${signal})`));
                this.rejectAllPending(new Error('Frame reader subprocess exited'));
                if (this.process === child) this.cleanup();
                if (wasReady && !this.stopping) this.scheduleRestart();
            });

            // A dead child turns stdin writes into EPIPE 'error' events;
            // without a listener those would crash the host process.
            child.stdin?.on('error', (err) => {
                this.logDebug(`Subprocess stdin error: ${err.message}`);
            });

            // Forward stderr for diagnostics (debug only; it never contains
            // image data, only status messages).
            child.stderr?.on('data', (chunk: Buffer) => {
                if (this.debug) {
                    process.stderr.write(`[frame-reader] ${chunk.toString()}`);
                }
            });

            // Parse JSON-line responses from stdout
            if (child.stdout) {
                const rl = createInterface({ input: child.stdout });
                rl.on('line', (line) => {
                    if (!line.trim()) return;
                    let data: unknown;
                    try {
                        data = JSON.parse(line);
                    } catch {
                        this.logDebug(`Failed to parse response (${line.length} bytes)`);
                        return;
                    }
                    if (!data || typeof data !== 'object') return;
                    const msg = data as Record<string, unknown>;
                    if (msg.type === 'ready') {
                        if (this.process === child && !this.ready) {
                            this.ready = true;
                            this.logDebug('Frame reader subprocess ready');
                            settle();
                        }
                        return;
                    }
                    this.handleResponse(msg);
                });
                this.readline = rl;
            }
        });
    }

    /**
     * Stop the Python subprocess.  Closes stdin (the worker exits on EOF),
     * sends SIGTERM, and SIGKILLs after a grace period.
     */
    stop(): void {
        this.stopping = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        const child = this.process;
        if (child && child.exitCode === null && child.signalCode === null) {
            this.logDebug('Stopping frame reader subprocess...');
            child.stdin?.end();
            const killTimer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGKILL');
                }
            }, KILL_GRACE_MS);
            killTimer.unref?.();
            child.once('exit', () => clearTimeout(killTimer));
            child.kill('SIGTERM');
        }
        this.rejectAllPending(new Error('Frame reader stopped'));
        this.cleanup();
    }

    /** Check if the subprocess is running and ready. */
    isReady(): boolean {
        return this.ready && this.process !== null && !this.process.killed;
    }

    // ── Request API ──────────────────────────────────────────────────────

    /**
     * Request a cropped frame from the subprocess.
     *
     * @param displayId   Display to read from (e.g., "display-1")
     * @param bounds      Window bounds in global logical (point) coordinates
     * @param scaleFactor Fallback logical→pixel scale, used only if the
     *                    display's real scale is unknown to the worker
     * @param prevHash    Previous frame hash for comparison (null for first capture)
     * @param jpegQuality JPEG quality (1-100)
     * @returns           CropResult with frame data and hash comparison
     */
    requestFrame(
        displayId: string,
        bounds: Rect,
        scaleFactor: number,
        prevHash: string | null,
        jpegQuality: number = 85,
    ): Promise<CropResult> {
        const request: Omit<FrameReaderRequest, 'requestId'> = {
            cmd: 'crop',
            displayId,
            bounds,
            scaleFactor,
            prevHash,
            jpegQuality,
            hashGrid: this.hashGrid,
        };
        return this.send<CropResult>(request, 'Frame request');
    }

    /**
     * Analyze an already-captured JPEG image.
     *
     * Sends the JPEG data to the Python subprocess which decodes it,
     * computes its perceptual hash, and compares with prevHash.
     * No shared memory or screen capture involved — purely image analysis.
     *
     * @param imageData  JPEG-encoded image as a Buffer
     * @param prevHash   Previous frame hash for comparison (null for first capture)
     * @returns          ImageAnalysisResult with hash and hamming distance
     */
    processImage(
        imageData: Buffer,
        prevHash: string | null,
    ): Promise<ImageAnalysisResult> {
        return this.send<ImageAnalysisResult>(
            {
                cmd: 'process_image',
                imageData: imageData.toString('base64'),
                prevHash,
                hashGrid: this.hashGrid,
            },
            'processImage',
        );
    }

    // ── Internal ─────────────────────────────────────────────────────────

    private send<T>(payload: Record<string, unknown>, label: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const child = this.process;
            if (!this.isReady() || !child?.stdin?.writable) {
                reject(new Error('Frame reader not ready'));
                return;
            }

            const requestId = `req_${++this.nextId}`;
            const timer = setTimeout(() => {
                if (this.pending.delete(requestId)) {
                    reject(new Error(`${label} timed out (${requestId})`));
                }
            }, REQUEST_TIMEOUT_MS);

            this.pending.set(requestId, { resolve, reject, timer });

            const line = JSON.stringify({ ...payload, requestId }) + '\n';
            child.stdin.write(line, (err) => {
                if (err) {
                    const p = this.pending.get(requestId);
                    if (p) {
                        clearTimeout(p.timer);
                        this.pending.delete(requestId);
                        reject(new Error(`Failed to write to subprocess: ${err.message}`));
                    }
                }
            });
        });
    }

    private handleResponse(data: Record<string, unknown>): void {
        const resp = data as unknown as FrameReaderResponse;
        const requestId = resp.requestId;
        const pending = typeof requestId === 'string' ? this.pending.get(requestId) : undefined;

        if (!pending) {
            this.logDebug(`Received response for unknown request: ${String(requestId)}`);
            return;
        }

        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        // A round-trip succeeded: the worker is healthy, so reset the
        // crash-loop counter (not on "ready", which a crash-looping worker
        // could still reach).
        this.restartAttempts = 0;

        if (!resp.ok) {
            pending.reject(new Error(resp.error ?? 'Unknown error from frame reader'));
            return;
        }

        // The response shape depends on the command that produced it.
        // For 'crop': includes frameData (base64 JPEG)
        // For 'process_image': no frameData (image was already provided by caller)
        if (resp.frameData) {
            // CropResult
            const frameBuffer = Buffer.from(resp.frameData, 'base64');
            pending.resolve({
                data: frameBuffer,
                width: resp.width ?? 0,
                height: resp.height ?? 0,
                hash: resp.hash ?? '',
                hammingDistance: resp.hammingDistance ?? -1,
                frameTimestamp: resp.frameTimestamp ?? 0,
            });
        } else {
            // ImageAnalysisResult (or other hash-only responses)
            pending.resolve({
                width: resp.width ?? 0,
                height: resp.height ?? 0,
                hash: resp.hash ?? '',
                hammingDistance: resp.hammingDistance ?? -1,
            });
        }
    }

    private rejectAllPending(err: Error): void {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
    }

    private scheduleRestart(): void {
        if (this.restartTimer || this.stopping) return;
        if (this.restartAttempts >= MAX_CONSECUTIVE_RESTARTS) {
            console.error(
                `[material-manager:frame-reader] subprocess exited ${this.restartAttempts} times; giving up`,
            );
            return;
        }
        const delay = Math.min(RESTART_BASE_MS * 2 ** this.restartAttempts, RESTART_MAX_MS);
        this.restartAttempts++;
        this.logDebug(`Restarting subprocess in ${delay}ms (attempt ${this.restartAttempts})`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.stopping) return;
            this.start().catch((err) => {
                this.logDebug(`Restart failed: ${(err as Error).message}`);
                this.scheduleRestart();
            });
        }, delay);
        this.restartTimer.unref?.();
    }

    private cleanup(): void {
        this.ready = false;
        this.process = null;
        if (this.readline) {
            this.readline.close();
            this.readline = null;
        }
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[material-manager:frame-reader]', message);
        }
    }
}
