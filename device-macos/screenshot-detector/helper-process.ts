import { ChildProcess, spawn } from 'child_process';
import { createInterface } from 'readline';

/**
 * Supervises a Swift JSON-lines helper: spawn, line parsing, graceful stop
 * (SIGTERM, then SIGKILL), and restart with exponential backoff when it
 * crashes. (Identical copies live in each device-macos package.)
 *
 * The helpers also exit on their own when their parent process dies.
 */
export interface HelperProcessOptions {
    /** Absolute path of the helper executable. */
    binary: string;
    args?: string[];
    /** Short label used in error messages. */
    name: string;
    /** Restart after an unexpected exit (default: true). */
    autoRestart?: boolean;
    /** Give up after this many restarts within `restartWindowMs` (default: 5). */
    maxRestarts?: number;
    restartWindowMs?: number;
    /** Exit codes that mean "do not restart" (e.g. a missing permission). */
    fatalExitCodes?: number[];
    /** One parsed JSON object per stdout line (objects with a string `type` only). */
    onMessage: (msg: { type: string; [key: string]: unknown }) => void;
    onError: (err: Error) => void;
    onStatus: (status: 'started' | 'stopped') => void;
    /** Diagnostic logger; only called when set. Never receives event payloads. */
    log?: (message: string) => void;
    /** Raw stderr from the helper; only called when set. */
    onStderr?: (text: string) => void;
}

const KILL_TIMEOUT_MS = 2000;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

export class HelperProcess {
    private child: ChildProcess | null = null;
    private wanted = false;
    private restartTimer: NodeJS.Timeout | null = null;
    private restartTimes: number[] = [];

    constructor(private readonly opts: HelperProcessOptions) {}

    /** True while the helper should be running (including while waiting to restart). */
    get running(): boolean {
        return this.wanted;
    }

    start(): boolean {
        if (this.wanted) return true;
        this.wanted = true;
        this.restartTimes = [];
        return this.spawnChild();
    }

    stop(): void {
        if (!this.wanted) return;
        this.wanted = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        const child = this.child;
        this.child = null;
        if (child) terminate(child);
        this.opts.onStatus('stopped');
    }

    private spawnChild(): boolean {
        let child: ChildProcess;
        try {
            child = spawn(this.opts.binary, this.opts.args ?? [], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            this.wanted = false;
            this.opts.onError(new Error(`Failed to start ${this.opts.name}: ${(err as Error).message}`));
            return false;
        }
        this.child = child;

        child.on('error', (err) => {
            if (this.child !== child) return;
            // Spawn failures (ENOENT, EACCES) will not fix themselves: no restart.
            this.child = null;
            this.wanted = false;
            this.opts.onError(new Error(`${this.opts.name} process error: ${err.message} (${this.opts.binary})`));
            this.opts.onStatus('stopped');
        });

        // 'close' (not 'exit'): fires after stdout is drained, so a final line such as an
        // `error` event written just before exiting is still delivered.
        child.on('close', (code, signal) => {
            if (this.child !== child) return; // stopped or superseded
            this.child = null;
            this.handleUnexpectedExit(code, signal);
        });

        if (child.stdout) {
            const rl = createInterface({ input: child.stdout });
            rl.on('line', (line) => {
                if (this.child !== child || !line.trim()) return;
                let msg: unknown;
                try {
                    msg = JSON.parse(line);
                } catch {
                    this.opts.log?.(`${this.opts.name}: unparseable line (${line.length} chars)`);
                    return;
                }
                if (msg && typeof msg === 'object' && typeof (msg as { type?: unknown }).type === 'string') {
                    this.opts.onMessage(msg as { type: string });
                } else {
                    this.opts.log?.(`${this.opts.name}: line without a "type" field`);
                }
            });
        }

        child.stderr?.on('data', (chunk: Buffer) => {
            this.opts.onStderr?.(chunk.toString());
        });

        this.opts.onStatus('started');
        return true;
    }

    private handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
        const how = `code=${code}, signal=${signal}`;
        if (!this.wanted) return;
        if (code !== null && (this.opts.fatalExitCodes ?? []).includes(code)) {
            this.wanted = false;
            this.opts.onError(new Error(`${this.opts.name} exited (${how}); not restarting`));
            this.opts.onStatus('stopped');
            return;
        }
        const now = Date.now();
        const windowMs = this.opts.restartWindowMs ?? 60_000;
        this.restartTimes = this.restartTimes.filter((t) => now - t < windowMs);
        const max = this.opts.maxRestarts ?? 5;
        if (this.opts.autoRestart === false || this.restartTimes.length >= max) {
            this.wanted = false;
            this.opts.onError(new Error(
                this.opts.autoRestart === false
                    ? `${this.opts.name} exited unexpectedly (${how})`
                    : `${this.opts.name} crashed ${max} times within ${windowMs} ms (${how}); giving up`,
            ));
            this.opts.onStatus('stopped');
            return;
        }
        const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.restartTimes.length, MAX_BACKOFF_MS);
        this.restartTimes.push(now);
        this.opts.onError(new Error(`${this.opts.name} exited unexpectedly (${how}); restarting in ${delay} ms`));
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.wanted && !this.child) this.spawnChild();
        }, delay);
    }
}

/** SIGTERM now, SIGKILL if the process is still alive after a grace period. */
function terminate(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, KILL_TIMEOUT_MS);
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
    child.kill('SIGTERM');
}
