import type { IpcMain } from 'electron';
import type { AUSMRuntime } from '@ausm/core/runtime';
import { streamRates } from './stream-fps-ipc';
import { previewJpegQuality, scheduleNextTick, sendPreviewFrame } from './preview-frames';

/**
 * Reference-counted polling loop that captures screen JPEGs and pushes
 * them to subscribed renderers.
 *
 * Channels:
 *   handle  ausm:screenStream:getDisplays
 *   on      ausm:screenStream:subscribe / unsubscribe
 *   send    ausm:screenFrame
 */
export function setupScreenStreamIPC(ipcMain: IpcMain, runtime: AUSMRuntime): void {
    const subscribers = new Set<Electron.WebContents>();
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let cachedDisplayIds: string[] = [];
    let lastDisplayRefresh = 0;
    const lastFrameNumber = new Map<string, number>();
    const DISPLAY_REFRESH_MS = 5_000;

    ipcMain.handle('ausm:screenStream:getDisplays', async () => {
        try {
            const displays = await runtime.getScreenDisplays();
            cachedDisplayIds = displays.map((d) => d.id);
            lastDisplayRefresh = Date.now();
            return displays;
        } catch (err) {
            console.warn('[AUSM IPC] ausm:screenStream:getDisplays failed:', (err as Error).message);
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
                    cachedDisplayIds.length === 0 ||
                    Date.now() - lastDisplayRefresh > DISPLAY_REFRESH_MS
                ) {
                    const displays = await runtime.getScreenDisplays();
                    cachedDisplayIds = displays.map((d) => d.id);
                    lastDisplayRefresh = Date.now();
                }

                const quality = previewJpegQuality(streamRates.screenFps);
                await Promise.all(
                    cachedDisplayIds.map(async (id) => {
                        const frame = await runtime.captureLatestScreenFrame(id, quality);
                        if (!frame) return;
                        if (lastFrameNumber.get(id) === frame.frameNumber) return;
                        lastFrameNumber.set(id, frame.frameNumber);
                        sendPreviewFrame(subscribers, 'ausm:screenFrame', {
                            displayId: frame.displayId,
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
                if (process.env.AUSM_DEBUG_SCREEN_STREAM) {
                    console.warn('[AUSM IPC] screen-stream poll error:', (err as Error).message);
                }
            } finally {
                polling = false;
            }
            pollTimer = scheduleNextTick(tick, startedAt, streamRates.screenFps);
        };
        pollTimer = setTimeout(tick, 0);
    };

    const stopPolling = () => {
        if (pollTimer != null) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    };

    ipcMain.on('ausm:screenStream:subscribe', (event) => {
        const wc = event.sender;
        if (subscribers.has(wc)) return;
        subscribers.add(wc);
        wc.once('destroyed', () => {
            if (subscribers.delete(wc) && subscribers.size === 0) stopPolling();
        });
        if (subscribers.size === 1) startPolling();
    });

    ipcMain.on('ausm:screenStream:unsubscribe', (event) => {
        if (subscribers.delete(event.sender) && subscribers.size === 0) stopPolling();
    });
}
