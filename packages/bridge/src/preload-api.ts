/**
 * Composable `window.ausm` helpers for a host Electron preload.
 *
 * This module has no side effects. Hosts that need extra renderer APIs
 * write their own preload and call `exposeAUSM({ ...extras })`.
 *
 * Hosts that only need AUSM should use `getAUSMPreloadPath()` instead.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type CleanupFn = () => void;

function createListener(channel: string, callback: (data: unknown) => void): CleanupFn {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => {
        ipcRenderer.removeListener(channel, handler);
    };
}

function createSubscription(
    eventChannel: string,
    subscribeChannel: string,
    unsubscribeChannel: string,
    callback: (data: unknown) => void,
): CleanupFn {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on(eventChannel, handler);
    ipcRenderer.send(subscribeChannel);
    return () => {
        ipcRenderer.removeListener(eventChannel, handler);
        ipcRenderer.send(unsubscribeChannel);
    };
}

export function createAUSMPreloadAPI() {
    return {
        onTextSelection: (callback: (event: unknown) => void) =>
            createListener('ausm:textSelection', callback),

        onTextHighlight: (callback: (event: unknown) => void) =>
            createListener('ausm:textHighlight', callback),

        onScreenshot: (callback: (event: unknown) => void) =>
            createListener('ausm:screenshot', callback),

        onWindowState: (callback: (event: unknown) => void) =>
            createListener('ausm:windowState', callback),

        onTextInput: (callback: (event: unknown) => void) =>
            createListener('ausm:textInput', callback),

        onMaterialEvent: (callback: (event: unknown) => void) =>
            createListener('ausm:materialEvent', callback),

        onCursorPlusPlusEvent: (callback: (event: unknown) => void) =>
            createListener('ausm:cursorPlusPlusEvent', callback),

        onCopyPasteEvent: (callback: (event: unknown) => void) =>
            createListener('ausm:copyPaste', callback),

        onSpaceChange: (callback: (event: unknown) => void) =>
            createListener('ausm:spaceChange', callback),

        onTaskEvent: (callback: (event: unknown) => void) =>
            createListener('ausm:taskEvent', callback),

        onDetectorEvent: (callback: (event: unknown) => void) =>
            createListener('ausm:detectorEvent', callback),

        onScreenInfo: (callback: (info: unknown) => void) =>
            createListener('ausm:screenInfo', callback),

        getScreenDisplays: () => ipcRenderer.invoke('ausm:screenStream:getDisplays'),

        subscribeScreenStream: (callback: (frame: unknown) => void): CleanupFn =>
            createSubscription(
                'ausm:screenFrame',
                'ausm:screenStream:subscribe',
                'ausm:screenStream:unsubscribe',
                callback,
            ),

        getCameraDevices: () => ipcRenderer.invoke('ausm:cameraStream:getDevices'),

        subscribeCameraStream: (callback: (frame: unknown) => void): CleanupFn =>
            createSubscription(
                'ausm:cameraFrame',
                'ausm:cameraStream:subscribe',
                'ausm:cameraStream:unsubscribe',
                callback,
            ),

        getPreviewFps: () => ipcRenderer.invoke('ausm:streamFps:get'),

        setPreviewFps: (next: { screenFps?: number; cameraFps?: number }) =>
            ipcRenderer.invoke('ausm:streamFps:set', next),

        onPreviewFps: (callback: (rates: unknown) => void): CleanupFn =>
            createListener('ausm:streamFps', callback),
    };
}

export type AUSMPreloadAPI = ReturnType<typeof createAUSMPreloadAPI>;

/**
 * Expose `window.ausm` once. Pass extras to merge onto that object, and/or
 * call `contextBridge.exposeInMainWorld('myApp', …)` for a separate namespace.
 */
export function exposeAUSM(extras?: Record<string, unknown>): void {
    contextBridge.exposeInMainWorld('ausm', {
        ...createAUSMPreloadAPI(),
        ...extras,
    });
}
