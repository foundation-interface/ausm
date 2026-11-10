/**
 * Type definitions for the camera streaming service.
 * The live client types (StreamConfig, CameraDeviceInfo, DeviceChangeEvent, ...) are
 * defined in src/helper-client.ts and re-exported from index.ts.
 */

export interface CameraDeviceInfo {
    /** Unique camera identifier (AVCaptureDevice.uniqueID) */
    id: string;
    /** Localized device name */
    name: string;
    /** Camera position: front, back, or unspecified */
    position: 'front' | 'back' | 'unspecified';
    /** Whether this device is currently streaming */
    active: boolean;
    /** Device manufacturer, if known */
    manufacturer?: string;
}

/** @deprecated Not produced by the current helper; kept for API compatibility. See README for the actual protocol. */
export interface FrameMetadata {
    deviceId: string;
    timestamp: number;
    bufferIndex: number;
    width: number;
    height: number;
    format: 'bgra' | 'rgba';
    byteLength: number;
    frameNumber: number;
}

/** @deprecated Not produced by the current helper; kept for API compatibility. See README for the actual protocol. */
export interface SharedMemoryConfig {
    name: string;
    size: number;
    frameCount: number;
    frameSize: number;
    width: number;
    height: number;
    format: 'bgra' | 'rgba';
}

export interface StreamConfig {
    /** Target frames per second (1-60, default: 10) */
    fps?: number;
    /** Target height in pixels (default: 720) */
    targetHeight?: number;
    /** Shared memory base name (default: '/ausm-camera-frames') */
    sharedMemoryName?: string;
    /** Number of frames in the ring buffer (default: 5) */
    frameCount?: number;
    /** Unix socket path (default: '/tmp/ausm-camera.sock') */
    socketPath?: string;
    /** Preferred camera uniqueID (default: system default) */
    deviceId?: string;
    /** Enable debug logging (default: false) */
    debug?: boolean;
}

export interface DeviceConfig {
    fps?: number;
    targetHeight?: number;
}

/** @deprecated Not produced by the current helper; kept for API compatibility. See README for the actual protocol. */
export interface StreamStatus {
    isStreaming: boolean;
    activeDevices: string[];
    fps: number;
    totalFrames: number;
}

export interface DeviceChangeEvent {
    type: 'added' | 'removed' | 'reconfigured';
    deviceId: string;
    device?: CameraDeviceInfo;
}

/** @deprecated Not produced by the current helper; kept for API compatibility. See README for the actual protocol. */
export interface FrameEvent {
    metadata: FrameMetadata;
    data?: Buffer;
}

/** @deprecated Not produced by the current helper; kept for API compatibility. See README for the actual protocol. */
export type SocketMessage =
    | { type: 'init'; config: SharedMemoryConfig; devices: CameraDeviceInfo[] }
    | { type: 'frame'; metadata: FrameMetadata }
    | { type: 'device-change'; event: DeviceChangeEvent }
    | { type: 'fps-change'; fps: number }
    | { type: 'error'; message: string };

/** @deprecated Not produced by the current helper; kept for API compatibility. See README for the actual protocol. */
export interface CameraStreamingEvents {
    'frame': (event: FrameEvent) => void;
    'device-change': (event: DeviceChangeEvent) => void;
    'error': (error: Error) => void;
    'status': (status: 'started' | 'stopped') => void;
}
