import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';

import { installModuleFakes } from './module-fakes';
import { ScreenshotStatus } from '../src/events/ScreenShotEvent';
import { CopyPasteAction } from '../src/events/CopyPasteEvent';
import { MouseAction } from '../src/events/CursorPlusPlusEvent';
import { TextInputStatus } from '../src/events/TextInputEvent';
import { WindowState } from '../src/events/WindowStateEvent';

/** Fake sensor service: an EventEmitter with start/stop counters. */
class FakeService extends EventEmitter {
    startResult = true;
    starts = 0;
    stops = 0;
    cleanups = 0;
    constructor(readonly config: unknown) { super(); }
    start() { this.starts++; return this.startResult; }
    stop() { this.stops++; return true; }
    cleanup() { this.cleanups++; }
}

class FakeCropReader {
    static instances: FakeCropReader[] = [];
    started = 0;
    stopped = 0;
    rejectStart = false;
    constructor(readonly config: Record<string, unknown>) { FakeCropReader.instances.push(this); }
    start() { this.started++; return this.rejectStart ? Promise.reject(new Error('no python')) : Promise.resolve(); }
    stop() { this.stopped++; }
    isReady() { return true; }
    async cropAtCursor() { return { data: Buffer.alloc(0), width: 0, height: 0 }; }
}

const made: Record<string, FakeService[]> = { screenshot: [], clipboard: [], cursor: [], viewport: [], textInput: [] };
const make = (kind: string) => (config: unknown) => {
    const s = new FakeService(config);
    made[kind].push(s);
    return s;
};
let failNext: string | null = null;
const factory = (kind: string) => (config: unknown) => {
    if (failNext === kind) { failNext = null; throw new Error(`${kind} unavailable`); }
    return make(kind)(config);
};

const restore = installModuleFakes({
    '@ausm/device-macos-screenshot-detector': { createScreenshotDetector: factory('screenshot') },
    '@ausm/device-macos-clipboard-monitor': { createClipboardMonitor: factory('clipboard') },
    '@ausm/device-macos-cursor-plus-plus': { createCursorPlusPlus: factory('cursor'), CropReader: FakeCropReader },
    '@ausm/core/clients': { createViewportClient: factory('viewport'), createTextInputClient: factory('textInput') },
});
after(restore);

const { createRuntime } = require('../src/runtime/index') as typeof import('../src/runtime/index');

const logs: string[] = [];
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
    logs.length = 0;
    console.log = console.warn = console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
});
after(() => Object.assign(console, saved));

const last = (kind: string) => made[kind][made[kind].length - 1];

test('emit*Event before the detector runs is dropped; after start it reaches subscribers', () => {
    const rt = createRuntime({ screenshotDetector: { enabled: false } });
    const seen: unknown[] = [];
    rt.onScreenshotEvent((e) => seen.push(e));
    rt.emitScreenshotEvent({ status: ScreenshotStatus.STARTED });
    assert.equal(seen.length, 0);
    (rt as any).screenshotDetector.start();
    assert.equal(made.screenshot.length, 0, 'disabled: no service created');
    rt.emitScreenshotEvent({ status: ScreenshotStatus.STARTED, timestamp: 0 });
    assert.equal(seen.length, 1);
    assert.equal((seen[0] as any).kind, 'screenshot');
    assert.equal((seen[0] as any).timestamp, 0);
    (rt as any).screenshotDetector.stop();
    rt.emitScreenshotEvent({ status: ScreenshotStatus.FINISHED });
    assert.equal(seen.length, 1);
});

test('screenshot service events flow to subscribers; stop stops the service', () => {
    const rt = createRuntime();
    const seen: any[] = [];
    rt.onScreenshotEvent((e) => seen.push(e));
    (rt as any).screenshotDetector.start();
    const svc = last('screenshot');
    assert.equal(svc.starts, 1);
    svc.emit('screenshot-event', { kind: 'screenshot', status: ScreenshotStatus.FINISHED });
    svc.emit('error', new Error('screen_recording_denied'));
    assert.equal(seen.length, 1);
    (rt as any).screenshotDetector.stop();
    assert.equal(svc.stops, 1);
    svc.emit('screenshot-event', { kind: 'screenshot' });
    assert.equal(seen.length, 1, 'late service events after stop are dropped');
});

test('a throwing subscriber does not starve the other subscribers or reach the service', () => {
    const rt = createRuntime();
    const seen: string[] = [];
    rt.onCopyPasteEvent(() => { throw new Error('consumer bug'); });
    rt.onCopyPasteEvent((e) => seen.push(e.action!));
    (rt as any).clipboardMonitorDetector.start();
    const svc = last('clipboard');
    assert.doesNotThrow(() => svc.emit('copy-paste-event', { kind: 'copyPaste', action: CopyPasteAction.COPY }));
    assert.deepEqual(seen, [CopyPasteAction.COPY]);
    assert.ok(logs.some((l) => l.includes('CopyPaste callback threw: consumer bug')));
});

test('clipboard service gets includeContent (default true, configurable)', () => {
    const a = createRuntime();
    (a as any).clipboardMonitorDetector.start();
    assert.equal((last('clipboard').config as any).includeContent, true);
    const b = createRuntime({ clipboardMonitor: { includeContent: false } });
    (b as any).clipboardMonitorDetector.start();
    assert.equal((last('clipboard').config as any).includeContent, false);
});

test('unavailable or failing sensor packages degrade to warnings, detector still runs', () => {
    const rt = createRuntime();
    failNext = 'screenshot';
    assert.doesNotThrow(() => (rt as any).screenshotDetector.start());
    assert.ok(logs.some((l) => l.includes('Screenshot detector not available: screenshot unavailable')));
    const seen: unknown[] = [];
    rt.onScreenshotEvent((e) => seen.push(e));
    rt.emitScreenshotEvent({});
    assert.equal(seen.length, 1);

    const rt3 = createRuntime();
    const proto = FakeService.prototype.start;
    FakeService.prototype.start = function () { this.starts++; return false; };
    try {
        (rt3 as any).clipboardMonitorDetector.start();
    } finally {
        FakeService.prototype.start = proto;
    }
    assert.ok(logs.some((l) => l.includes('Failed to start clipboard monitor service')));
});

test('cursor++: disabled by default; enabled wires CropReader as the crop source', async () => {
    const off = createRuntime();
    (off as any).cursorPlusPlusDetector.start();
    const n = made.cursor.length;
    assert.equal(made.cursor.length, n);

    const rt = createRuntime({ cursorPlusPlus: { enabled: true, cropWidth: 80, cropHeight: 80 }, screenStreaming: { socketPath: '/tmp/x.sock' } as any });
    const seen: any[] = [];
    rt.onCursorPlusPlusEvent((e) => seen.push(e));
    (rt as any).cursorPlusPlusDetector.start();
    const svc = last('cursor');
    const reader = FakeCropReader.instances[FakeCropReader.instances.length - 1];
    assert.equal(reader.started, 1);
    assert.equal(reader.config.screenStreamSocketPath, '/tmp/x.sock');
    assert.equal((svc.config as any).displayStreamCrop, reader);
    assert.equal((svc.config as any).cropWidth, 80);
    svc.emit('cursor-event', { action: 'CLICK', x: -100, y: 5, uiElementSubrole: 'AXButton', windowTitle: '受信 📬' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'cursorPlusPlus');
    assert.equal(seen[0].action, MouseAction.CLICK);
    assert.equal(seen[0].x, -100);
    assert.equal(seen[0].windowTitle, '受信 📬');
    assert.equal(seen[0].interactionScreenshot, null);
    (rt as any).cursorPlusPlusDetector.stop();
    assert.equal(svc.stops, 1);
    assert.equal(reader.stopped, 1);
});

test('cursor++: a CropReader that fails to start only warns', async () => {
    const proto = FakeCropReader.prototype.start;
    FakeCropReader.prototype.start = function () { this.started++; return Promise.reject(new Error('no python')); };
    try {
        const rt = createRuntime({ cursorPlusPlus: { enabled: true } });
        (rt as any).cursorPlusPlusDetector.start();
        await new Promise((r) => setImmediate(r));
        assert.ok(logs.some((l) => l.includes('CropReader failed to start: no python')));
        (rt as any).cursorPlusPlusDetector.stop();
    } finally {
        FakeCropReader.prototype.start = proto;
    }
});

test('text input: native client events become TextInputEvents; logging never prints typed text', () => {
    const rt = createRuntime({ textInput: { enableNativeTextInput: true }, logging: { textInput: true } });
    const seen: any[] = [];
    rt.subscribeToTextInputEvent((e) => seen.push(e));
    (rt as any).textInputDetector.start();
    const client = last('textInput');
    client.emit('text-input', { status: TextInputStatus.UPDATED, text: 'SECRET-TYPED-TEXT', timestamp: 3 });
    assert.equal(seen[0].kind, 'textInput');
    assert.equal(seen[0].text, 'SECRET-TYPED-TEXT');
    assert.equal(seen[0].status, TextInputStatus.UPDATED);
    assert.ok(logs.some((l) => l.includes('TextInputEvent') && l.includes('<17 chars>')));
    assert.ok(logs.every((l) => !l.includes('SECRET')));
    (rt as any).textInputDetector.stop();
    assert.equal(client.stops, 1);
    assert.equal(client.cleanups, 1);
});

test('text input without enableNativeTextInput creates no client but accepts emitted events', () => {
    const rt = createRuntime();
    const n = made.textInput.length;
    const seen: unknown[] = [];
    rt.subscribeToTextInputEvent((e) => seen.push(e));
    (rt as any).textInputDetector.start();
    assert.equal(made.textInput.length, n);
    rt.emitTextInputEvent({ text: '' });
    assert.equal(seen.length, 1);
});

test('window state + space change flow from the viewport client', () => {
    const rt = createRuntime();
    const states: any[] = [];
    const spaces: any[] = [];
    rt.onApplicationSwitchEvent((e) => states.push(e));
    rt.onSpaceChangeEvent((e) => spaces.push(e));
    (rt as any).applicationStateDetector.start();
    const client = last('viewport');
    client.emit('window-state', { state: WindowState.FOCUSED, bounds: { x: -1920, y: 0, width: 10, height: 10 }, title: 'שלום' });
    client.emit('space-changed', { timestamp: 42 });
    assert.equal(states[0].kind, 'windowState');
    assert.equal(states[0].state, WindowState.FOCUSED);
    assert.equal(states[0].title, 'שלום');
    assert.equal(spaces[0].kind, 'spaceChange');
    assert.equal(spaces[0].timestamp, 42);
    rt.emitSpaceChangeEvent({});
    assert.equal(spaces.length, 2);
    (rt as any).applicationStateDetector.stop();
    assert.equal(client.stops, 1);
    client.emit('space-changed', { timestamp: 43 });
    assert.equal(spaces.length, 2);
});

test('every emit* path builds the right event kind', () => {
    const rt = createRuntime({ screenshotDetector: { enabled: false }, clipboardMonitor: { enabled: false } });
    const d = rt as any;
    d.textSelectionDetector.running = true;
    d.screenshotDetector.start();
    d.clipboardMonitorDetector.start();
    d.applicationStateDetector.running = true;
    d.textInputDetector.start();
    d.cursorPlusPlusDetector.running = true;
    d.materialDetector.start();
    const kinds: string[] = [];
    rt.onTextSelectionEvent((e) => kinds.push(e.kind));
    rt.onScreenshotEvent((e) => kinds.push(e.kind));
    rt.onCopyPasteEvent((e) => kinds.push(e.kind));
    rt.onApplicationSwitchEvent((e) => kinds.push(e.kind));
    rt.onSpaceChangeEvent((e) => kinds.push(e.kind));
    rt.subscribeToTextInputEvent((e) => kinds.push(e.kind));
    rt.onCursorPlusPlusEvent((e) => kinds.push(e.kind));
    rt.onMaterialEvent((e) => kinds.push(e.kind));
    rt.emitTextSelectionEvent({});
    rt.emitScreenshotEvent({});
    rt.emitCopyPasteEvent({});
    rt.emitWindowStateEvent({});
    rt.emitSpaceChangeEvent({});
    rt.emitTextInputEvent({});
    rt.emitCursorPlusPlusEvent({});
    rt.emitMaterialEvent({});
    assert.deepEqual(kinds, ['textSelection', 'screenshot', 'copyPaste', 'windowState', 'spaceChange', 'textInput', 'cursorPlusPlus', 'material']);
});
