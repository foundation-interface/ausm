import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { CursorPlusPlusService, createCursorPlusPlus } from '../index';
import type { CursorEventLike, CursorPlusPlusConfig, DisplayStreamCrop, NativeCursorEvent } from '../types';
import { makeTempDir, writeFakeHelper, scriptedLines, waitFor, tick } from '../../test-support/fakes';

const dir = makeTempDir();
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A service that believes it is running, fed directly with helper lines. */
function harness(config: CursorPlusPlusConfig = {}) {
    const svc = new CursorPlusPlusService(config);
    (svc as any).helper = { running: true, stop() { this.running = false; } };
    const events: CursorEventLike[] = [];
    const moves: Array<[number, number]> = [];
    const errors: string[] = [];
    svc.on('cursor-event', (e) => events.push(e));
    svc.on('cursor-move', (x, y) => moves.push([x, y]));
    svc.on('error', (e) => errors.push(e.message));
    const send = (e: Partial<NativeCursorEvent> & Record<string, unknown>) =>
        (svc as any).handleNativeEvent({ type: 'cursor-event', ...e });
    return { svc, events, moves, errors, send };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await tick();
}

/** Crop source whose responses the test resolves by hand. */
function manualCrop() {
    const calls: Array<{ args: number[]; resolve: (v: { data: Buffer; width: number; height: number }) => void; reject: (e: Error) => void }> = [];
    const crop: DisplayStreamCrop = {
        cropAtCursor: (...args: number[]) =>
            new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
    };
    return { crop, calls };
}

const jpeg = (w = 4, h = 2) => ({ data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: w, height: h });

test('CLICK maps every native field onto the enriched event', async () => {
    const h = harness();
    h.send({
        action: 'CLICK', x: 100.5, y: -20, button: 0, clickCount: 1, windowId: 42,
        windowTitle: 'Doc — 草稿 📝', ownerName: 'Pages', bundleId: 'com.apple.iWork.Pages',
        uiElementRole: 'AXButton', uiElementSubrole: 'AXCloseButton', uiElementLabel: 'Close',
        uiElementDescription: 'close button', uiElementValue: null, uiElementIsEditableText: false,
        futureField: 'ignored',
    });
    await settle();
    assert.equal(h.events.length, 1);
    const e = h.events[0];
    assert.equal(e.action, 'CLICK');
    assert.equal(e.x, 100.5);
    assert.equal(e.y, -20);
    assert.equal(e.button, 0);
    assert.equal(e.clickCount, 1);
    assert.equal(e.windowId, 42);
    assert.equal(e.windowTitle, 'Doc — 草稿 📝');
    assert.equal(e.application, 'Pages');
    assert.equal(e.bundleId, 'com.apple.iWork.Pages');
    assert.equal(e.uiElementRole, 'AXButton');
    assert.equal(e.uiElementSubrole, 'AXCloseButton');
    assert.equal(e.uiElementLabel, 'Close');
    assert.equal(e.uiElementDescription, 'close button');
    assert.equal(e.uiElementValue, null);
    assert.equal(e.uiElementIsEditableText, false);
    assert.equal(e.materialId, null);
    assert.equal(e.interactionScreenshot, null);
    assert.equal((e as any).futureField, undefined);
    assert.match(e.eventID ?? '', /^cur_\d+_[a-z0-9]+$/);
    assert.equal(typeof e.timestamp, 'number');
});

test('missing optional fields become null, not undefined', async () => {
    const h = harness();
    h.send({ action: 'SCROLL', scrollDeltaY: -3.5 });
    await settle();
    const e = h.events[0];
    for (const k of ['x', 'y', 'button', 'clickCount', 'scrollDeltaX', 'holdDurationMs', 'windowId', 'windowTitle',
        'application', 'bundleId', 'uiElementRole', 'uiElementLabel', 'uiElementValue', 'uiElementIsEditableText'] as const) {
        assert.equal(e[k], null, k);
    }
    assert.equal(e.scrollDeltaY, -3.5);
});

test('MOVE is lightweight: cursor-move + un-enriched cursor-event; position tracked', async () => {
    const lookups: number[] = [];
    const { crop, calls } = manualCrop();
    const h = harness({
        displayStreamCrop: crop,
        materialLookup: { getMaterialForWindow: (id) => { lookups.push(id); return null; } },
    });
    h.send({ action: 'MOVE', x: -1920, y: 1080.25, windowId: 9, ownerName: 'Finder' });
    await settle();
    assert.deepEqual(h.moves, [[-1920, 1080.25]]);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].action, 'MOVE');
    assert.equal(h.events[0].application, 'Finder');
    assert.equal(h.events[0].interactionScreenshot, undefined);
    assert.deepEqual(lookups, [], 'no material lookup for MOVE');
    assert.equal(calls.length, 0, 'no crop for MOVE');
    assert.deepEqual(h.svc.getPosition(), { x: -1920, y: 1080.25 });
});

test('MOVE without coordinates reports 0,0 on cursor-move but keeps the last position', async () => {
    const h = harness();
    h.send({ action: 'MOVE', x: 5, y: 6 });
    h.send({ action: 'MOVE' });
    await settle();
    assert.deepEqual(h.moves, [[5, 6], [0, 0]]);
    assert.deepEqual(h.svc.getPosition(), { x: 5, y: 6 });
    assert.equal(h.events[1].x, null);
});

test('MOVE is enriched when listed in enrichActions', async () => {
    const h = harness({
        enrichActions: ['MOVE'],
        materialLookup: { getMaterialForWindow: () => ({ materialId: 'm1', title: '', application: null, bundleId: null }) },
    });
    h.send({ action: 'MOVE', x: 1, y: 2, windowId: 3 });
    await settle();
    assert.equal(h.events[0].materialId, 'm1');
});

test('material lookup: found, missing, throwing, and skipped without a window id', async () => {
    const h = harness({
        materialLookup: {
            getMaterialForWindow: (id) => {
                if (id === 1) return { materialId: 'mat-1', title: 't', application: null, bundleId: null };
                if (id === 2) throw new Error('lookup failed');
                return null;
            },
        },
    });
    h.send({ action: 'CLICK', windowId: 1 });
    h.send({ action: 'CLICK', windowId: 2 });
    h.send({ action: 'CLICK', windowId: 3 });
    h.send({ action: 'CLICK' });
    await settle();
    assert.deepEqual(h.events.map((e) => e.materialId), ['mat-1', null, null, null]);
    assert.equal(h.errors.length, 0, 'lookup failures are non-critical');
});

test('crop is requested with configured size/scale/quality and attached as JPEG', async () => {
    const { crop, calls } = manualCrop();
    const h = harness({ displayStreamCrop: crop, cropWidth: 80, cropHeight: 80, cropJpegQuality: 60, defaultScaleFactor: 1 });
    h.send({ action: 'RIGHT_CLICK', x: -500, y: -300 });
    await settle();
    assert.deepEqual(calls[0].args, [-500, -300, 80, 80, 1, 60]);
    calls[0].resolve(jpeg(160, 80));
    await settle();
    assert.deepEqual(h.events[0].interactionScreenshot, {
        dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
        width: 160, height: 80, mimeType: 'image/jpeg',
    });
});

test('crop defaults: 200x40 at scale 2, quality 75', async () => {
    const { crop, calls } = manualCrop();
    const h = harness({ displayStreamCrop: crop });
    h.send({ action: 'CLICK', x: 1, y: 2 });
    await settle();
    assert.deepEqual(calls[0].args, [1, 2, 200, 40, 2, 75]);
    calls[0].resolve(jpeg());
    await settle();
});

test('crop failures and empty crops yield a null screenshot, not an error', async () => {
    const { crop, calls } = manualCrop();
    const h = harness({ displayStreamCrop: crop });
    h.send({ action: 'CLICK' });
    h.send({ action: 'CLICK' });
    await settle();
    calls[0].reject(new Error('no frame'));
    calls[1].resolve({ data: Buffer.alloc(0), width: 0, height: 0 });
    await settle();
    assert.deepEqual(h.events.map((e) => e.interactionScreenshot), [null, null]);
    assert.equal(h.errors.length, 0);
});

test('actions outside enrichActions are not cropped', async () => {
    const { crop, calls } = manualCrop();
    const h = harness({ displayStreamCrop: crop });
    h.send({ action: 'HOLD_START', holdDurationMs: 300 });
    h.send({ action: 'DRAG', x: 1, y: 1 });
    await settle();
    assert.equal(calls.length, 0);
    assert.deepEqual(h.events.map((e) => [e.action, e.interactionScreenshot]), [['HOLD_START', null], ['DRAG', null]]);
    assert.equal(h.events[0].holdDurationMs, 300);
});

test('events are emitted in helper order even when an earlier crop is slower', async () => {
    const { crop, calls } = manualCrop();
    const h = harness({ displayStreamCrop: crop });
    h.send({ action: 'CLICK', x: 1, clickCount: 1 });
    h.send({ action: 'DOUBLE_CLICK', x: 1, clickCount: 2 });
    h.send({ action: 'MOVE', x: 2 });
    await settle();
    assert.equal(calls.length, 2);
    calls[1].resolve(jpeg()); // second crop finishes first
    await settle();
    calls[0].resolve(jpeg());
    await settle();
    assert.deepEqual(h.events.map((e) => e.action), ['CLICK', 'DOUBLE_CLICK', 'MOVE']);
});

test('HOLD_START / HOLD_END / CLICK keep their order with a slow crop on HOLD_END', async () => {
    const { crop, calls } = manualCrop();
    const h = harness({ displayStreamCrop: crop });
    h.send({ action: 'HOLD_START' });
    h.send({ action: 'DRAG' });
    h.send({ action: 'HOLD_END', holdDurationMs: 1200 });
    h.send({ action: 'HOLD_START' });
    await settle();
    calls[0].resolve(jpeg());
    await settle();
    assert.deepEqual(h.events.map((e) => e.action), ['HOLD_START', 'DRAG', 'HOLD_END', 'HOLD_START']);
});

test('no cursor-event is emitted after stop() for crops still in flight', async () => {
    const { crop, calls } = manualCrop();
    const h = harness({ displayStreamCrop: crop });
    h.send({ action: 'CLICK' });
    await settle();
    h.svc.stop();
    calls[0].resolve(jpeg());
    await settle();
    assert.equal(h.events.length, 0);
});

test('helper error lines are surfaced as errors', async () => {
    const h = harness();
    (h.svc as any).handleNativeEvent({ type: 'error', code: 'event_tap_disabled', message: 'tap disabled' });
    (h.svc as any).handleNativeEvent({ type: 'error' });
    (h.svc as any).handleNativeEvent({ type: 'ready' });
    await settle();
    assert.deepEqual(h.errors, ['event_tap_disabled: tap disabled', 'error: unknown helper error']);
    assert.equal(h.events.length, 0);
});

test('lines without an action, or with an unknown action, are ignored', async () => {
    const h = harness();
    h.send({});
    h.send({ action: 'TELEPORT' as any, x: 999, y: 999 });
    h.send({ action: '' as any });
    await settle();
    assert.equal(h.events.length, 0);
    assert.deepEqual(h.svc.getPosition(), { x: 0, y: 0 }, 'unknown actions do not move the cursor');
});

test('a throwing cursor-event listener is reported and does not stop later events', async () => {
    const h = harness();
    let calls = 0;
    h.svc.on('cursor-event', () => {
        calls++;
        if (calls === 1) throw new Error('consumer bug');
    });
    h.send({ action: 'CLICK' });
    h.send({ action: 'MOVE', x: 1, y: 1 });
    h.send({ action: 'CLICK' });
    await settle();
    assert.equal(calls, 3);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /consumer bug/);
});

test('reportEvent: ignored while stopped; fills id and timestamp; keeps explicit values', async () => {
    const svc = new CursorPlusPlusService();
    const events: CursorEventLike[] = [];
    svc.on('cursor-event', (e) => events.push(e));
    svc.reportEvent({ action: 'CLICK' });
    assert.equal(events.length, 0);
    (svc as any).helper = { running: true, stop() {} };
    svc.reportEvent({ action: 'CLICK', x: 1 });
    svc.reportEvent({ action: 'CLICK', eventID: 'mine', timestamp: 7 });
    assert.match(events[0].eventID ?? '', /^cur_/);
    assert.equal(typeof events[0].timestamp, 'number');
    assert.equal(events[1].eventID, 'mine');
    assert.equal(events[1].timestamp, 7);
});

test('cleanup() stops and removes listeners', () => {
    const svc = new CursorPlusPlusService();
    svc.on('cursor-event', () => {});
    svc.cleanup();
    assert.equal(svc.listenerCount('cursor-event'), 0);
    assert.equal(svc.isRunning(), false);
});

// ── Process lifecycle with a fake helper script ────────────────────────────

async function argvFor(config: CursorPlusPlusConfig, name: string): Promise<string[]> {
    const argvFile = path.join(dir, `${name}.json`);
    const helperPath = writeFakeHelper(dir, name, scriptedLines([], { argvFile }));
    const svc = new CursorPlusPlusService({ ...config, helperPath });
    svc.start();
    try {
        await waitFor(() => fs.existsSync(argvFile), 5000, 'argv file');
    } finally {
        svc.stop();
    }
    return JSON.parse(fs.readFileSync(argvFile, 'utf8'));
}

test('move throttle argument: default, custom, and invalid values clamp to 0', async () => {
    assert.deepEqual(await argvFor({}, 'cur-a'), ['--move-throttle-ms', '100']);
    assert.deepEqual(await argvFor({ moveThrottleMs: 16 }, 'cur-b'), ['--move-throttle-ms', '16']);
    assert.deepEqual(await argvFor({ moveThrottleMs: 0 }, 'cur-c'), ['--move-throttle-ms', '0']);
    assert.deepEqual(await argvFor({ moveThrottleMs: -10 }, 'cur-d'), ['--move-throttle-ms', '0']);
    assert.deepEqual(await argvFor({ moveThrottleMs: NaN }, 'cur-e'), ['--move-throttle-ms', '0']);
    assert.deepEqual(await argvFor({ moveThrottleMs: Infinity }, 'cur-f'), ['--move-throttle-ms', '0']);
});

test('exit code 2 (no Accessibility) is fatal: no restart', async () => {
    const helperPath = writeFakeHelper(dir, 'cur-fatal', scriptedLines([
        { type: 'error', code: 'accessibility_denied', message: 'grant Accessibility' },
    ], { exitCode: 2 }));
    const svc = createCursorPlusPlus({ helperPath });
    const errors: string[] = [];
    const statuses: string[] = [];
    svc.on('error', (e) => errors.push(e.message));
    svc.on('status', (s) => statuses.push(s));
    svc.start();
    await waitFor(() => statuses.includes('stopped'), 5000, 'stopped');
    assert.equal(svc.isRunning(), false);
    assert.equal(errors[0], 'accessibility_denied: grant Accessibility');
    assert.match(errors[1], /code=2.*not restarting/);
    await new Promise((r) => setTimeout(r, 700)); // past the first backoff
    assert.deepEqual(statuses, ['started', 'stopped']);
});

test('end-to-end: helper lines become cursor events', async () => {
    const helperPath = writeFakeHelper(dir, 'cur-e2e', scriptedLines([
        { type: 'ready' },
        { type: 'cursor-event', action: 'MOVE', x: 10, y: 10 },
        { type: 'cursor-event', action: 'CLICK', x: 11, y: 12, button: 0, clickCount: 1 },
    ]));
    const svc = new CursorPlusPlusService({ helperPath });
    const events: CursorEventLike[] = [];
    svc.on('cursor-event', (e) => events.push(e));
    svc.start();
    try {
        await waitFor(() => events.length === 2, 5000, 'two events');
    } finally {
        svc.stop();
    }
    assert.deepEqual(events.map((e) => e.action), ['MOVE', 'CLICK']);
    assert.deepEqual(svc.getPosition(), { x: 11, y: 12 });
});
