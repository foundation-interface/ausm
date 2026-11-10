/**
 * Viewport Monitor Service for AUSM
 *
 * Spawns a Swift helper subprocess that runs a native CFRunLoop, enabling
 * reliable NSWorkspace notifications and AXObserver callbacks for window
 * lifecycle monitoring. Events are streamed as JSON lines over stdout.
 *
 * Architecture:
 *   Swift subprocess (ViewportHelper)
 *     └─ CFRunLoop on main thread
 *         ├─ CGWindowList polling (~60 Hz) → open / close / bounds / title
 *         ├─ NSWorkspace notifications     → app activate / deactivate / terminate, Space change
 *         └─ AXObserver                    → focus / unfocused
 *     └─ stdout: one JSON object per line
 *
 *   Node.js (this module)
 *     └─ child_process.spawn (stdin kept open so the helper exits if this process dies)
 *         └─ readline on stdout → parse JSON → emit typed events
 */

import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import { createInterface, Interface } from 'readline';
import { resolveHelperBinary } from './resolve-helper';

import type {
    NativeWindowEvent,
    SpaceChangeNativeEvent,
    WindowEvent,
    WindowEventType,
    ViewportMonitorConfig,
    ViewportMonitorEvents,
    ViewportPermissionState,
} from './types';

// Re-export types
export * from './types';

function helperBinary(): string {
    return resolveHelperBinary(__dirname, 'viewport-helper', 'ViewportHelper');
}

const WINDOW_EVENT_TYPES: ReadonlySet<string> = new Set<WindowEventType>([
    'window-opened',
    'window-closed',
    'window-focused',
    'window-unfocused',
    'bounds-changed',
    'title-changed',
]);

const MAX_LINE_LENGTH = 1_000_000;
const MAX_RESTART_ATTEMPTS = 5;
const MAX_RESTART_DELAY_MS = 30_000;
/** A helper that ran this long is considered healthy; the backoff counter resets. */
const STABLE_RUN_MS = 60_000;

function isRect(v: unknown): boolean {
    if (!v || typeof v !== 'object') return false;
    const r = v as Record<string, unknown>;
    return ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number');
}

/**
 * Viewport Monitor Service
 *
 * Monitors window lifecycle events across all applications on macOS
 * by running a Swift helper subprocess with a native CFRunLoop.
 *
 * @example
 * ```typescript
 * const monitor = new ViewportMonitorService();
 *
 * monitor.on('window-focused', (event) => {
 *     console.log('Focused:', event.ownerName);
 * });
 *
 * monitor.start();
 * // later...
 * monitor.stop();
 * ```
 */
export class ViewportMonitorService extends EventEmitter {
    private process: ChildProcess | null = null;
    private readline: Interface | null = null;
    private running = false;
    private debug = false;
    private autoRestart = true;
    private restartAttempts = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    private spawnedAt = 0;

    /**
     * Start monitoring window lifecycle events.
     * Spawns the Swift ViewportHelper subprocess.
     */
    start(config?: ViewportMonitorConfig): boolean {
        this.debug = config?.debug ?? false;
        this.autoRestart = config?.autoRestart ?? true;

        if (this.running) {
            this.logDebug('Viewport monitor already running');
            return true;
        }

        if (process.platform !== 'darwin') {
            this.handleError('Viewport monitor only works on macOS');
            return false;
        }

        const binary = config?.helperPath ?? helperBinary();
        if (!fs.existsSync(binary)) {
            this.handleError(
                `Viewport helper binary not found at ${binary}. Run 'npm run build:swift' in @ausm/device-macos-viewport-manager.`,
            );
            return false;
        }

        this.restartAttempts = 0;
        if (!this.spawnHelper(binary)) return false;
        this.running = true;
        this.emit('status', 'started');
        this.logDebug('Viewport monitor started');
        return true;
    }

    private spawnHelper(binary: string): boolean {
        let child: ChildProcess;
        try {
            // stdin is a pipe that we never write to: the helper exits on EOF if we die.
            child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
            this.handleError(`Failed to start helper: ${(err as Error).message}`);
            return false;
        }
        this.process = child;
        this.spawnedAt = Date.now();

        child.stdin?.on('error', () => { /* helper gone; exit handler deals with it */ });

        child.on('error', (err) => {
            this.handleError(`Helper process error: ${err.message}`);
            // A spawn failure (EACCES, ENOENT) emits 'error' and 'close' but never 'exit':
            // without this the monitor would stay "running" with no helper behind it.
            if (this.process !== child || child.pid !== undefined) return;
            this.process = null;
            this.readline?.close();
            this.readline = null;
            if (!this.running) return;
            this.running = false;
            this.emit('status', 'stopped');
        });

        child.on('exit', (code, signal) => {
            // Ignore exits of a previous child after stop()/restart.
            if (this.process !== child) return;
            this.process = null;
            this.readline?.close();
            this.readline = null;
            if (!this.running) return;

            this.logDebug(`Helper exited (code=${code}, signal=${signal})`);
            if (this.autoRestart && this.scheduleRestart(binary)) return;

            this.running = false;
            this.handleError(`Viewport helper exited (code=${code}, signal=${signal})`);
            this.emit('status', 'stopped');
        });

        if (child.stdout) {
            const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
            rl.on('line', (line) => this.handleLine(line));
            this.readline = rl;
        }

        child.stderr?.on('data', (chunk: Buffer) => {
            if (this.debug) {
                process.stderr.write(`[viewport-helper] ${chunk.toString()}`);
            }
        });
        return true;
    }

    private scheduleRestart(binary: string): boolean {
        if (Date.now() - this.spawnedAt > STABLE_RUN_MS) this.restartAttempts = 0;
        if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) return false;
        const delay = Math.min(1000 * 2 ** this.restartAttempts, MAX_RESTART_DELAY_MS);
        this.restartAttempts += 1;
        this.logDebug(`Restarting helper in ${delay} ms (attempt ${this.restartAttempts})`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (!this.running) return;
            if (!this.spawnHelper(binary)) {
                this.running = false;
                this.emit('status', 'stopped');
            }
        }, delay);
        return true;
    }

    /**
     * Stop monitoring. Sends SIGTERM to the helper subprocess.
     */
    stop(): boolean {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (!this.running) {
            return true;
        }

        this.running = false;
        const child = this.process;
        this.process = null;
        this.readline?.close();
        this.readline = null;
        try {
            child?.kill('SIGTERM');
        } catch (err) {
            this.handleError(`Failed to stop helper: ${(err as Error).message}`);
        }
        this.emit('status', 'stopped');
        this.logDebug('Viewport monitor stopped');
        return true;
    }

    /** Check if monitor is running */
    isRunning(): boolean {
        return this.running;
    }

    /** Stop and remove all listeners */
    cleanup(): void {
        this.stop();
        this.removeAllListeners();
    }

    // Type-safe event emitter methods
    on<K extends keyof ViewportMonitorEvents>(
        event: K,
        listener: ViewportMonitorEvents[K],
    ): this {
        return super.on(event, listener);
    }

    once<K extends keyof ViewportMonitorEvents>(
        event: K,
        listener: ViewportMonitorEvents[K],
    ): this {
        return super.once(event, listener);
    }

    emit<K extends keyof ViewportMonitorEvents>(
        event: K,
        ...args: Parameters<ViewportMonitorEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    // ── Private ───────────────────────────────────────────────────────────

    private handleLine(line: string): void {
        if (!line.trim() || !this.running) return;
        if (line.length > MAX_LINE_LENGTH) {
            this.logDebug(`Dropping oversized line (${line.length} chars)`);
            return;
        }
        let data: unknown;
        try {
            data = JSON.parse(line);
        } catch {
            // Do not echo the line: it may contain window titles.
            this.logDebug(`Failed to parse helper line (${line.length} chars)`);
            return;
        }
        if (!data || typeof data !== 'object') return;
        try {
            this.handleEvent(data as Record<string, unknown>);
        } catch (err) {
            // A throwing listener must not break the readline loop.
            this.handleError(`Listener threw: ${(err as Error).message}`);
        }
    }

    private handleEvent(data: Record<string, unknown>): void {
        const type = data.type;

        if (type === 'ready' || type === 'permission') {
            if (typeof data.accessibilityTrusted === 'boolean') {
                const state: ViewportPermissionState = {
                    accessibilityTrusted: data.accessibilityTrusted,
                    screenRecordingGranted: data.screenRecordingGranted === true,
                };
                this.emit('permission', state);
            }
            return;
        }

        if (type === 'space-changed') {
            this.emit('space-changed', data as unknown as SpaceChangeNativeEvent);
            return;
        }

        if (typeof type !== 'string' || !WINDOW_EVENT_TYPES.has(type) || !isRect(data.bounds)) {
            this.logDebug(`Ignoring unknown helper message type: ${String(type)}`);
            return;
        }

        const native = data as unknown as NativeWindowEvent;
        const event: WindowEvent = {
            ...native,
            timestamp: Date.now(),
        };

        this.emit('window-event', event);
        this.emit(native.type, event);

        if (this.debug) {
            const b = event.bounds;
            const boundsStr = `(${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)})`;
            this.logDebug(
                `${event.type}: "${event.title}" [${event.bundleId}] ${boundsStr}`,
            );
        }
    }

    private handleError(message: string): void {
        if (this.debug) {
            console.error('[viewport-monitor]', message);
        }
        // EventEmitter throws on an unhandled 'error'; never crash the host for a sensor failure.
        if (this.listenerCount('error') > 0) {
            this.emit('error', new Error(message));
        } else if (!this.debug) {
            console.warn('[viewport-monitor]', message);
        }
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[viewport-monitor]', message);
        }
    }
}

/**
 * Create a new ViewportMonitorService instance
 */
export function createViewportMonitor(): ViewportMonitorService {
    return new ViewportMonitorService();
}

export default ViewportMonitorService;
