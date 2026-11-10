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
    private onReadyCallback: (() => void) | null = null;

    private pending = new Map<
        string,
        { resolve: (lines: string[]) => void; reject: (err: Error) => void }
    >();

    constructor(options: OcrWorkerOptions = {}) {
        this.pythonPath = options.pythonPath ?? 'python3';
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
        this.debug = options.debug ?? false;
    }

    /** Start the Python subprocess. Resolves when it signals "ready". */
    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.process) {
                resolve();
                return;
            }

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

            const startupTimeout = setTimeout(() => {
                if (!this.ready) {
                    reject(new Error('OCR worker timed out waiting for ready (15s)'));
                    child.kill('SIGKILL');
                }
            }, 15_000);

            child.on('error', (err) => {
                clearTimeout(startupTimeout);
                if (!this.ready) {
                    reject(new Error(`OCR worker failed to start: ${err.message}`));
                }
                this.cleanup();
            });

            child.on('exit', (code, signal) => {
                clearTimeout(startupTimeout);
                this.logDebug(`Subprocess exited (code=${code}, signal=${signal})`);
                if (!this.ready) {
                    reject(new Error(`OCR worker exited before ready (code=${code})`));
                }
                for (const [, p] of this.pending) {
                    p.reject(new Error('OCR worker subprocess exited'));
                }
                this.pending.clear();
                this.cleanup();
            });

            child.stderr?.on('data', (chunk: Buffer) => {
                if (this.debug) {
                    process.stderr.write(`[ocr-worker] ${chunk.toString()}`);
                }
            });

            if (child.stdout) {
                const rl = createInterface({ input: child.stdout });
                rl.on('line', (line) => {
                    if (!line.trim()) return;
                    try {
                        this.handleResponse(JSON.parse(line));
                    } catch {
                        this.logDebug(`Failed to parse response: ${line.substring(0, 200)}`);
                    }
                });
                this.readline = rl;
            }

            this.onReadyCallback = () => {
                clearTimeout(startupTimeout);
                this.ready = true;
                this.process = child;
                this.logDebug('OCR worker ready');
                resolve();
            };
        });
    }

    stop(): void {
        if (this.process && !this.process.killed) {
            this.process.stdin?.end();
            const proc = this.process;
            const killTimer = setTimeout(() => {
                if (!proc.killed) proc.kill('SIGKILL');
            }, 2000);
            proc.once('exit', () => clearTimeout(killTimer));
            proc.kill('SIGTERM');
        }
        this.cleanup();
    }

    isReady(): boolean {
        return this.ready && this.process !== null && !this.process.killed;
    }

    /** OCR a single JPEG. Returns the recognized text lines (top-to-bottom). */
    recognize(jpegData: Buffer): Promise<string[]> {
        return new Promise((resolve, reject) => {
            if (!this.isReady()) {
                reject(new Error('OCR worker not ready'));
                return;
            }

            const requestId = `ocr_${++this.nextId}`;
            this.pending.set(requestId, { resolve, reject });

            const line = JSON.stringify({
                cmd: 'ocr',
                requestId,
                imageData: jpegData.toString('base64'),
            }) + '\n';

            this.process!.stdin!.write(line, (err) => {
                if (err) {
                    this.pending.delete(requestId);
                    reject(new Error(`Failed to write to OCR worker: ${err.message}`));
                }
            });

            setTimeout(() => {
                if (this.pending.has(requestId)) {
                    this.pending.delete(requestId);
                    reject(new Error(`OCR request timed out (${requestId})`));
                }
            }, this.requestTimeoutMs);
        });
    }

    private handleResponse(data: Record<string, unknown>): void {
        if (data.type === 'ready') {
            this.onReadyCallback?.();
            this.onReadyCallback = null;
            return;
        }

        const requestId = String(data.requestId ?? '');
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);

        if (data.ok) {
            pending.resolve((data.lines as string[]) ?? []);
        } else {
            pending.reject(new Error((data.error as string) ?? 'Unknown OCR error'));
        }
    }

    private cleanup(): void {
        this.ready = false;
        this.process = null;
        this.onReadyCallback = null;
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
