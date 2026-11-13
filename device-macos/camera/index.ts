/**
 * AUSM Camera Streaming Service
 *
 * High-performance webcam streaming with shared memory frame distribution.
 *
 * Uses a Swift-based camera-helper process that communicates via
 * Unix sockets and writes frames to POSIX shared memory.
 */

export {
    HelperClient,
    type CameraDeviceInfo,
    type StreamConfig,
    type DeviceConfig,
    type DeviceChangeEvent,
    type CaptureErrorEvent,
    type HelperExitEvent,
    type LatestFrameResult,
} from './src/helper-client';

import {
    HelperClient,
    type StreamConfig,
    type LatestFrameResult,
    type CaptureErrorEvent,
    type HelperExitEvent,
} from './src/helper-client';

const MAX_RESTART_ATTEMPTS = 5;
const MAX_RESTART_DELAY_MS = 30_000;
/** A helper that ran this long is considered healthy; the restart budget resets. */
const STABLE_RUN_MS = 60_000;

/**
 * Camera Streaming Service
 *
 * Wraps HelperClient with a higher-level API for managing camera streaming.
 * The helper process uses AVFoundation (via Swift) and writes frames
 * to POSIX shared memory for zero-copy distribution to consumers.
 */
export class CameraStreamingService {
    private helper: HelperClient;
    private config: StreamConfig;
    private running = false;
    private requestedDeviceIds: string[] | undefined;
    private restartAttempts = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    /** The caller wants streaming (set by start(), cleared by stop()). */
    private wanted = false;
    private startedAt = 0;

    constructor(config: StreamConfig = {}) {
        this.helper = new HelperClient(config.socketPath, config.debug ?? false);
        this.config = config;
        // If the helper crashes while streaming, restart it with exponential backoff.
        this.helper.on('exit', (evt: HelperExitEvent) => this.handleHelperExit(evt));
    }

    private handleHelperExit(evt: HelperExitEvent): void {
        if (!this.running) return;
        this.running = false;
        if (Date.now() - this.startedAt > STABLE_RUN_MS) this.restartAttempts = 0;
        this.scheduleRestart(evt);
    }

    private scheduleRestart(evt: HelperExitEvent): void {
        if (!this.wanted) return;
        if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
            console.error(
                `[CameraStreamingService] Helper exited (code=${evt.code}, signal=${evt.signal}); giving up after ${MAX_RESTART_ATTEMPTS} restarts`,
            );
            return;
        }
        const delay = Math.min(1000 * 2 ** this.restartAttempts, MAX_RESTART_DELAY_MS);
        this.restartAttempts += 1;
        if (this.config.debug) {
            console.warn(`[CameraStreamingService] Helper exited unexpectedly; restarting in ${delay} ms`);
        }
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (!this.wanted) return;
            void this.startInternal(this.requestedDeviceIds).then((ok) => {
                // A failed attempt keeps backing off instead of silently ending the retries.
                if (!ok) this.scheduleRestart(evt);
            });
        }, delay);
        this.restartTimer.unref?.();
    }

    /**
     * Start the camera streaming service.
     * Spawns the helper process, configures it, and starts streaming.
     */
    async start(deviceIds?: string[]): Promise<boolean> {
        if (this.running) return false;
        this.wanted = true;
        this.restartAttempts = 0;
        return this.startInternal(deviceIds);
    }

    private async startInternal(deviceIds?: string[]): Promise<boolean> {
        if (this.running) return false;
        this.requestedDeviceIds = deviceIds;

        try {
            await this.helper.start();
            await this.helper.configure(this.config);
            let ids = deviceIds;
            if (!ids) {
                if (this.config.deviceId) {
                    ids = [this.config.deviceId];
                } else {
                    ids = (await this.helper.getDevices()).map((d) => d.id);
                }
            }
            await this.helper.startStream(ids);
            if (!this.wanted) {
                // stop() was called while this start was in flight.
                try { await this.helper.stop(); } catch { /* ignore */ }
                return false;
            }
            this.running = true;
            this.startedAt = Date.now();
            return true;
        } catch (err) {
            console.error('[CameraStreamingService] Failed to start:', (err as Error).message);
            try { await this.helper.stop(); } catch { /* ignore */ }
            return false;
        }
    }

    /**
     * Stop streaming and shut down the helper process.
     */
    async stop(): Promise<boolean> {
        this.wanted = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (!this.running) {
            // A crashed helper may still be marked as alive; make sure it is gone.
            try { await this.helper.stop(); } catch { /* ignore */ }
            return false;
        }

        try {
            await this.helper.stopStream();
            await this.helper.stop();
            this.running = false;
            return true;
        } catch {
            try { await this.helper.stop(); } catch { /* ignore */ }
            this.running = false;
            return false;
        }
    }

    async isStreaming(): Promise<boolean> {
        if (!this.helper.isRunning()) return false;
        try {
            return await this.helper.isStreaming();
        } catch {
            return false;
        }
    }

    private devicesErrorLogged = false;

    async getDevices() {
        try {
            const result = await this.helper.getDevices();
            this.devicesErrorLogged = false;
            return result;
        } catch (err) {
            // Callers poll this every tick; say it once per outage, not once per tick.
            if (!this.devicesErrorLogged) {
                this.devicesErrorLogged = true;
                console.error('[CameraStreamingService] Failed to get devices:', (err as Error).message);
            }
            return [];
        }
    }

    /**
     * Start capture on the given cameras (or every known camera).
     * Safe to call while already streaming — new devices are added.
     */
    async startDevices(deviceIds?: string[]): Promise<boolean> {
        if (!this.helper.isRunning()) return false;
        try {
            const ids = deviceIds ?? (await this.helper.getDevices()).map((d) => d.id);
            await this.helper.startStream(ids);
            return true;
        } catch (err) {
            if (this.config.debug) {
                console.error('[CameraStreamingService] startDevices:', (err as Error).message);
            }
            return false;
        }
    }

    async updateConfiguration(config: Partial<StreamConfig>): Promise<void> {
        this.config = { ...this.config, ...config };
        await this.helper.updateConfiguration(config);
    }

    /**
     * Capture the most recent frame for a camera as a JPEG.
     *
     * Returns null instead of throwing on transient failures so callers
     * can poll without try/catch.
     */
    async captureLatestFrame(
        deviceId: string,
        jpegQuality: number = 0.7,
    ): Promise<LatestFrameResult | null> {
        try {
            return await this.helper.captureLatestFrame(deviceId, jpegQuality);
        } catch (err) {
            if (this.config.debug) {
                console.error('[CameraStreamingService] captureLatestFrame:', (err as Error).message);
            }
            return null;
        }
    }

    async cleanup(): Promise<void> {
        try {
            await this.stop();
        } catch {
            // Ensure cleanup never throws
        }
    }

    getHelper(): HelperClient {
        return this.helper;
    }

    onDeviceChange(callback: (event: { type: string; deviceId: string; event: string }) => void): void {
        this.helper.onDeviceChange(callback);
    }

    /** Called when a camera session fails or is interrupted (e.g. another app took the camera). */
    onCaptureError(callback: (event: CaptureErrorEvent) => void): void {
        this.helper.onCaptureError(callback);
    }
}

/**
 * Create a pre-configured camera streaming service.
 */
export function createCameraStreamer(options: {
    fps?: number;
    targetHeight?: number;
    sharedMemoryName?: string;
    socketPath?: string;
    frameCount?: number;
    deviceId?: string;
    debug?: boolean;
} = {}): CameraStreamingService {
    return new CameraStreamingService({
        fps: options.fps ?? 10,
        targetHeight: options.targetHeight ?? 720,
        sharedMemoryName: options.sharedMemoryName ?? '/ausm-camera-frames',
        frameCount: options.frameCount ?? 5,
        socketPath: options.socketPath,
        deviceId: options.deviceId,
        debug: options.debug ?? false,
    });
}

export default CameraStreamingService;
