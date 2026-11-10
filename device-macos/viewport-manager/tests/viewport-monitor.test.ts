import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import ViewportMonitorDefault, {
    ViewportMonitorService,
    createViewportMonitor,
    type WindowEvent,
    type SpaceChangeNativeEvent,
    type ViewportPermissionState,
} from '../index';
import { makeTempDir, writeFakeHelper, scriptedLines, waitFor, isAlive, quietConsole } from '../../test-support/fakes';

const dir = makeTempDir();
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function collect(svc: ViewportMonitorService) {
    const events: WindowEvent[] = [];
    const typed: Array<[string, WindowEvent]> = [];
    const spaces: SpaceChangeNativeEvent[] = [];
    const permissions: ViewportPermissionState[] = [];
    const errors: string[] = [];
    const statuses: string[] = [];
    svc.on('window-event', (e) => events.push(e));
    for (const t of ['window-opened', 'window-closed', 'window-focused', 'window-unfocused', 'bounds-changed', 'title-changed'] as const) {
        svc.on(t, (e) => typed.push([t, e]));
    }
    svc.on('space-changed', (e) => spaces.push(e));
    svc.on('permission', (p) => permissions.push(p));
    svc.on('error', (e) => errors.push(e.message));
    svc.on('status', (s) => statuses.push(s));
    return { events, typed, spaces, permissions, errors, statuses };
}

function feed(lines: unknown[]) {
    const svc = new ViewportMonitorService();
    (svc as any).running = true;
    const c = collect(svc);
    for (const l of lines) (svc as any).handleLine(typeof l === 'string' ? l : JSON.stringify(l));
    return { svc, ...c };
}

const win = (type: string, extra: Record<string, unknown> = {}) => ({
    type, windowId: 101, title: 'Inbox — 受信トレイ 📬', ownerName: 'Mail', bundleId: 'com.apple.mail', pid: 500,
    bounds: { x: -1728, y: -1117, width: 1728, height: 1117 }, displayId: 2, ...extra,
});

test('every window event type is emitted on window-event and on its own channel', () => {
    const types = ['window-opened', 'window-closed', 'window-focused', 'window-unfocused', 'bounds-changed', 'title-changed'];
    const before = Date.now();
    const { events, typed } = feed(types.map((t) => win(t)));
    assert.deepEqual(events.map((e) => e.type), types);
    assert.deepEqual(typed.map(([t]) => t), types);
    for (const [t, e] of typed) assert.equal(e.type, t);
    const e = events[0];
    assert.equal(e.windowId, 101);
    assert.equal(e.title, 'Inbox — 受信トレイ 📬');
    assert.deepEqual(e.bounds, { x: -1728, y: -1117, width: 1728, height: 1117 });
    assert.equal(e.displayId, 2);
    assert.ok(e.timestamp >= before && e.timestamp <= Date.now());
});

test('optional fields (oldTitle, oldBounds, documentPath) pass through; unknown fields are kept', () => {
    const { events } = feed([
        win('title-changed', { oldTitle: 'old', documentPath: '/Users/x/ドキュメント.pages', futureField: 1 }),
        win('bounds-changed', { oldBounds: { x: 0, y: 0, width: 1, height: 1 } }),
    ]);
    assert.equal(events[0].oldTitle, 'old');
    assert.equal(events[0].documentPath, '/Users/x/ドキュメント.pages');
    assert.equal((events[0] as any).futureField, 1);
    assert.deepEqual(events[1].oldBounds, { x: 0, y: 0, width: 1, height: 1 });
});

test('helper timestamp is replaced by the receive time', () => {
    const { events } = feed([win('window-focused', { timestamp: 5 })]);
    assert.notEqual(events[0].timestamp, 5);
});

test('window events without valid bounds or with unknown types are ignored', () => {
    const { events, errors } = feed([
        win('window-opened', { bounds: null }),
        win('window-opened', { bounds: { x: 0, y: 0, width: 10 } }),
        win('window-opened', { bounds: { x: '0', y: 0, width: 10, height: 10 } }),
        win('window-minimized'),
        win('WINDOW-OPENED'),
        { bounds: { x: 0, y: 0, width: 1, height: 1 } },
        { type: 7, bounds: { x: 0, y: 0, width: 1, height: 1 } },
    ]);
    assert.equal(events.length, 0);
    assert.equal(errors.length, 0);
});

test('space-changed is forwarded; permission state needs a boolean accessibility flag', () => {
    const { spaces, permissions, events } = feed([
        { type: 'space-changed', timestamp: 1234.5 },
        { type: 'ready', accessibilityTrusted: true, screenRecordingGranted: true },
        { type: 'permission', accessibilityTrusted: false },
        { type: 'permission', accessibilityTrusted: true, screenRecordingGranted: 'yes' },
        { type: 'permission' },
    ]);
    assert.deepEqual(spaces, [{ type: 'space-changed', timestamp: 1234.5 }]);
    assert.deepEqual(permissions, [
        { accessibilityTrusted: true, screenRecordingGranted: true },
        { accessibilityTrusted: false, screenRecordingGranted: false },
        { accessibilityTrusted: true, screenRecordingGranted: false },
    ]);
    assert.equal(events.length, 0);
});

test('malformed, blank, non-object and oversized lines are dropped', () => {
    const { events } = feed([
        '{"type":"window-opened"',
        '',
        '  ',
        'null',
        '[]',
        '"x"',
        JSON.stringify(win('window-opened', { title: 't'.repeat(1_000_001) })),
        win('window-closed'),
    ]);
    assert.deepEqual(events.map((e) => e.type), ['window-closed']);
});

test('duplicate and out-of-order events are passed through unchanged', () => {
    const { events } = feed([win('window-closed'), win('window-opened'), win('window-opened')]);
    assert.deepEqual(events.map((e) => e.type), ['window-closed', 'window-opened', 'window-opened']);
});

test('a throwing listener is reported and later lines still flow', () => {
    const svc = new ViewportMonitorService();
    (svc as any).running = true;
    const errors: string[] = [];
    svc.on('error', (e) => errors.push(e.message));
    let n = 0;
    svc.on('window-event', () => {
        n++;
        if (n === 1) throw new Error('consumer bug');
    });
    (svc as any).handleLine(JSON.stringify(win('window-opened')));
    (svc as any).handleLine(JSON.stringify(win('window-closed')));
    assert.equal(n, 2);
    assert.deepEqual(errors, ['Listener threw: consumer bug']);
});

test('debug logging does not print unparseable lines', () => {
    const logs: string[] = [];
    const saved = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
    try {
        const svc = new ViewportMonitorService();
        (svc as any).running = true;
        (svc as any).debug = true;
        (svc as any).handleLine('{"title":"SECRET-TITLE"');
    } finally {
        console.log = saved;
    }
    assert.ok(logs.every((l) => !l.includes('SECRET')));
});

test('exports: default export and factory build the service', () => {
    assert.equal(ViewportMonitorDefault, ViewportMonitorService);
    assert.ok(createViewportMonitor() instanceof ViewportMonitorService);
});

// ── Process lifecycle with fake helpers ────────────────────────────────────

test('missing helper binary: start() returns false with an error', () => {
    const svc = new ViewportMonitorService();
    const c = collect(svc);
    assert.equal(svc.start({ helperPath: path.join(dir, 'missing') }), false);
    assert.equal(svc.isRunning(), false);
    assert.match(c.errors[0], /binary not found/);
    assert.deepEqual(c.statuses, []);
});

test('end-to-end with a fake helper; stop kills it; double start/stop are safe', async () => {
    const helperPath = writeFakeHelper(dir, 'vp-e2e', scriptedLines([
        { type: 'ready', accessibilityTrusted: true, screenRecordingGranted: false },
        win('window-opened'),
        { type: 'space-changed', timestamp: 1 },
    ]));
    const svc = new ViewportMonitorService();
    const c = collect(svc);
    assert.equal(svc.start({ helperPath }), true);
    assert.equal(svc.start({ helperPath }), true);
    await waitFor(() => c.spaces.length === 1, 5000, 'space change');
    assert.equal(c.events.length, 1);
    const child = (svc as any).process;
    svc.stop();
    svc.stop();
    assert.deepEqual(c.statuses, ['started', 'stopped']);
    await waitFor(() => !isAlive(child.pid), 3000, 'helper killed');
});

test('helper exit with autoRestart=false delivers final lines then reports stopped', async () => {
    const helperPath = writeFakeHelper(dir, 'vp-exit', scriptedLines([win('window-closed')], { exitCode: 4 }));
    const svc = new ViewportMonitorService();
    const c = collect(svc);
    svc.start({ helperPath, autoRestart: false });
    await waitFor(() => c.statuses.includes('stopped'), 5000, 'stopped');
    assert.equal(c.events.length, 1);
    assert.match(c.errors[0], /exited \(code=4/);
});

test('helper that cannot be executed (EACCES) ends in stopped, not a phantom running state', async () => {
    const helperPath = path.join(dir, 'vp-noexec');
    fs.writeFileSync(helperPath, 'nope', { mode: 0o600 });
    const svc = new ViewportMonitorService();
    const c = collect(svc);
    svc.start({ helperPath });
    await waitFor(() => !svc.isRunning(), 3000, 'not running');
    assert.match(c.errors[0], /EACCES/);
    assert.deepEqual(c.statuses, ['started', 'stopped']);
    // and it can be started again later
    assert.equal(svc.start({ helperPath: path.join(dir, 'still-missing') }), false);
});

test('crash restarts after 1 s backoff', async () => {
    const counter = path.join(dir, 'vp-restart.count');
    const helperPath = writeFakeHelper(dir, 'vp-restart', `
const fs = require('fs');
const n = (fs.existsSync(${JSON.stringify(counter)}) ? +fs.readFileSync(${JSON.stringify(counter)}, 'utf8') : 0) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
if (n === 1) process.exit(1);
setInterval(() => {}, 1000);
`);
    const svc = new ViewportMonitorService();
    const c = collect(svc);
    svc.start({ helperPath });
    await waitFor(() => fs.existsSync(counter) && fs.readFileSync(counter, 'utf8') === '2', 4000, 'restart');
    assert.equal(svc.isRunning(), true);
    assert.deepEqual(c.statuses, ['started']);
    svc.stop();
});

test('cleanup() without listeners does not throw', async () => {
    await quietConsole(() => {
        const svc = new ViewportMonitorService();
        svc.start({ helperPath: path.join(dir, 'missing-3') });
        svc.cleanup();
    });
});
