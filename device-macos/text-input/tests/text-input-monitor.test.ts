import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { TextInputMonitorService, createTextInputMonitor, type TextInputEventLike, type TextInputPermissionState } from '../index';
import { makeTempDir, writeFakeHelper, scriptedLines, waitFor, isAlive, quietConsole, tricky } from '../../test-support/fakes';

const dir = makeTempDir();
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function collect(svc: TextInputMonitorService) {
    const events: TextInputEventLike[] = [];
    const errors: string[] = [];
    const statuses: string[] = [];
    const permissions: TextInputPermissionState[] = [];
    svc.on('text-input', (e) => events.push(e));
    svc.on('error', (e) => errors.push(e.message));
    svc.on('status', (s) => statuses.push(s));
    svc.on('permission', (p) => permissions.push(p));
    return { events, errors, statuses, permissions };
}

function feed(lines: string[]) {
    const svc = new TextInputMonitorService();
    (svc as any).running = true;
    const c = collect(svc);
    for (const l of lines) (svc as any).handleLine(l);
    return { svc, ...c };
}

const src = { type: 'AXTextArea', application: 'com.apple.Notes', applicationLocalizedName: 'Notes', screenBounds: { x: -100, y: 50, width: 400, height: 300 } };

test('helper lines map to text-input events with every field', () => {
    const { events } = feed([
        JSON.stringify({ status: 'TEXT_EDITING_STARTED', text: '', timestamp: 10, sourceElement: src, caretScreenPosition: { x: -90, y: 60 } }),
        JSON.stringify({ status: 'TEXT_EDITING_UPDATED', text: 'hi', timestamp: 11, sourceElement: src }),
        JSON.stringify({ status: 'TEXT_EDITING_FINISHED', text: 'hi', timestamp: 12 }),
    ]);
    assert.deepEqual(events.map((e) => [e.status, e.text, e.timestamp]), [
        ['TEXT_EDITING_STARTED', '', 10],
        ['TEXT_EDITING_UPDATED', 'hi', 11],
        ['TEXT_EDITING_FINISHED', 'hi', 12],
    ]);
    assert.deepEqual(events[0].sourceElement, src);
    assert.deepEqual(events[0].caretScreenPosition, { x: -90, y: 60 });
    assert.equal(events[2].sourceElement, null);
    assert.equal(events[2].caretScreenPosition, null);
    for (const e of events) assert.match(e.eventID ?? '', /^txt_\d+_[a-z0-9]+$/);
});

test('text round-trips: empty, emoji, RTL, CJK, combining marks, control characters, 2 MiB', () => {
    for (const [name, text] of Object.entries(tricky)) {
        const { events } = feed([JSON.stringify({ status: 'TEXT_EDITING_UPDATED', text })]);
        assert.equal(events[0].text, text, name);
    }
});

test('non-string text becomes null; bad timestamp falls back to now', () => {
    const before = Date.now();
    const { events } = feed([
        JSON.stringify({ status: 'TEXT_EDITING_UPDATED', text: 12, timestamp: '1' }),
        JSON.stringify({ status: 'TEXT_EDITING_UPDATED', text: null }),
        JSON.stringify({ status: 'TEXT_EDITING_UPDATED' }),
    ]);
    assert.deepEqual(events.map((e) => e.text), [null, null, null]);
    assert.ok(events[0].timestamp! >= before);
});

test('unknown statuses, missing status, malformed JSON, blank and non-object lines are ignored', () => {
    const { events, errors } = feed([
        JSON.stringify({ status: 'TEXT_INPUT_STARTED', text: 'x' }),
        JSON.stringify({ status: 'text_editing_started' }),
        JSON.stringify({ text: 'no status' }),
        JSON.stringify({ type: 'future', status: 5 }),
        '{"status":"TEXT_EDITING_UPDATED","text":"trunc',
        '',
        '   ',
        'null',
        '42',
        '"str"',
    ]);
    assert.equal(events.length, 0);
    assert.equal(errors.length, 0);
});

test('ready / permission lines emit permission state only when the flag is boolean', () => {
    const { events, permissions } = feed([
        JSON.stringify({ type: 'ready', accessibilityTrusted: false }),
        JSON.stringify({ type: 'permission', accessibilityTrusted: true }),
        JSON.stringify({ type: 'permission' }),
        JSON.stringify({ type: 'ready', accessibilityTrusted: 'yes' }),
    ]);
    assert.deepEqual(permissions, [{ accessibilityTrusted: false }, { accessibilityTrusted: true }]);
    assert.equal(events.length, 0);
});

test('oversized lines are dropped without parsing', () => {
    const svc = new TextInputMonitorService();
    (svc as any).running = true;
    const c = collect(svc);
    const big = JSON.stringify({ status: 'TEXT_EDITING_UPDATED', text: 'y'.repeat(16 * 1024 * 1024 + 10) });
    (svc as any).handleLine(big);
    (svc as any).handleLine(JSON.stringify({ status: 'TEXT_EDITING_UPDATED', text: 'ok' }));
    assert.deepEqual(c.events.map((e) => e.text), ['ok']);
});

test('lines are ignored while not running', () => {
    const svc = new TextInputMonitorService();
    const c = collect(svc);
    (svc as any).handleLine(JSON.stringify({ status: 'TEXT_EDITING_UPDATED', text: 'x' }));
    assert.equal(c.events.length, 0);
});

test('a throwing listener is reported and does not break later lines', () => {
    const svc = new TextInputMonitorService();
    (svc as any).running = true;
    const errors: string[] = [];
    svc.on('error', (e) => errors.push(e.message));
    let n = 0;
    svc.on('text-input', () => {
        n++;
        if (n === 1) throw new Error('consumer bug');
    });
    (svc as any).handleLine(JSON.stringify({ status: 'TEXT_EDITING_STARTED' }));
    (svc as any).handleLine(JSON.stringify({ status: 'TEXT_EDITING_FINISHED' }));
    assert.equal(n, 2);
    assert.deepEqual(errors, ['Listener threw: consumer bug']);
});

test('debug logs never contain typed text', () => {
    const logs: string[] = [];
    const saved = { log: console.log, error: console.error };
    console.log = console.error = (...a: unknown[]) => logs.push(a.map(String).join(' '));
    try {
        const svc = new TextInputMonitorService();
        (svc as any).running = true;
        (svc as any).debug = true;
        (svc as any).handleLine(JSON.stringify({ status: 'TEXT_EDITING_UPDATED', text: 'SECRET-TYPED-TEXT' }));
        (svc as any).handleLine('{"status":"TEXT_EDITING_UPDATED","text":"SECRET-TYPED-TEXT"'); // malformed
        svc.reportEvent({ status: 'TEXT_EDITING_UPDATED', text: 'SECRET-TYPED-TEXT' });
    } finally {
        Object.assign(console, saved);
    }
    assert.ok(logs.length >= 3);
    assert.ok(logs.every((l) => !l.includes('SECRET')));
    assert.ok(logs.some((l) => l.includes('<17 chars>')));
});

test('reportEvent works in stub mode only while running; fills id/timestamp', () => {
    const svc = createTextInputMonitor();
    const c = collect(svc);
    svc.reportEvent({ status: 'TEXT_EDITING_STARTED' });
    assert.equal(c.events.length, 0);
    (svc as any).running = true;
    svc.reportEvent({ status: 'TEXT_EDITING_STARTED', text: 'a' });
    svc.reportEvent({ status: 'TEXT_EDITING_FINISHED', eventID: 'id-1', timestamp: 3 });
    assert.match(c.events[0].eventID ?? '', /^txt_/);
    assert.equal(c.events[1].eventID, 'id-1');
    assert.equal(c.events[1].timestamp, 3);
});

// ── Process lifecycle with fake helpers ────────────────────────────────────

test('missing helper binary falls back to stub mode with an error', () => {
    const svc = new TextInputMonitorService();
    const c = collect(svc);
    assert.equal(svc.start({ helperPath: path.join(dir, 'missing') }), true);
    assert.equal(svc.isRunning(), true);
    assert.match(c.errors[0], /binary not found/);
    assert.deepEqual(c.statuses, ['started']);
    svc.stop();
    assert.deepEqual(c.statuses, ['started', 'stopped']);
});

test('end-to-end with a fake helper; double start and double stop are safe', async () => {
    const helperPath = writeFakeHelper(dir, 'ti-e2e', scriptedLines([
        { type: 'ready', accessibilityTrusted: true },
        { status: 'TEXT_EDITING_STARTED', text: 'שלום 👋', sourceElement: src },
        { status: 'TEXT_EDITING_FINISHED', text: 'שלום 👋' },
    ]));
    const svc = new TextInputMonitorService();
    const c = collect(svc);
    assert.equal(svc.start({ helperPath }), true);
    assert.equal(svc.start({ helperPath }), true);
    await waitFor(() => c.events.length === 2, 5000, 'two events');
    const child = (svc as any).process;
    assert.deepEqual(c.permissions, [{ accessibilityTrusted: true }]);
    assert.equal(c.events[0].text, 'שלום 👋');
    svc.stop();
    svc.stop();
    assert.deepEqual(c.statuses, ['started', 'stopped']);
    await waitFor(() => !isAlive(child.pid), 3000, 'helper killed');
});

test('final lines written right before the helper exits are delivered', async () => {
    const helperPath = writeFakeHelper(dir, 'ti-last', scriptedLines([
        { status: 'TEXT_EDITING_STARTED', text: 'a' },
        { status: 'TEXT_EDITING_FINISHED', text: 'a' },
    ], { exitCode: 1 }));
    const svc = new TextInputMonitorService();
    const c = collect(svc);
    svc.start({ helperPath, autoRestart: false });
    await waitFor(() => c.statuses.includes('stopped'), 5000, 'stopped');
    assert.deepEqual(c.events.map((e) => e.status), ['TEXT_EDITING_STARTED', 'TEXT_EDITING_FINISHED']);
    assert.match(c.errors[0], /exited \(code=1/);
    assert.equal(svc.isRunning(), false);
});

test('a large burst written right before exit is fully delivered (stdout drained before teardown)', async () => {
    const helperPath = writeFakeHelper(dir, 'ti-burst', `
const line = JSON.stringify({ status: 'TEXT_EDITING_UPDATED', text: 'z'.repeat(20000) }) + '\\n';
process.stdout.write(line.repeat(200), () => process.exit(0));
`);
    const svc = new TextInputMonitorService();
    const c = collect(svc);
    svc.start({ helperPath, autoRestart: false });
    await waitFor(() => c.statuses.includes('stopped'), 5000, 'stopped');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(c.events.length, 200);
});

test('helper that cannot be executed (EACCES) ends in stopped, not a phantom running state', async () => {
    const helperPath = path.join(dir, 'ti-noexec');
    fs.writeFileSync(helperPath, 'not executable', { mode: 0o644 });
    const svc = new TextInputMonitorService();
    const c = collect(svc);
    svc.start({ helperPath });
    await waitFor(() => c.errors.length > 0, 3000, 'error');
    await waitFor(() => !svc.isRunning(), 3000, 'not running');
    assert.match(c.errors[0], /EACCES/);
    assert.deepEqual(c.statuses, ['started', 'stopped']);
});

test('crash is restarted after backoff; stop() during the wait cancels it', async () => {
    const counter = path.join(dir, 'ti-restart.count');
    const helperPath = writeFakeHelper(dir, 'ti-restart', `
const fs = require('fs');
const n = (fs.existsSync(${JSON.stringify(counter)}) ? +fs.readFileSync(${JSON.stringify(counter)}, 'utf8') : 0) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
process.stdout.write(JSON.stringify({ status: 'TEXT_EDITING_UPDATED', text: 'run' + n }) + '\\n', () => process.exit(1));
`);
    const svc = new TextInputMonitorService();
    const c = collect(svc);
    svc.start({ helperPath });
    await waitFor(() => c.events.length === 2, 5000, 'second run');
    assert.deepEqual(c.events.map((e) => e.text), ['run1', 'run2']);
    assert.equal(svc.isRunning(), true);
    svc.stop(); // second run exits, restart #2 waits 2 s
    await new Promise((r) => setTimeout(r, 2300));
    assert.equal(fs.readFileSync(counter, 'utf8'), '2');
    assert.equal(c.statuses.filter((s) => s === 'started').length, 1);
});

test('without an error listener, failures warn instead of throwing', async () => {
    await quietConsole(async () => {
        const svc = new TextInputMonitorService();
        svc.start({ helperPath: path.join(dir, 'missing-2') });
        svc.cleanup();
        assert.equal(svc.listenerCount('status'), 0);
    });
});
