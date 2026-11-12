/**
 * AUSM Runtime - Core runtime implementation
 * 
 * @example
 * ```typescript
 * import { createRuntime, ausmRuntime } from '@ausm/core/runtime';
 * 
 * // Use the default singleton
 * ausmRuntime.initialize();
 * ausmRuntime.onTextSelectionEvent((event) => {
 *   console.log('Selected:', event.selectedText);
 * });
 * 
 * // Or create a new instance
 * const runtime = createRuntime();
 * runtime.initialize();
 * ```
 */

import { 
    AUSMUIElementData, 
    Point, 
    EventCallback, 
    Rect, 
    ImageData, 
    AUSMApplication 
} from '../types';
import { createTextSelectionEvent, DetectionSource, SelectionStage, type TextSelectionEvent, type TextSelectionEventData } from '../events/TextSelectionEvent';
import { createScreenshotEvent, type ScreenshotEvent, type ScreenshotEventData } from '../events/ScreenShotEvent';
import { createWindowStateEvent, type WindowStateEvent, type WindowStateEventData } from '../events/WindowStateEvent';
import { createTextInputEvent, type TextInputEvent, type TextInputEventData } from '../events/TextInputEvent';
import { createMaterialEvent, MaterialEventType, type MaterialEvent, type MaterialEventData } from '../events/MaterialEvent';
import { createCursorPlusPlusEvent, type CursorPlusPlusEvent, type CursorPlusPlusEventData } from '../events/CursorPlusPlusEvent';
import { createCopyPasteEvent, type CopyPasteEvent, type CopyPasteEventData } from '../events/CopyPasteEvent';
import { createSpaceChangeEvent, type SpaceChangeEvent, type SpaceChangeEventData } from '../events/SpaceChangeEvent';
import { createTaskEvent, type TaskEvent, type TaskEventData } from '../events/TaskEvent';
import { DetectorManager } from '../detectors/DetectorManager';
import { TaskTracker, observationFromDetectorResult } from '../detectors/TaskTracker';
import { createDetectorEvent, type DetectorEvent, type DetectorEventData, type DetectorsConfig } from '../detectors/types';
import { createAUSMUIElement, type AUSMEvent, type AUSMUIElement } from '../AUSM';
import { HttpHost } from './http-host';
import { resolvePythonPath, resolveScreenStreamReaderPath } from './resolve-install-paths';

// Type-only imports for service clients (erased at compile time).
// Actual client code is loaded at runtime via require('@ausm/core/clients')
// so that missing optional dependencies fail gracefully in try/catch blocks.
import type { SelectionClient } from './clients/text-selection-client';
import type { ViewportClient } from './clients/viewport-client';
import type { TextInputClient } from './clients/text-input-client';
import type {
    MaterialClient,
    MaterialFrameMessage,
    MaterialCreatedMessage,
    MaterialFocusedMessage,
    MaterialUnfocusedMessage,
    MaterialSaveMessage,
    MaterialTypeUpdateMessage,
    MaterialTypeClassifiedMessage,
} from './clients/material-client';
import type { MemoryClient } from './clients/memory-client';
import type { DetectorPipelineClient, DetectorPipelineClientResult } from './clients/detector-pipeline-client';

// Re-export base classes
export { AUSMEvent, AUSMUIElement };

// Re-export client types for external consumers (e.g. electron-bridge)
export type { MemoryClient } from './clients/memory-client';
export type { MaterialClient } from './clients/material-client';
export { DetectorManager } from '../detectors/DetectorManager';
export type { DetectorEntry, DetectorEvent, DetectorEventData, DetectorsConfig } from '../detectors/types';
export { createDetectorEvent } from '../detectors/types';
export type { DetectorPipelineClient } from './clients/detector-pipeline-client';

// Screen streaming configuration
export interface ScreenStreamingConfig {
    /** Target frames per second (1-60, default: 10) */
    fps?: number;
    /** Target height in pixels (default: 1080) */
    targetHeight?: number;
    /** Shared memory name (default: '/ausm-frames') */
    sharedMemoryName?: string;
    /** Unix socket path (default: '/tmp/ausm-frames.sock') */
    socketPath?: string;
}

// Camera streaming configuration
export interface CameraStreamingConfig {
    /** Target frames per second (1-60, default: 10) */
    fps?: number;
    /** Target height in pixels (default: 720) */
    targetHeight?: number;
    /** Shared memory name (default: '/ausm-camera-frames') */
    sharedMemoryName?: string;
    /** Unix socket path (default: '/tmp/ausm-camera.sock') */
    socketPath?: string;
    /** Preferred camera uniqueID (default: system default camera) */
    deviceId?: string;
}

// Material Manager configuration
export interface MaterialManagerConfig {
    /** Enable material tracking (default: false) */
    enabled?: boolean;
    /**
     * Hamming distance threshold for perceptual hash comparison.
     * Frames with distance >= this value are considered "significant".
     * Range: 0-64, where 0 = identical. Default: 8
     */
    hashDistanceThreshold?: number;
    /** Periodic capture interval in ms while a window is active. Default: 3000 */
    captureIntervalMs?: number;
    /** Max frames per material. Default: 200 */
    maxFramesPerMaterial?: number;
    /** @deprecated Use maxFramesPerMaterial instead */
    maxFramesPerWindow?: number;
    /** JPEG quality for stored frames (1-100). Default: 85 */
    jpegQuality?: number;
    /** Python executable path. Default: 'python3' */
    pythonPath?: string;
    /** Path to the screen-stream-reader Python package (for PYTHONPATH). */
    screenStreamReaderPath?: string;
    /** SQLite database path for persistent frame storage. Default: ':memory:' */
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
    /**
     * Unix socket path of the screen-stream helper.
     * The material-manager service process will connect to this socket
     * for per-window capture (CGWindowListCreateImage).
     * If not provided, defaults to the runtime's screen-streaming socket path.
     */
    screenStreamSocketPath?: string;

    /**
     * Path to the material-manager service script (dist/service.js).
     * Auto-resolved from @ausm/device-macos-material-manager if not provided.
     */
    servicePath?: string;
    /**
     * Node executable path for the service process.
     * Defaults to 'node' from PATH (system Node.js, not Electron's).
     */
    nodePath?: string;

    /**
     * Blacklist rules for filtering out materials.
     * Materials matching any rule are silently ignored — never created,
     * persisted, or emitted as events.
     */
    materialBlacklist?: {
        /** Exact application names to block (case-insensitive). */
        apps?: string[];
        /** Substrings to match against the window/material title (case-insensitive). */
        titleIncludes?: string[];
        /** Bundle identifiers to block (case-insensitive, e.g. "com.apple.dock"). */
        bundleIds?: string[];
    };
}

// Text selection configuration
export interface TextSelectionConfig {
    /** Enable native text selection monitoring (macOS only). Defaults to true. */
    enableNativeSelection?: boolean;
    /** Enable clipboard fallback for text retrieval. Defaults to true. */
    enableClipboard?: boolean;
}

// Text input configuration
export interface TextInputConfig {
    /** Enable native text input monitoring via text-input service (macOS only). Defaults to false. */
    enableNativeTextInput?: boolean;
}

// Screenshot detector configuration (macOS only)
export interface ScreenshotDetectorConfig {
    /** Enable native screenshot monitoring via @ausm/device-macos-screenshot-detector (macOS only). Default: true on darwin */
    enabled?: boolean;
}

// Clipboard monitor configuration (macOS only)
export interface ClipboardMonitorConfig {
    /** Enable clipboard monitoring via @ausm/device-macos-clipboard-monitor (macOS only). Default: true on darwin */
    enabled?: boolean;
    /** Include clipboard content in events (default: true). Set false for privacy. */
    includeContent?: boolean;
}

// Cursor++ configuration
export interface CursorPlusPlusConfig {
    /** Enable cursor++ tracking (default: false) */
    enabled?: boolean;
    /** Crop width in logical points for the interaction screenshot (default: 200) */
    cropWidth?: number;
    /** Crop height in logical points for the interaction screenshot (default: 40) */
    cropHeight?: number;
    /** JPEG quality for the interaction screenshot crop, 1-100 (default: 75) */
    cropJpegQuality?: number;
    /** Throttle interval (ms) for MOVE events (default: 100) */
    moveThrottleMs?: number;
    /** Scale factor hint for logical→physical pixel conversion (default: 2 on Retina, auto-detected per display) */
    defaultScaleFactor?: number;
}

// Logging configuration — single object with a global default and per-module overrides
export interface LoggingConfig {
    /** Global default for all modules (default: false) */
    global_default?: boolean;
    /** Log text selection events */
    textSelection?: boolean;
    /** Log text input events */
    textInput?: boolean;
    /** Log window state / viewport events */
    windowState?: boolean;
    /** Log material manager events */
    materialManager?: boolean;
    /** Log screen streaming events */
    screenStreaming?: boolean;
    /** Log camera streaming events */
    cameraStreaming?: boolean;
    /** Log screenshot detector events */
    screenshot?: boolean;
    /** Log clipboard monitor events */
    clipboardMonitor?: boolean;
    /** Log cursor++ events */
    cursorPlusPlus?: boolean;
    /** Log detector pipeline / TaskEvent reporting */
    detectorPipeline?: boolean;
    /** Print periodic event frequency summary to console (interval in ms, or true for 5s default) */
    eventFrequency?: boolean | number;
}

/** Detector evaluation (Vertex Gemini or Cerebras). */
export interface DetectorPipelineRuntimeConfig {
    /** Enable the detector pipeline. Default: true when Vertex projectId or Cerebras apiKey is set. */
    enabled?: boolean;
    /** 'vertex' (default) or 'cerebras'. Falls back to TASK_DETECTOR_PROVIDER. */
    provider?: 'vertex' | 'cerebras';
    /** Google Cloud project ID. Falls back to TASK_DETECTOR_PROJECT_ID / AUSM_DETECTOR_PROJECT_ID. */
    projectId?: string;
    /** Cerebras API key. Falls back to CEREBRAS_API_KEY. */
    apiKey?: string;
    /** Override Cerebras API base URL. Falls back to CEREBRAS_BASE_URL. */
    apiBaseUrl?: string;
    /** Vertex AI region (default: global) */
    location?: string;
    /** Model name (Vertex default: gemini-2.0-flash; Cerebras default: gemma-4-31b) */
    model?: string;
}

// Memory service configuration
export interface MemoryConfig {
    /** Start with writes frozen — no materials, frames, or screenshots will be persisted. Reads still work. Default: false */
    frozen?: boolean;
    /**
     * Enable live material OCR (Apple Vision, macOS only).
     * When enabled, every MATERIAL_UNFOCUSED triggers an incremental OCR pass
     * over the frames captured during that focus session. Recognized lines are
     * deduplicated and merged into the material's accumulated text content,
     * and a MATERIAL_CONTENT_UPDATED event is emitted when new text is found.
     * Read the accumulated text via runtime.getMaterialContent(materialId).
     * Requires pyobjc-framework-Vision / -Quartz (packages/core/src/memory/py/requirements.txt).
     * Default: false
     */
    ocrEnabled?: boolean;
    /** Python executable for the OCR worker. Auto-resolved from the AUSM venv if omitted. */
    ocrPythonPath?: string;
    /** Max frames OCRed per unfocus pass. Default: 40 */
    ocrMaxFramesPerRun?: number;
}

// Runtime configuration
export interface AUSMRuntimeConfig {
    /** Text selection configuration */
    textSelection?: TextSelectionConfig;
    /** Text input configuration */
    textInput?: TextInputConfig;
    /**
     * @deprecated Use `logging.global_default` instead. Kept for backward compatibility;
     * if both `debug` and `logging.global_default` are set, `logging.global_default` wins.
     */
    debug?: boolean;
    /** Logging configuration — global default + per-module overrides */
    logging?: LoggingConfig;
    /** Enable screen streaming service */
    enableScreenStreaming?: boolean;
    /** Screen streaming configuration */
    screenStreaming?: ScreenStreamingConfig;
    /** Enable camera streaming service (default: false — requires Camera permission) */
    enableCameraStreaming?: boolean;
    /** Camera streaming configuration */
    cameraStreaming?: CameraStreamingConfig;
    /** Material manager configuration */
    materialManager?: MaterialManagerConfig;
    /** Screenshot detector configuration (screencapture/screencaptureui monitoring) */
    screenshotDetector?: ScreenshotDetectorConfig;
    /** Clipboard monitor configuration (copy/paste detection) */
    clipboardMonitor?: ClipboardMonitorConfig;
    /** Cursor++ configuration (mouse interaction tracking) */
    cursorPlusPlus?: CursorPlusPlusConfig;
    /** Memory service configuration (persistent storage for materials, frames, screenshots) */
    memory?: MemoryConfig;
    /** File-based detector specs under the repo `detectors` directory */
    detectors?: DetectorsConfig;
    /** Multimodal detector pipeline (Vertex AI). Required to emit TaskEvent. */
    detectorPipeline?: DetectorPipelineRuntimeConfig;
    /**
     * Optional HTTP host (Material Chat: memory search + agent).
     * Spawned as a child process so better-sqlite3 stays out of Electron.
     */
    http?: {
        enabled?: boolean;
        port?: number;
    };
    /** Session/prefs data dir for the Material Chat host. */
    materialChat?: {
        enabled?: boolean;
        dataDir?: string;
    };
}

type LoggingModule = Exclude<keyof LoggingConfig, 'global_default' | 'eventFrequency'>;

/**
 * Check whether logging is enabled for a specific module.
 * Priority: per-module toggle > logging.global_default > legacy debug flag > false.
 */
function isLogging(config: AUSMRuntimeConfig, module: LoggingModule): boolean {
    const moduleToggle = config.logging?.[module];
    if (moduleToggle !== undefined) return moduleToggle;
    if (config.logging?.global_default !== undefined) return config.logging.global_default;
    return config.debug ?? false;
}

/**
 * Deliver an event to every subscriber. A throwing subscriber is logged and skipped: it must
 * not starve the others (frequency monitor, detector pipeline, host callbacks) or propagate
 * back into the sensor service that produced the event.
 */
function dispatchToCallbacks<T>(callbacks: EventCallback<T>[], event: T, label: string): void {
    for (const cb of callbacks) {
        try {
            cb(event);
        } catch (err) {
            console.error(`[AUSM] ${label} callback threw:`, (err as Error)?.message ?? err);
        }
    }
}

// ============================================================================
// Event Frequency Monitor
// ============================================================================

/**
 * If the host's stdout/stderr is a pipe whose reader went away (`app | head`,
 * a closed terminal), the next console.log emits EPIPE on the stream, and with
 * no listener that becomes an uncaught exception that kills the host. Losing
 * log lines is fine; crashing is not.
 */
let stdioGuarded = false;
function guardBrokenStdio(): void {
    if (stdioGuarded) return;
    stdioGuarded = true;
    for (const stream of [process.stdout, process.stderr]) {
        // Swallow every stdio error: reporting it would mean writing to the same broken stream.
        stream?.on?.('error', () => {});
    }
}

class EventFrequencyMonitor {
    private counts = new Map<string, number>();
    private windowStart = Date.now();
    private timer: ReturnType<typeof setInterval> | null = null;
    private intervalMs: number;

    constructor(intervalMs = 5000) {
        this.intervalMs = intervalMs;
    }

    start(): void {
        if (this.timer) return;
        this.windowStart = Date.now();
        this.timer = setInterval(() => this.flush(), this.intervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.flush();
    }

    record(kind: string): void {
        this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    }

    private flush(): void {
        if (this.counts.size === 0) return;
        const elapsed = (Date.now() - this.windowStart) / 1000;
        const parts: string[] = [];
        for (const [kind, count] of Array.from(this.counts.entries()).sort()) {
            parts.push(`${kind}=${count} (${(count / elapsed).toFixed(1)}/s)`);
        }
        const total = Array.from(this.counts.values()).reduce((a, b) => a + b, 0);
        console.log(`[AUSM Frequency] ${elapsed.toFixed(1)}s | total=${total} (${(total / elapsed).toFixed(1)}/s) | ${parts.join(', ')}`);
        this.counts.clear();
        this.windowStart = Date.now();
    }
}

// ============================================================================
// Detector Implementations
// ============================================================================

interface Detector<T> {
    start(): void;
    stop(): void;
    addCallback(callback: EventCallback<T>): void;
    emit(event: T): void;
}

class TextSelectionDetectorImpl implements Detector<TextSelectionEvent> {
    private callbacks: EventCallback<TextSelectionEvent>[] = [];
    private running = false;
    private selectionClient: SelectionClient | null = null;
    private config: AUSMRuntimeConfig;

    constructor(config: AUSMRuntimeConfig = {}) {
        this.config = config;
    }

    async start(): Promise<void> {
        this.running = true;
        console.log('[AUSM] TextSelectionDetector started');

        // Try to start native selection monitoring if enabled
        const enableNative = this.config.textSelection?.enableNativeSelection;
        if (enableNative !== false && process.platform === 'darwin') {
            this.startNativeMonitoring();
        }
    }

    stop(): void {
        this.running = false;
        console.log('[AUSM] TextSelectionDetector stopped');

        // Stop native monitoring if running
        if (this.selectionClient) {
            this.selectionClient.stop();
            this.selectionClient.cleanup();
            this.selectionClient = null;
        }
    }

    addCallback(callback: EventCallback<TextSelectionEvent>): void {
        this.callbacks.push(callback);
    }

    emit(event: TextSelectionEvent): void {
        if (this.running) {
            dispatchToCallbacks(this.callbacks, event, 'TextSelection');
        }
    }

    private startNativeMonitoring(): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createSelectionClient } = require('@ausm/core/clients');
            
            const enableClipboard = this.config.textSelection?.enableClipboard ?? true;
            const client: SelectionClient = createSelectionClient({
                debug: isLogging(this.config, 'textSelection'),
                enableClipboard,
            });
            
            this.selectionClient = client;

            // Check permissions
            if (!client.isProcessTrusted()) {
                console.log('[AUSM] Accessibility permission not granted. Requesting...');
                client.requestProcessTrust();
            }

            // Subscribe to selection events
            client.on('selection', (data) => {
                const eventData = data as TextSelectionEventData;
                eventData.detectionSource = DetectionSource.NATIVE;
                const event = createTextSelectionEvent(eventData);
                this.emit(event);
            });

            client.on('error', (error) => {
                console.error('[AUSM] Selection monitor error:', (error as Error).message);
            });

            // Start monitoring
            if (client.start()) {
                console.log('[AUSM] Native selection monitoring started');
            } else {
                console.warn('[AUSM] Failed to start native selection monitoring');
            }
        } catch (err) {
            console.warn('[AUSM] Native selection monitoring not available:', (err as Error).message);
        }
    }

}


// Type for ScreenStreamingService (to avoid direct import dependency)
export interface ScreenDisplayInfo {
    id: string;
    width: number;
    height: number;
    isMain: boolean;
    isBuiltIn?: boolean;
    /** Numeric CGDirectDisplayID */
    displayId?: number;
    /** Backing scale factor (e.g. 2.0 for Retina) */
    scaleFactor?: number;
    /** Logical-point origin X in the global desktop coordinate space */
    originX?: number;
    /** Logical-point origin Y in the global desktop coordinate space */
    originY?: number;
    /** Logical-point width (CSS pixels) */
    logicalWidth?: number;
    /** Logical-point height (CSS pixels) */
    logicalHeight?: number;
}

export interface LatestScreenFrame {
    /** JPEG-encoded image data */
    data: Buffer;
    displayId: string;
    width: number;
    height: number;
    jpegSize: number;
    timestamp: number;
    frameNumber: number;
}

interface ScreenStreamingServiceType {
    start(displayIds?: string[]): Promise<boolean>;
    stop(): Promise<boolean>;
    cleanup(): Promise<void>;
    getDisplays(): Promise<ScreenDisplayInfo[]>;
    isStreaming(): Promise<boolean>;
    updateConfiguration(config: Record<string, unknown>): Promise<void>;
    onDisplayChange(callback: (event: { type: string; displayId: string; event: string }) => void): void;
    captureWindow?(windowId: number, jpegQuality?: number, displayId?: string): Promise<{ data: Buffer; width: number; height: number }>;
    captureLatestFrame?(displayId: string, jpegQuality?: number): Promise<LatestScreenFrame | null>;
}

// Screen streaming manager
class ScreenStreamingManagerImpl {
    private service: ScreenStreamingServiceType | null = null;
    private config: AUSMRuntimeConfig;
    private running = false;

    constructor(config: AUSMRuntimeConfig = {}) {
        this.config = config;
    }

    async start(): Promise<boolean> {
        if (!this.config.enableScreenStreaming) {
            return this.running;
        }

        if (this.running) {
            console.log('[AUSM] Screen streaming already running');
            return this.running;
        }

        const streamingConfig = this.config.screenStreaming || {};

        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createScreenStreamer } = require('@ausm/device-macos-screen-stream');

            this.service = createScreenStreamer({
                fps: streamingConfig.fps ?? 10,
                targetHeight: streamingConfig.targetHeight ?? 1080,
                sharedMemoryName: streamingConfig.sharedMemoryName ?? '/ausm-frames',
                socketPath: streamingConfig.socketPath ?? '/tmp/ausm-frames.sock',
                debug: isLogging(this.config, 'screenStreaming'),
            }) as ScreenStreamingServiceType;

            const started = await this.service.start();
            if (started) {
                this.running = true;
                console.log('[AUSM] Screen streaming service started');
                console.log('[AUSM] Shared memory: %s', streamingConfig.sharedMemoryName ?? '/ausm-frames');
            } else {
                // The service already logged why; drop it so callers see "not available"
                // instead of polling a helper that never came up.
                console.error('[AUSM] Failed to start screen streaming');
                this.service = null;
            }
        } catch (err) {
            console.warn('[AUSM] Screen streaming not available:', (err as Error).message);
            this.service = null;
        }
        return this.running;
    }

    async stop(): Promise<void> {
        if (this.service) {
            console.log('[AUSM] Stopping screen streaming service...');
            await this.service.cleanup();
            this.service = null;
        }
        this.running = false;
    }

    isRunning(): boolean {
        return this.running;
    }

    getService(): ScreenStreamingServiceType | null {
        return this.service;
    }
}

export interface CameraDeviceInfo {
    id: string;
    name: string;
    position: 'front' | 'back' | 'unspecified';
    active: boolean;
    manufacturer?: string;
}

export interface LatestCameraFrame {
    data: Buffer;
    deviceId: string;
    width: number;
    height: number;
    jpegSize: number;
    timestamp: number;
    frameNumber: number;
}

interface CameraStreamingServiceType {
    start(deviceIds?: string[]): Promise<boolean>;
    stop(): Promise<boolean>;
    cleanup(): Promise<void>;
    getDevices(): Promise<CameraDeviceInfo[]>;
    startDevices?(deviceIds?: string[]): Promise<boolean>;
    isStreaming(): Promise<boolean>;
    updateConfiguration(config: Record<string, unknown>): Promise<void>;
    onDeviceChange(callback: (event: { type: string; deviceId: string; event: string }) => void): void;
    captureLatestFrame?(deviceId: string, jpegQuality?: number): Promise<LatestCameraFrame | null>;
}

class CameraStreamingManagerImpl {
    private service: CameraStreamingServiceType | null = null;
    private config: AUSMRuntimeConfig;
    private running = false;

    constructor(config: AUSMRuntimeConfig = {}) {
        this.config = config;
    }

    async start(): Promise<boolean> {
        if (!this.config.enableCameraStreaming) {
            return this.running;
        }

        if (this.running) {
            console.log('[AUSM] Camera streaming already running');
            return this.running;
        }

        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createCameraStreamer } = require('@ausm/device-macos-camera');

            const streamingConfig = this.config.cameraStreaming || {};

            this.service = createCameraStreamer({
                fps: streamingConfig.fps ?? 10,
                targetHeight: streamingConfig.targetHeight ?? 720,
                sharedMemoryName: streamingConfig.sharedMemoryName ?? '/ausm-camera-frames',
                socketPath: streamingConfig.socketPath ?? '/tmp/ausm-camera.sock',
                deviceId: streamingConfig.deviceId,
                debug: isLogging(this.config, 'cameraStreaming'),
            }) as CameraStreamingServiceType;

            const started = await this.service.start();
            if (started) {
                this.running = true;
                console.log('[AUSM] Camera streaming service started');
                console.log('[AUSM] Camera shared memory: %s', streamingConfig.sharedMemoryName ?? '/ausm-camera-frames');
            } else {
                // The service already logged why; drop it so callers see "not available"
                // instead of polling a helper that never came up.
                console.error('[AUSM] Failed to start camera streaming');
                this.service = null;
            }
        } catch (err) {
            console.warn('[AUSM] Camera streaming not available:', (err as Error).message);
            this.service = null;
        }
        return this.running;
    }

    async stop(): Promise<void> {
        if (this.service) {
            console.log('[AUSM] Stopping camera streaming service...');
            await this.service.cleanup();
            this.service = null;
            this.running = false;
        }
    }

    isRunning(): boolean {
        return this.running;
    }

    getService(): CameraStreamingServiceType | null {
        return this.service;
    }
}

// Type for child process
interface ChildProcessType {
    pid?: number;
    killed: boolean;
    kill(signal?: string): boolean;
    on(event: string, listener: (...args: unknown[]) => void): void;
}

// Type for child process with streams
interface ChildProcessWithStreams extends ChildProcessType {
    stdout?: NodeJS.ReadableStream | null;
    stderr?: NodeJS.ReadableStream | null;
}

class ScreenshotDetectorImpl implements Detector<ScreenshotEvent> {
    private callbacks: EventCallback<ScreenshotEvent>[] = [];
    private running = false;
    private screenshotService: ScreenshotDetectorServiceType | null = null;
    private config: AUSMRuntimeConfig;

    constructor(config: AUSMRuntimeConfig = {}) {
        this.config = config;
    }

    start(): void {
        const enabled = this.config.screenshotDetector?.enabled ?? (process.platform === 'darwin');
        if (enabled && process.platform === 'darwin') {
            this.startScreenshotService();
        }
        this.running = true;
        console.log('[AUSM] ScreenshotDetector started');
    }

    stop(): void {
        this.running = false;
        if (this.screenshotService) {
            this.screenshotService.stop();
            this.screenshotService = null;
        }
        console.log('[AUSM] ScreenshotDetector stopped');
    }

    addCallback(callback: EventCallback<ScreenshotEvent>): void {
        this.callbacks.push(callback);
    }

    emit(event: ScreenshotEvent): void {
        if (this.running) {
            if (isLogging(this.config, 'screenshot')) {
                console.log(`[AUSM] ScreenshotEvent: status=${event.status} type=${event.type} bounds=${event.bounds ? 'yes' : 'no'}`);
            }
            dispatchToCallbacks(this.callbacks, event, 'Screenshot');
        }
    }

    private startScreenshotService(): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createScreenshotDetector } = require('@ausm/device-macos-screenshot-detector');

            const service: ScreenshotDetectorServiceType = createScreenshotDetector({
                debug: isLogging(this.config, 'screenshot'),
            });

            this.screenshotService = service;

            service.on('screenshot-event', (event: unknown) => {
                this.emit(event as ScreenshotEvent);
            });

            service.on('error', (error: unknown) => {
                console.error('[AUSM] Screenshot detector error:', (error as Error).message);
            });

            if (service.start()) {
                console.log('[AUSM] Screenshot detector service started');
            } else {
                console.warn('[AUSM] Failed to start screenshot detector service');
            }
        } catch (err) {
            console.warn('[AUSM] Screenshot detector not available:', (err as Error).message);
        }
    }
}

class ClipboardMonitorImpl implements Detector<CopyPasteEvent> {
    private callbacks: EventCallback<CopyPasteEvent>[] = [];
    private running = false;
    private clipboardService: ClipboardMonitorServiceType | null = null;
    private config: AUSMRuntimeConfig;

    constructor(config: AUSMRuntimeConfig = {}) {
        this.config = config;
    }

    start(): void {
        const enabled = this.config.clipboardMonitor?.enabled ?? (process.platform === 'darwin');
        if (enabled && process.platform === 'darwin') {
            this.startClipboardService();
        }
        this.running = true;
        console.log('[AUSM] ClipboardMonitor started');
    }

    stop(): void {
        this.running = false;
        if (this.clipboardService) {
            this.clipboardService.stop();
            this.clipboardService = null;
        }
        console.log('[AUSM] ClipboardMonitor stopped');
    }

    addCallback(callback: EventCallback<CopyPasteEvent>): void {
        this.callbacks.push(callback);
    }

    emit(event: CopyPasteEvent): void {
        if (this.running) {
            if (isLogging(this.config, 'clipboardMonitor')) {
                console.log(`[AUSM] CopyPasteEvent: action=${event.action} contentLength=${event.content?.length ?? 0}`);
            }
            dispatchToCallbacks(this.callbacks, event, 'CopyPaste');
        }
    }

    private startClipboardService(): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createClipboardMonitor } = require('@ausm/device-macos-clipboard-monitor');

            const service: ClipboardMonitorServiceType = createClipboardMonitor({
                debug: isLogging(this.config, 'clipboardMonitor'),
                includeContent: this.config.clipboardMonitor?.includeContent ?? true,
            });

            this.clipboardService = service;

            service.on('copy-paste-event', (event: unknown) => {
                this.emit(event as CopyPasteEvent);
            });

            service.on('error', (error: unknown) => {
                console.error('[AUSM] Clipboard monitor error:', (error as Error).message);
            });

            if (service.start()) {
                console.log('[AUSM] Clipboard monitor service started');
            } else {
                console.warn('[AUSM] Failed to start clipboard monitor service');
            }
        } catch (err) {
            console.warn('[AUSM] Clipboard monitor not available:', (err as Error).message);
        }
    }
}

// Type for ClipboardMonitorService (to avoid direct import of @ausm/device-macos-clipboard-monitor)
interface ClipboardMonitorServiceType {
    start(): boolean;
    stop(): boolean;
    on(event: string, handler: (...args: unknown[]) => void): void;
}


class ApplicationStateDetectorImpl implements Detector<WindowStateEvent> {
    private callbacks: EventCallback<WindowStateEvent>[] = [];
    private spaceChangeCallbacks: EventCallback<SpaceChangeEvent>[] = [];
    private running = false;
    private viewportClients: ViewportClient[] = [];
    private config: AUSMRuntimeConfig;

    constructor(config: AUSMRuntimeConfig = {}) {
        this.config = config;
    }

    start(): void {
        this.running = true;
        console.log('[AUSM] ApplicationStateDetector started');

        if (process.platform === 'darwin') {
            this.startNativeMonitoring();
        }
    }

    stop(): void {
        this.running = false;
        console.log('[AUSM] ApplicationStateDetector stopped');

        for (const client of this.viewportClients) {
            client.stop();
            client.cleanup();
        }
        this.viewportClients = [];
    }

    addCallback(callback: EventCallback<WindowStateEvent>): void {
        this.callbacks.push(callback);
    }

    addSpaceChangeCallback(callback: EventCallback<SpaceChangeEvent>): void {
        this.spaceChangeCallbacks.push(callback);
    }

    emit(event: WindowStateEvent): void {
        if (this.running) {
            if (isLogging(this.config, 'windowState')) {
                const b = event.bounds;
                const boundsStr = b ? `${b.x},${b.y} ${b.width}x${b.height}` : 'null';
                console.log(`[AUSM] WindowStateEvent: state=${event.state} app="${event.application ?? ''}" title="${event.title ?? ''}" bounds=[${boundsStr}]`);
            }
            dispatchToCallbacks(this.callbacks, event, 'WindowState');
        }
    }

    emitSpaceChange(event: SpaceChangeEvent): void {
        if (this.running) {
            if (isLogging(this.config, 'windowState')) {
                console.log('[AUSM] SpaceChangeEvent: active space changed');
            }
            dispatchToCallbacks(this.spaceChangeCallbacks, event, 'SpaceChange');
        }
    }

    private startNativeMonitoring(): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createViewportClient } = require('@ausm/core/clients');

            const client: ViewportClient = createViewportClient({
                debug: isLogging(this.config, 'windowState'),
            });

            this.viewportClients.push(client);

            client.on('window-state', (data) => {
                const eventData = data as WindowStateEventData;
                const event = createWindowStateEvent(eventData);
                this.emit(event);
            });

            client.on('space-changed', (data: { timestamp: number }) => {
                const event = createSpaceChangeEvent({ timestamp: data.timestamp });
                this.emitSpaceChange(event);
            });

            client.on('error', (error) => {
                console.error('[AUSM] Viewport monitor error:', (error as Error).message);
            });

            if (client.start()) {
                console.log('[AUSM] Viewport monitoring started');
            } else {
                console.warn('[AUSM] Failed to start viewport monitoring');
            }
        } catch (err) {
            console.warn('[AUSM] Viewport monitoring not available:', (err as Error).message);
        }
    }
}

class TextInputDetectorImpl implements Detector<TextInputEvent> {
    private callbacks: EventCallback<TextInputEvent>[] = [];
    private running = false;
    private textInputClient: TextInputClient | null = null;
    private config: AUSMRuntimeConfig;

    constructor(config: AUSMRuntimeConfig = {}) {
        this.config = config;
    }

    start(): void {
        this.running = true;
        console.log('[AUSM] TextInputDetector started');

        const enableNative = this.config.textInput?.enableNativeTextInput;
        if (enableNative && process.platform === 'darwin') {
            this.startNativeTextInputMonitoring();
        }
    }

    stop(): void {
        this.running = false;
        console.log('[AUSM] TextInputDetector stopped');

        if (this.textInputClient) {
            this.textInputClient.stop();
            this.textInputClient.cleanup();
            this.textInputClient = null;
        }
    }

    addCallback(callback: EventCallback<TextInputEvent>): void {
        this.callbacks.push(callback);
    }

    emit(event: TextInputEvent): void {
        if (this.running) {
            if (isLogging(this.config, 'textInput')) {
                // Never log typed text, only its length.
                console.log(`[AUSM] TextInputEvent: status=${event.status} text=<${event.text?.length ?? 0} chars>`);
            }
            dispatchToCallbacks(this.callbacks, event, 'TextInput');
        }
    }

    private startNativeTextInputMonitoring(): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createTextInputClient } = require('@ausm/core/clients');

            const client: TextInputClient = createTextInputClient({
                debug: isLogging(this.config, 'textInput'),
            });

            this.textInputClient = client;

            client.on('text-input', (data) => {
                const eventData = data as TextInputEventData;
                const event = createTextInputEvent(eventData);
                this.emit(event);
            });

            client.on('error', (error) => {
                console.error('[AUSM] Text input monitor error:', (error as Error).message);
            });

            if (client.start()) {
                console.log('[AUSM] Native text input monitoring started');
            } else {
                console.warn('[AUSM] Failed to start native text input monitoring');
            }
        } catch (err) {
            console.warn('[AUSM] Native text input monitoring not available:', (err as Error).message);
        }
    }
}


// Type for ScreenshotDetectorService (to avoid direct import of @ausm/device-macos-screenshot-detector)
interface ScreenshotDetectorServiceType {
    start(): boolean;
    stop(): boolean;
    on(event: string, handler: (...args: unknown[]) => void): void;
}

// Type for CursorPlusPlusService (to avoid direct import of @ausm/device-macos-cursor-plus-plus)
interface CursorPlusPlusServiceType {
    start(): boolean;
    stop(): boolean;
    on(event: string, handler: (...args: unknown[]) => void): void;
}

/** CropReader type (to avoid direct import of @ausm/device-macos-cursor-plus-plus at top level). */
interface CropReaderLike {
    start(): Promise<void>;
    stop(): void;
    isReady(): boolean;
    cropAtCursor(
        cursorX: number,
        cursorY: number,
        cropWidth: number,
        cropHeight: number,
        scaleFactor: number,
        jpegQuality: number,
    ): Promise<{ data: Buffer; width: number; height: number }>;
}

class CursorPlusPlusDetectorImpl implements Detector<CursorPlusPlusEvent> {
    private callbacks: EventCallback<CursorPlusPlusEvent>[] = [];
    private running = false;
    private cursorService: CursorPlusPlusServiceType | null = null;
    private cropReader: CropReaderLike | null = null;
    private config: AUSMRuntimeConfig;

    constructor(config: AUSMRuntimeConfig = {}) {
        this.config = config;
    }

    start(): void {
        if (!this.config.cursorPlusPlus?.enabled) return;
        this.running = true;
        console.log('[AUSM] CursorPlusPlus started');
        this.startCropReader();
        this.startCursorService();
    }

    stop(): void {
        this.running = false;
        if (this.cursorService) {
            this.cursorService.stop();
            this.cursorService = null;
        }
        if (this.cropReader) {
            this.cropReader.stop();
            this.cropReader = null;
        }
        console.log('[AUSM] CursorPlusPlus stopped');
    }

    addCallback(callback: EventCallback<CursorPlusPlusEvent>): void {
        this.callbacks.push(callback);
    }

    emit(event: CursorPlusPlusEvent): void {
        if (this.running) {
            dispatchToCallbacks(this.callbacks, event, 'CursorPlusPlus');
        }
    }

    /**
     * Spawn a CropReader (Python subprocess) that reads directly from
     * the screen-stream shared memory via screen_stream_reader.
     * No dependency on @ausm/device-macos-material-manager.
     */
    private startCropReader(): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { CropReader } = require('@ausm/device-macos-cursor-plus-plus');

            const pythonPath = resolvePythonPath();
            const screenStreamReaderPath = resolveScreenStreamReaderPath();

            const reader: CropReaderLike = new CropReader({
                debug: isLogging(this.config, 'cursorPlusPlus'),
                pythonPath,
                screenStreamReaderPath,
                screenStreamSocketPath:
                    this.config.screenStreaming?.socketPath ??
                    '/tmp/ausm-frames.sock',
            });
            reader.start().catch((err: Error) => {
                console.warn('[AUSM] CursorPlusPlus: CropReader failed to start:', err.message);
            });
            this.cropReader = reader;
            console.log('[AUSM] CursorPlusPlus: CropReader started (shared-memory crop via screen_stream_reader)');
        } catch (err) {
            console.warn(
                '[AUSM] CursorPlusPlus: CropReader not available, screenshots disabled:',
                (err as Error).message,
            );
        }
    }

    private startCursorService(): void {
        const cppConfig = this.config.cursorPlusPlus;
        if (!cppConfig) return;

        const cropReader = this.cropReader;

        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createCursorPlusPlus } = require('@ausm/device-macos-cursor-plus-plus');

            const service: CursorPlusPlusServiceType = createCursorPlusPlus({
                cropWidth: cppConfig.cropWidth,
                cropHeight: cppConfig.cropHeight,
                cropJpegQuality: cppConfig.cropJpegQuality,
                moveThrottleMs: cppConfig.moveThrottleMs,
                debug: isLogging(this.config, 'cursorPlusPlus'),
                displayStreamCrop: cropReader ?? undefined,
                defaultScaleFactor: cppConfig.defaultScaleFactor,
            });

            this.cursorService = service;

            service.on('cursor-event', (data) => {
                const eventData = data as CursorPlusPlusEventData;
                const event = createCursorPlusPlusEvent(eventData);
                this.emit(event);
            });

            service.on('error', (error) => {
                console.error('[AUSM] CursorPlusPlus error:', (error as Error).message);
            });

            if (service.start()) {
                console.log('[AUSM] CursorPlusPlus service started');
            } else {
                console.warn('[AUSM] Failed to start CursorPlusPlus service');
            }
        } catch (err) {
            console.warn('[AUSM] CursorPlusPlus not available:', (err as Error).message);
        }
    }
}


// Material event detector (follows the same Detector<T> pattern as other events)
class MaterialDetectorImpl implements Detector<MaterialEvent> {
    private callbacks: EventCallback<MaterialEvent>[] = [];
    private running = false;

    start(): void { this.running = true; }
    stop(): void { this.running = false; }

    addCallback(callback: EventCallback<MaterialEvent>): void {
        this.callbacks.push(callback);
    }

    emit(event: MaterialEvent): void {
        if (!this.running) return;
        dispatchToCallbacks(this.callbacks, event, 'Material');
    }
}


// Material Manager integration — runs the material-manager as a separate
// Node.js process via MaterialClient (stdio JSON-lines IPC).  This keeps
// native addons (better-sqlite3) out of the runtime process.
class MaterialManagerImpl {
    private client: MaterialClient | null = null;
    private config: AUSMRuntimeConfig;
    private running = false;
    private materialCallbacks: EventCallback<unknown>[] = [];
    private materialDetector: MaterialDetectorImpl | null = null;
    private memoryClient: MemoryClient | null = null;
    /** materialId → timestamp (ms) when that material last gained focus. */
    private materialFocusStart = new Map<string, number>();
    /** materialId → recency-decayed importance weight [0, 1]. Refreshed after every focus session. */
    private materialWeightCache = new Map<string, number>();

    constructor(config: AUSMRuntimeConfig = {}, detector?: MaterialDetectorImpl) {
        this.config = config;
        this.materialDetector = detector ?? null;
    }

    setMemoryClient(client: MemoryClient): void {
        this.memoryClient = client;
    }

    /**
     * Return the best available weight for a material.
     * 1. If the cache has a non-zero value, use it.
     * 2. If the material is currently focused, estimate a live weight from
     *    the elapsed focus time so far (using the same decay formula but
     *    with age = 0, i.e. fully fresh).
     * 3. Otherwise null.
     */
    private getLiveWeight(materialId: string): number | null {
        const cached = this.materialWeightCache.get(materialId);
        if (cached != null && cached > 0) return cached;

        const focusStart = this.materialFocusStart.get(materialId);
        if (focusStart != null) {
            const elapsedMs = Date.now() - focusStart;
            if (elapsedMs < 500) return cached ?? null;
            const elapsedHours = elapsedMs / 3_600_000;
            const REFERENCE_HOURS = 1;
            const w = Math.min(1, Math.log(1 + elapsedHours) / Math.log(1 + REFERENCE_HOURS));
            return Math.round(w * 100) / 100 || 0.01;
        }

        return cached ?? null;
    }

    async start(): Promise<void> {
        if (!this.config.materialManager?.enabled) {
            return;
        }

        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createMaterialClient } = require('@ausm/core/clients');

            const mmConfig = this.config.materialManager || {};

            // Resolve screen-stream socket path from either the MM config
            // or the screen-streaming config (same helper process).
            const screenStreamSocketPath =
                mmConfig.screenStreamSocketPath ??
                this.config.screenStreaming?.socketPath ??
                '/tmp/ausm-frames.sock';

            const pythonPath = resolvePythonPath(mmConfig.pythonPath);
            const screenStreamReaderPath = resolveScreenStreamReaderPath(mmConfig.screenStreamReaderPath);
            console.log(`[AUSM] Material manager using Python: ${pythonPath}`);

            this.client = createMaterialClient({
                debug: isLogging(this.config, 'materialManager'),
                hashDistanceThreshold: mmConfig.hashDistanceThreshold,
                captureIntervalMs: mmConfig.captureIntervalMs,
                maxFramesPerMaterial: mmConfig.maxFramesPerMaterial,
                maxFramesPerWindow: mmConfig.maxFramesPerWindow,
                jpegQuality: mmConfig.jpegQuality,
                pythonPath,
                screenStreamReaderPath,
                dbPath: mmConfig.dbPath,
                captureDelayMs: mmConfig.captureDelayMs,
                maxFreshnessRetries: mmConfig.maxFreshnessRetries,
                freshnessRetryBaseMs: mmConfig.freshnessRetryBaseMs,
                hashGrid: mmConfig.hashGrid,
                screenStreamSocketPath,
                servicePath: mmConfig.servicePath,
                nodePath: mmConfig.nodePath,
                materialBlacklist: mmConfig.materialBlacklist,
            }) as MaterialClient;

            // Seed the weight caches from persisted data so weights are
            // available on the very first MaterialEvent, not only after the
            // first unfocus. Awaited so the cache is warm before events flow.
            if (this.memoryClient) {
                try {
                    const [matWeights] = await Promise.all([
                        this.memoryClient.getMaterialWeights(),
                    ]);
                    for (const [id, w] of Object.entries(matWeights)) {
                        this.materialWeightCache.set(id, w);
                    }
                    console.log(`[AUSM] Seeded material weight cache (${Object.keys(matWeights).length} entries)`);
                } catch { /* best-effort — events will still work, just without initial weights */ }
            }

            // Subscribe to typed events from the service process
            const client = this.client;

            client.on('material-frame', (data) => {
                // Forward to legacy untyped callbacks
                dispatchToCallbacks(this.materialCallbacks, data, 'Material');

                // Persist frame to memory
                if (this.memoryClient) {
                    if (data.dataBase64) {
                        try {
                            this.memoryClient.addFrame({
                                frameId: data.frameId,
                                materialId: data.materialId,
                                windowId: data.windowId,
                                timestamp: data.timestamp ?? Date.now(),
                                width: data.width,
                                height: data.height,
                                data: Buffer.from(data.dataBase64, 'base64'),
                                title: data.title ?? null,
                                application: data.application ?? null,
                                bundleId: data.bundleId ?? null,
                                captureReason: data.captureReason ?? 'UNKNOWN',
                            }, (data as unknown as Record<string, unknown>).hash as string ?? '');
                        } catch (err) {
                            console.warn('[AUSM] Failed to persist frame to memory:', (err as Error).message);
                        }
                    }
                }

                // Emit typed MaterialEvent
                if (this.materialDetector) {
                    const frameMaterialId = data.materialId ?? null;
                    this.materialDetector.emit(createMaterialEvent({
                        materialEventType: MaterialEventType.FRAME_CAPTURED,
                        materialId: frameMaterialId,
                        windowId: data.windowId ?? null,
                        title: data.title ?? null,
                        application: data.application ?? null,
                        bundleId: data.bundleId ?? null,
                        frameId: data.frameId ?? null,
                        frameWidth: data.width ?? null,
                        frameHeight: data.height ?? null,
                        frameSizeBytes: data.sizeBytes ?? null,
                        frameDataBase64: data.dataBase64 ?? null,
                        captureReason: data.captureReason ?? null,
                        timestamp: data.timestamp ?? Date.now(),
                        bounds: data.bounds ?? null,
                        displayId: data.displayId ?? null,
                        pid: data.pid ?? null,
                        focusWeight: frameMaterialId ? this.getLiveWeight(frameMaterialId) : null,
                    }));
                }
            });

            client.on('material-created', (data) => {
                if (this.materialDetector) {
                    const materialId = data.materialId as string | null;
                    this.materialDetector.emit(createMaterialEvent({
                        materialEventType: MaterialEventType.MATERIAL_CREATED,
                        materialId,
                        windowId: data.windowId ?? null,
                        title: data.title ?? null,
                        application: data.application ?? null,
                        bundleId: data.bundleId ?? null,
                        documentPath: data.documentPath ?? null,
                        isNew: true,
                        firstSeen: data.firstSeen ?? null,
                        lastSeen: data.lastSeen ?? null,
                        bounds: data.bounds ?? null,
                        displayId: data.displayId ?? null,
                        pid: data.pid ?? null,
                        frameId: data.frameId ?? null,
                        frameDataBase64: data.dataBase64 ?? null,
                        frameSizeBytes: data.sizeBytes ?? null,
                        frameWidth: data.frameWidth ?? null,
                        frameHeight: data.frameHeight ?? null,
                        appMetadata: data.appMetadata ?? null,
                        focusWeight: materialId ? this.getLiveWeight(materialId) : null,
                    }));
                }
            });

            client.on('material-type-classified', (data) => {
                if (this.materialDetector) {
                    const materialId = data.materialId as string | null;
                    this.materialDetector.emit(createMaterialEvent({
                        materialEventType: MaterialEventType.MATERIAL_TYPE_CLASSIFIED,
                        materialId,
                        windowId: data.windowId ?? null,
                        title: data.title ?? null,
                        application: data.application ?? null,
                        bundleId: data.bundleId ?? null,
                        documentPath: data.documentPath ?? null,
                        firstSeen: data.firstSeen ?? null,
                        lastSeen: data.lastSeen ?? null,
                        materialType: data.materialType ?? null,
                        materialTypeConfidence: data.materialTypeConfidence ?? null,
                        appMetadata: data.appMetadata ?? null,
                        bounds: data.bounds ?? null,
                        displayId: data.displayId ?? null,
                        pid: data.pid ?? null,
                        focusWeight: materialId ? this.getLiveWeight(materialId) : null,
                    }));
                }
            });

            client.on('material-focused', (data) => {
                const materialId = data.materialId as string | null;
                if (materialId) {
                    this.materialFocusStart.set(materialId, Date.now());
                }

                if (this.materialDetector) {
                    const focusedMaterialId = data.materialId as string | null;
                    this.materialDetector.emit(createMaterialEvent({
                        materialEventType: MaterialEventType.MATERIAL_FOCUSED,
                        materialId: focusedMaterialId,
                        windowId: data.windowId ?? null,
                        title: data.title ?? null,
                        application: data.application ?? null,
                        bundleId: data.bundleId ?? null,
                        documentPath: data.documentPath ?? null,
                        firstSeen: data.firstSeen ?? null,
                        lastSeen: data.lastSeen ?? null,
                        appMetadata: data.appMetadata ?? null,
                        bounds: data.bounds ?? null,
                        displayId: data.displayId ?? null,
                        pid: data.pid ?? null,
                        frameId: data.frameId ?? null,
                        frameDataBase64: data.dataBase64 ?? null,
                        frameSizeBytes: data.sizeBytes ?? null,
                        frameWidth: data.frameWidth ?? null,
                        frameHeight: data.frameHeight ?? null,
                        focusWeight: focusedMaterialId ? this.getLiveWeight(focusedMaterialId) : null,
                    }));
                }
            });

            client.on('material-unfocused', (data) => {
                const materialId = data.materialId as string | null;

                // Incremental OCR pass over the frames captured during this
                // focus session (fire-and-forget; runs in the memory service).
                // Delayed slightly so the final UNFOCUSED frame (captured
                // asynchronously after this event) is included in the pass.
                if (materialId && this.memoryClient && this.config.memory?.ocrEnabled &&
                    typeof this.memoryClient.processMaterialOcr === 'function') {
                    const memoryClient = this.memoryClient;
                    setTimeout(() => {
                    memoryClient.processMaterialOcr(materialId).then((res) => {
                        if (!res.ok || res.addedLines <= 0 || !this.materialDetector) return;
                        this.materialDetector.emit(createMaterialEvent({
                            materialEventType: MaterialEventType.MATERIAL_CONTENT_UPDATED,
                            materialId,
                            windowId: data.windowId ?? null,
                            title: data.title ?? null,
                            application: data.application ?? null,
                            bundleId: data.bundleId ?? null,
                            documentPath: data.documentPath ?? null,
                            appMetadata: data.appMetadata ?? null,
                            contentLength: res.textLength,
                            contentLineCount: res.lineCount,
                            contentPreview: res.preview,
                            contentAddedLines: res.addedLines,
                            focusWeight: this.getLiveWeight(materialId),
                        }));
                    }).catch((err: Error) => {
                        console.warn('[AUSM] Material OCR failed:', err.message);
                    });
                    }, 1500);
                }

                if (materialId && this.memoryClient) {
                    const startedAt = this.materialFocusStart.get(materialId);
                    this.materialFocusStart.delete(materialId);

                    if (startedAt != null) {
                        const endedAt = Date.now();
                        const durationMs = endedAt - startedAt;

                        // Discard accidental focus flickers (< 500 ms)
                        if (durationMs >= 500) {
                            const { randomUUID } = require('crypto') as typeof import('crypto');
                            this.memoryClient.recordFocusSession({
                                sessionId:  randomUUID(),
                                materialId,
                                startedAt,
                                endedAt,
                                durationMs,
                            });
                            // Refresh weight caches asynchronously after the session is written
                            this.memoryClient.getMaterialWeights().then((weights) => {
                                for (const [id, w] of Object.entries(weights)) {
                                    this.materialWeightCache.set(id, w);
                                }
                            }).catch(() => { /* ignore */ });
                        }
                    }
                }

                if (this.materialDetector) {
                    const unfocusedMaterialId = data.materialId as string | null;
                    this.materialDetector.emit(createMaterialEvent({
                        materialEventType: MaterialEventType.MATERIAL_UNFOCUSED,
                        materialId: unfocusedMaterialId,
                        windowId: data.windowId ?? null,
                        title: data.title ?? null,
                        application: data.application ?? null,
                        bundleId: data.bundleId ?? null,
                        documentPath: data.documentPath ?? null,
                        firstSeen: data.firstSeen ?? null,
                        lastSeen: data.lastSeen ?? null,
                        appMetadata: data.appMetadata ?? null,
                        bounds: data.bounds ?? null,
                        displayId: data.displayId ?? null,
                        pid: data.pid ?? null,
                        frameId: data.frameId ?? null,
                        frameDataBase64: data.dataBase64 ?? null,
                        frameSizeBytes: data.sizeBytes ?? null,
                        frameWidth: data.frameWidth ?? null,
                        frameHeight: data.frameHeight ?? null,
                        focusWeight: unfocusedMaterialId ? this.getLiveWeight(unfocusedMaterialId) : null,
                    }));
                }
            });

            client.on('material-save', (data) => {
                if (this.memoryClient) {
                    try {
                        this.memoryClient.saveMaterial({
                            materialId: data.materialId,
                            title: data.title,
                            windowId: data.windowId,
                            application: data.application ?? null,
                            bundleId: data.bundleId ?? null,
                            documentPath: data.documentPath ?? null,
                            lastFrameHash: data.lastFrameHash ?? null,
                            firstSeen: data.firstSeen,
                            lastSeen: data.lastSeen,
                            materialType: data.materialType ?? null,
                            materialTypeConfidence: data.materialTypeConfidence ?? null,
                            appMetadata: data.appMetadata ?? null,
                        });
                    } catch (err) {
                        console.warn('[AUSM] Failed to persist material to memory:', (err as Error).message);
                    }
                }
            });

            client.on('material-type-update', (data) => {
                if (this.memoryClient) {
                    try {
                        this.memoryClient.updateMaterialType(
                            data.materialId,
                            data.materialType,
                            data.materialTypeConfidence,
                        );
                    } catch (err) {
                        console.warn('[AUSM] Failed to update material type in memory:', (err as Error).message);
                    }
                }
            });

            client.on('error', (error: unknown) => {
                if (isLogging(this.config, 'materialManager')) {
                    console.error('[AUSM] Material manager error:', (error as Error).message);
                }
            });

            await client.start();
            this.running = true;
            console.log('[AUSM] Material manager service started');
        } catch (err) {
            console.warn('[AUSM] Material manager not available:', (err as Error).message);
            this.client = null;
        }
    }

    async stop(): Promise<void> {
        if (this.client) {
            await this.client.stop();
            this.client = null;
        }
        this.memoryClient = null;
        this.running = false;
    }

    isRunning(): boolean {
        return this.running;
    }

    /**
     * Get all materials from memory (metadata only).
     * Returns empty array if material manager or memory is not running.
     */
    async getMaterials(limit = 100): Promise<unknown[]> {
        if (!this.memoryClient?.getAllMaterials) return [];
        try {
            return await this.memoryClient.getAllMaterials(limit);
        } catch {
            return [];
        }
    }

    /**
     * Get the latest frame (thumbnail) for a material.
     */
    async getMaterialLatestFrame(materialId: string): Promise<unknown> {
        if (!this.memoryClient?.getMaterialLatestFrame) return null;
        try {
            return await this.memoryClient.getMaterialLatestFrame(materialId);
        } catch {
            return null;
        }
    }

    /**
     * Get multiple frames (history) for a material.
     */
    async getMaterialFrames(materialId: string, limit = 20): Promise<unknown[]> {
        if (!this.memoryClient?.getMaterialFrames) return [];
        try {
            return await this.memoryClient.getMaterialFrames(materialId, limit);
        } catch {
            return [];
        }
    }

    /**
     * Get the accumulated OCR text content for a material.
     * Returns null if OCR is disabled or the material has never been OCRed.
     */
    async getMaterialContent(materialId: string): Promise<{
        materialId: string;
        text: string;
        lineCount: number;
        frameCount: number;
        lastFrameTs: number;
        updatedAt: number;
    } | null> {
        if (!this.memoryClient?.getMaterialOcr) return null;
        try {
            return await this.memoryClient.getMaterialOcr(materialId);
        } catch {
            return null;
        }
    }

    /** Forward a WindowStateEvent to the material manager service. */
    handleWindowEvent(event: WindowStateEvent): void {
        if (!this.running || !this.client) return;
        this.client.sendWindowEvent(event as unknown as Record<string, unknown>);
    }

    addCallback(callback: EventCallback<unknown>): void {
        this.materialCallbacks.push(callback);
    }
}

// ============================================================================
// AUSM Runtime
// ============================================================================

export class AUSMRuntime {
    private textSelectionDetector: TextSelectionDetectorImpl;
    private screenshotDetector: ScreenshotDetectorImpl;
    private clipboardMonitorDetector: ClipboardMonitorImpl;
    private applicationStateDetector: ApplicationStateDetectorImpl;
    private textInputDetector: TextInputDetectorImpl;
    private materialDetector: MaterialDetectorImpl;
    private cursorPlusPlusDetector: CursorPlusPlusDetectorImpl;
    private screenStreamingManager: ScreenStreamingManagerImpl;
    private cameraStreamingManager: CameraStreamingManagerImpl;
    private materialManagerImpl: MaterialManagerImpl;
    private memoryClient: MemoryClient | null = null;
    private httpHost: HttpHost | null = null;
    private detectorManager: DetectorManager;
    private detectorPipelineClient: DetectorPipelineClient | null = null;
    private detectorPipelineWarmupTimer: ReturnType<typeof setTimeout> | null = null;
    private detectorCallbacks: EventCallback<DetectorEvent>[] = [];
    private taskCallbacks: EventCallback<TaskEvent>[] = [];
    private frequencyMonitor: EventFrequencyMonitor | null = null;
    private config: AUSMRuntimeConfig;
    /** In-flight or completed initialize(); concurrent/repeat calls share it. */
    private initPromise: Promise<void> | null = null;
    /** Bumped by shutdown() so an initialize() still in progress stops starting things. */
    private lifecycleGeneration = 0;

    constructor(config: AUSMRuntimeConfig = {}) {
        this.config = config;

        const freq = config.logging?.eventFrequency;
        if (freq) {
            const intervalMs = typeof freq === 'number' ? freq : 5000;
            this.frequencyMonitor = new EventFrequencyMonitor(intervalMs);
        }
        this.textSelectionDetector = new TextSelectionDetectorImpl(config);
        this.screenshotDetector = new ScreenshotDetectorImpl(config);
        this.clipboardMonitorDetector = new ClipboardMonitorImpl(config);
        this.applicationStateDetector = new ApplicationStateDetectorImpl(config);
        this.textInputDetector = new TextInputDetectorImpl(config);
        this.materialDetector = new MaterialDetectorImpl();
        this.cursorPlusPlusDetector = new CursorPlusPlusDetectorImpl(config);
        this.screenStreamingManager = new ScreenStreamingManagerImpl(config);
        this.cameraStreamingManager = new CameraStreamingManagerImpl(config);
        this.materialManagerImpl = new MaterialManagerImpl(config, this.materialDetector);
        this.detectorManager = new DetectorManager(config.detectors);

        if (this.frequencyMonitor) {
            const fm = this.frequencyMonitor;
            this.textSelectionDetector.addCallback(() => fm.record('textSelection'));
            this.screenshotDetector.addCallback(() => fm.record('screenshot'));
            this.clipboardMonitorDetector.addCallback(() => fm.record('copyPaste'));
            this.applicationStateDetector.addCallback(() => fm.record('windowState'));
            this.applicationStateDetector.addSpaceChangeCallback(() => fm.record('spaceChange'));
            this.textInputDetector.addCallback(() => fm.record('textInput'));
            this.materialDetector.addCallback(() => fm.record('material'));
            this.cursorPlusPlusDetector.addCallback(() => fm.record('cursorPlusPlus'));
        }
    }

    /** Initialize and start all event sources. Repeat or concurrent calls share one run. */
    initialize(): Promise<void> {
        if (!this.initPromise) {
            const run = this.doInitialize();
            this.initPromise = run;
            run.catch(() => {
                if (this.initPromise === run) this.initPromise = null;
            });
        }
        return this.initPromise;
    }

    private async doInitialize(): Promise<void> {
        const generation = this.lifecycleGeneration;
        const shutDownMeanwhile = (): boolean => {
            if (generation === this.lifecycleGeneration) return false;
            console.warn('[AUSM] Shutdown requested during initialize — remaining startup skipped');
            return true;
        };
        const startTime = Date.now();
        const checkpoint = (name: string) => {
            const elapsed = Date.now() - startTime;
            console.log(`[AUSM] ${name} (+${elapsed}ms)`);
        };
        
        guardBrokenStdio();
        console.log('[AUSM] Initializing Runtime...');
        this.frequencyMonitor?.start();
        
        // Step 1: Start screen streaming
        let screenUp = false;
        try {
            screenUp = await this.screenStreamingManager.start();
        } catch (err) {
            console.warn('[AUSM] Screen streaming failed to start:', (err as Error).message);
        }
        if (shutDownMeanwhile()) {
            this.screenStreamingManager.stop().catch(() => {});
            return;
        }
        checkpoint(screenUp ? 'Screen streaming started' : 'Screen streaming unavailable');

        // Step 1b: Start camera streaming (optional, default off)
        let cameraUp = false;
        try {
            cameraUp = await this.cameraStreamingManager.start();
        } catch (err) {
            console.warn('[AUSM] Camera streaming failed to start:', (err as Error).message);
        }
        if (shutDownMeanwhile()) {
            this.cameraStreamingManager.stop().catch(() => {});
            return;
        }
        checkpoint(cameraUp ? 'Camera streaming started' : 'Camera streaming off');

        // Step 2: Start event sources
        await this.textSelectionDetector.start();
        checkpoint('Selection detector started');
        
        // These are synchronous/fast, run together
        this.screenshotDetector.start();
        this.clipboardMonitorDetector.start();
        this.applicationStateDetector.start();
        this.textInputDetector.start();
        checkpoint('Other detectors started');

        // Step 5: Start memory service (separate process — keeps better-sqlite3 out of Electron)
        try {
            const mmConfig = this.config.materialManager || {};
            const memConfig = this.config.memory || {};
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createMemoryClient } = require('@ausm/core/clients');

            const ocrPythonPath = resolvePythonPath(memConfig.ocrPythonPath ?? mmConfig.pythonPath);
            if (memConfig.ocrEnabled) {
                console.log(`[AUSM] Memory OCR using Python: ${ocrPythonPath}`);
            }

            const mc = createMemoryClient({
                dbPath: mmConfig.dbPath ?? ':memory:',
                maxFramesPerMaterial:
                    mmConfig.maxFramesPerMaterial ?? mmConfig.maxFramesPerWindow ?? 200,
                nodePath: mmConfig.nodePath,
                ocrEnabled: memConfig.ocrEnabled ?? false,
                pythonPath: ocrPythonPath,
                ocrMaxFramesPerRun: memConfig.ocrMaxFramesPerRun,
                frozen: memConfig.frozen ?? false,
            }) as MemoryClient;
            await mc.start();
            if (shutDownMeanwhile()) {
                mc.stop().catch(() => {});
                return;
            }
            this.memoryClient = mc;
            this.materialManagerImpl.setMemoryClient(mc);

            // Wire screenshot persistence: save to memory on every FINISHED screenshot
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fsForScreenshot = require('fs') as typeof import('fs');
            this.screenshotDetector.addCallback((event: ScreenshotEvent) => {
                if (!this.memoryClient) return;
                if (event.status !== 'SCREENSHOT_FINISHED') {
                    console.log(`[AUSM] Screenshot event (non-FINISHED): status=${event.status} — skipping memory save`);
                    return;
                }

                let dataBase64: string | null = null;
                let width: number | null = null;
                let height: number | null = null;
                let mimeType = 'image/jpeg';

                if (event.imageData?.dataBase64) {
                    dataBase64 = event.imageData.dataBase64;
                    width = event.imageData.width;
                    height = event.imageData.height;
                    mimeType = event.imageData.mimeType ?? 'image/jpeg';
                    console.log(`[AUSM] Screenshot memory: using inline imageData (${width}x${height})`);
                } else if (event.imagePath) {
                    try {
                        if (fsForScreenshot.existsSync(event.imagePath)) {
                            dataBase64 = fsForScreenshot.readFileSync(event.imagePath).toString('base64');
                            width = event.imageWidth ?? 0;
                            height = event.imageHeight ?? 0;
                            console.log(`[AUSM] Screenshot memory: read from imagePath (${width}x${height}, ${Math.round(dataBase64.length / 1024)}KB base64)`);
                        } else {
                            console.warn(`[AUSM] Screenshot memory: imagePath not found: ${event.imagePath}`);
                        }
                    } catch (err) {
                        console.warn(`[AUSM] Screenshot memory: failed to read imagePath: ${(err as Error).message}`);
                    }
                } else {
                    console.warn('[AUSM] Screenshot memory: no imageData or imagePath available');
                    return;
                }

                if (!dataBase64 || !width || !height) {
                    console.warn('[AUSM] Screenshot memory: missing data/dimensions — skipping');
                    return;
                }

                const screenshotId = (event.eventID ?? `screenshot-${event.timestamp ?? Date.now()}`).replace(/[^a-zA-Z0-9-_]/g, '_');
                try {
                    this.memoryClient.saveScreenshot({
                        screenshotId,
                        dataBase64,
                        width,
                        height,
                        mimeType,
                        timestamp: event.timestamp ?? Date.now(),
                        bounds: event.bounds,
                        screenshotType: event.type ?? null,
                    });
                    console.log(`[AUSM] Screenshot saved to memory: id=${screenshotId} (${width}x${height})`);
                } catch (err) {
                    console.warn('[AUSM] Failed to persist screenshot to memory:', (err as Error).message);
                }
            });

            console.log('[AUSM] Memory service started');

            // Apply frozen config if set
            if (this.config.memory?.frozen && this.memoryClient?.freezeMemory) {
                await this.memoryClient.freezeMemory();
                console.log('[AUSM] Memory started in frozen mode — writes disabled');
            }
        } catch (err) {
            console.warn('[AUSM] Memory service not available:', (err as Error).message);
        }
        checkpoint('Memory service started');

        if (this.config.http?.enabled || this.config.materialChat?.enabled) {
            this.httpHost = new HttpHost({
                enabled: true,
                port: this.config.http?.port ?? 8788,
                dbPath: this.config.materialManager?.dbPath,
                nodePath: this.config.materialManager?.nodePath,
                materialChat: this.config.materialChat,
            });
            try {
                const host = this.httpHost;
                await host.start();
                if (shutDownMeanwhile()) {
                    host.stop().catch(() => {});
                    if (this.httpHost === host) this.httpHost = null;
                    return;
                }
            } catch (err) {
                this.httpHost = null;
                const message = `[AUSM] HTTP host failed to start: ${(err as Error).message}`;
                if (this.config.materialChat?.enabled) {
                    throw new Error(message);
                }
                console.warn(message);
            }
        }
        checkpoint('HTTP host started');

        // Step 6: Start material manager + material detector
        // (needs screen streaming + viewport events + memory)
        try {
            this.materialDetector.start();
            await this.materialManagerImpl.start();
            if (shutDownMeanwhile()) {
                this.materialManagerImpl.stop().catch(() => {});
                this.materialDetector.stop();
                return;
            }

            // Wire window state events into the material manager
            if (this.materialManagerImpl.isRunning()) {
                this.applicationStateDetector.addCallback((event: WindowStateEvent) => {
                    this.materialManagerImpl.handleWindowEvent(event);
                });
            }
        } catch (err) {
            console.warn('[AUSM] Material manager failed to start:', (err as Error).message);
        }
        checkpoint('Material manager started');

        // Step 7: Start cursor++ detector (uses display-stream shared memory for crops)
        this.cursorPlusPlusDetector.start();
        checkpoint('CursorPlusPlus detector started');

        if (this.config.detectors?.enabled !== false) {
            try {
                await this.detectorManager.load();
                const loaded = this.detectorManager.getAllDetectors();
                console.log(`[AUSM] Loaded ${loaded.length} detector(s): ${loaded.map((d) => d.name).join(', ') || '(none)'}`);
            } catch (err) {
                console.warn('[AUSM] Failed to load detectors:', (err as Error).message);
            }
        }
        checkpoint('Detectors loaded');
        if (shutDownMeanwhile()) return;

        await this.startDetectorPipeline();
        checkpoint('Detector pipeline started');

        const totalTime = Date.now() - startTime;
        console.log(`[AUSM] Runtime started (total: ${totalTime}ms)`);
    }

    private async startDetectorPipeline(): Promise<void> {
        const dpConfig = this.config.detectorPipeline ?? {};
        // Empty or whitespace-only values (config or env) count as unset.
        const pick = (value: string | undefined): string | undefined => value?.trim() || undefined;
        const env = (name: string): string | undefined => pick(process.env[name]);
        const projectId =
            pick(dpConfig.projectId)
            ?? env('TASK_DETECTOR_PROJECT_ID')
            ?? env('AUSM_DETECTOR_PROJECT_ID')
            ?? '';
        const apiKey = pick(dpConfig.apiKey) ?? env('CEREBRAS_API_KEY') ?? '';
        const rawProvider = pick(dpConfig.provider) ?? env('TASK_DETECTOR_PROVIDER');
        const requestedProvider = (rawProvider ?? '').toLowerCase();
        if (rawProvider && requestedProvider !== 'cerebras' && requestedProvider !== 'vertex') {
            console.warn(`[AUSM] Unknown detector pipeline provider "${rawProvider}" (expected "vertex" or "cerebras") — inferring from credentials`);
        }
        const provider: 'vertex' | 'cerebras' =
            requestedProvider === 'cerebras' || requestedProvider === 'vertex'
                ? requestedProvider
                : (apiKey && !projectId ? 'cerebras' : 'vertex');
        const enabled = dpConfig.enabled ?? (provider === 'cerebras' ? Boolean(apiKey) : Boolean(projectId));
        if (!enabled) return;
        if (provider === 'cerebras' && !apiKey) {
            console.warn('[AUSM] Detector pipeline provider=cerebras but no CEREBRAS_API_KEY');
            return;
        }
        if (provider === 'vertex' && !projectId) {
            console.warn('[AUSM] Detector pipeline enabled but no projectId (set TASK_DETECTOR_PROJECT_ID)');
            return;
        }

        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createDetectorPipelineClient } = require('@ausm/core/clients');
            const model = pick(dpConfig.model) ?? env('TASK_DETECTOR_MODEL');
            console.log(`[AUSM] Detector pipeline: ${provider} / ${model || (provider === 'cerebras' ? 'gemma-4-31b' : 'gemini-2.0-flash')}`);
            const dpClient: DetectorPipelineClient = createDetectorPipelineClient({
                provider,
                projectId,
                apiKey,
                apiBaseUrl: pick(dpConfig.apiBaseUrl) ?? env('CEREBRAS_BASE_URL'),
                location: pick(dpConfig.location) ?? env('TASK_DETECTOR_LOCATION'),
                model,
                debug: isLogging(this.config, 'detectorPipeline'),
            });

            this.detectorPipelineClient = dpClient;
            const dpLog = isLogging(this.config, 'detectorPipeline');
            const taskTracker = new TaskTracker();
            dpClient.setEvaluationContext(taskTracker.formatContext());

            // Viewport emits APPEAR for every already-open window on startup.
            // Those census events would fill the detector buffer. Ignore them.
            const DETECTOR_STARTUP_IGNORE_MS = 2500;
            const ignoreUntil = Date.now() + DETECTOR_STARTUP_IGNORE_MS;
            const isStartupBurst = (): boolean => Date.now() < ignoreUntil;

            dpClient.on('error', (err: Error) => {
                console.warn('[AUSM] Detector pipeline error:', err.message);
            });

            dpClient.on('detector-triggered', (result: DetectorPipelineClientResult) => {
                this.frequencyMonitor?.record('detector');
                const detectorEvent = createDetectorEvent({
                    detectorName: result.detectorName,
                    eventType: result.eventType,
                    confidence: result.confidence,
                    summary: result.summary,
                    evidence: result.evidence,
                    timestamp: result.timestamp,
                    application: result.application,
                    bundleId: result.bundleId,
                    windowTitle: result.windowTitle,
                    suggestedDetectors: result.suggestedDetectors,
                    modelLatencyMs: result.modelLatencyMs ?? null,
                });
                dispatchToCallbacks(this.detectorCallbacks, detectorEvent, 'Detector');

                if (result.eventType === 'task' || result.detectorName === 'rapid-task') {
                    const observation = observationFromDetectorResult(result);
                    const taskEvents = taskTracker.apply(observation);
                    dpClient.setEvaluationContext(taskTracker.formatContext());
                    if (taskEvents.length === 0 && dpLog) {
                        console.log(
                            `[AUSM] TaskTracker: no event (${observation.action ?? 'none'} "${observation.label}")`,
                        );
                    }
                    for (const taskEvent of taskEvents) {
                        this.frequencyMonitor?.record('task');
                        dispatchToCallbacks(this.taskCallbacks, taskEvent, 'Task');
                        if (dpLog) {
                            console.log(
                                `[AUSM] TaskEvent: ${taskEvent.status} "${taskEvent.taskLabel}"` +
                                ` (${taskEvent.application ?? 'unknown'})` +
                                (result.modelLatencyMs != null ? ` model=${result.modelLatencyMs}ms send→response` : ''),
                            );
                        }
                    }
                }
            });

            for (const detector of this.detectorManager.getAllDetectors()) {
                dpClient.addDetector({
                    name: detector.name,
                    description: detector.description,
                    event: detector.event,
                    body: detector.body,
                    cooldownMs: detector.cooldownMs,
                    intervalMs: detector.intervalMs,
                    debounceMs: detector.debounceMs,
                    trigger: detector.trigger,
                    sources: detector.sources,
                    events: detector.events,
                    isolated: detector.isolated,
                    dispatchOnly: detector.dispatchOnly || !detector.enabled,
                });
            }

            const dpLatestFrames = new Map<string, string>();
            let dpFocusedMaterialId: string | null = null;

            const fetchFrameForPipeline = async (materialId: string) => {
                try {
                    const frame = await this.getMaterialLatestFrame(materialId) as { dataBase64?: string } | null;
                    if (frame?.dataBase64) {
                        dpLatestFrames.set(materialId, frame.dataBase64);
                        dpClient.onScreenFrameAvailable(frame.dataBase64);
                    }
                } catch {
                    /* best-effort */
                }
            };

            const offerMaterialFrame = (materialId: string, frameDataBase64?: string | null) => {
                if (frameDataBase64) {
                    dpLatestFrames.set(materialId, frameDataBase64);
                    dpClient.onScreenFrameAvailable(frameDataBase64);
                    return;
                }
                const cachedFrame = dpLatestFrames.get(materialId);
                if (cachedFrame) {
                    dpClient.onScreenFrameAvailable(cachedFrame);
                } else {
                    void fetchFrameForPipeline(materialId);
                }
            };

            this.materialDetector.addCallback((e: MaterialEvent) => {
                if (isStartupBurst()) return;

                if (
                    (e.materialEventType === MaterialEventType.MATERIAL_CREATED
                        || e.materialEventType === MaterialEventType.MATERIAL_FOCUSED)
                    && e.materialId
                ) {
                    if (e.materialEventType === MaterialEventType.MATERIAL_FOCUSED) {
                        dpFocusedMaterialId = e.materialId;
                    }
                    return;
                }

                if (e.materialEventType === MaterialEventType.MATERIAL_UNFOCUSED && e.materialId) {
                    if (e.materialId === dpFocusedMaterialId) {
                        dpFocusedMaterialId = null;
                    }
                    return;
                }

                if (e.materialEventType !== MaterialEventType.FRAME_CAPTURED || !e.materialId) {
                    return;
                }

                if (e.frameDataBase64) {
                    dpLatestFrames.set(e.materialId, e.frameDataBase64);
                }

                if (e.materialId !== dpFocusedMaterialId) {
                    return;
                }

                offerMaterialFrame(e.materialId, e.frameDataBase64);
                dpClient.pushMaterialEvent({
                    type: e.materialEventType,
                    materialId: e.materialId,
                    title: e.title,
                    application: e.application,
                    appMetadata: e.appMetadata ?? null,
                    focusWeight: e.focusWeight ?? null,
                });
            });

            this.textInputDetector.addCallback((e: TextInputEvent) => {
                if (isStartupBurst()) return;
                if (e.status) {
                    dpClient.pushTextInputEvent({
                        status: e.status,
                        text: e.text,
                        application: e.sourceElement?.application ?? null,
                    });
                }
            });

            this.applicationStateDetector.addCallback((e: WindowStateEvent) => {
                if (isStartupBurst()) return;
                if (e.state) {
                    dpClient.pushWindowStateEvent({
                        state: e.state,
                        application: e.application,
                        title: e.title,
                        bundleId: e.bundleId,
                        windowId: e.windowId,
                    });
                }
            });

            this.textSelectionDetector.addCallback((e: TextSelectionEvent) => {
                if (isStartupBurst()) return;
                if (!e.selectedText) return;
                dpClient.pushTextSelectionEvent({
                    selectedText: e.selectedText,
                    application: e.sourceElement?.application ?? null,
                    selectionStage: e.selectionStage ?? null,
                    selectionMethod: e.selectionMethod ?? null,
                    elementType: e.sourceElement?.type ?? null,
                });
            });

            this.clipboardMonitorDetector.addCallback((e: CopyPasteEvent) => {
                if (isStartupBurst()) return;
                if (e.action) {
                    dpClient.pushCopyPasteEvent({
                        action: e.action,
                        text: e.content,
                    });
                }
            });

            this.screenshotDetector.addCallback((e: ScreenshotEvent) => {
                if (isStartupBurst()) return;
                if (e.status) {
                    dpClient.pushScreenshotEvent({
                        status: e.status,
                        type: e.type,
                    });
                }
            });

            const DP_CURSOR_ACTIONS = new Set(['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'SCROLL', 'HOLD_START', 'HOLD_END']);
            this.cursorPlusPlusDetector.addCallback((e: CursorPlusPlusEvent) => {
                if (isStartupBurst()) return;
                const action = e.action ?? '';
                if (!DP_CURSOR_ACTIONS.has(action)) return;
                dpClient.pushCursorEvent({
                    action,
                    x: e.x,
                    y: e.y,
                    application: e.application,
                    uiElementRole: e.uiElementRole,
                    uiElementLabel: e.uiElementLabel,
                });
            });

            if (!dpClient.start()) {
                // The service already reported why (missing/invalid credentials) via 'error'.
                console.warn('[AUSM] Detector pipeline failed to start — detector and task events are disabled');
                dpClient.cleanup();
                this.detectorPipelineClient = null;
                return;
            }

            console.log(
                `[AUSM] Detector pipeline started (rapid-task) — ignoring startup window census for ${DETECTOR_STARTUP_IGNORE_MS}ms`,
            );
            this.detectorPipelineWarmupTimer = setTimeout(() => {
                this.detectorPipelineWarmupTimer = null;
                if (dpLog) {
                    console.log('[AUSM] Detector pipeline accepting activity events');
                }
            }, DETECTOR_STARTUP_IGNORE_MS);
        } catch (err) {
            console.warn('[AUSM] Detector pipeline failed to start:', (err as Error).message);
        }
    }

    /** Wait for a service to be ready with polling */
    private async waitForServiceReady(
        checkFn: () => Promise<boolean>,
        maxWait: number,
        pollInterval: number
    ): Promise<number> {
        const startTime = Date.now();
        while (Date.now() - startTime < maxWait) {
            try {
                if (await checkFn()) {
                    return Date.now() - startTime;
                }
            } catch {
                // Ignore errors during polling
            }
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
        return Date.now() - startTime;
    }


    /** Stop all event sources */
    shutdown(): void {
        console.log('[AUSM] Shutting down...');
        this.lifecycleGeneration++;
        this.initPromise = null;
        this.frequencyMonitor?.stop();
        // Material manager stop is async (process shutdown) — fire-and-forget.
        this.materialManagerImpl.stop().catch(() => {});
        this.materialDetector.stop();
        this.textSelectionDetector.stop();
        this.screenshotDetector.stop();
        this.clipboardMonitorDetector.stop();
        this.applicationStateDetector.stop();
        this.textInputDetector.stop();
        this.cursorPlusPlusDetector.stop();
        if (this.detectorPipelineWarmupTimer) {
            clearTimeout(this.detectorPipelineWarmupTimer);
            this.detectorPipelineWarmupTimer = null;
        }
        if (this.detectorPipelineClient) {
            this.detectorPipelineClient.cleanup();
            this.detectorPipelineClient = null;
        }
        // Memory client stop is async — fire-and-forget during shutdown.
        if (this.memoryClient) {
            this.memoryClient.stop().catch(() => {});
            this.memoryClient = null;
        }
        if (this.httpHost) {
            this.httpHost.stop().catch(() => {});
            this.httpHost = null;
        }
        // Screen streaming stop is async but we fire-and-forget during shutdown.
        // The helper will also auto-exit when this process dies (stdin EOF detection).
        this.screenStreamingManager.stop().catch(() => {});
        this.cameraStreamingManager.stop().catch(() => {});
    }

    // ========================================================================
    // Selection CV Service API
    // ========================================================================

    // ========================================================================
    // Screen Streaming API
    // ========================================================================

    /** URL of the Material Chat HTTP host, or null if not running. */
    getHttpUrl(): string | null {
        return this.httpHost?.getUrl() ?? null;
    }

    /** Check if screen streaming is currently running */
    isScreenStreaming(): boolean {
        return this.screenStreamingManager.isRunning();
    }

    /** Get screen streaming service (for advanced usage) */
    getScreenStreamingService(): ScreenStreamingServiceType | null {
        return this.screenStreamingManager.getService();
    }

    /**
     * Get the list of displays known to the screen-stream service, including
     * each display's logical-point origin/size so callers can render their
     * physical layout (e.g. a multi-monitor setup).
     *
     * Returns [] if screen streaming is disabled or not yet started.
     */
    async getScreenDisplays(): Promise<ScreenDisplayInfo[]> {
        const service = this.screenStreamingManager.getService();
        if (!service) return [];
        try {
            return await service.getDisplays();
        } catch {
            return [];
        }
    }

    /**
     * Capture the most recent BGRA frame for a given display from the live
     * capture stream and return it as a JPEG.
     *
     * Returns null if screen streaming isn't running, the display has no
     * frame yet, or any other transient failure.  Callers can poll this at
     * the desired frame rate (e.g. 10 Hz to match the default capture FPS).
     */
    async captureLatestScreenFrame(
        displayId: string,
        jpegQuality: number = 0.7,
    ): Promise<LatestScreenFrame | null> {
        const service = this.screenStreamingManager.getService();
        if (!service || typeof service.captureLatestFrame !== 'function') {
            return null;
        }
        try {
            return (await service.captureLatestFrame(displayId, jpegQuality)) ?? null;
        } catch {
            return null;
        }
    }

    // ========================================================================
    // Camera Streaming API
    // ========================================================================

    /** Check if camera streaming is currently running */
    isCameraStreaming(): boolean {
        return this.cameraStreamingManager.isRunning();
    }

    /** Get camera streaming service (for advanced usage) */
    getCameraStreamingService(): CameraStreamingServiceType | null {
        return this.cameraStreamingManager.getService();
    }

    /**
     * Get the list of cameras known to the camera-stream service.
     * Returns [] if camera streaming is disabled or not yet started.
     */
    async getCameraDevices(): Promise<CameraDeviceInfo[]> {
        const service = this.cameraStreamingManager.getService();
        if (!service) return [];
        try {
            return await service.getDevices();
        } catch {
            return [];
        }
    }

    /**
     * Capture the most recent BGRA frame for a given camera from the live
     * capture stream and return it as a JPEG.
     *
     * Returns null if camera streaming isn't running, the device has no
     * frame yet, or any other transient failure.
     */
    async captureLatestCameraFrame(
        deviceId: string,
        jpegQuality: number = 0.7,
    ): Promise<LatestCameraFrame | null> {
        const service = this.cameraStreamingManager.getService();
        if (!service || typeof service.captureLatestFrame !== 'function') {
            return null;
        }
        try {
            return (await service.captureLatestFrame(deviceId, jpegQuality)) ?? null;
        } catch {
            return null;
        }
    }

    // ========================================================================
    // Material Manager API
    // ========================================================================

    /** Check if material manager is currently running */
    isMaterialManagerRunning(): boolean {
        return this.materialManagerImpl.isRunning();
    }

    /**
     * Get all materials from memory (metadata only).
     * Returns empty array if material manager is not running.
     */
    async getMaterials(limit = 100): Promise<unknown[]> {
        return this.materialManagerImpl.getMaterials(limit);
    }

    /**
     * Get the latest frame (thumbnail) for a material.
     */
    async getMaterialLatestFrame(materialId: string): Promise<unknown> {
        return this.materialManagerImpl.getMaterialLatestFrame(materialId);
    }

    /**
     * Get multiple frames (history) for a material.
     */
    async getMaterialFrames(materialId: string, limit = 20): Promise<unknown[]> {
        return this.materialManagerImpl.getMaterialFrames(materialId, limit);
    }

    /**
     * Get the accumulated OCR text content for a material (memory.ocrEnabled).
     * Returns null if OCR is disabled or no text has been extracted yet.
     */
    async getMaterialContent(materialId: string): Promise<{
        materialId: string;
        text: string;
        lineCount: number;
        frameCount: number;
        lastFrameTs: number;
        updatedAt: number;
    } | null> {
        return this.materialManagerImpl.getMaterialContent(materialId);
    }

    /**
     * List recent screenshots from memory (metadata only, no image data).
     */
    async getScreenshots(limit = 50, since = 0): Promise<unknown[]> {
        if (!this.memoryClient?.getScreenshots) return [];
        try {
            return await this.memoryClient.getScreenshots(limit, since);
        } catch {
            return [];
        }
    }

    /**
     * Get a single screenshot by ID (with base64 image data).
     */
    async getScreenshot(screenshotId: string): Promise<unknown> {
        if (!this.memoryClient?.getScreenshot) return null;
        try {
            return await this.memoryClient.getScreenshot(screenshotId);
        } catch {
            return null;
        }
    }

    /**
     * Compute recency-decayed importance weights for all materials.
     * Returns a map of materialId → weight [0, 1].
     */
    async getMaterialWeights(halfLifeDays = 7): Promise<Record<string, number>> {
        if (!this.memoryClient?.getMaterialWeights) return {};
        try {
            return await this.memoryClient.getMaterialWeights(halfLifeDays);
        } catch {
            return {};
        }
    }

    // ========================================================================
    // Memory Freeze API
    // ========================================================================

    /** Freeze the memory DB — all writes (materials, frames, screenshots) are silently dropped. Reads still work. */
    async freezeMemory(): Promise<boolean> {
        if (!this.memoryClient?.freezeMemory) return false;
        try {
            return await this.memoryClient.freezeMemory();
        } catch {
            return false;
        }
    }

    /** Unfreeze the memory DB — resume normal write operations. */
    async unfreezeMemory(): Promise<boolean> {
        if (!this.memoryClient?.unfreezeMemory) return false;
        try {
            return await this.memoryClient.unfreezeMemory();
        } catch {
            return false;
        }
    }

    /** Check if the memory DB is currently frozen. */
    async isMemoryFrozen(): Promise<boolean> {
        if (!this.memoryClient?.isMemoryFrozen) return false;
        try {
            return await this.memoryClient.isMemoryFrozen();
        } catch {
            return false;
        }
    }

    /**
     * Subscribe to typed material events (FRAME_CAPTURED, MATERIAL_CREATED, MATERIAL_FOCUSED, MATERIAL_UNFOCUSED).
     * This is the preferred API — events are typed as MaterialEvent.
     */
    onMaterialEvent(callback: EventCallback<MaterialEvent>): void {
        this.materialDetector.addCallback(callback);
    }

    /**
     * Subscribe to material frame events (legacy untyped API).
     * Callback receives the raw MaterialFrame object from @ausm/device-macos-material-manager.
     * @deprecated Use onMaterialEvent() instead for typed MaterialEvent instances.
     */
    onMaterialFrameEvent(callback: EventCallback<unknown>): void {
        this.materialManagerImpl.addCallback(callback);
    }


    /**
     * Get all currently active (focused) material trackers.
     * @deprecated The material manager now runs in a separate process.
     * Use onMaterialEvent() to receive material lifecycle events instead.
     */
    getActiveMaterialWindows(): unknown[] {
        return [];
    }

    // ========================================================================
    // Event Subscriptions
    // ========================================================================

    onTextSelectionEvent(callback: EventCallback<TextSelectionEvent>): void {
        this.textSelectionDetector.addCallback(callback);
    }

    onScreenshotEvent(callback: EventCallback<ScreenshotEvent>): void {
        this.screenshotDetector.addCallback(callback);
    }

    onCopyPasteEvent(callback: EventCallback<CopyPasteEvent>): void {
        this.clipboardMonitorDetector.addCallback(callback);
    }

    onApplicationSwitchEvent(callback: EventCallback<WindowStateEvent>): void {
        this.applicationStateDetector.addCallback(callback);
    }

    onSpaceChangeEvent(callback: EventCallback<SpaceChangeEvent>): void {
        this.applicationStateDetector.addSpaceChangeCallback(callback);
    }

    subscribeToTextInputEvent(callback: EventCallback<TextInputEvent>): void {
        this.textInputDetector.addCallback(callback);
    }

    onCursorPlusPlusEvent(callback: EventCallback<CursorPlusPlusEvent>): void {
        this.cursorPlusPlusDetector.addCallback(callback);
    }

    onDetectorEvent(callback: EventCallback<DetectorEvent>): void {
        this.detectorCallbacks.push(callback);
    }

    onTaskEvent(callback: EventCallback<TaskEvent>): void {
        this.taskCallbacks.push(callback);
    }

    // ========================================================================
    // Event Emission
    // ========================================================================

    emitTextSelectionEvent(data: TextSelectionEventData): void {
        this.frequencyMonitor?.record('textSelection');
        this.textSelectionDetector.emit(createTextSelectionEvent(data));
    }

    emitScreenshotEvent(data: ScreenshotEventData): void {
        this.frequencyMonitor?.record('screenshot');
        this.screenshotDetector.emit(createScreenshotEvent(data));
    }

    emitCopyPasteEvent(data: CopyPasteEventData): void {
        this.frequencyMonitor?.record('copyPaste');
        this.clipboardMonitorDetector.emit(createCopyPasteEvent(data));
    }

    emitWindowStateEvent(data: WindowStateEventData): void {
        this.frequencyMonitor?.record('windowState');
        this.applicationStateDetector.emit(createWindowStateEvent(data));
    }

    emitMaterialEvent(data: MaterialEventData): void {
        this.frequencyMonitor?.record('material');
        this.materialDetector.emit(createMaterialEvent(data));
    }

    emitTextInputEvent(data: TextInputEventData): void {
        this.frequencyMonitor?.record('textInput');
        this.textInputDetector.emit(createTextInputEvent(data));
    }



    emitCursorPlusPlusEvent(data: CursorPlusPlusEventData): void {
        this.frequencyMonitor?.record('cursorPlusPlus');
        this.cursorPlusPlusDetector.emit(createCursorPlusPlusEvent(data));
    }

    emitSpaceChangeEvent(data: SpaceChangeEventData): void {
        this.frequencyMonitor?.record('spaceChange');
        this.applicationStateDetector.emitSpaceChange(createSpaceChangeEvent(data));
    }

    emitDetectorEvent(data: DetectorEventData): void {
        this.frequencyMonitor?.record('detector');
        const event = createDetectorEvent(data);
        dispatchToCallbacks(this.detectorCallbacks, event, 'Detector');
    }

    emitTaskEvent(data: TaskEventData): void {
        this.frequencyMonitor?.record('task');
        const event = createTaskEvent(data);
        dispatchToCallbacks(this.taskCallbacks, event, 'Task');
    }

    // ========================================================================
    // Runtime API Methods
    // ========================================================================

    getImmediateContext(event: AUSMEvent): unknown {
        return null;
    }

    getRelevantMaterials(event: AUSMEvent): unknown[] {
        return [];
    }

    getScreenshotImageData(eventID: string | null, bounds: Rect | null): ImageData {
        return {
            data: new Uint8ClampedArray(0),
            width: 0,
            height: 0
        };
    }

    getCoveredMaterials(bounds: Rect | null): AUSMApplication[] {
        return [];
    }

    getBounds(sourceElement: unknown, content: string): Rect | null {
        return null;
    }
}

/** Create a new runtime instance */
export function createRuntime(config?: AUSMRuntimeConfig): AUSMRuntime {
    return new AUSMRuntime(config);
}

/** Default runtime singleton (with native selection enabled) */
export const ausmRuntime = new AUSMRuntime({
    textSelection: { enableNativeSelection: true },
    logging: { eventFrequency: true },
});
