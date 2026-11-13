/**
 * Minimal in-memory stand-in for the parts of `electron` the bridge touches.
 * Installed via a require hook before any bridge module is loaded.
 */
import { EventEmitter } from 'events';
import Module from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';

export const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ausm-bridge-userdata-'));

export const electron = {
    registeredSchemes: [] as unknown[],
    protocolHandlers: new Map<string, (req: { url: string }) => Response>(),
    exposed: new Map<string, Record<string, any>>(),
    rendererSends: [] as Array<[string, unknown?]>,
    rendererInvokes: [] as Array<[string, unknown?]>,
    renderer: new EventEmitter(),

    app: { getPath: (_name: string) => userDataDir },
    protocol: {
        registerSchemesAsPrivileged(schemes: unknown[]) { electron.registeredSchemes.push(...schemes); },
        handle(scheme: string, handler: (req: { url: string }) => Response) {
            if (electron.protocolHandlers.has(scheme)) throw new Error('already handled');
            electron.protocolHandlers.set(scheme, handler);
        },
    },
    contextBridge: {
        exposeInMainWorld(name: string, api: Record<string, any>) { electron.exposed.set(name, api); },
    },
    ipcRenderer: {
        on(channel: string, fn: (...a: any[]) => void) { electron.renderer.on(channel, fn); },
        removeListener(channel: string, fn: (...a: any[]) => void) { electron.renderer.removeListener(channel, fn); },
        send(channel: string, arg?: unknown) { electron.rendererSends.push([channel, arg]); },
        invoke(channel: string, arg?: unknown) { electron.rendererInvokes.push([channel, arg]); return Promise.resolve(`invoked:${channel}`); },
    },
};

const anyModule = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const original = anyModule._load;
anyModule._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') return electron;
    return original.call(this, request, parent, isMain);
};

process.on('exit', () => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

export class FakeIpcMain {
    listeners = new Map<string, (...a: any[]) => unknown>();
    handlers = new Map<string, (...a: any[]) => unknown>();
    on(channel: string, fn: (...a: any[]) => unknown) { this.listeners.set(channel, fn); return this; }
    handle(channel: string, fn: (...a: any[]) => unknown) {
        if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
        this.handlers.set(channel, fn);
    }
}

export class FakeWebContents extends EventEmitter {
    sent: Array<[string, unknown]> = [];
    destroyed = false;
    isDestroyed() { return this.destroyed; }
    send(channel: string, data: unknown) { this.sent.push([channel, data]); }
}

export class FakeWindow {
    webContents = new FakeWebContents();
    destroyed = false;
    isDestroyed() { return this.destroyed; }
}

/** Runtime double exposing the subscription/emit/query surface the bridge uses. */
export function fakeRuntime(opts: { omit?: string[]; noUnsubscribe?: boolean } = {}) {
    const subs = new Map<string, Array<(e: any) => void>>();
    const emitted: Array<[string, unknown]> = [];
    const sub = (name: string) => (cb: (e: any) => void) => {
        if (!subs.has(name)) subs.set(name, []);
        subs.get(name)!.push(cb);
        if (opts.noUnsubscribe) return undefined;
        return () => {
            const list = subs.get(name)!;
            if (list.includes(cb)) list.splice(list.indexOf(cb), 1);
        };
    };
    const rt: Record<string, any> = {
        fire: (name: string, event: unknown) => (subs.get(name) ?? []).forEach((cb) => cb(event)),
        subs,
        emitted,
        displays: [{ id: 'd1' }] as Array<{ id: string }>,
        frames: new Map<string, any>(),
        screenService: null as any,
        cameraService: null as any,
        getScreenDisplays: async () => rt.displays,
        captureLatestScreenFrame: async (id: string) => rt.frames.get(id) ?? null,
        getCameraDevices: async () => [],
        captureLatestCameraFrame: async () => null,
        getScreenStreamingService: () => rt.screenService,
        getCameraStreamingService: () => rt.cameraService,
    };
    for (const name of [
        'onTextSelectionEvent', 'onScreenshotEvent', 'onCopyPasteEvent', 'onApplicationSwitchEvent', 'subscribeToTextInputEvent',
        'onCursorPlusPlusEvent', 'onMaterialEvent', 'onSpaceChangeEvent', 'onTaskEvent', 'onDetectorEvent',
    ]) {
        if (!opts.omit?.includes(name)) rt[name] = sub(name);
    }
    for (const name of [
        'emitTextSelectionEvent', 'emitScreenshotEvent', 'emitCopyPasteEvent', 'emitWindowStateEvent', 'emitTextInputEvent',
        'emitCursorPlusPlusEvent', 'emitTaskEvent', 'emitDetectorEvent',
    ]) {
        rt[name] = (data: unknown) => emitted.push([name, data]);
    }
    return rt;
}
