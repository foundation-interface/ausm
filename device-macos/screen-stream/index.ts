/**
 * AUSM Screen Streaming Service (macOS only)
 *
 * Captures displays with ScreenCaptureKit in a Swift helper process
 * (`build/screen-capture-helper`) that writes BGRA frames to POSIX shared
 * memory for zero-copy consumers (see python/screen-stream-reader) and
 * serves JPEG snapshots over a Unix socket. See README.md.
 */

export {
    HelperClient,
    HelperCommandError,
    type DisplayInfo,
    type HelperErrorEvent,
    type StreamConfig,
    type DisplayConfig,
    type DisplayChangeEvent,
    type WindowCaptureResult,
    type LatestFrameResult,
} from './src/helper-client';

export type {
    FrameMetadata,
    SharedMemoryConfig,
    StreamStatus,
    FrameEvent,
    SocketMessage,
    ScreenStreamingEvents,
} from './types';

import {
    HelperClient,
    type StreamConfig,
    type LatestFrameResult,
    type WindowCaptureResult,
    type HelperErrorEvent,
} from './src/helper-client';

/**
 * Screen Streaming Service
 * 
 * Wraps HelperClient with a higher-level API for managing screen streaming.
 * The helper process uses ScreenCaptureKit (via Swift) and writes frames
 * to POSIX shared memory for zero-copy distribution to consumers.
 */
export class ScreenStreamingService {
    private helper: HelperClient;
    private config: StreamConfig;
    private running = false;

    constructor(config: StreamConfig = {}) {
        this.helper = new HelperClient(config.socketPath, config.debug ?? false);
        this.config = config;
        // If the helper dies unexpectedly, reflect it so start() can be retried.
        this.helper.on('exit', () => { this.running = false; });
    }

    /**
     * Start the screen streaming service.
     * Spawns the helper process, configures it, and starts streaming.
     */
    async start(displayIds?: string[]): Promise<boolean> {
        if (this.running) return false;

        try {
            await this.helper.start();
            await this.helper.configure(this.config);
            await this.helper.startStream(displayIds);
            this.running = true;
            return true;
        } catch (err) {
            console.error('[ScreenStreamingService] Failed to start:', (err as Error).message);
            // Don't leave a half-started helper behind.
            try { await this.helper.stop(); } catch { /* ignore */ }
            return false;
        }
    }

    /**
     * Stop streaming and shut down the helper process.
     */
    async stop(): Promise<boolean> {
        if (!this.running) {
            // start() may still be in flight (or the helper may have crashed): make sure no
            // helper is left behind. An in-flight start() then fails and returns false.
            try { await this.helper.stop(); } catch { /* ignore */ }
            return false;
        }

        try {
            await this.helper.stopStream();
            await this.helper.stop();
            this.running = false;
            return true;
        } catch {
            // Force stop
            try { await this.helper.stop(); } catch { /* ignore */ }
            this.running = false;
            return false;
        }
    }

    /**
     * Check if streaming is currently active.
     */
    async isStreaming(): Promise<boolean> {
        if (!this.helper.isRunning()) return false;
        try {
            return await this.helper.isStreaming();
        } catch {
            return false;
        }
    }

    /**
     * Get list of available displays.
     */
    async getDisplays() {
        try {
            return await this.helper.getDisplays();
        } catch (err) {
            console.error('[ScreenStreamingService] Failed to get displays:', err);
            return [];
        }
    }

    /**
     * Update stream configuration (e.g., change FPS or resolution).
     */
    async updateConfiguration(config: Partial<StreamConfig>): Promise<void> {
        this.config = { ...this.config, ...config };
        await this.helper.updateConfiguration(config);
    }

    /**
     * Capture the most recent frame for a display as a JPEG.
     *
     * Returns null instead of throwing on transient failures (no frame yet,
     * helper not ready, etc.) so callers can poll without try/catch.
     */
    async captureLatestFrame(
        displayId: string,
        jpegQuality: number = 0.7,
    ): Promise<LatestFrameResult | null> {
        try {
            return await this.helper.captureLatestFrame(displayId, jpegQuality);
        } catch {
            return null;
        }
    }

    /**
     * Capture a single window (by CGWindowID) as a JPEG, scaled to the same
     * pixel density as the display stream. Throws on failure.
     */
    async captureWindow(
        windowId: number,
        jpegQuality: number = 0.85,
        displayId?: string,
    ): Promise<WindowCaptureResult> {
        return this.helper.captureWindow(windowId, jpegQuality, displayId);
    }

    /**
     * Clean up all resources.
     */
    async cleanup(): Promise<void> {
        try {
            await this.stop();
        } catch {
            // Ensure cleanup never throws
        }
    }

    /**
     * Get the underlying HelperClient for advanced usage.
     */
    getHelper(): HelperClient {
        return this.helper;
    }

    /**
     * Register listener for display change events.
     */
    onDisplayChange(callback: (event: { type: string; displayId: string; event: string }) => void): void {
        this.helper.onDisplayChange(callback);
    }

    /**
     * Register listener for helper-pushed errors (e.g. Screen Recording
     * permission revoked while capturing).
     */
    onError(callback: (event: HelperErrorEvent) => void): void {
        this.helper.onHelperError(callback);
    }
}

/**
 * Create a pre-configured screen streaming service.
 */
export function createScreenStreamer(options: {
    fps?: number;
    targetHeight?: number;
    sharedMemoryName?: string;
    socketPath?: string;
    frameCount?: number;
    enableRecording?: boolean;
    outputDirectory?: string;
    debug?: boolean;
} = {}): ScreenStreamingService {
    return new ScreenStreamingService({
        fps: options.fps ?? 10,
        targetHeight: options.targetHeight ?? 1080,
        sharedMemoryName: options.sharedMemoryName ?? '/ausm-frames',
        frameCount: options.frameCount ?? 5,
        enableRecording: options.enableRecording ?? false,
        outputDirectory: options.outputDirectory ?? '',
        socketPath: options.socketPath,
        debug: options.debug ?? false,
    });
}

export default ScreenStreamingService;
