import { electron, FakeIpcMain, FakeWindow, FakeWebContents, fakeRuntime, userDataDir } from './fake-electron';

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    AUSM_IPC_CHANNELS,
    AUSM_SCREENSHOT_SCHEME,
    getAUSMPreloadPath,
    serveAUSMScreenshotCache,
    setupAUSMElectronBridge,
    setupAUSMIPCHandlers,
} from '../src/electron-bridge';
import * as bridgeIndex from '../src/index';
import { createAUSMPreloadAPI, exposeAUSM } from '../src/preload-api';
import { clampStreamFps, intervalMsForFps, streamRates, DEFAULT_STREAM_FPS } from '../src/stream-fps-ipc';
import { previewJpegQuality } from '../src/preview-frames';

let saved: { log: typeof console.log; warn: typeof console.warn };
beforeEach(() => {
    saved = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = () => {};
    electron.renderer.removeAllListeners();
    electron.rendererSends.length = 0;
    electron.rendererInvokes.length = 0;
    streamRates.screenFps = DEFAULT_STREAM_FPS;
    streamRates.cameraFps = DEFAULT_STREAM_FPS;
});
afterEach(() => {
    console.log = saved.log;
    console.warn = saved.warn;
    mock.timers.reset();
});

/** Channels the preload listens on that the main process never sends (kept for compatibility). */
const RESERVED_RENDERER_CHANNELS = new Set(['ausm:textHighlight', 'ausm:screenInfo']);

describe('channels and exports', () => {
    test('IPC channel names are unique and namespaced', () => {
        const values = Object.values(AUSM_IPC_CHANNELS);
        assert.equal(new Set(values).size, values.length);
        assert.ok(values.every((v) => v.startsWith('ausm:')));
    });

    test('package index re-exports the bridge API', () => {
        for (const name of ['setupAUSMElectronBridge', 'setupAUSMIPCHandlers', 'getAUSMPreloadPath', 'AUSM_IPC_CHANNELS',
            'AUSM_SCREENSHOT_SCHEME', 'AUSM_SCREENSHOT_SCHEME_PRIVILEGES', 'registerAUSMScreenshotScheme', 'serveAUSMScreenshotCache']) {
            assert.ok(name in bridgeIndex, name);
        }
    });

    test('importing the bridge registers the screenshot scheme as privileged', () => {
        assert.ok(electron.registeredSchemes.some((s: any) => s.scheme === AUSM_SCREENSHOT_SCHEME && s.privileges.standard && s.privileges.secure));
    });

    test('getAUSMPreloadPath points at the built preload next to the bridge', () => {
        const p = getAUSMPreloadPath();
        assert.equal(path.basename(p), 'preload.js');
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'dist', 'preload.js')), 'dist/preload.js is built');
    });
});

describe('preload API', () => {
    const LISTENERS: Record<string, string> = {
        onTextSelection: 'ausm:textSelection', onTextHighlight: 'ausm:textHighlight', onScreenshot: 'ausm:screenshot',
        onWindowState: 'ausm:windowState', onTextInput: 'ausm:textInput', onMaterialEvent: 'ausm:materialEvent',
        onCursorPlusPlusEvent: 'ausm:cursorPlusPlusEvent', onCopyPasteEvent: 'ausm:copyPaste', onSpaceChange: 'ausm:spaceChange',
        onTaskEvent: 'ausm:taskEvent', onDetectorEvent: 'ausm:detectorEvent', onScreenInfo: 'ausm:screenInfo', onPreviewFps: 'ausm:streamFps',
    };

    test('exposes exactly the documented methods', () => {
        assert.deepEqual(Object.keys(createAUSMPreloadAPI()).sort(), [
            ...Object.keys(LISTENERS), 'getScreenDisplays', 'subscribeScreenStream', 'getCameraDevices', 'subscribeCameraStream',
            'getPreviewFps', 'setPreviewFps',
        ].sort());
    });

    test('each listener subscribes to its channel, delivers payloads, and its cleanup unsubscribes', () => {
        const api = createAUSMPreloadAPI() as Record<string, any>;
        for (const [method, channel] of Object.entries(LISTENERS)) {
            const got: unknown[] = [];
            const off = api[method]((d: unknown) => got.push(d));
            electron.renderer.emit(channel, {}, { n: 1 });
            assert.deepEqual(got, [{ n: 1 }], method);
            off();
            electron.renderer.emit(channel, {}, { n: 2 });
            assert.equal(got.length, 1, `${method} cleanup`);
            assert.equal(electron.renderer.listenerCount(channel), 0);
        }
    });

    test('every renderer channel is sent by the main process (or explicitly reserved)', () => {
        const sent = new Set<string>(Object.values(AUSM_IPC_CHANNELS));
        for (const channel of Object.values(LISTENERS)) {
            assert.ok(sent.has(channel) || RESERVED_RENDERER_CHANNELS.has(channel), channel);
        }
    });

    test('stream subscriptions send subscribe/unsubscribe and remove their listener', () => {
        const api = createAUSMPreloadAPI();
        const frames: unknown[] = [];
        const off = api.subscribeScreenStream((f) => frames.push(f));
        const offCam = api.subscribeCameraStream(() => {});
        electron.renderer.emit('ausm:screenFrame', {}, { frameNumber: 1 });
        off();
        offCam();
        electron.renderer.emit('ausm:screenFrame', {}, { frameNumber: 2 });
        assert.deepEqual(frames, [{ frameNumber: 1 }]);
        assert.deepEqual(electron.rendererSends.map(([c]) => c), [
            'ausm:screenStream:subscribe', 'ausm:cameraStream:subscribe', 'ausm:screenStream:unsubscribe', 'ausm:cameraStream:unsubscribe',
        ]);
    });

    test('invoke helpers use the matching main-process handler channels', async () => {
        const api = createAUSMPreloadAPI();
        await api.getScreenDisplays();
        await api.getCameraDevices();
        await api.getPreviewFps();
        await api.setPreviewFps({ screenFps: 30 });
        assert.deepEqual(electron.rendererInvokes, [
            ['ausm:screenStream:getDisplays', undefined], ['ausm:cameraStream:getDevices', undefined],
            ['ausm:streamFps:get', undefined], ['ausm:streamFps:set', { screenFps: 30 }],
        ]);
        const handled = new FakeIpcMain();
        setupAUSMIPCHandlers(handled as any, fakeRuntime() as any);
        for (const [channel] of electron.rendererInvokes) assert.ok(handled.handlers.has(channel), channel);
        for (const [channel] of electron.rendererSends) assert.ok(handled.listeners.has(channel), channel);
    });

    test('exposeAUSM exposes window.ausm once, merging extras over the defaults', () => {
        const extra = () => 'mine';
        exposeAUSM({ myInvoke: extra, onTaskEvent: extra });
        const api = electron.exposed.get('ausm')!;
        assert.equal(api.myInvoke, extra);
        assert.equal(api.onTaskEvent, extra, 'extras override');
        assert.equal(typeof api.onDetectorEvent, 'function');
    });
});

describe('setupAUSMElectronBridge', () => {
    test('forwards every runtime event type to its channel', () => {
        const rt = fakeRuntime();
        const win = new FakeWindow();
        const bridge = setupAUSMElectronBridge(win as any, rt as any);
        const cases: Array<[string, string]> = [
            ['onTextSelectionEvent', AUSM_IPC_CHANNELS.TEXT_SELECTION], ['onCopyPasteEvent', AUSM_IPC_CHANNELS.COPY_PASTE],
            ['onApplicationSwitchEvent', AUSM_IPC_CHANNELS.WINDOW_STATE], ['subscribeToTextInputEvent', AUSM_IPC_CHANNELS.TEXT_INPUT],
            ['onCursorPlusPlusEvent', AUSM_IPC_CHANNELS.CURSOR_PLUS_PLUS], ['onSpaceChangeEvent', AUSM_IPC_CHANNELS.SPACE_CHANGE],
            ['onTaskEvent', AUSM_IPC_CHANNELS.TASK], ['onDetectorEvent', AUSM_IPC_CHANNELS.DETECTOR],
        ];
        for (const [sub, channel] of cases) {
            rt.fire(sub, { kind: sub });
            assert.deepEqual(win.webContents.sent.at(-1), [channel, { kind: sub }], sub);
        }
        assert.equal(bridge.window, win);
        assert.doesNotThrow(() => bridge.cleanup());
    });

    test('material events drop the inline frame before crossing IPC', () => {
        const rt = fakeRuntime();
        const win = new FakeWindow();
        setupAUSMElectronBridge(win as any, rt as any);
        rt.fire('onMaterialEvent', { materialId: 'm', frameDataBase64: 'X'.repeat(1000) });
        assert.deepEqual(win.webContents.sent[0], [AUSM_IPC_CHANNELS.MATERIAL_EVENT, { materialId: 'm' }]);
    });

    test('nothing is sent to a destroyed window', () => {
        const rt = fakeRuntime();
        const win = new FakeWindow();
        setupAUSMElectronBridge(win as any, rt as any);
        win.destroyed = true;
        rt.fire('onTaskEvent', {});
        assert.equal(win.webContents.sent.length, 0);
    });

    test('optional runtime subscriptions may be missing', () => {
        const rt = fakeRuntime({ omit: ['onCopyPasteEvent', 'onCursorPlusPlusEvent', 'onMaterialEvent', 'onSpaceChangeEvent', 'onTaskEvent', 'onDetectorEvent'] });
        assert.doesNotThrow(() => setupAUSMElectronBridge(new FakeWindow() as any, rt as any));
    });

    test('screenshots with inline data become data URLs without the raw payload', () => {
        const rt = fakeRuntime();
        const win = new FakeWindow();
        setupAUSMElectronBridge(win as any, rt as any);
        rt.fire('onScreenshotEvent', { type: 'REGION', imageData: { dataBase64: 'QUJD', width: 4, height: 2, mimeType: 'image/png' } });
        const [channel, payload] = win.webContents.sent[0] as [string, any];
        assert.equal(channel, AUSM_IPC_CHANNELS.SCREENSHOT);
        assert.equal(payload.imageUrl, 'data:image/png;base64,QUJD');
        assert.equal(payload.imageWidth, 4);
        assert.equal(payload.imageData, undefined);
    });

    test('screenshots on disk are copied into the cache and served via the custom scheme', async () => {
        const rt = fakeRuntime();
        const win = new FakeWindow();
        setupAUSMElectronBridge(win as any, rt as any);
        const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ausm-shot-')), 'shot.jpg');
        fs.writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        rt.fire('onScreenshotEvent', { eventID: 'shot/1 a', imagePath: src, imageWidth: 10, imageHeight: 20, timestamp: 1 });
        const payload = win.webContents.sent[0][1] as any;
        assert.equal(payload.imageUrl, 'ausm-screenshot://screenshot/shot_1_a');
        assert.equal(payload.imageWidth, 10);
        assert.equal(fs.existsSync(src), true, 'source left for other subscribers (runtime memory)');
        const cached = path.join(userDataDir, 'ausm-screenshots', 'shot_1_a.jpg');
        assert.ok(fs.existsSync(cached));

        // A duplicate event whose source is already gone reuses the cached copy.
        fs.rmSync(src);
        rt.fire('onScreenshotEvent', { eventID: 'dup', imagePath: src, timestamp: 2 });
        assert.equal((win.webContents.sent[1][1] as any).imageUrl, 'ausm-screenshot://screenshot/shot_1_a');

        const handler = electron.protocolHandlers.get(AUSM_SCREENSHOT_SCHEME)!;
        const ok = handler({ url: 'ausm-screenshot://screenshot/shot_1_a' });
        assert.equal(ok.status, 200);
        assert.equal(ok.headers.get('Content-Type'), 'image/jpeg');
        assert.equal(Buffer.from(await ok.arrayBuffer()).length, 4);
        fs.rmSync(path.dirname(src), { recursive: true, force: true });
    });

    test('the screenshot cache keeps the newest 50 files and drops ones older than 24 h', () => {
        const dir = path.join(userDataDir, 'ausm-screenshots');
        fs.mkdirSync(dir, { recursive: true });
        for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
        const now = Date.now() / 1000;
        for (let i = 0; i < 55; i++) {
            const f = path.join(dir, `old${i}.jpg`);
            fs.writeFileSync(f, 'x');
            fs.utimesSync(f, now - 3600 + i, now - 3600 + i);
        }
        const stale = path.join(dir, 'stale.jpg');
        fs.writeFileSync(stale, 'x');
        fs.utimesSync(stale, now - 25 * 3600, now - 25 * 3600);

        const rt = fakeRuntime();
        setupAUSMElectronBridge(new FakeWindow() as any, rt as any);
        const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ausm-shot-')), 'shot.jpg');
        fs.writeFileSync(src, 'x');
        rt.fire('onScreenshotEvent', { eventID: 'newest', imagePath: src, timestamp: 1 });
        const left = fs.readdirSync(dir);
        assert.equal(left.length, 50);
        assert.ok(left.includes('newest.jpg'));
        assert.ok(!left.includes('stale.jpg'));
        assert.ok(!left.includes('old0.jpg'), 'oldest beyond the cap are removed');
        fs.rmSync(path.dirname(src), { recursive: true, force: true });
    });

    test('cleanup unsubscribes from the runtime and stops forwarding', () => {
        const rt = fakeRuntime();
        const win = new FakeWindow();
        const bridge = setupAUSMElectronBridge(win as any, rt as any);
        bridge.cleanup();
        for (const [name, list] of rt.subs) assert.equal(list.length, 0, name);

        // A runtime without unsubscribe handles: the forwarders still go quiet.
        const legacy = fakeRuntime({ noUnsubscribe: true });
        const win2 = new FakeWindow();
        setupAUSMElectronBridge(win2 as any, legacy as any).cleanup();
        legacy.fire('onTaskEvent', {});
        legacy.fire('onScreenshotEvent', { imageData: { dataBase64: 'QQ==', width: 1, height: 1 } });
        assert.equal(win2.webContents.sent.length, 0);
    });

    test('logging reports lengths, never selected or copied text', () => {
        const logs: string[] = [];
        const saved = console.log;
        console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
        try {
            const rt = fakeRuntime();
            setupAUSMElectronBridge(new FakeWindow() as any, rt as any, { debug: true });
            rt.fire('onTextSelectionEvent', { selectedText: 'SECRET-SELECTION' });
            rt.fire('onCopyPasteEvent', { action: 'COPY', contentType: 'text', content: 'SECRET-CLIP' });
        } finally {
            console.log = saved;
        }
        assert.ok(logs.some((l) => l.includes('<16 chars>')));
        assert.ok(!logs.some((l) => l.includes('SECRET')));
    });

    test('a missing screenshot file yields no image URL', () => {
        const rt = fakeRuntime();
        const win = new FakeWindow();
        setupAUSMElectronBridge(win as any, rt as any);
        rt.fire('onScreenshotEvent', { imagePath: path.join(os.tmpdir(), 'definitely-missing-ausm.jpg') });
        assert.equal((win.webContents.sent[0][1] as any).imageUrl, null);
    });
});

describe('screenshot protocol handler', () => {
    test('serveAUSMScreenshotCache is idempotent', () => {
        serveAUSMScreenshotCache();
        serveAUSMScreenshotCache();
        assert.ok(electron.protocolHandlers.has(AUSM_SCREENSHOT_SCHEME));
    });

    test('unknown paths and missing ids return 404', () => {
        serveAUSMScreenshotCache();
        const handler = electron.protocolHandlers.get(AUSM_SCREENSHOT_SCHEME)!;
        assert.equal(handler({ url: 'ausm-screenshot://other/x' }).status, 404);
        assert.equal(handler({ url: 'ausm-screenshot://screenshot/nope' }).status, 404);
    });

    test('path traversal outside the cache directory is refused', () => {
        serveAUSMScreenshotCache();
        const handler = electron.protocolHandlers.get(AUSM_SCREENSHOT_SCHEME)!;
        const outside = path.join(userDataDir, 'secret.jpg');
        fs.writeFileSync(outside, 'not for the renderer');
        for (const id of ['..%2Fsecret', '..%2F..%2F' + encodeURIComponent(path.basename(userDataDir)) + '%2Fsecret', '%2E%2E%2Fsecret']) {
            assert.equal(handler({ url: `ausm-screenshot://screenshot/${id}` }).status, 404, id);
        }
    });

    test('malformed percent-encoding returns 404 instead of throwing', () => {
        serveAUSMScreenshotCache();
        const handler = electron.protocolHandlers.get(AUSM_SCREENSHOT_SCHEME)!;
        assert.equal(handler({ url: 'ausm-screenshot://screenshot/%E0%A4%A' }).status, 404);
    });
});

describe('setupAUSMIPCHandlers', () => {
    test('registers every renderer→main channel', () => {
        const ipc = new FakeIpcMain();
        setupAUSMIPCHandlers(ipc as any, fakeRuntime() as any);
        for (const ch of [AUSM_IPC_CHANNELS.GET_SCREENSHOT, AUSM_IPC_CHANNELS.GET_CONTEXT, AUSM_IPC_CHANNELS.SCREEN_STREAM_GET_DISPLAYS,
            AUSM_IPC_CHANNELS.CAMERA_STREAM_GET_DEVICES, AUSM_IPC_CHANNELS.STREAM_FPS_GET, AUSM_IPC_CHANNELS.STREAM_FPS_SET]) {
            assert.ok(ipc.handlers.has(ch), ch);
        }
        for (const ch of [AUSM_IPC_CHANNELS.EMIT_TEST_EVENT, AUSM_IPC_CHANNELS.SCREEN_STREAM_SUBSCRIBE, AUSM_IPC_CHANNELS.SCREEN_STREAM_UNSUBSCRIBE,
            AUSM_IPC_CHANNELS.CAMERA_STREAM_SUBSCRIBE, AUSM_IPC_CHANNELS.CAMERA_STREAM_UNSUBSCRIBE]) {
            assert.ok(ipc.listeners.has(ch), ch);
        }
    });

    test('test-event emission routes each type to the runtime; unknown types are ignored', () => {
        const ipc = new FakeIpcMain();
        const rt = fakeRuntime();
        setupAUSMIPCHandlers(ipc as any, rt as any);
        const emit = ipc.listeners.get(AUSM_IPC_CHANNELS.EMIT_TEST_EVENT)!;
        for (const type of ['textSelection', 'screenshot', 'copyPaste', 'windowState', 'textInput', 'cursorPlusPlus', 'task', 'detector', 'bogus']) {
            emit({}, type, { t: type });
        }
        assert.deepEqual(rt.emitted.map(([name]: [string]) => name), [
            'emitTextSelectionEvent', 'emitScreenshotEvent', 'emitCopyPasteEvent', 'emitWindowStateEvent', 'emitTextInputEvent',
            'emitCursorPlusPlusEvent', 'emitTaskEvent', 'emitDetectorEvent',
        ]);
    });

    test('placeholder handlers return null', async () => {
        const ipc = new FakeIpcMain();
        setupAUSMIPCHandlers(ipc as any, fakeRuntime() as any);
        assert.equal(await ipc.handlers.get(AUSM_IPC_CHANNELS.GET_SCREENSHOT)!({}, null), null);
        assert.equal(await ipc.handlers.get(AUSM_IPC_CHANNELS.GET_CONTEXT)!({}, 'id'), null);
    });

    test('preview FPS get/set clamps, updates services and echoes to the sender', async () => {
        const ipc = new FakeIpcMain();
        const rt = fakeRuntime();
        const updates: unknown[] = [];
        rt.screenService = { updateConfiguration: async (c: unknown) => { updates.push(c); } };
        rt.cameraService = { updateConfiguration: async () => { throw new Error('camera busy'); } };
        setupAUSMIPCHandlers(ipc as any, rt as any);
        const sender = new FakeWebContents();
        const set = ipc.handlers.get(AUSM_IPC_CHANNELS.STREAM_FPS_SET)!;
        assert.deepEqual(await set({ sender }, { screenFps: 500, cameraFps: Number.NaN }), { screenFps: 60, cameraFps: DEFAULT_STREAM_FPS });
        assert.deepEqual(updates, [{ fps: 60 }]);
        assert.deepEqual(await set({ sender }, null), { screenFps: 60, cameraFps: DEFAULT_STREAM_FPS });
        const got = await ipc.handlers.get(AUSM_IPC_CHANNELS.STREAM_FPS_GET)!({ sender });
        assert.deepEqual(got, { screenFps: 60, cameraFps: DEFAULT_STREAM_FPS });
        assert.ok(sender.sent.every(([c]) => c === AUSM_IPC_CHANNELS.STREAM_FPS));
        sender.destroyed = true;
        await ipc.handlers.get(AUSM_IPC_CHANNELS.STREAM_FPS_GET)!({ sender });
        assert.equal(sender.sent.length, 3, 'no send to a destroyed sender');
    });

    test('screen stream: polls only while subscribed and skips repeated frame numbers', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const ipc = new FakeIpcMain();
        const rt = fakeRuntime();
        rt.frames.set('d1', { displayId: 'd1', frameNumber: 1, width: 1, height: 1, jpegSize: 1, timestamp: 0, data: 'f1' });
        setupAUSMIPCHandlers(ipc as any, rt as any);
        const wc = new FakeWebContents();
        const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

        ipc.listeners.get(AUSM_IPC_CHANNELS.SCREEN_STREAM_SUBSCRIBE)!({ sender: wc });
        ipc.listeners.get(AUSM_IPC_CHANNELS.SCREEN_STREAM_SUBSCRIBE)!({ sender: wc }); // duplicate ignored
        mock.timers.tick(0);
        await flush();
        assert.deepEqual(wc.sent.map(([c, d]: [string, any]) => [c, d.frameNumber]), [[AUSM_IPC_CHANNELS.SCREEN_FRAME, 1]]);

        mock.timers.tick(intervalMsForFps(streamRates.screenFps));
        await flush();
        assert.equal(wc.sent.length, 1, 'same frame number is not resent');

        rt.frames.set('d1', { ...rt.frames.get('d1'), frameNumber: 2 });
        mock.timers.tick(intervalMsForFps(streamRates.screenFps));
        await flush();
        assert.equal(wc.sent.length, 2);

        ipc.listeners.get(AUSM_IPC_CHANNELS.SCREEN_STREAM_UNSUBSCRIBE)!({ sender: wc });
        rt.frames.set('d1', { ...rt.frames.get('d1'), frameNumber: 3 });
        mock.timers.tick(1000);
        await flush();
        assert.equal(wc.sent.length, 2, 'no frames after unsubscribe');
    });

    test('screen stream getDisplays returns [] when the runtime throws', async () => {
        const ipc = new FakeIpcMain();
        const rt = fakeRuntime();
        rt.getScreenDisplays = async () => { throw new Error('no service'); };
        setupAUSMIPCHandlers(ipc as any, rt as any);
        assert.deepEqual(await ipc.handlers.get(AUSM_IPC_CHANNELS.SCREEN_STREAM_GET_DISPLAYS)!({}), []);
    });
});

describe('fps helpers', () => {
    test('clampStreamFps bounds, rounds and defaults non-finite input', () => {
        assert.equal(clampStreamFps(0), 1);
        assert.equal(clampStreamFps(-5), 1);
        assert.equal(clampStreamFps(1000), 60);
        assert.equal(clampStreamFps(29.6), 30);
        assert.equal(clampStreamFps(Number.NaN), DEFAULT_STREAM_FPS);
        assert.equal(clampStreamFps(Number.POSITIVE_INFINITY), DEFAULT_STREAM_FPS);
    });

    test('intervalMsForFps and preview quality tiers', () => {
        assert.equal(intervalMsForFps(10), 100);
        assert.equal(intervalMsForFps(60), 17);
        assert.equal(intervalMsForFps(0), 1000);
        assert.deepEqual([previewJpegQuality(60), previewJpegQuality(45), previewJpegQuality(24), previewJpegQuality(10)], [0.4, 0.4, 0.5, 0.6]);
    });
});
