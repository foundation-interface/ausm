/**
 * Legacy type definitions, re-exported from index.ts for API compatibility.
 *
 * The current helper does not emit these socket messages or events; the live
 * API is HelperClient / ScreenStreamingService (see src/helper-client.ts) and
 * the shared memory layout documented in README.md.
 */

/**
 * Display information
 */
export interface DisplayInfo {
    /** Unique display identifier */
    id: string;
    /** CGDirectDisplayID */
    displayId: number;
    /** Display width in pixels */
    width: number;
    /** Display height in pixels */
    height: number;
    /** Whether this is the main display */
    isMain: boolean;
    /** Whether this is a built-in display */
    isBuiltIn: boolean;
    /** Display scale factor (e.g., 2.0 for Retina) */
    scaleFactor: number;
    /** Refresh rate in Hz */
    refreshRate: number;
}

/**
 * Frame metadata
 */
export interface FrameMetadata {
    /** Display ID this frame belongs to */
    displayId: string;
    /** Frame timestamp */
    timestamp: number;
    /** Frame index in the ring buffer */
    bufferIndex: number;
    /** Frame width */
    width: number;
    /** Frame height */
    height: number;
    /** Pixel format (e.g., 'bgra') */
    format: 'bgra' | 'rgba';
    /** Frame size in bytes */
    byteLength: number;
    /** Frame number since capture started */
    frameNumber: number;
}

/**
 * Shared memory configuration
 */
export interface SharedMemoryConfig {
    /** Shared memory region name (e.g., '/ausm-frames') */
    name: string;
    /** Total size of shared memory region */
    size: number;
    /** Number of frames in ring buffer */
    frameCount: number;
    /** Size of each frame in bytes */
    frameSize: number;
    /** Frame width */
    width: number;
    /** Frame height */
    height: number;
    /** Pixel format */
    format: 'bgra' | 'rgba';
}

/**
 * Stream configuration
 */
export interface StreamConfig {
    /** Target frames per second (1-60, default: 10) */
    fps?: number;
    /** Scale factor for output (0.25-1.0, default: 1.0) */
    scale?: number;
    /** Target height in pixels (will scale proportionally, default: native) */
    targetHeight?: number;
    /** Pixel format for output */
    format?: 'bgra' | 'rgba';
    /** Show cursor in capture */
    showCursor?: boolean;
    /** Display IDs to capture (null = all displays) */
    displayIds?: string[];
    /** Enable video file recording */
    enableRecording?: boolean;
    /** Output directory for video files */
    outputDirectory?: string;
    /** Video codec ('h264' or 'hevc') */
    videoCodec?: 'h264' | 'hevc';
    /** Video bitrate in bps (default: 2_000_000 for 1080p) */
    videoBitrate?: number;
}

/**
 * Stream status
 */
export interface StreamStatus {
    /** Whether streaming is active */
    isStreaming: boolean;
    /** Currently streaming displays */
    activeDisplays: string[];
    /** Current FPS setting */
    fps: number;
    /** Total frames captured */
    totalFrames: number;
    /** Recording status per display */
    recordings: Record<string, {
        outputPath: string;
        frames: number;
        duration: number;
    }>;
}

/**
 * Display change event
 */
export interface DisplayChangeEvent {
    type: 'added' | 'removed' | 'reconfigured';
    displayId: string;
    display?: DisplayInfo;
}

/**
 * Frame event for subscribers
 */
export interface FrameEvent {
    /** Frame metadata */
    metadata: FrameMetadata;
    /** Raw frame data (only if not using shared memory) */
    data?: Buffer;
}

/**
 * Unix socket message types
 */
export type SocketMessage =
    | { type: 'init'; config: SharedMemoryConfig; displays: DisplayInfo[] }
    | { type: 'frame'; metadata: FrameMetadata }
    | { type: 'display-change'; event: DisplayChangeEvent }
    | { type: 'fps-change'; fps: number }
    | { type: 'error'; message: string };

/**
 * Events emitted by ScreenStreamingService
 */
export interface ScreenStreamingEvents {
    'frame': (event: FrameEvent) => void;
    'display-change': (event: DisplayChangeEvent) => void;
    'error': (error: Error) => void;
    'status': (status: 'started' | 'stopped') => void;
}
