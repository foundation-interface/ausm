import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { ScreenshotStatus, ScreenshotType, type ScreenshotEvent } from '@ausm/core';
import { ScreenshotDetectorService, createScreenshotDetector } from '../index';
import { makeTempDir, writeFakeHelper, scriptedLines, waitFor, nextEvent, quietConsole } from '../../test-support/fakes';

const dir = makeTempDir();
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Drive the JSON-line → event mapping without a process. */
function feed(lines: Record<string, unknown>[], svc = new ScreenshotDetectorService()) {
    const events: ScreenshotEvent[] = [];
    const errors: string[] = [];
    svc.on('screenshot-event', (e) => events.push(e));
    svc.on('error', (e) => errors.push(e.message));
    for (const l of lines) (svc as any).handleNativeEvent(l);
    return { svc, events, errors };
}

const R = { x: 10, y: 20, width: 300, height: 200 };

test('full keyboard-selection session: started → updated → finished with image', () => {
    const { events, errors } = feed([
        { type: 'ready' },
        { type: 'screencapture_started', pid: 1, mode: 'selection', destination: 'file', timestamp: 1000, displayId: '1' },
        { type: 'selection_rect_changed', rect: R, timestamp: 1100, displayId: '1' },
        {
            type: 'screencapture_ended', mode: 'selection', rect: R, timestamp: 1200, displayId: '1',
            imagePath: '/tmp/x.png', imageWidth: 600, imageHeight: 400, scale: 2,
        },
    ]);
    assert.equal(errors.length, 0);
    assert.deepEqual(events.map((e) => e.status), [ScreenshotStatus.STARTED, ScreenshotStatus.UPDATED, ScreenshotStatus.FINISHED]);
    assert.equal(events[0].type, ScreenshotType.SELECTED_REGION);
    assert.equal(events[0].timestamp, 1000);
    assert.equal(events[0].displayID, '1');
    assert.equal(events[0].bounds, null);
    assert.deepEqual(events[1].bounds, R);
    assert.equal(events[1].type, ScreenshotType.SELECTED_REGION);
    const fin = events[2];
    assert.equal(fin.kind, 'screenshot');
    assert.equal(fin.imagePath, '/tmp/x.png');
    assert.equal(fin.imageWidth, 600);
    assert.equal(fin.imageHeight, 400);
    assert.equal(fin.imageData, null);
    assert.deepEqual(fin.bounds, R);
    for (const e of events) assert.match(e.eventID ?? '', /^ss_\d+_[a-z0-9]+$/);
    assert.equal(new Set(events.map((e) => e.eventID)).size, 3, 'event ids are unique');
});

test('mode → type mapping', () => {
    const typeOf = (line: Record<string, unknown>) => feed([line]).events[0]?.type;
    assert.equal(typeOf({ type: 'screencapture_started', mode: 'screen' }), ScreenshotType.FULL_SCREEN);
    assert.equal(typeOf({ type: 'screencapture_started', mode: 'window' }), ScreenshotType.SELECTED_WINDOW);
    assert.equal(typeOf({ type: 'screencapture_started', mode: 'selection' }), ScreenshotType.SELECTED_REGION);
    assert.equal(typeOf({ type: 'screencapture_started', mode: 'interactive' }), ScreenshotType.FULL_SCREEN);
    assert.equal(typeOf({ type: 'screencapture_started', mode: 'unknown' }), ScreenshotType.FULL_SCREEN);
    assert.equal(typeOf({ type: 'screencapture_started' }), ScreenshotType.FULL_SCREEN);
    // A rect on the ended event makes it a region, unless the mode was window.
    assert.equal(typeOf({ type: 'screencapture_ended', mode: 'interactive', rect: R }), ScreenshotType.SELECTED_REGION);
    assert.equal(typeOf({ type: 'screencapture_ended', mode: 'window', rect: R }), ScreenshotType.SELECTED_WINDOW);
    assert.equal(typeOf({ type: 'screencapture_ended', mode: 'screen' }), ScreenshotType.FULL_SCREEN);
});

test('cancelled session (Esc) is FINISHED without an image', () => {
    const { events } = feed([
        { type: 'screencapture_started', mode: 'interactive' },
        { type: 'screencapture_ended', mode: 'interactive', cancelled: true },
    ]);
    const fin = events[1];
    assert.equal(fin.status, ScreenshotStatus.FINISHED);
    assert.equal(fin.imagePath, null);
    assert.equal(fin.imageWidth, null);
    assert.equal(fin.imageHeight, null);
    assert.equal(fin.bounds, null);
});

test('imagePath is dropped unless both dimensions are present and non-zero', () => {
    const pathFor = (extra: Record<string, unknown>) =>
        feed([{ type: 'screencapture_ended', imagePath: '/tmp/a.png', ...extra }]).events[0].imagePath;
    assert.equal(pathFor({ imageWidth: 10, imageHeight: 10 }), '/tmp/a.png');
    assert.equal(pathFor({ imageWidth: 10 }), null);
    assert.equal(pathFor({ imageHeight: 10 }), null);
    assert.equal(pathFor({ imageWidth: 0, imageHeight: 10 }), null);
    assert.equal(pathFor({ imagePath: 42, imageWidth: 10, imageHeight: 10 }), null);
});

test('unicode / spaces in image path survive', () => {
    const p = '/private/var/folders/xy/T/スクリーン ショット 👍🏽 שלום.png';
    const { events } = feed([{ type: 'screencapture_ended', imagePath: p, imageWidth: 1, imageHeight: 1 }]);
    assert.equal(events[0].imagePath, p);
});

test('malformed rects become null bounds; negative-origin multi-display rects are kept', () => {
    const boundsOf = (rect: unknown) => feed([{ type: 'selection_rect_changed', rect } as any]).events[0];
    for (const bad of [undefined, null, {}, { x: 1, y: 2, width: 3 }, { x: '1', y: 2, width: 3, height: 4 }, 'rect', [1, 2, 3, 4]]) {
        const e = boundsOf(bad);
        assert.equal(e.bounds, null, `rect ${JSON.stringify(bad)}`);
        assert.equal(e.type, ScreenshotType.FULL_SCREEN);
        assert.equal(e.status, ScreenshotStatus.UPDATED);
    }
    // Display left of / above the main display has negative global coordinates.
    const neg = { x: -2560, y: -1440, width: 2560.5, height: 0.5 };
    assert.deepEqual(boundsOf(neg).bounds, neg);
    // Extra fields on the rect are not copied onto bounds.
    assert.deepEqual(boundsOf({ ...R, scale: 2, junk: 'x' }).bounds, R);
});

test('missing/invalid timestamp falls back to now; displayId must be a string', () => {
    const before = Date.now();
    const { events } = feed([
        { type: 'screencapture_started', timestamp: 'yesterday', displayId: 7 },
        { type: 'screencapture_started', timestamp: 0, displayId: '' },
    ]);
    assert.ok(events[0].timestamp >= before && events[0].timestamp <= Date.now());
    assert.equal(events[0].displayID, null);
    assert.equal(events[1].timestamp, 0, 'zero is a valid timestamp');
    assert.equal(events[1].displayID, '');
});

test('screencaptureui_started opens a session only when none is open', () => {
    const inside = feed([
        { type: 'screencapture_started', mode: 'interactive' },
        { type: 'screencaptureui_started' },
        { type: 'screencaptureui_ended' },
        { type: 'screencapture_ended', mode: 'interactive' },
    ]);
    assert.deepEqual(inside.events.map((e) => e.status), [ScreenshotStatus.STARTED, ScreenshotStatus.FINISHED]);

    const alone = feed([{ type: 'screencaptureui_started' }, { type: 'screencaptureui_ended' }]);
    assert.deepEqual(alone.events.map((e) => [e.status, e.type]), [
        [ScreenshotStatus.STARTED, ScreenshotType.FULL_SCREEN],
        [ScreenshotStatus.FINISHED, ScreenshotType.FULL_SCREEN],
    ]);
    assert.equal(alone.events[1].imagePath, null);
});

test('hotkeyOnly never synthesizes a session from screencaptureui events', () => {
    const { events } = feed(
        [{ type: 'screencaptureui_started' }, { type: 'screencaptureui_ended' }],
        new ScreenshotDetectorService({ hotkeyOnly: true }),
    );
    assert.equal(events.length, 0);
});

test('duplicate / out-of-order UI events do not produce extra sessions', () => {
    const { events } = feed([
        { type: 'screencaptureui_ended' }, // no session open: ignored
        { type: 'screencaptureui_started' },
        { type: 'screencaptureui_started' }, // duplicate: ignored
        { type: 'screencaptureui_ended' },
        { type: 'screencaptureui_ended' }, // duplicate: ignored
    ]);
    assert.deepEqual(events.map((e) => e.status), [ScreenshotStatus.STARTED, ScreenshotStatus.FINISHED]);
});

test('a UI session is taken over by a real screencapture session', () => {
    const { events } = feed([
        { type: 'screencaptureui_started' },
        { type: 'screencapture_started', mode: 'selection' },
        { type: 'screencaptureui_ended' }, // belongs to the real session now: ignored
        { type: 'screencapture_ended', mode: 'selection', rect: R },
    ]);
    assert.deepEqual(events.map((e) => e.status), [
        ScreenshotStatus.STARTED, ScreenshotStatus.STARTED, ScreenshotStatus.FINISHED,
    ]);
});

test('screencapture_ended without a started event still reports FINISHED', () => {
    const { events } = feed([{ type: 'screencapture_ended', mode: 'screen' }]);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, ScreenshotStatus.FINISHED);
});

test('helper errors and capture failures go to the error event, not screenshot-event', () => {
    const { events, errors } = feed([
        { type: 'error', code: 'screen_recording_denied', message: 'grant Screen Recording' },
        { type: 'error' },
        { type: 'screenshot_capture_failed', reason: 'sck_timeout' },
        { type: 'screenshot_capture_failed' },
    ]);
    assert.equal(events.length, 0);
    assert.deepEqual(errors, [
        'screen_recording_denied: grant Screen Recording',
        'error: unknown helper error',
        'Screenshot capture failed: sck_timeout',
        'Screenshot capture failed: unknown',
    ]);
});

test('unknown event types are ignored', () => {
    const { events, errors } = feed([{ type: 'future_event', x: 1 }, { type: '' }]);
    assert.equal(events.length, 0);
    assert.equal(errors.length, 0);
});

test('errors without an error listener warn instead of throwing', async () => {
    const svc = new ScreenshotDetectorService();
    const warned: unknown[][] = [];
    const saved = console.warn;
    console.warn = (...a: unknown[]) => warned.push(a);
    try {
        (svc as any).handleNativeEvent({ type: 'error', code: 'accessibility_denied', message: 'm' });
    } finally {
        console.warn = saved;
    }
    assert.equal(warned.length, 1);
});

// ── Process lifecycle with a fake helper script ────────────────────────────

test('start() spawns the helper, maps its lines, stop() reports stopped', async () => {
    const argvFile = path.join(dir, 'argv-1.json');
    const helperPath = writeFakeHelper(dir, 'ss-helper-1', scriptedLines([
        { type: 'ready' },
        'garbage line',
        { type: 'screencapture_started', mode: 'window', timestamp: 5 },
        { type: 'screencapture_ended', mode: 'window', timestamp: 6, rect: R },
    ], { argvFile }));
    const svc = createScreenshotDetector({ helperPath, debug: false });
    const events: ScreenshotEvent[] = [];
    const statuses: string[] = [];
    svc.on('screenshot-event', (e) => events.push(e));
    svc.on('status', (s) => statuses.push(s));
    assert.equal(svc.isRunning(), false);
    assert.equal(svc.start(), true);
    assert.equal(svc.isRunning(), true);
    assert.equal(svc.start(), true, 'second start is a no-op');
    await waitFor(() => events.length === 2, 5000, 'two screenshot events');
    assert.deepEqual(events.map((e) => [e.status, e.type, e.timestamp]), [
        [ScreenshotStatus.STARTED, ScreenshotType.SELECTED_WINDOW, 5],
        [ScreenshotStatus.FINISHED, ScreenshotType.SELECTED_WINDOW, 6],
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), []);
    assert.equal(svc.stop(), true);
    assert.equal(svc.isRunning(), false);
    assert.deepEqual(statuses, ['started', 'stopped']);
    assert.equal(svc.stop(), true, 'double stop is safe');
});

test('debug mode passes --debug to the helper', async () => {
    const argvFile = path.join(dir, 'argv-2.json');
    const helperPath = writeFakeHelper(dir, 'ss-helper-2', scriptedLines([], { argvFile }));
    await quietConsole(async () => {
        const svc = new ScreenshotDetectorService({ helperPath, debug: true });
        svc.start();
        await waitFor(() => fs.existsSync(argvFile), 5000, 'argv file');
        svc.stop();
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), ['--debug']);
});

test('hotkeyOnly passes --hotkey-only (combined with --debug)', async () => {
    const argvFile = path.join(dir, 'argv-hk.json');
    const helperPath = writeFakeHelper(dir, 'ss-helper-hk', scriptedLines([], { argvFile }));
    await quietConsole(async () => {
        const svc = new ScreenshotDetectorService({ helperPath, debug: true, hotkeyOnly: true });
        svc.start();
        await waitFor(() => fs.existsSync(argvFile), 5000, 'argv file');
        svc.stop();
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), ['--debug', '--hotkey-only']);
});

test('origin field on helper events is tolerated', () => {
    const { events } = feed([
        { type: 'screencapture_started', origin: 'cli', mode: 'screen' },
        { type: 'screencapture_ended', origin: 'cli', mode: 'screen' },
    ]);
    assert.equal(events.length, 2);
});

test('missing helper binary: error event and stopped status, no throw', async () => {
    const svc = new ScreenshotDetectorService({ helperPath: path.join(dir, 'does-not-exist') });
    const errors: string[] = [];
    svc.on('error', (e) => errors.push(e.message));
    const stopped = nextEvent(svc, 'status').then(() => nextEvent(svc, 'status'));
    assert.equal(svc.start(), true); // spawn failure is asynchronous
    assert.equal(await stopped, 'stopped');
    assert.equal(svc.isRunning(), false);
    assert.match(errors[0], /ENOENT/);
});

test('helper crash with autoRestart=false: error then stopped; session state resets', async () => {
    const helperPath = writeFakeHelper(dir, 'ss-helper-3', scriptedLines([
        { type: 'screencaptureui_started' },
    ], { exitCode: 9 }));
    const svc = new ScreenshotDetectorService({ helperPath, autoRestart: false });
    const errors: string[] = [];
    const events: ScreenshotEvent[] = [];
    svc.on('error', (e) => errors.push(e.message));
    svc.on('screenshot-event', (e) => events.push(e));
    svc.start();
    await waitFor(() => !svc.isRunning(), 5000, 'helper exit');
    assert.equal(events.length, 1, 'line written before exit is delivered');
    assert.match(errors[0], /exited unexpectedly \(code=9/);
    // A stale ui_ended after the crash must not produce a FINISHED for the dead session.
    (svc as any).handleNativeEvent({ type: 'screencaptureui_ended' });
    assert.equal(events.length, 1);
});

test('a throwing screenshot-event listener is reported and later events still flow', async () => {
    const helperPath = writeFakeHelper(dir, 'ss-helper-5', scriptedLines([
        { type: 'screencapture_started' },
        { type: 'screencapture_ended' },
    ]));
    const svc = new ScreenshotDetectorService({ helperPath });
    const seen: string[] = [];
    const errors: string[] = [];
    svc.on('error', (e) => errors.push(e.message));
    svc.on('screenshot-event', (e) => {
        seen.push(e.status!);
        if (seen.length === 1) throw new Error('consumer bug');
    });
    svc.start();
    try {
        await waitFor(() => seen.length === 2, 5000, 'both events');
    } finally {
        svc.stop();
    }
    assert.deepEqual(seen, [ScreenshotStatus.STARTED, ScreenshotStatus.FINISHED]);
    assert.ok(errors.some((m) => /listener threw: consumer bug/.test(m)));
});

test('stop() immediately after start() kills the helper before it speaks', async () => {
    const helperPath = writeFakeHelper(dir, 'ss-helper-4', scriptedLines([
        { type: 'screencapture_started' },
    ], { delayMs: 300 }));
    const svc = new ScreenshotDetectorService({ helperPath });
    const events: ScreenshotEvent[] = [];
    svc.on('screenshot-event', (e) => events.push(e));
    svc.start();
    svc.stop();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(events.length, 0);
    assert.equal(svc.isRunning(), false);
});
