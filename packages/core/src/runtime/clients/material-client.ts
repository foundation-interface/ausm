/**
 * Material Client — Bridge between AUSM runtime and the material-manager service process.
 *
 * Spawns the material-manager as a separate Node.js process and communicates
 * over stdio JSON-lines:
 *
 *   stdin  (client → MM): config, window-event messages
 *   stdout (MM → client): material-frame, material-created, material-focused, material-unfocused, ready, error
 *   stderr: debug/log output (forwarded to parent console)
 *
 * This keeps native addons (better-sqlite3) out of the runtime process.
 */

import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';

// ── Options ───────────────────────────────────────────────────────────────

export interface MaterialClientOptions {
    /** Enable debug logging */
    debug?: boolean;

    // ── Material Manager config (forwarded to the service process) ────────

    /** Hamming distance threshold for perceptual hash comparison. Default: 8 */
    hashDistanceThreshold?: number;
    /** Periodic capture interval in ms. Default: 3000 */
    captureIntervalMs?: number;
    /** Max frames per material. Default: 200 */
    maxFramesPerMaterial?: number;
    /** JPEG quality (1-100). Default: 85 */
    jpegQuality?: number;
    /** Python executable path. Default: 'python3' */
    pythonPath?: string;
    /** Path to the screen-stream-reader Python package (for PYTHONPATH). */
    screenStreamReaderPath?: string;
    /** SQLite database path. Default: ':memory:' */
    dbPath?: string;
    /** Delay (ms) before capturing after content-changing events. Default: 350 */
    captureDelayMs?: number;
    /** Max freshness retries. Default: 3 */
    maxFreshnessRetries?: number;
    /** Freshness retry base interval (ms). Default: 150 */
    freshnessRetryBaseMs?: number;
    /**
     * Tile grid for perceptual hashing.  Image is divided into
     * hashGrid × hashGrid tiles with an independent pHash per tile.
     * Catches small localized edits (typing) that whole-image pHash misses.
     * 1 = single hash, 4 = 4×4 grid (16 tiles).  Default: 4
     */
    hashGrid?: number;

    // ── Screen-stream integration ─────────────────────────────────────────

    /**
     * Unix socket path of the screen-stream helper that is already running.
     * The material-manager service will connect to this socket for
     * per-window capture (CGWindowListCreateImage).
     */
    screenStreamSocketPath?: string;

    // ── Process configuration ─────────────────────────────────────────────

    /**
     * Path to the material-manager service script.
     * Defaults to the built `dist/service.js`.
     */
    servicePath?: string;

    /**
     * Node executable path for spawning the service process.
     * Defaults to `'node'` (resolved from PATH), which is the system Node.js.
     * This is intentional: the runtime may be running inside Electron whose
     * embedded Node version differs from the one native addons (better-sqlite3)
     * were compiled against.
     */
    nodePath?: string;

    /** Stop timeout in ms. After this, the process is force-killed. Default: 5000 */
    stopTimeoutMs?: number;

    /**
     * Blacklist rules for filtering out materials (forwarded to the service).
     */
    materialBlacklist?: {
        apps?: string[];
        titleIncludes?: string[];
        bundleIds?: string[];
    };

}

// ── Event types ───────────────────────────────────────────────────────────

/** Window position/display info included with every material event. */
export interface MaterialWindowInfo {
    /** Current window bounds in screen coordinates */
    bounds?: { x: number; y: number; width: number; height: number } | null;
    /** macOS CGDirectDisplayID of the display the window is on */
    displayId?: number | null;
    /** Process ID of the owning application */
    pid?: number | null;
}

/** Optional latest frame snapshot included with lifecycle events. */
export interface MaterialFrameSnapshot {
    /** Frame ID of the latest snapshot */
    frameId?: string;
    /** JPEG data as base64 */
    dataBase64?: string;
    /** JPEG data size in bytes */
    sizeBytes?: number;
    /** Frame width in pixels */
    frameWidth?: number;
    /** Frame height in pixels */
    frameHeight?: number;
}

/** Raw material-frame message from the service process. */
export interface MaterialFrameMessage extends MaterialWindowInfo {
    type: 'material-frame';
    frameId: string;
    materialId: string;
    windowId: number;
    width: number;
    height: number;
    timestamp: number;
    title: string | null;
    application: string | null;
    bundleId: string | null;
    captureReason: string;
    dataBase64: string;
    sizeBytes: number;
}

/** Raw material-created message from the service process. */
export interface MaterialCreatedMessage extends MaterialWindowInfo, MaterialFrameSnapshot {
    type: 'material-created';
    materialId: string;
    windowId: number;
    title: string;
    application: string | null;
    bundleId: string | null;
    documentPath: string | null;
    firstSeen: number;
    lastSeen: number;
    appMetadata: Record<string, string | null> | null;
}

/** Raw material-focused message from the service process. */
export interface MaterialFocusedMessage extends MaterialWindowInfo, MaterialFrameSnapshot {
    type: 'material-focused';
    windowId: number;
    materialId: string;
    title: string;
    application: string | null;
    bundleId: string | null;
    documentPath: string | null;
    firstSeen: number;
    lastSeen: number;
    appMetadata: Record<string, string | null> | null;
}

/** Raw material-unfocused message from the service process. */
export interface MaterialUnfocusedMessage extends MaterialWindowInfo, MaterialFrameSnapshot {
    type: 'material-unfocused';
    windowId: number;
    materialId: string;
    title: string;
    application: string | null;
    bundleId: string | null;
    documentPath: string | null;
    firstSeen: number;
    lastSeen: number;
    appMetadata: Record<string, string | null> | null;
}

/** Raw material-type-classified message from the service process. */
export interface MaterialTypeClassifiedMessage extends MaterialWindowInfo {
    type: 'material-type-classified';
    materialId: string;
    windowId: number;
    title: string;
    application: string | null;
    bundleId: string | null;
    documentPath: string | null;
    materialType: string;
    materialTypeConfidence: number;
    appMetadata: Record<string, string | null> | null;
    firstSeen: number;
    lastSeen: number;
}

/** Raw material-save message from the service process. */
export interface MaterialSaveMessage {
    type: 'material-save';
    materialId: string;
    title: string;
    windowId: number;
    application: string | null;
    bundleId: string | null;
    documentPath: string | null;
    lastFrameHash: string | null;
    firstSeen: number;
    lastSeen: number;
    materialType: string | null;
    materialTypeConfidence: number | null;
    appMetadata: Record<string, string | null> | null;
}

/** Raw material-type-update message from the service process. */
export interface MaterialTypeUpdateMessage {
    type: 'material-type-update';
    materialId: string;
    materialType: string;
    materialTypeConfidence: number;
}

export interface MaterialClientEvents {
    'material-frame': (data: MaterialFrameMessage) => void;
    'material-created': (data: MaterialCreatedMessage) => void;
    'material-type-classified': (data: MaterialTypeClassifiedMessage) => void;
    'material-focused': (data: MaterialFocusedMessage) => void;
    'material-unfocused': (data: MaterialUnfocusedMessage) => void;
    'material-save': (data: MaterialSaveMessage) => void;
    'material-type-update': (data: MaterialTypeUpdateMessage) => void;
    'ready': () => void;
    'error': (error: Error) => void;
    'exit': (code: number | null, signal: string | null) => void;
}

// ── Default service path ──────────────────────────────────────────────────

function resolveDefaultServicePath(): string {
    try {
        const mmPkgPath = require.resolve('@ausm/device-macos-material-manager/package.json');
        return path.join(path.dirname(mmPkgPath), 'dist', 'service.js');
    } catch {
        return path.resolve(__dirname, '../../../device-macos/material-manager/dist/service.js');
    }
}

// ── MaterialClient ────────────────────────────────────────────────────────

export class MaterialClient extends EventEmitter {
    private options: MaterialClientOptions;
    private process: ChildProcess | null = null;
    private stdoutBuffer = '';
    private running = false;
    private stopTimeoutMs: number;

    constructor(options: MaterialClientOptions = {}) {
        super();
        this.options = options;
        this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    /**
     * Spawn the material-manager service process and wait for "ready".
     * Resolves once the service has started and is ready to receive events.
     */
    async start(): Promise<void> {
        if (this.running) return;

        const servicePath = this.options.servicePath ?? resolveDefaultServicePath();
        const nodePath = this.options.nodePath ?? 'node';

        this.debug(`Spawning service: ${nodePath} ${servicePath}`);

        this.process = spawn(nodePath, [servicePath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        // Monitor stderr (debug/log output from service)
        this.process.stderr?.setEncoding('utf-8');
        this.process.stderr?.on('data', (chunk: string) => {
            if (this.options.debug) {
                for (const line of chunk.split('\n')) {
                    if (line.trim()) console.log(line);
                }
            }
        });

        // EPIPE when the child dies mid-write must not crash the host; 'exit' handles the failure.
        this.process.stdin?.on('error', (err) => this.debug(`stdin error: ${err.message}`));

        // Monitor stdout (JSON-line events from service)
        this.process.stdout?.setEncoding('utf-8');
        this.process.stdout?.on('data', (chunk: string) => {
            this.handleStdoutData(chunk);
        });

        // Monitor process exit
        this.process.on('exit', (code, signal) => {
            this.debug(`Service process exited (code=${code}, signal=${signal})`);
            this.running = false;
            this.process = null;
            this.emit('exit', code, signal);
        });

        this.process.on('error', (err) => {
            this.debug(`Service process error: ${err.message}`);
            this.emit('error', err);
        });

        // Wait for the "ready" message
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.removeListener('ready', onReady);
                this.removeListener('error', onError);
                this.removeListener('exit', onExit);
                // Don't leave a half-started child running.
                const proc = this.process;
                this.process = null;
                proc?.kill('SIGKILL');
                reject(new Error('Material manager service timed out waiting for ready signal (10s)'));
            }, 10000);

            const onReady = () => {
                clearTimeout(timeout);
                this.running = true;
                resolve();
            };

            const onError = (err: Error) => {
                clearTimeout(timeout);
                this.removeListener('ready', onReady);
                reject(err);
            };

            const onExit = (code: number | null) => {
                clearTimeout(timeout);
                this.removeListener('ready', onReady);
                reject(new Error(`Material manager service exited before ready (code=${code})`));
            };

            this.once('ready', onReady);
            this.once('error', onError);
            this.once('exit', onExit);

            // Send config as first message
            this.sendConfig();
        });

        this.debug('Service is ready');
    }

    /**
     * Stop the service process gracefully.
     * Closes stdin (triggers EOF shutdown in service), then force-kills after timeout.
     */
    async stop(): Promise<void> {
        if (!this.process) return;

        this.debug('Stopping service…');
        this.running = false;

        const proc = this.process;
        this.process = null;

        return new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                this.debug('Force-killing service (timeout)');
                proc.kill('SIGKILL');
                resolve();
            }, this.stopTimeoutMs);

            proc.on('exit', () => {
                clearTimeout(timeout);
                resolve();
            });

            // Close stdin → triggers EOF in service → graceful shutdown
            proc.stdin?.end();
        });
    }

    /** Whether the service is running and ready. */
    isRunning(): boolean {
        return this.running;
    }

    // ── Event forwarding ──────────────────────────────────────────────────

    /**
     * Forward a window state event to the service process.
     * Call this for every WindowStateEvent from the ApplicationStateDetector.
     */
    sendWindowEvent(event: Record<string, unknown>): void {
        if (!this.process?.stdin?.writable) return;

        this.sendMessage({
            type: 'window-event',
            windowId: event.windowId ?? null,
            bounds: event.bounds ?? null,
            displayId: event.displayId ?? null,
            title: event.title ?? null,
            application: event.application ?? null,
            bundleId: event.bundleId ?? null,
            pid: event.pid ?? null,
            state: event.state ?? null,
            documentPath: event.documentPath ?? null,
        });
    }

    // ── Internal: IPC ─────────────────────────────────────────────────────

    private sendConfig(): void {
        const o = this.options;
        this.sendMessage({
            type: 'config',
            debug: o.debug ?? false,
            hashDistanceThreshold: o.hashDistanceThreshold,
            captureIntervalMs: o.captureIntervalMs,
            maxFramesPerMaterial: o.maxFramesPerMaterial,
            jpegQuality: o.jpegQuality,
            pythonPath: o.pythonPath,
            screenStreamReaderPath: o.screenStreamReaderPath,
            dbPath: o.dbPath,
            captureDelayMs: o.captureDelayMs,
            maxFreshnessRetries: o.maxFreshnessRetries,
            freshnessRetryBaseMs: o.freshnessRetryBaseMs,
            hashGrid: o.hashGrid,
            screenStreamSocketPath: o.screenStreamSocketPath,
            materialBlacklist: o.materialBlacklist,
        });
    }

    private sendMessage(msg: Record<string, unknown>): void {
        if (!this.process?.stdin?.writable) return;
        const line = JSON.stringify(msg) + '\n';
        this.process.stdin.write(line);
    }

    private handleStdoutData(chunk: string): void {
        this.stdoutBuffer += chunk;

        let newlineIdx: number;
        while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
            const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
            if (line) {
                try {
                    const msg = JSON.parse(line) as Record<string, unknown>;
                    this.handleServiceMessage(msg);
                } catch (err) {
                    this.debug(`Failed to parse stdout: ${(err as Error).message}`);
                }
            }
        }
    }

    private handleServiceMessage(msg: Record<string, unknown>): void {
        switch (msg.type) {
            case 'ready':
                this.emit('ready');
                break;

            case 'material-frame':
                this.emit('material-frame', msg as unknown as MaterialFrameMessage);
                break;

            case 'material-created':
                this.emit('material-created', msg as unknown as MaterialCreatedMessage);
                break;

            case 'material-type-classified':
                this.emit('material-type-classified', msg as unknown as MaterialTypeClassifiedMessage);
                break;

            case 'material-focused':
                this.emit('material-focused', msg as unknown as MaterialFocusedMessage);
                break;

            case 'material-unfocused':
                this.emit('material-unfocused', msg as unknown as MaterialUnfocusedMessage);
                break;

            case 'material-save':
                this.emit('material-save', msg as unknown as MaterialSaveMessage);
                break;

            case 'material-type-update':
                this.emit('material-type-update', msg as unknown as MaterialTypeUpdateMessage);
                break;

            case 'error':
                this.emit('error', new Error(msg.message as string ?? 'Unknown service error'));
                break;

            default:
                this.debug(`Unknown service message type: ${msg.type}`);
        }
    }

    // ── Type-safe event emitter ───────────────────────────────────────────

    on<K extends keyof MaterialClientEvents>(
        event: K,
        listener: MaterialClientEvents[K],
    ): this {
        return super.on(event, listener);
    }

    once<K extends keyof MaterialClientEvents>(
        event: K,
        listener: MaterialClientEvents[K],
    ): this {
        return super.once(event, listener);
    }

    emit<K extends keyof MaterialClientEvents>(
        event: K,
        ...args: Parameters<MaterialClientEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    // ── Debug ─────────────────────────────────────────────────────────────

    private debug(message: string): void {
        if (this.options.debug) {
            console.log('[MaterialClient]', message);
        }
    }
}

// ── Factory ───────────────────────────────────────────────────────────────

/** Create a new MaterialClient instance. */
export function createMaterialClient(options?: MaterialClientOptions): MaterialClient {
    return new MaterialClient(options);
}
