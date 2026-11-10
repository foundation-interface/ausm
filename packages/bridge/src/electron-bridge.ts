/**
 * AUSM Electron Bridge
 *
 * Automatically forwards all AUSM runtime events to the Electron renderer process.
 *
 * Import this module before `app.ready` so the `ausm-screenshot://` scheme is
 * registered as privileged. Host apps do not register or serve that scheme.
 *
 * @example
 * ```typescript
 * import { app, BrowserWindow } from 'electron';
 * import { createRuntime } from '@ausm/core/runtime';
 * import { setupAUSMElectronBridge, getAUSMPreloadPath } from '@ausm/bridge/electron';
 *
 * const runtime = createRuntime({ textSelection: { enableNativeSelection: true } });
 *
 * app.whenReady().then(() => {
 *   runtime.initialize();
 *   const mainWindow = new BrowserWindow({
 *     webPreferences: { preload: getAUSMPreloadPath(), contextIsolation: true },
 *   });
 *
 *   const bridge = setupAUSMElectronBridge(mainWindow, runtime);
 *   mainWindow.on('closed', () => bridge.cleanup());
 * });
 * ```
 */

import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { app, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Absolute path to the default AUSM preload (`window.ausm` only).
 * To add host APIs, write your own preload and call `exposeAUSM` from
 * `@ausm/bridge/preload-api` instead of using this path.
 */
export function getAUSMPreloadPath(): string {
    return path.join(__dirname, 'preload.js');
}
import type { AUSMRuntime } from '@ausm/core/runtime';
import { setupStreamFpsIPC } from './stream-fps-ipc';
import { setupScreenStreamIPC } from './screen-stream-ipc';
import { setupCameraStreamIPC } from './camera-stream-ipc';
import type { 
    TextSelectionEvent,
    ScreenshotEvent,
    CopyPasteEvent,
    WindowStateEvent,
    TextInputEvent,
    MaterialEvent,
    CursorPlusPlusEvent,
    SpaceChangeEvent,
    TaskEvent,
    DetectorEvent,
} from '@ausm/core';

/** Per-module logging toggles for the bridge (mirrors runtime LoggingConfig) */
export interface BridgeLoggingConfig {
    /** Global default for all modules (default: false) */
    global_default?: boolean;
    textSelection?: boolean;
    textInput?: boolean;
    windowState?: boolean;
    materialManager?: boolean;
    cursorPlusPlus?: boolean;
    screenStreaming?: boolean;
    cameraStreaming?: boolean;
    screenshot?: boolean;
    clipboardMonitor?: boolean;
    detectorPipeline?: boolean;
}

export interface ElectronBridgeOptions {
    /**
     * @deprecated Use `logging` instead. Kept for backward compatibility;
     * if both are set, `logging` takes precedence.
     */
    debug?: boolean;
    /** Per-module logging config — same shape as runtime LoggingConfig */
    logging?: BridgeLoggingConfig;
    /** Custom IPC channel prefix (default: 'ausm:') */
    channelPrefix?: string;
}

export interface ElectronBridge {
    /** Clean up event listeners */
    cleanup: () => void;
    /** Get the window being bridged */
    window: BrowserWindow;
}

/**
 * IPC Channel names used by the bridge
 */
export const AUSM_IPC_CHANNELS = {
    TEXT_SELECTION: 'ausm:textSelection',
    SCREENSHOT: 'ausm:screenshot',
    COPY_PASTE: 'ausm:copyPaste',
    WINDOW_STATE: 'ausm:windowState',
    TEXT_INPUT: 'ausm:textInput',
    CURSOR_PLUS_PLUS: 'ausm:cursorPlusPlusEvent',
    MATERIAL_EVENT: 'ausm:materialEvent',
    SPACE_CHANGE: 'ausm:spaceChange',
    TASK: 'ausm:taskEvent',
    DETECTOR: 'ausm:detectorEvent',
    // Renderer -> Main
    GET_SCREENSHOT: 'ausm:getScreenshot',
    GET_CONTEXT: 'ausm:getContext',
    EMIT_TEST_EVENT: 'ausm:emitTestEvent',
    SCREEN_STREAM_GET_DISPLAYS: 'ausm:screenStream:getDisplays',
    SCREEN_STREAM_SUBSCRIBE: 'ausm:screenStream:subscribe',
    SCREEN_STREAM_UNSUBSCRIBE: 'ausm:screenStream:unsubscribe',
    SCREEN_FRAME: 'ausm:screenFrame',
    CAMERA_STREAM_GET_DEVICES: 'ausm:cameraStream:getDevices',
    CAMERA_STREAM_SUBSCRIBE: 'ausm:cameraStream:subscribe',
    CAMERA_STREAM_UNSUBSCRIBE: 'ausm:cameraStream:unsubscribe',
    CAMERA_FRAME: 'ausm:cameraFrame',
    STREAM_FPS_GET: 'ausm:streamFps:get',
    STREAM_FPS_SET: 'ausm:streamFps:set',
    STREAM_FPS: 'ausm:streamFps',
} as const;

/** Shared across bridge instances — reuse imageUrl when duplicate events share the same source path */
const SCREENSHOT_PATH_CACHE = new Map<string, { safeId: string; imageWidth: number | null; imageHeight: number | null; ts: number }>();
const SCREENSHOT_CACHE_REUSE_MS = 5000;

export const AUSM_SCREENSHOT_SCHEME = 'ausm-screenshot';
export const AUSM_SCREENSHOT_SCHEME_PRIVILEGES = {
    standard: true,
    secure: true,
    supportFetchAPI: true,
};

function screenshotCacheDir(): string {
    return path.join(app.getPath('userData'), 'ausm-screenshots');
}

/**
 * Must run before `app.ready`. Invoked automatically when this module is imported.
 * Hosts that already call `registerSchemesAsPrivileged` for other schemes should
 * include `AUSM_SCREENSHOT_SCHEME` in that list and import this module afterward.
 */
export function registerAUSMScreenshotScheme(): void {
    try {
        protocol.registerSchemesAsPrivileged([
            {
                scheme: AUSM_SCREENSHOT_SCHEME,
                privileges: AUSM_SCREENSHOT_SCHEME_PRIVILEGES,
            },
        ]);
    } catch {
        // Already registered, or imported after app.ready
    }
}

let screenshotProtocolRegistered = false;

/** Serve cached JPEGs so renderer `<img src="ausm-screenshot://…">` works. Idempotent. */
export function serveAUSMScreenshotCache(): void {
    if (screenshotProtocolRegistered) return;
    try {
        protocol.handle(AUSM_SCREENSHOT_SCHEME, (request) => {
            const match = request.url.match(/^ausm-screenshot:\/\/screenshot\/(.+)$/);
            if (!match) return new Response('Not Found', { status: 404 });
            let id: string;
            try {
                id = decodeURIComponent(match[1]);
            } catch {
                return new Response('Not Found', { status: 404 });
            }
            // Cache ids are generated as [A-Za-z0-9_-]+; anything else (e.g. "../") could
            // escape the cache directory and read arbitrary .jpg files.
            if (!/^[A-Za-z0-9_-]+$/.test(id)) return new Response('Not Found', { status: 404 });
            const filePath = path.join(screenshotCacheDir(), `${id}.jpg`);
            if (!fs.existsSync(filePath)) return new Response('Not Found', { status: 404 });
            const buf = fs.readFileSync(filePath);
            return new Response(buf, { headers: { 'Content-Type': 'image/jpeg' } });
        });
        screenshotProtocolRegistered = true;
    } catch {
        // Protocol may already be registered
        screenshotProtocolRegistered = true;
    }
}

registerAUSMScreenshotScheme();

/**
 * Set up automatic event bridging between AUSM runtime and Electron renderer.
 * 
 * @param window - The BrowserWindow to send events to
 * @param runtime - The AUSM runtime instance
 * @param options - Optional configuration
 * @returns Bridge object with cleanup function
 */
export function setupAUSMElectronBridge(
    window: BrowserWindow,
    runtime: AUSMRuntime,
    options: ElectronBridgeOptions = {}
): ElectronBridge {
    const { debug = false, logging, channelPrefix = 'ausm:' } = options;

    // Resolve whether a module should log:
    //   per-module toggle > logging.global_default > legacy debug flag > false
    type Module = Exclude<keyof BridgeLoggingConfig, 'global_default'>;
    const shouldLog = (module: Module): boolean => {
        const toggle = logging?.[module];
        if (toggle !== undefined) return toggle;
        if (logging?.global_default !== undefined) return logging.global_default;
        return debug;
    };

    const makeLogger = (module: Module) =>
        shouldLog(module)
            ? (...args: unknown[]) => console.log('[AUSM Bridge]', ...args)
            : () => {};

    const send = (channel: string, data: unknown) => {
        if (!window.isDestroyed()) {
            window.webContents.send(channel, data);
        }
    };

    // Events are plain objects (interfaces + factories), so they serialize
    // directly over IPC via structured clone — no manual property picking needed.

    runtime.onTextSelectionEvent((event: TextSelectionEvent) => {
        makeLogger('textSelection')('Text Selection:', event.selectedText?.slice(0, 50));
        send(AUSM_IPC_CHANNELS.TEXT_SELECTION, event);
    });

    // Screenshot events: cache JPEGs to disk and serve via ausm-screenshot://
    // so multi-MB base64 never goes over IPC.
    serveAUSMScreenshotCache();
    const cacheDir = screenshotCacheDir();
    const ensureScreenshotCache = () => {
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
    };

    runtime.onScreenshotEvent((event: ScreenshotEvent) => {
        const hasImage = event.imageData != null || event.imagePath != null;
        makeLogger('screenshot')('Screenshot:', event.type, hasImage ? '(with image)' : '', event.imagePath ? `path=${event.imagePath}` : '');
        let imageUrl: string | null = null;
        let imageWidth: number | null = null;
        let imageHeight: number | null = null;
        if (event.imagePath) {
            const sourceExists = fs.existsSync(event.imagePath);
            const cached = SCREENSHOT_PATH_CACHE.get(event.imagePath);
            const cacheValid = cached && Date.now() - cached.ts < SCREENSHOT_CACHE_REUSE_MS;
            if (!sourceExists && cacheValid) {
                imageUrl = `ausm-screenshot://screenshot/${encodeURIComponent(cached!.safeId)}`;
                imageWidth = cached!.imageWidth;
                imageHeight = cached!.imageHeight;
            } else if (!sourceExists) {
                const hasAnyRecentCache = Array.from(SCREENSHOT_PATH_CACHE.values()).some((v) => Date.now() - v.ts < SCREENSHOT_CACHE_REUSE_MS);
                if (!hasAnyRecentCache) {
                    console.warn('[AUSM Bridge] Screenshot source file missing:', event.imagePath);
                }
            } else {
                ensureScreenshotCache();
                const safeId = (event.eventID ?? `screenshot-${event.timestamp}`).replace(/[^a-zA-Z0-9-_]/g, '_');
                const destPath = path.join(cacheDir, `${safeId}.jpg`);
                try {
                    fs.copyFileSync(event.imagePath, destPath);
                    imageUrl = `ausm-screenshot://screenshot/${encodeURIComponent(safeId)}`;
                    imageWidth = event.imageWidth ?? event.imageData?.width ?? null;
                    imageHeight = event.imageHeight ?? event.imageData?.height ?? null;
                    const now = Date.now();
                    SCREENSHOT_PATH_CACHE.set(event.imagePath, { safeId, imageWidth, imageHeight, ts: now });
                    for (const [p, v] of Array.from(SCREENSHOT_PATH_CACHE.entries())) {
                        if (now - v.ts > SCREENSHOT_CACHE_REUSE_MS) SCREENSHOT_PATH_CACHE.delete(p);
                    }
                    try { fs.unlinkSync(event.imagePath); } catch { /* copy is in cache */ }
                } catch (err) {
                    console.warn('[AUSM Bridge] Failed to cache screenshot:', (err as Error).message, 'source=', event.imagePath);
                }
            }
        } else if (event.imageData) {
            imageWidth = event.imageData.width;
            imageHeight = event.imageData.height;
            imageUrl = `data:${event.imageData.mimeType ?? 'image/jpeg'};base64,${event.imageData.dataBase64}`;
        }
        send(AUSM_IPC_CHANNELS.SCREENSHOT, {
            ...event,
            imageUrl,
            imageWidth,
            imageHeight,
            imageData: imageUrl ? undefined : event.imageData,
        });
    });

    if (typeof runtime.onCopyPasteEvent === 'function') {
        runtime.onCopyPasteEvent((event: CopyPasteEvent) => {
            makeLogger('clipboardMonitor')('Copy/Paste:', event.action, event.contentType, event.content?.slice(0, 30));
            send(AUSM_IPC_CHANNELS.COPY_PASTE, event);
        });
    }

    runtime.onApplicationSwitchEvent((event: WindowStateEvent) => {
        makeLogger('windowState')('Window State:', event.application, event.state);
        send(AUSM_IPC_CHANNELS.WINDOW_STATE, event);
    });

    runtime.subscribeToTextInputEvent((event: TextInputEvent) => {
        makeLogger('textInput')('Text Input:', event.status);
        send(AUSM_IPC_CHANNELS.TEXT_INPUT, event);
    });

    if (typeof runtime.onCursorPlusPlusEvent === 'function') {
        runtime.onCursorPlusPlusEvent((event: CursorPlusPlusEvent) => {
            makeLogger('cursorPlusPlus')('Cursor++:', event.action, `(${event.x},${event.y})`);
            send(AUSM_IPC_CHANNELS.CURSOR_PLUS_PLUS, event);
        });
    }

    if (typeof runtime.onMaterialEvent === 'function') {
        runtime.onMaterialEvent((event: MaterialEvent) => {
            makeLogger('materialManager')('Material Event:', event.materialEventType, event.materialId ?? event.title ?? '');
            // FRAME_CAPTURED includes a full JPEG; keep the IPC payload small.
            const { frameDataBase64: _omit, ...lean } = event;
            send(AUSM_IPC_CHANNELS.MATERIAL_EVENT, lean);
        });
    }

    if (typeof runtime.onSpaceChangeEvent === 'function') {
        runtime.onSpaceChangeEvent((event: SpaceChangeEvent) => {
            makeLogger('windowState')('Space changed');
            send(AUSM_IPC_CHANNELS.SPACE_CHANGE, event);
        });
    }

    if (typeof runtime.onTaskEvent === 'function') {
        runtime.onTaskEvent((event: TaskEvent) => {
            makeLogger('detectorPipeline')('Task:', event.status, event.taskLabel ?? '');
            send(AUSM_IPC_CHANNELS.TASK, event);
        });
    }

    if (typeof runtime.onDetectorEvent === 'function') {
        runtime.onDetectorEvent((event: DetectorEvent) => {
            makeLogger('detectorPipeline')('Detector:', event.detectorName, event.eventType);
            send(AUSM_IPC_CHANNELS.DETECTOR, event);
        });
    }


    if (logging?.global_default || debug) {
        console.log('[AUSM Bridge] Event bridge configured');
    }

    return {
        cleanup: () => {
            // Note: AUSM runtime doesn't currently support removing callbacks
            // This is a placeholder for future implementation
        },
        window
    };
}

/**
 * Set up IPC handlers for renderer -> main communication.
 * Call this once in your main process. Registers screenshot serving,
 * live screen/camera preview streams, and preview FPS get/set.
 *
 * @param ipcMain - Electron's ipcMain module
 * @param runtime - The AUSM runtime instance
 * @param options - Optional configuration.
 */
export function setupAUSMIPCHandlers(
    ipcMain: IpcMain,
    runtime: AUSMRuntime,
    options: ElectronBridgeOptions = {}
): void {
    const { debug = false, logging } = options;

    const ipcDebug = logging?.global_default ?? debug;
    const log = ipcDebug
        ? (...args: unknown[]) => console.log('[AUSM IPC]', ...args)
        : () => {};

    // Handle test event emission (for development)
    ipcMain.on(AUSM_IPC_CHANNELS.EMIT_TEST_EVENT, (_event: IpcMainEvent, type: string, data: unknown) => {
        log('Emit test event:', type);
        switch (type) {
            case 'textSelection':
                runtime.emitTextSelectionEvent(data as Parameters<typeof runtime.emitTextSelectionEvent>[0]);
                break;
            case 'screenshot':
                runtime.emitScreenshotEvent(data as Parameters<typeof runtime.emitScreenshotEvent>[0]);
                break;
            case 'copyPaste':
                runtime.emitCopyPasteEvent(data as Parameters<typeof runtime.emitCopyPasteEvent>[0]);
                break;
            case 'windowState':
                runtime.emitWindowStateEvent(data as Parameters<typeof runtime.emitWindowStateEvent>[0]);
                break;
            case 'textInput':
                runtime.emitTextInputEvent(data as Parameters<typeof runtime.emitTextInputEvent>[0]);
                break;
            case 'cursorPlusPlus':
                runtime.emitCursorPlusPlusEvent(data as Parameters<typeof runtime.emitCursorPlusPlusEvent>[0]);
                break;
            case 'task':
                runtime.emitTaskEvent(data as Parameters<typeof runtime.emitTaskEvent>[0]);
                break;
            case 'detector':
                runtime.emitDetectorEvent(data as Parameters<typeof runtime.emitDetectorEvent>[0]);
                break;
        }
    });

    // Handle screenshot requests
    ipcMain.handle(AUSM_IPC_CHANNELS.GET_SCREENSHOT, async (_event: IpcMainInvokeEvent, bounds?: unknown) => {
        log('Get screenshot request:', bounds);
        // TODO: Implement using Electron's desktopCapturer
        return null;
    });

    // Handle context requests
    ipcMain.handle(AUSM_IPC_CHANNELS.GET_CONTEXT, async (_event: IpcMainInvokeEvent, eventID?: string) => {
        log('Get context request:', eventID);
        // TODO: Implement context retrieval
        return null;
    });

    setupStreamFpsIPC(ipcMain, runtime);
    setupScreenStreamIPC(ipcMain, runtime);
    setupCameraStreamIPC(ipcMain, runtime);

    serveAUSMScreenshotCache();
    log('IPC handlers configured');
}

export default setupAUSMElectronBridge;
