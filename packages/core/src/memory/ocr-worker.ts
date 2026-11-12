/**
 * OCR Worker — manages the Apple Vision OCR Python subprocess
 * (py/ocr_worker.py) and provides the LineDeduper used to merge OCR
 * output across frames of the same material.
 *
 * Communication uses a JSON-line protocol over stdio, the same pattern
 * as material-manager's FrameReader. The worker is stateless: one JPEG
 * in, recognized lines out. Merging happens here in TypeScript so the
 * accumulated per-material text can be rebuilt from the database.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface } from 'readline';
import * as path from 'path';
import * as fs from 'fs';

// ── OcrWorker ──────────────────────────────────────────────────────────────

export interface OcrWorkerOptions {
    /** Python executable path. Default: 'python3' */
    pythonPath?: string;
    /** Per-request timeout in ms. Default: 30_000 */
    requestTimeoutMs?: number;
    /** Log debug output to stderr */
    debug?: boolean;
}

export class OcrWorker {
    private process: ChildProcess | null = null;
    private readline: Interface | null = null;
    private ready = false;
    private nextId = 0;
    private pythonPath: string;
    private requestTimeoutMs: number;
    private debug: boolean;
    /** In-progress start, shared by concurrent callers. */
    private startPromise: Promise<void> | null = null;

    private pending = new Map<
        string,
        {
            resolve: (lines: string[]) => void;
            reject: (err: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();

    constructor(options: OcrWorkerOptions = {}) {
        this.pythonPath = options.pythonPath ?? 'python3';
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
        this.debug = options.debug ?? false;
    }

    /** Start the Python subprocess. Resolves when it signals "ready". */
    start(): Promise<void> {
        if (this.isReady()) return Promise.resolve();
        if (this.startPromise) return this.startPromise;

        const promise = new Promise<void>((resolve, reject) => {
            // Published package ships src/memory/py next to dist/memory-service.js.
            const candidates = [
                path.resolve(__dirname, '../src/memory/py/ocr_worker.py'),
                path.resolve(__dirname, 'py/ocr_worker.py'),
            ];
            try {
                const pkg = require.resolve('@ausm/core/package.json');
                candidates.unshift(path.join(path.dirname(pkg), 'src/memory/py/ocr_worker.py'));
            } catch {
                // running from source before the package is linked
            }
            const resolvedScript = candidates.find((p) => fs.existsSync(p)) ?? candidates[0];

            this.logDebug(`Spawning: ${this.pythonPath} ${resolvedScript}`);

            const child = spawn(this.pythonPath, [resolvedScript], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            // Track the child immediately so stop() can kill it even before
            // it reports ready (it used to be orphaned).
            this.process = child;

            let settled = false;
            const settle = (err?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(startupTimeout);
                if (err) reject(err);
                else resolve();
            };

            const startupTimeout = setTimeout(() => {
                settle(new Error('OCR worker timed out waiting for ready (15s)'));
                child.kill('SIGKILL');
            }, 15_000);

            child.on('error', (err) => {
                settle(new Error(`OCR worker failed to start: ${err.message}`));
                if (this.process === child) this.cleanup();
            });

            child.on('exit', (code, signal) => {
                this.logDebug(`Subprocess exited (code=${code}, signal=${signal})`);
                settle(new Error(`OCR worker exited before ready (code=${code})`));
                // Only the current worker's exit affects shared state; a
                // previous worker exiting late must not touch its successor.
                if (this.process === child) {
                    this.rejectAll(new Error('OCR worker subprocess exited'));
                    this.cleanup();
                }
            });

            // A dead child turns stdin writes into EPIPE 'error' events.
            child.stdin?.on('error', (err) => this.logDebug(`stdin error: ${err.message}`));

            child.stderr?.on('data', (chunk: Buffer) => {
                if (this.debug) {
                    process.stderr.write(`[ocr-worker] ${chunk.toString()}`);
                }
            });

            if (child.stdout) {
                const rl = createInterface({ input: child.stdout });
                rl.on('line', (line) => {
                    if (!line.trim() || this.process !== child) return;
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
                        if (!this.ready) {
                            this.ready = true;
                            this.logDebug('OCR worker ready');
                            settle();
                        }
                        return;
                    }
                    this.handleResponse(msg);
                });
                this.readline = rl;
            }
        });

        this.startPromise = promise;
        const clear = () => {
            if (this.startPromise === promise) this.startPromise = null;
        };
        promise.then(clear, clear);
        return promise;
    }

    stop(): void {
        const proc = this.process;
        if (proc && proc.exitCode === null && proc.signalCode === null) {
            proc.stdin?.end();
            const killTimer = setTimeout(() => {
                if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
            }, 2000);
            killTimer.unref?.();
            proc.once('exit', () => clearTimeout(killTimer));
            proc.kill('SIGTERM');
        }
        this.rejectAll(new Error('OCR worker stopped'));
        this.cleanup();
    }

    isReady(): boolean {
        return this.ready && this.process !== null && !this.process.killed;
    }

    /** OCR a single JPEG. Returns the recognized text lines (top-to-bottom). */
    recognize(jpegData: Buffer): Promise<string[]> {
        return new Promise((resolve, reject) => {
            const child = this.process;
            if (!this.isReady() || !child?.stdin?.writable) {
                reject(new Error('OCR worker not ready'));
                return;
            }

            const requestId = `ocr_${++this.nextId}`;
            const timer = setTimeout(() => {
                if (this.pending.delete(requestId)) {
                    reject(new Error(`OCR request timed out (${requestId})`));
                }
            }, this.requestTimeoutMs);
            this.pending.set(requestId, { resolve, reject, timer });

            const line = JSON.stringify({
                cmd: 'ocr',
                requestId,
                imageData: jpegData.toString('base64'),
            }) + '\n';

            child.stdin.write(line, (err) => {
                if (err && this.pending.delete(requestId)) {
                    clearTimeout(timer);
                    reject(new Error(`Failed to write to OCR worker: ${err.message}`));
                }
            });
        });
    }

    private handleResponse(data: Record<string, unknown>): void {
        const requestId = String(data.requestId ?? '');
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);

        if (data.ok) {
            // Keep only string lines: a malformed reply must not reach the
            // deduper (non-strings made it throw, a string was iterated per char).
            const lines = Array.isArray(data.lines)
                ? data.lines.filter((l): l is string => typeof l === 'string')
                : [];
            pending.resolve(lines);
        } else {
            pending.reject(new Error(typeof data.error === 'string' ? data.error : 'Unknown OCR error'));
        }
    }

    private rejectAll(err: Error): void {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
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
            process.stderr.write(`[memory:ocr-worker] ${message}\n`);
        }
    }
}

// ── Smart line dedup ───────────────────────────────────────────────────────
//
// Across frames of the same material, OCR re-emits the same on-screen text
// in slightly different forms (case, spacing, trailing punctuation,
// line-splitting after scroll). Naive trim-dedup misses all of that.
// We normalize for comparison while keeping the original line in the output.
// Port of the LineDeduper in scripts/ocr_visualizer.py.

const PUNCT_EDGES = '.,;:!?·•·-—_"\'() []{}<>';

function normalizeLine(s: string): string {
    let n = s.replace(/\s+/g, ' ').trim().toLowerCase();
    let start = 0;
    let end = n.length;
    while (start < end && PUNCT_EDGES.includes(n[start])) start++;
    while (end > start && PUNCT_EDGES.includes(n[end - 1])) end--;
    return n.slice(start, end);
}

/** Order-preserving line set with normalized + substring dedup. */
export class LineDeduper {
    private lines: string[] = [];
    private seen = new Set<string>();
    /** Normalized forms with length > 20, for the substring containment check. */
    private longNorms: string[] = [];

    addLines(newLines: string[]): void {
        for (const raw of newLines) {
            if (typeof raw !== 'string') continue;
            const n = normalizeLine(raw);
            if (n.length < 2) continue;
            if (this.seen.has(n)) continue;
            // If this normalized line is fully contained inside an existing
            // longer one, treat it as a duplicate (catches partial re-reads
            // of the same on-screen text from a wider OCR pass).
            if (n.length > 20 && this.longNorms.some((s) => s.length > n.length && s.includes(n))) {
                continue;
            }
            this.seen.add(n);
            if (n.length > 20) this.longNorms.push(n);
            this.lines.push(raw);
        }
    }

    get lineCount(): number {
        return this.lines.length;
    }

    text(): string {
        return this.lines.join('\n');
    }
}
