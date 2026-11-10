import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';

import { installModuleFakes } from './module-fakes';
import { TextInputStatus } from '../src/events/TextInputEvent';
import { WindowState } from '../src/events/WindowStateEvent';
import { DetectionSource, SelectionMethod, TextElementType } from '../src/events/TextSelectionEvent';

// ── Fakes for the device packages ─────────────────────────────────────────

class FakeMonitor extends EventEmitter {
    static instances: FakeMonitor[] = [];
    startResult = true;
    starts: unknown[] = [];
    stops = 0;
    cleanups = 0;
    constructor() {
        super();
        FakeMonitor.instances.push(this);
    }
    start(config?: unknown) { this.starts.push(config); return this.startResult; }
    stop() { this.stops++; return true; }
    cleanup() { this.cleanups++; }
}

class FakeNativeSelectionMonitor {
    static instances: FakeNativeSelectionMonitor[] = [];
    static throwOnConstruct = false;
    callback: ((d: any) => void) | null = null;
    calls: string[] = [];
    throwOnStart = false;
    trusted = true;
    constructor() {
        if (FakeNativeSelectionMonitor.throwOnConstruct) throw new Error('no addon instance');
        FakeNativeSelectionMonitor.instances.push(this);
    }
    start(cb: (d: any) => void) {
        this.calls.push('start');
        if (this.throwOnStart) throw new Error('AX not trusted');
        this.callback = cb;
    }
    stop() { this.calls.push('stop'); }
    disableClipboard() { this.calls.push('disableClipboard'); }
    isProcessTrusted() { return this.trusted; }
    requestProcessTrust() { return false; }
}

const restore = installModuleFakes({
    '@ausm/device-macos-text-input': { TextInputMonitorService: FakeMonitor },
    '@ausm/device-macos-viewport-manager': { createViewportMonitor: () => new FakeMonitor() },
    'node-gyp-build': () => ({ SelectionMonitor: FakeNativeSelectionMonitor }),
});
after(restore);

// Loaded after the fakes are installed.
const { TextInputClient, createTextInputClient } = require('../src/runtime/clients/text-input-client') as typeof import('../src/runtime/clients/text-input-client');
const { ViewportClient, createViewportClient } = require('../src/runtime/clients/viewport-client') as typeof import('../src/runtime/clients/viewport-client');
const { SelectionClient, createSelectionClient } = require('../src/runtime/clients/text-selection-client') as typeof import('../src/runtime/clients/text-selection-client');

const lastMonitor = () => FakeMonitor.instances[FakeMonitor.instances.length - 1];

function silenced<T>(fn: () => T): T {
    const saved = { warn: console.warn, error: console.error, log: console.log };
    console.warn = console.error = console.log = () => {};
    try { return fn(); } finally { Object.assign(console, saved); }
}

// ── TextInputClient ───────────────────────────────────────────────────────

test('TextInputClient maps helper statuses onto the core TextInputStatus enum', () => {
    const client = createTextInputClient();
    const monitor = lastMonitor();
    const out: any[] = [];
    client.on('text-input', (e) => out.push(e));
    assert.equal(client.start(), true);
    monitor.emit('text-input', { status: 'TEXT_EDITING_STARTED', text: '' });
    monitor.emit('text-input', { status: 'TEXT_EDITING_UPDATED', text: 'a' });
    monitor.emit('text-input', { status: 'TEXT_EDITING_FINISHED', text: 'a' });
    assert.deepEqual(out.map((e) => e.status), [TextInputStatus.STARTED, TextInputStatus.UPDATED, TextInputStatus.ENDED]);
});

test('TextInputClient accepts core status values and nulls out unknown ones', () => {
    const client = new TextInputClient();
    const monitor = lastMonitor();
    const out: any[] = [];
    client.on('text-input', (e) => out.push(e));
    client.start();
    monitor.emit('text-input', { status: 'TEXT_INPUT_ENDED' });
    monitor.emit('text-input', { status: 'SOMETHING_ELSE' });
    monitor.emit('text-input', {});
    assert.deepEqual(out.map((e) => e.status), [TextInputStatus.ENDED, null, null]);
});

test('TextInputClient fills ids/timestamps, keeps provided values and builds the source element', () => {
    const client = new TextInputClient();
    const monitor = lastMonitor();
    const out: any[] = [];
    client.on('text-input', (e) => out.push(e));
    client.start();
    const before = Date.now();
    monitor.emit('text-input', {
        status: 'TEXT_EDITING_UPDATED', text: 'שלום 👋', timestamp: 0, eventID: 'given', displayID: 'd1',
        sourceElement: { type: 'AXTextField', application: 'com.apple.Safari', content: 'ctx', screenBounds: { x: -5, y: -5, width: 1, height: 1 } },
        caretScreenPosition: { x: -3, y: 4 },
    });
    monitor.emit('text-input', { status: 'TEXT_EDITING_UPDATED' });
    assert.equal(out[0].eventID, 'given');
    assert.equal(out[0].timestamp, 0);
    assert.equal(out[0].displayID, 'd1');
    assert.equal(out[0].text, 'שלום 👋');
    assert.deepEqual(out[0].sourceElement, {
        type: 'AXTextField', application: 'com.apple.Safari', applicationID: null, applicationLocalizedName: null,
        screenBounds: { x: -5, y: -5, width: 1, height: 1 }, screenContent: 'ctx',
    });
    assert.deepEqual(out[0].caretScreenPosition, { x: -3, y: 4 });
    assert.match(out[1].eventID, /^txt_\d+_/);
    assert.ok(out[1].timestamp >= before);
    assert.equal(out[1].text, null);
    assert.equal(out[1].sourceElement, null);
    assert.equal(out[1].caretScreenPosition, null);
});

test('TextInputClient drops events while stopped and forwards status/errors', () => {
    const client = new TextInputClient({ debug: false });
    const monitor = lastMonitor();
    const out: any[] = [];
    const statuses: string[] = [];
    const errors: string[] = [];
    client.on('text-input', (e) => out.push(e));
    client.on('status', (s) => statuses.push(s));
    client.on('error', (e) => errors.push(e.message));
    monitor.emit('text-input', { status: 'TEXT_EDITING_STARTED' });
    assert.equal(out.length, 0, 'not started');
    client.start();
    client.start(); // no second monitor start
    assert.equal(monitor.starts.length, 1);
    monitor.emit('status', 'started');
    monitor.emit('error', new Error('helper gone'));
    client.stop();
    client.stop();
    assert.equal(monitor.stops, 1);
    monitor.emit('text-input', { status: 'TEXT_EDITING_STARTED' });
    assert.equal(out.length, 0, 'stopped');
    assert.deepEqual(statuses, ['started']);
    assert.deepEqual(errors, ['helper gone']);
    client.cleanup();
    assert.equal(monitor.cleanups, 1);
    assert.equal(client.listenerCount('text-input'), 0);
});

test('TextInputClient: failed monitor start leaves the client stopped; autoStart starts it', () => {
    const a = new TextInputClient();
    lastMonitor().startResult = false;
    assert.equal(a.start(), false);
    assert.equal(a.isRunning(), false);
    const b = new TextInputClient({ autoStart: true });
    assert.equal(b.isRunning(), true);
});

test('TextInputClient without an error listener does not crash the host on monitor errors', () => {
    const client = new TextInputClient();
    const monitor = lastMonitor();
    silenced(() => assert.doesNotThrow(() => monitor.emit('error', new Error('helper crashed'))));
    client.cleanup();
});

test('TextInputClient debug log never contains typed text', () => {
    const logs: string[] = [];
    const saved = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
    try {
        const client = new TextInputClient({ debug: true });
        const monitor = lastMonitor();
        client.start();
        monitor.emit('text-input', { status: 'TEXT_EDITING_UPDATED', text: 'SECRET-TYPED' });
    } finally {
        console.log = saved;
    }
    assert.ok(logs.length > 0);
    assert.ok(logs.every((l) => !l.includes('SECRET')));
});

// ── ViewportClient ────────────────────────────────────────────────────────

const nativeWin = (type: string, extra: Record<string, unknown> = {}) => ({
    type, windowId: 11, title: 'Inbox — 受信', ownerName: 'Mail', bundleId: 'com.apple.mail', pid: 77,
    bounds: { x: -1728, y: -1117, width: 1728, height: 1117 }, displayId: 2, timestamp: 1234, ...extra,
});

test('ViewportClient maps every window event type to WindowState', () => {
    const client = createViewportClient();
    const monitor = lastMonitor();
    const out: any[] = [];
    client.on('window-state', (e) => out.push(e));
    client.start();
    const map: Record<string, WindowState> = {
        'window-opened': WindowState.APPEAR,
        'window-closed': WindowState.VANISHED,
        'window-focused': WindowState.FOCUSED,
        'window-unfocused': WindowState.UNFOCUSED,
        'bounds-changed': WindowState.BOUNDS_CHANGED,
        'title-changed': WindowState.TITLE_CHANGED,
    };
    for (const t of Object.keys(map)) monitor.emit('window-event', nativeWin(t));
    assert.deepEqual(out.map((e) => e.state), Object.values(map));
    const e = out[0];
    assert.equal(e.application, 'Mail');
    assert.equal(e.title, 'Inbox — 受信');
    assert.equal(e.windowId, 11);
    assert.equal(e.pid, 77);
    assert.equal(e.displayId, 2);
    assert.equal(e.timestamp, 1234);
    assert.deepEqual(e.bounds, { x: -1728, y: -1117, width: 1728, height: 1117 });
    assert.equal(e.oldBounds, null);
    assert.equal(e.oldTitle, null);
    assert.equal(e.documentPath, null);
    assert.match(e.eventID, /^win_\d+_/);
});

test('ViewportClient carries optional fields; displayId 0 is preserved', () => {
    const client = new ViewportClient();
    const monitor = lastMonitor();
    const out: any[] = [];
    client.on('window-state', (e) => out.push(e));
    client.start();
    monitor.emit('window-event', nativeWin('title-changed', {
        oldTitle: 'old', oldBounds: { x: 0, y: 0, width: 1, height: 1 }, documentPath: '/Users/x/文書.pages', displayId: 0,
    }));
    assert.equal(out[0].oldTitle, 'old');
    assert.deepEqual(out[0].oldBounds, { x: 0, y: 0, width: 1, height: 1 });
    assert.equal(out[0].documentPath, '/Users/x/文書.pages');
    assert.equal(out[0].displayId, 0);
});

test('ViewportClient: unknown window event types are reported, not emitted with an undefined state', () => {
    const client = new ViewportClient();
    const monitor = lastMonitor();
    const out: any[] = [];
    const errors: string[] = [];
    client.on('window-state', (e) => out.push(e));
    client.on('error', (e) => errors.push(e.message));
    client.start();
    monitor.emit('window-event', nativeWin('window-minimized'));
    assert.equal(out.length, 0);
    assert.equal(errors.length, 1);
});

test('ViewportClient forwards space changes and drops everything while stopped', () => {
    const client = new ViewportClient();
    const monitor = lastMonitor();
    const states: any[] = [];
    const spaces: any[] = [];
    client.on('window-state', (e) => states.push(e));
    client.on('space-changed', (e) => spaces.push(e));
    monitor.emit('window-event', nativeWin('window-opened'));
    monitor.emit('space-changed', { type: 'space-changed', timestamp: 1 });
    assert.equal(states.length + spaces.length, 0);
    client.start();
    monitor.emit('space-changed', { type: 'space-changed', timestamp: 99 });
    assert.deepEqual(spaces, [{ timestamp: 99 }]);
    client.stop();
    monitor.emit('space-changed', { type: 'space-changed', timestamp: 100 });
    assert.equal(spaces.length, 1);
    client.cleanup();
    assert.equal(monitor.cleanups, 1);
});

test('ViewportClient: a throwing window-state listener is reported as an error', () => {
    const client = new ViewportClient();
    const monitor = lastMonitor();
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.message));
    client.on('window-state', () => { throw new Error('consumer bug'); });
    client.start();
    monitor.emit('window-event', nativeWin('window-opened'));
    assert.deepEqual(errors, ['Failed to process event: consumer bug']);
});

test('ViewportClient without an error listener does not crash on monitor errors', () => {
    const client = new ViewportClient();
    const monitor = lastMonitor();
    silenced(() => assert.doesNotThrow(() => monitor.emit('error', new Error('helper crashed'))));
    client.cleanup();
});

// ── SelectionClient ───────────────────────────────────────────────────────

const lastNative = () => FakeNativeSelectionMonitor.instances[FakeNativeSelectionMonitor.instances.length - 1];

function selectionEvent(extra: Record<string, unknown> = {}) {
    return {
        type: 'text-selection', text: 'selected', programName: 'com.apple.Safari', localizedName: 'Safari',
        method: 1, detectType: 1, posLevel: 3, isFullscreen: false,
        startTopX: 100, startTopY: 200, startBottomX: 100, startBottomY: 220,
        endTopX: 300, endTopY: 260, endBottomX: 300, endBottomY: 280,
        mouseStartX: 0, mouseStartY: 0, mouseEndX: 0, mouseEndY: 0,
        hasElementBounds: true, elementX: -10, elementY: 5, elementWidth: 800, elementHeight: 600,
        ...extra,
    };
}

function startedSelectionClient(options = {}) {
    const client = createSelectionClient(options);
    const out: any[] = [];
    client.on('selection', (e) => out.push(e));
    assert.equal(client.start(), true);
    const native = lastNative();
    return { client, native, out, send: (d: unknown) => native.callback!(d) };
}

test('SelectionClient maps a native selection to TextSelectionEventData', () => {
    const { send, out } = startedSelectionClient();
    send(selectionEvent());
    assert.equal(out.length, 1);
    const e = out[0];
    assert.equal(e.selectedText, 'selected');
    assert.deepEqual(e.screenBound, { x: 100, y: 200, width: 200, height: 80 });
    assert.equal(e.selectionMethod, SelectionMethod.MOUSE);
    assert.equal(e.detectionSource, DetectionSource.NATIVE);
    assert.equal(e.sourceElement.type, TextElementType.WEB_NON_EDITABLE_TEXT);
    assert.equal(e.sourceElement.application, 'com.apple.Safari');
    assert.equal(e.sourceElement.applicationLocalizedName, 'Safari');
    assert.deepEqual(e.sourceElement.screenBounds, { x: -10, y: 5, width: 800, height: 600 });
    assert.equal(e.displayID, null);
    assert.match(e.eventID, /^sel_\d+_/);
});

test('SelectionClient bounds: negative coordinates, reversed corners, low position level, degenerate rects', () => {
    const { send, out } = startedSelectionClient();
    send(selectionEvent({ startTopX: -2000, startTopY: -500, endBottomX: -1900, endBottomY: -480 }));
    send(selectionEvent({ startTopX: 300, startTopY: 280, endBottomX: 100, endBottomY: 200 })); // end before start
    send(selectionEvent({ posLevel: 2 }));
    send(selectionEvent({ startTopX: 5, endBottomX: 5 })); // zero width
    assert.deepEqual(out[0].screenBound, { x: -2000, y: -500, width: 100, height: 20 });
    assert.deepEqual(out[1].screenBound, { x: 100, y: 200, width: 200, height: 80 });
    assert.equal(out[2].screenBound, null);
    assert.equal(out[3].screenBound, null);
});

test('SelectionClient: element bounds only when reported and non-empty', () => {
    const { send, out } = startedSelectionClient();
    send(selectionEvent({ hasElementBounds: false }));
    send(selectionEvent({ elementWidth: 0, elementHeight: 0 }));
    assert.equal(out[0].sourceElement.screenBounds, null);
    assert.equal(out[1].sourceElement.screenBounds, null);
});

test('SelectionClient: detection type → selection method', () => {
    const { send, out } = startedSelectionClient();
    for (const detectType of [0, 1, 2, 3, 99]) send(selectionEvent({ detectType }));
    assert.deepEqual(out.map((e) => e.selectionMethod), [
        SelectionMethod.OTHER, SelectionMethod.MOUSE, SelectionMethod.DOUBLE_CLICK, SelectionMethod.MOUSE, SelectionMethod.OTHER,
    ]);
});

test('SelectionClient: element type inference matches whole words only', () => {
    const { send, out } = startedSelectionClient();
    const cases: Array<[string, string, TextElementType]> = [
        ['com.microsoft.VSCode', 'Code', TextElementType.CODE_EDITOR],
        ['com.todesktop.230313mzl4w4u92', 'Cursor', TextElementType.CODE_EDITOR],
        ['com.microsoft.Word', 'Microsoft Word', TextElementType.DOCUMENT_EDITOR],
        ['com.apple.mail', 'Mail', TextElementType.EMAIL],
        ['com.tinyspeck.slackmacgap', 'Slack', TextElementType.MESSAGE],
        ['com.apple.Preview', 'Preview', TextElementType.PDF_TEXT],
        ['company.thebrowser.Browser', 'Arc', TextElementType.WEB_NON_EDITABLE_TEXT],
        ['com.apple.Terminal', 'Terminal', TextElementType.OTHER],
        // substring false positives
        ['com.1password.1password', '1Password', TextElementType.OTHER],
        ['com.apple.Passwords', 'Passwords', TextElementType.OTHER],
        ['com.example.research', 'Research', TextElementType.OTHER],
        ['com.example.archiver', 'Archiver', TextElementType.OTHER],
        ['com.example.mailchimp-desktop', 'Mailchimp', TextElementType.OTHER],
        ['', '', TextElementType.OTHER],
    ];
    for (const [programName, localizedName] of cases) send(selectionEvent({ programName, localizedName }));
    assert.deepEqual(out.map((e) => e.sourceElement.type), cases.map((c) => c[2]));
});

test('SelectionClient: empty / whitespace-only selections are dropped; unicode text kept', () => {
    const { send, out } = startedSelectionClient();
    send(selectionEvent({ text: '' }));
    send(selectionEvent({ text: ' \n\t ' }));
    send(selectionEvent({ text: null }));
    send(selectionEvent({ text: '  مرحبا 👋 ' }));
    assert.deepEqual(out.map((e) => e.selectedText), ['  مرحبا 👋 ']);
});

test('SelectionClient forwards mouse and keyboard events by action', () => {
    const { client, send } = startedSelectionClient();
    const seen: string[] = [];
    for (const ev of ['mouse-down', 'mouse-up', 'mouse-move', 'mouse-wheel', 'key-down', 'key-up'] as const) {
        client.on(ev, () => seen.push(ev));
    }
    send({ type: 'mouse-event', action: 'mouse-down', x: -1, y: -1, button: 0, flag: 0 });
    send({ type: 'mouse-event', action: 'mouse-wheel', x: 0, y: 0, button: 0, flag: 0 });
    send({ type: 'keyboard-event', action: 'key-up', uniKey: 'a', vkCode: 0, sys: false, flags: 0 });
    send({ type: 'unknown-event' });
    send(null);
    assert.deepEqual(seen, ['mouse-down', 'mouse-wheel', 'key-up']);
});

test('SelectionClient lifecycle: status events, double start/stop, callbacks after stop ignored', () => {
    const client = new SelectionClient({ enableClipboard: false });
    const statuses: string[] = [];
    const out: any[] = [];
    client.on('status', (s) => statuses.push(s));
    client.on('selection', (e) => out.push(e));
    assert.equal(client.stop(), true, 'stop before start is a no-op');
    client.start();
    client.start();
    const native = lastNative();
    assert.deepEqual(native.calls, ['disableClipboard', 'start']);
    client.stop();
    client.stop();
    native.callback!(selectionEvent());
    assert.equal(out.length, 0);
    assert.deepEqual(statuses, ['started', 'stopped']);
    assert.equal(client.isProcessTrusted(), true);
    assert.equal(client.requestProcessTrust(), false);
    client.cleanup();
});

test('SelectionClient: native start failure is reported and leaves the client stopped', () => {
    const client = new SelectionClient();
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.message));
    (client as any).instance = new FakeNativeSelectionMonitor();
    (client as any).instance.throwOnStart = true;
    assert.equal(client.start(), false);
    assert.equal(client.isRunning(), false);
    assert.deepEqual(errors, ['Failed to start monitor: AX not trusted']);
});

test('SelectionClient: monitor construction failure reported; trust checks return false', () => {
    FakeNativeSelectionMonitor.throwOnConstruct = true;
    try {
        const client = new SelectionClient();
        const errors: string[] = [];
        client.on('error', (e) => errors.push(e.message));
        assert.equal(client.start(), false);
        assert.match(errors[0], /Failed to create monitor instance: no addon instance/);
        assert.equal(client.isProcessTrusted(), false);
        assert.equal(client.requestProcessTrust(), false);
    } finally {
        FakeNativeSelectionMonitor.throwOnConstruct = false;
    }
});

test('SelectionClient: a throwing selection listener is reported, not thrown into the addon', () => {
    const { client, send } = startedSelectionClient();
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.message));
    client.on('selection', () => { throw new Error('consumer bug'); });
    assert.doesNotThrow(() => send(selectionEvent()));
    assert.deepEqual(errors, ['Failed to process event: consumer bug']);
});

test('SelectionClient without an error listener does not throw into the native callback', () => {
    const { client, send } = startedSelectionClient();
    client.on('selection', () => { throw new Error('consumer bug'); });
    silenced(() => assert.doesNotThrow(() => send(selectionEvent())));
});
