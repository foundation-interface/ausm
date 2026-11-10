import type { IpcMain } from 'electron';
import type { AUSMRuntime } from '@ausm/core/runtime';
import { streamRates } from './stream-fps-ipc';
import { previewJpegQuality, scheduleNextTick, sendPreviewFrame } from './preview-frames';

/**
 * Reference-counted polling loop that captures camera JPEGs and pushes
 * them to subscribed renderers.
 *
 * Channels:
 *   handle  ausm:cameraStream:getDevices
 *   on      ausm:cameraStream:subscribe / unsubscribe
 *   send    ausm:cameraFrame
 */
export function setupCameraStreamIPC(ipcMain: IpcMain, runtime: AUSMRuntime): void {
    const subscribers = new Set<Electron.WebContents>();
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let cachedDeviceIds: string[] = [];
    let lastDeviceRefresh = 0;
    const lastFrameNumber = new Map<string, number>();
    const DEVICE_REFRESH_MS = 5_000;

    const refreshDevices = async () => {
        const devices = await runtime.getCameraDevices();
        cachedDeviceIds = devices.map((d) => d.id);
        lastDeviceRefresh = Date.now();

        const inactive = devices.filter((d) => !d.active);
        if (inactive.length > 0) {
            const service = runtime.getCameraStreamingService() as {
                startDevices?: (ids?: string[]) => Promise<boolean>;
            } | null;
            if (typeof service?.startDevices === 'function') {
                await service.startDevices(devices.map((d) => d.id));
            }
        }
        return devices;
    };

    ipcMain.handle('ausm:cameraStream:getDevices', async () => {
        try {
            return await refreshDevices();
        } catch (err) {
            console.warn('[AUSM IPC] ausm:cameraStream:getDevices failed:', (err as Error).message);
            return [];
        }
    });

    const startPolling = () => {
        if (pollTimer != null) return;
        const tick = async () => {
            if (subscribers.size === 0) {
                pollTimer = null;
                return;
            }
            if (polling) return;
            polling = true;
            const startedAt = Date.now();
            try {
                if (
                    cachedDeviceIds.length === 0 ||
                    Date.now() - lastDeviceRefresh > DEVICE_REFRESH_MS
                ) {
                    await refreshDevices();
                }

                const quality = previewJpegQuality(streamRates.cameraFps);
                await Promise.all(
                    cachedDeviceIds.map(async (id) => {
                        const frame = await runtime.captureLatestCameraFrame(id, quality);
                        if (!frame) return;
                        if (lastFrameNumber.get(id) === frame.frameNumber) return;
                        lastFrameNumber.set(id, frame.frameNumber);
                        sendPreviewFrame(subscribers, 'ausm:cameraFrame', {
                            deviceId: frame.deviceId,
                            width: frame.width,
                            height: frame.height,
                            jpegSize: frame.jpegSize,
                            timestamp: frame.timestamp,
                            frameNumber: frame.frameNumber,
                            data: frame.data,
                        });
                    }),
                );
            } catch (err) {
                if (process.env.AUSM_DEBUG_CAMERA_STREAM) {
                    console.warn('[AUSM IPC] camera-stream poll error:', (err as Error).message);
                }
            } finally {
                polling = false;
            }
            pollTimer = scheduleNextTick(tick, startedAt, streamRates.cameraFps);
        };
        pollTimer = setTimeout(tick, 0);
    };

    const stopPolling = () => {
        if (pollTimer != null) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    };

    ipcMain.on('ausm:cameraStream:subscribe', (event) => {
        const wc = event.sender;
        if (subscribers.has(wc)) return;
        subscribers.add(wc);
        wc.once('destroyed', () => {
            if (subscribers.delete(wc) && subscribers.size === 0) stopPolling();
        });
        if (subscribers.size === 1) startPolling();
    });

    ipcMain.on('ausm:cameraStream:unsubscribe', (event) => {
        if (subscribers.delete(event.sender) && subscribers.size === 0) stopPolling();
    });
}
