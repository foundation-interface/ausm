/**
 * Text Input Monitor Service for AUSM
 *
 * Spawns a Swift helper subprocess (TextInputHelper) that uses the macOS
 * Accessibility API to detect when the user focuses/types in/leaves editable
 * text elements. Events are streamed as JSON lines over stdout.
 *
 * Architecture:
 *   Swift subprocess (TextInputHelper)
 *     └─ CFRunLoop on main thread
 *         ├─ NSWorkspace notifications → app activate / terminate
 *         └─ AXObserver
 *             ├─ kAXFocusedUIElementChangedNotification → STARTED / FINISHED
 *             └─ kAXValueChangedNotification            → UPDATED
 *     └─ stdout: one JSON object per line
 *
 *   Node.js (this module)
 *     └─ child_process.spawn (stdin kept open so the helper exits if this process dies)
 *         └─ readline on stdout → parse JSON → emit typed events
 *
 * Privacy: password fields are never reported by the helper, and this module never
 * logs typed text (debug logs show only status and text length).
 *
 * Falls back to a manual reportEvent() stub when the helper binary
 * is not available or on non-macOS platforms.
 */

import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import { createInterface, Interface } from 'readline';
import { resolveHelperBinary } from './resolve-helper';

import type {
    NativeTextInputEvent,
    TextInputEventLike,
    TextInputMonitorConfig,
    TextInputMonitorEvents,
    TextInputPermissionState,
    TextInputStatusLike,
} from './types';

export type { TextInputEventLike, TextInputMonitorConfig, TextInputMonitorEvents };

function helperBinary(): string {
    return resolveHelperBinary(__dirname, 'text-input-helper', 'TextInputHelper');
}

const STATUSES: ReadonlySet<string> = new Set<TextInputStatusLike>([
    'TEXT_EDITING_STARTED',
    'TEXT_EDITING_UPDATED',
    'TEXT_EDITING_FINISHED',
]);

/** Lines can carry the full contents of a large text area; cap to protect the host. */
const MAX_LINE_LENGTH = 16 * 1024 * 1024;
const MAX_RESTART_ATTEMPTS = 5;
const MAX_RESTART_DELAY_MS = 30_000;
/** A helper that ran this long is considered healthy; the backoff counter resets. */
const STABLE_RUN_MS = 60_000;

function newEventID(): string {
    return `txt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** Debug-log description of a text value that never reveals its content. */
function describeText(text: string | null | undefined): string {
    return text == null ? 'null' : `<${text.length} chars>`;
}

export class TextInputMonitorService extends EventEmitter {
    private process: ChildProcess | null = null;
    private readline: Interface | null = null;
    private running = false;
    private debug = false;
    private autoRestart = true;
    private restartAttempts = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    private spawnedAt = 0;

    /**
     * Start monitoring text input events.
     * On macOS: spawns the Swift TextInputHelper subprocess.
     * On other platforms or if the binary is missing: starts in stub mode.
     */
    start(config?: TextInputMonitorConfig): boolean {
        this.debug = config?.debug ?? false;
        this.autoRestart = config?.autoRestart ?? true;

        if (this.running) {
            this.logDebug('Text input monitor already running');
            return true;
        }

        if (process.platform !== 'darwin') {
            this.logDebug('Text input monitor only works on macOS — starting in stub mode');
            return this.startStub();
        }

        const binary = helperBinary();
        if (!fs.existsSync(binary)) {
            this.handleError(
                `Text input helper binary not found at ${binary}. Run 'npm run build:swift' in @ausm/device-macos-text-input.`,
            );
            this.logDebug('Falling back to stub mode');
            return this.startStub();
        }

        this.restartAttempts = 0;
        if (!this.spawnHelper(binary)) {
            this.logDebug('Falling back to stub mode');
            return this.startStub();
        }
        this.running = true;
        this.emit('status', 'started');
        this.logDebug('Text input monitor started (native mode)');
        return true;
    }

    private startStub(): boolean {
        this.running = true;
        this.emit('status', 'started');
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
            this.handleError(`Text input helper exited (code=${code}, signal=${signal})`);
            this.emit('status', 'stopped');
        });

        if (child.stdout) {
            const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
            rl.on('line', (line) => this.handleLine(line));
            this.readline = rl;
        }

        // The helper never writes typed text to stderr.
        child.stderr?.on('data', (chunk: Buffer) => {
            if (this.debug) {
                process.stderr.write(`[text-input-helper] ${chunk.toString()}`);
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
        this.logDebug('Text input monitor stopped');
        return true;
    }

    cleanup(): void {
        this.stop();
        this.removeAllListeners();
    }

    /**
     * Manually report a text input event (stub / test API).
     * Works regardless of whether the native helper is running.
     */
    reportEvent(data: TextInputEventLike): void {
        if (!this.running) return;
        const payload: TextInputEventLike = {
            ...data,
            timestamp: data.timestamp ?? Date.now(),
            eventID: data.eventID ?? newEventID(),
        };
        this.emit('text-input', payload);
        this.logDebug(`text-input: status=${payload.status} text=${describeText(payload.text)}`);
    }

    isRunning(): boolean {
        return this.running;
    }

    on<K extends keyof TextInputMonitorEvents>(
        event: K,
        listener: TextInputMonitorEvents[K],
    ): this {
        return super.on(event, listener);
    }

    once<K extends keyof TextInputMonitorEvents>(
        event: K,
        listener: TextInputMonitorEvents[K],
    ): this {
        return super.once(event, listener);
    }

    emit<K extends keyof TextInputMonitorEvents>(
        event: K,
        ...args: Parameters<TextInputMonitorEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    // ── Private ───────────────────────────────────────────────────────────

    private handleLine(line: string): void {
        if (!line.trim() || !this.running) return;
        if (line.length > MAX_LINE_LENGTH) {
            this.logDebug(`Dropping oversized helper line (${line.length} chars)`);
            return;
        }
        let data: unknown;
        try {
            data = JSON.parse(line);
        } catch {
            // Never echo the line: it may contain typed text.
            this.logDebug(`Failed to parse helper line (${line.length} chars)`);
            return;
        }
        if (!data || typeof data !== 'object') return;
        try {
            this.handleNativeEvent(data as NativeTextInputEvent);
        } catch (err) {
            // A throwing listener must not break the readline loop.
            this.handleError(`Listener threw: ${(err as Error).message}`);
        }
    }

    private handleNativeEvent(data: NativeTextInputEvent): void {
        if (data.type === 'ready' || data.type === 'permission') {
            if (typeof data.accessibilityTrusted === 'boolean') {
                const state: TextInputPermissionState = { accessibilityTrusted: data.accessibilityTrusted };
                this.logDebug(`Helper ${data.type}: accessibilityTrusted=${state.accessibilityTrusted}`);
                this.emit('permission', state);
            }
            return;
        }

        if (typeof data.status !== 'string' || !STATUSES.has(data.status)) {
            this.logDebug(`Ignoring helper message without a known status (type=${String(data.type)})`);
            return;
        }

        const payload: TextInputEventLike = {
            eventID: newEventID(),
            timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
            text: typeof data.text === 'string' ? data.text : null,
            sourceElement: data.sourceElement ?? null,
            status: data.status,
            caretScreenPosition: data.caretScreenPosition ?? null,
        };

        this.emit('text-input', payload);
        this.logDebug(`text-input: status=${payload.status} text=${describeText(payload.text)}`);
    }

    private handleError(message: string): void {
        if (this.debug) {
            console.error('[text-input-monitor]', message);
        }
        // EventEmitter throws on an unhandled 'error'; never crash the host for a sensor failure.
        if (this.listenerCount('error') > 0) {
            this.emit('error', new Error(message));
        } else if (!this.debug) {
            console.warn('[text-input-monitor]', message);
        }
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[text-input-monitor]', message);
        }
    }
}

export function createTextInputMonitor(): TextInputMonitorService {
    return new TextInputMonitorService();
}
