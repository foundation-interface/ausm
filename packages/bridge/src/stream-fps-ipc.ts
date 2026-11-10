import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { AUSMRuntime } from '@ausm/core/runtime';

export const DEFAULT_STREAM_FPS = 10;
export const MIN_STREAM_FPS = 1;
export const MAX_STREAM_FPS = 60;

export const streamRates = {
    screenFps: DEFAULT_STREAM_FPS,
    cameraFps: DEFAULT_STREAM_FPS,
};

export function clampStreamFps(fps: number): number {
    if (!Number.isFinite(fps)) return DEFAULT_STREAM_FPS;
    return Math.max(MIN_STREAM_FPS, Math.min(MAX_STREAM_FPS, Math.round(fps)));
}

export function intervalMsForFps(fps: number): number {
    return Math.max(1, Math.round(1000 / clampStreamFps(fps)));
}

function sendRates(sender: Electron.WebContents, payload: typeof streamRates): void {
    if (!sender.isDestroyed()) {
        sender.send('ausm:streamFps', payload);
    }
}

/** Get/set preview capture rates and push the current values to the asking renderer. */
export function setupStreamFpsIPC(ipcMain: IpcMain, runtime: AUSMRuntime): void {
    ipcMain.handle('ausm:streamFps:get', (event: IpcMainInvokeEvent) => {
        const payload = { ...streamRates };
        sendRates(event.sender, payload);
        return payload;
    });

    ipcMain.handle(
        'ausm:streamFps:set',
        async (event: IpcMainInvokeEvent, next: { screenFps?: number; cameraFps?: number }) => {
            if (next?.screenFps != null) {
                streamRates.screenFps = clampStreamFps(next.screenFps);
                const service = runtime.getScreenStreamingService();
                if (service && typeof service.updateConfiguration === 'function') {
                    try {
                        await service.updateConfiguration({ fps: streamRates.screenFps });
                    } catch (err) {
                        console.warn('[AUSM IPC] Failed to update screen-stream fps:', (err as Error).message);
                    }
                }
            }

            if (next?.cameraFps != null) {
                streamRates.cameraFps = clampStreamFps(next.cameraFps);
                const service = runtime.getCameraStreamingService();
                if (service && typeof service.updateConfiguration === 'function') {
                    try {
                        await service.updateConfiguration({ fps: streamRates.cameraFps });
                    } catch (err) {
                        console.warn('[AUSM IPC] Failed to update camera-stream fps:', (err as Error).message);
                    }
                }
            }

            const payload = { ...streamRates };
            sendRates(event.sender, payload);
            return payload;
        },
    );
}
