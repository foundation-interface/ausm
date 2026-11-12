/**
 * MaterialManager capture pipeline: scheduling, coalescing, in-flight and
 * superseded captures, freshness retries, pHash dedup threshold, storage
 * modes and focus bookkeeping — all against fakes (no Python, no screen).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MaterialManager } from '../material-manager';
import { analysis, crop, ev, flush, harness, sleep, stopAll } from './helpers';

afterEach(stopAll);

// ── Display-stream (crop) path ────────────────────────────────────────────

test('FOCUSED schedules one delayed crop; first frame (distance -1) is stored', async () => {
    const h = harness();
    h.mm.handleWindowEvent(ev('FOCUSED'));
    assert.equal(h.reader.crops.length, 0, 'capture is delayed');
    await sleep(10);
    assert.equal(h.reader.crops.length, 1);
    assert.equal(h.reader.crops[0].displayId, 'display-1');
    assert.equal(h.reader.crops[0].prevHash, null);
    h.reader.crops[0].d.resolve(crop('h1', -1));
    await flush();
    assert.equal(h.frames.length, 1);
    assert.equal(h.frames[0].title, 'Doc 1');
    assert.equal(h.frames[0].captureReason, 'FOCUSED');
    assert.equal(h.mm.getTracker(7)!.lastFrameHash, 'h1');
    h.mm.stop();
});

test('rapid title changes are coalesced into a single capture', async () => {
    const h = harness({ captureDelayMs: 15 });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    for (let i = 0; i < 10; i++) {
        h.mm.handleWindowEvent(ev('TITLE_CHANGED', { title: `Loading ${i}` }));
    }
    await sleep(40);
    assert.equal(h.reader.crops.length, 1);
    h.reader.crops[0].d.resolve(crop('h', -1));
    await flush();
    assert.equal(h.frames[0].title, 'Loading 9');
    assert.equal(h.frames[0].captureReason, 'TITLE_CHANGED');
    // every intermediate title still became a material
    assert.equal(h.mm.getMaterials(7).length, 11);
    h.mm.stop();
});

test('dedup threshold: distance >= threshold stored, below discarded', async () => {
    const h = harness({ hashDistanceThreshold: 8 });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.reader.crops[0].d.resolve(crop('a', -1));
    await flush();
    const tracker = h.mm.getTracker(7)!;
    const internals = h.mm as unknown as { captureFrame: (t: unknown, d: number) => void };

    internals.captureFrame(tracker, 1);
    assert.equal(h.reader.crops[1].prevHash, 'a');
    h.reader.crops[1].d.resolve(crop('b', 7));
    await flush();
    assert.equal(h.frames.length, 1, 'distance 7 < 8 is a duplicate');
    assert.equal(tracker.lastFrameHash, 'a', 'discarded frame does not move the reference hash');

    internals.captureFrame(tracker, 1);
    h.reader.crops[2].d.resolve(crop('c', 8));
    await flush();
    assert.equal(h.frames.length, 2, 'distance == threshold is significant');
    assert.equal(h.frames[1].captureReason, 'PERIODIC');
    assert.equal(tracker.lastFrameHash, 'c');
    h.mm.stop();
});

test('threshold 0 stores identical frames', async () => {
    const h = harness({ hashDistanceThreshold: 0 });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.reader.crops[0].d.resolve(crop('a', 0));
    await flush();
    assert.equal(h.frames.length, 1);
    h.mm.stop();
});

test('stale frames are retried with exponential back-off, then accepted', async () => {
    const h = harness({ maxFreshnessRetries: 2, freshnessRetryBaseMs: 5 });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    const stale = 1; // epoch ms far in the past → frame predates the event
    h.reader.crops[0].d.resolve(crop('s0', -1, stale));
    await flush();
    assert.equal(h.frames.length, 0, 'stale frame not stored');
    await sleep(15);
    assert.equal(h.reader.crops.length, 2, 'first retry');
    h.reader.crops[1].d.resolve(crop('s1', -1, stale));
    await flush();
    await sleep(25);
    assert.equal(h.reader.crops.length, 3, 'second retry after doubled back-off');
    // retries exhausted: even a stale frame is accepted now
    h.reader.crops[2].d.resolve(crop('s2', -1, stale));
    await flush();
    assert.equal(h.frames.length, 1);
    await sleep(30);
    assert.equal(h.reader.crops.length, 3, 'no further retries');
    h.mm.stop();
});

test('frameTimestamp 0 (unknown) or a frame newer than the event skips the freshness retry', async () => {
    const h = harness({ maxFreshnessRetries: 3 });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.reader.crops[0].d.resolve(crop('x', -1, 0));
    await flush();
    assert.equal(h.frames.length, 1);

    h.mm.handleWindowEvent(ev('TITLE_CHANGED', { title: 'Doc 2' }));
    await sleep(5);
    // a frame from "the future" (Python clock slightly ahead) is fresh
    h.reader.crops[1].d.resolve(crop('y', -1, Date.now() + 10_000));
    await flush();
    assert.equal(h.frames.length, 2);
    h.mm.stop();
});

test('stop() cancels pending freshness retries', async () => {
    const h = harness({ maxFreshnessRetries: 3, freshnessRetryBaseMs: 20 });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.reader.crops[0].d.resolve(crop('s', -1, 1));
    await flush();
    h.mm.stop();
    await sleep(40);
    assert.equal(h.reader.crops.length, 1);
});

test('crop result arriving after the window lost focus is discarded', async () => {
    const h = harness();
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.mm.handleWindowEvent(ev('UNFOCUSED'));
    h.reader.crops[0].d.resolve(crop('late', -1));
    await flush();
    assert.equal(h.frames.length, 0);
    h.mm.stop();
});

test('window vanishing before the delayed capture fires cancels it', async () => {
    const h = harness({ captureDelayMs: 10 });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    h.mm.handleWindowEvent(ev('VANISHED'));
    await sleep(25);
    assert.equal(h.reader.crops.length, 0);
    h.mm.stop();
});

test('window vanishing mid-crop drops the frame', async () => {
    const h = harness();
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.mm.handleWindowEvent(ev('VANISHED'));
    h.reader.crops[0].d.resolve(crop('gone', -1));
    await flush();
    assert.equal(h.frames.length, 0);
    h.mm.stop();
});

test('crop failures are swallowed (no error event, no throw)', async () => {
    const h = harness();
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.reader.crops[0].d.reject(new Error('No frame available'));
    await flush();
    assert.equal(h.frames.length, 0);
    assert.equal(h.errors.length, 0);
    h.mm.stop();
});

test('reader not ready → capture is skipped silently', async () => {
    const h = harness();
    h.reader.ready = false;
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    assert.equal(h.reader.crops.length, 0);
    h.mm.stop();
});

test('title change while a crop is in flight does not attribute old pixels to the new material', async () => {
    const h = harness();
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.reader.crops[0].d.resolve(crop('a', -1));
    await flush();
    const tracker = h.mm.getTracker(7)!;
    const internals = h.mm as unknown as { captureFrame: (t: unknown, d: number) => void };

    // periodic crop starts for "Doc 1" ...
    internals.captureFrame(tracker, 1);
    // ... the tab switches before it returns
    h.mm.handleWindowEvent(ev('TITLE_CHANGED', { title: 'Doc 2' }));
    h.reader.crops[1].d.resolve(crop('old-pixels', 20));
    await flush();
    assert.ok(
        !h.frames.some((f) => f.title === 'Doc 2' && f.data.toString() === 'old-pixels'),
        'stale crop must not be stored under the new title',
    );
    // the TITLE_CHANGED capture still runs and sees no stale reference hash
    await sleep(5);
    const last = h.reader.crops[h.reader.crops.length - 1];
    assert.equal(last.prevHash, null);
    last.d.resolve(crop('new', -1));
    await flush();
    assert.equal(h.frames[h.frames.length - 1].title, 'Doc 2');
    assert.equal(h.frames[h.frames.length - 1].data.toString(), 'new');
    h.mm.stop();
});

test('bounds changes pause periodic capture and resume after they settle', async () => {
    const h = harness({ captureDelayMs: 5, captureIntervalMs: 1000 });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    const tracker = h.mm.getTracker(7)!;
    assert.notEqual(tracker.captureTimer, null);
    h.mm.handleWindowEvent(ev('BOUNDS_CHANGED', { bounds: { x: 5, y: 5, width: 100, height: 100 } }));
    assert.equal(tracker.captureTimer, null, 'paused while resizing');
    h.mm.handleWindowEvent(ev('BOUNDS_CHANGED', { bounds: { x: 6, y: 6, width: 120, height: 90 }, displayId: 3 }));
    assert.deepEqual(tracker.bounds, { x: 6, y: 6, width: 120, height: 90 });
    assert.equal(tracker.displayId, 3);
    await sleep(20);
    assert.notEqual(tracker.captureTimer, null, 'resumed after settling');
    h.mm.stop();
});

test('bounds change for a background window only updates metadata', () => {
    const h = harness();
    h.mm.handleWindowEvent(ev('APPEAR'));
    h.mm.handleWindowEvent(ev('BOUNDS_CHANGED', { bounds: { x: 1, y: 2, width: 3, height: 4 } }));
    const t = h.mm.getTracker(7)!;
    assert.deepEqual(t.bounds, { x: 1, y: 2, width: 3, height: 4 });
    assert.equal(t.captureTimer, null);
    // bounds change for an unknown window is ignored
    h.mm.handleWindowEvent(ev('BOUNDS_CHANGED', { windowId: 99 }));
    assert.equal(h.mm.getTracker(99), undefined);
    h.mm.stop();
});

test('periodic capture ticks for the focused window and skips right after an explicit capture', async () => {
    const h = harness({ captureIntervalMs: 25 });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    assert.equal(h.reader.crops.length, 1); // FOCUSED capture
    h.reader.crops[0].d.resolve(crop('a', -1));
    await sleep(40);
    // at least one PERIODIC request happened after the first full interval
    assert.ok(h.reader.crops.length >= 2);
    h.mm.handleWindowEvent(ev('UNFOCUSED'));
    const n = h.reader.crops.length;
    await sleep(60);
    assert.equal(h.reader.crops.length, n, 'no periodic capture after unfocus');
    h.mm.stop();
});

test('periodic capture keeps running when the wall clock jumps backwards', async (t) => {
    const h = harness({ captureIntervalMs: 20 });
    let offset = 0;
    const realNow = Date.now.bind(Date);
    t.mock.method(Date, 'now', () => realNow() + offset);
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.reader.crops[0].d.resolve(crop('a', -1));
    await flush();
    offset = -3_600_000; // NTP / manual change: one hour back
    await sleep(70);
    assert.ok(h.reader.crops.length >= 2, `periodic capture stalled (${h.reader.crops.length} crops)`);
    h.mm.stop();
});

// ── Per-window (helper) path ──────────────────────────────────────────────

test('helper path: capture → processImage → store; reason propagated', async () => {
    const h = harness({}, { helper: true });
    h.mm.handleWindowEvent(ev('FOCUSED', { displayId: 4 }));
    await sleep(5);
    assert.equal(h.helper!.calls.length, 1);
    assert.equal(h.helper!.calls[0].displayId, 'display-4');
    h.helper!.calls[0].d.resolve({ data: Buffer.from('jpg'), width: 40, height: 30 });
    await flush();
    assert.equal(h.reader.images.length, 1);
    assert.equal(h.reader.images[0].prevHash, null);
    h.reader.images[0].d.resolve(analysis('ha', -1));
    await flush();
    assert.equal(h.frames.length, 1);
    assert.equal(h.frames[0].width, 40);
    assert.equal(h.frames[0].captureReason, 'FOCUSED');
    h.mm.stop();
});

test('helper path: background TITLE_CHANGED still captures; UNFOCUSED captures immediately', async () => {
    const h = harness({ captureDelayMs: 1 }, { helper: true });
    h.mm.handleWindowEvent(ev('APPEAR'));
    await sleep(5);
    h.helper!.calls[0].d.resolve({ data: Buffer.from('a'), width: 1, height: 1 });
    await flush();
    h.reader.images[0].d.resolve(analysis('a', -1));
    await flush();
    h.mm.handleWindowEvent(ev('TITLE_CHANGED', { title: 'bg' }));
    await sleep(5);
    assert.equal(h.helper!.calls.length, 2, 'inactive window captured via backing store');

    h.helper!.calls[1].d.resolve({ data: Buffer.from('b'), width: 1, height: 1 });
    await flush();
    h.reader.images[1].d.resolve(analysis('b', -1));
    await flush();

    h.mm.handleWindowEvent(ev('FOCUSED', { title: 'bg' }));
    await sleep(5);
    h.helper!.calls[2].d.resolve({ data: Buffer.from('c'), width: 1, height: 1 });
    await flush();
    h.reader.images[2].d.resolve(analysis('c', 50));
    await flush();
    const before = h.helper!.calls.length;
    h.mm.handleWindowEvent(ev('UNFOCUSED', { title: 'bg' }));
    assert.equal(h.helper!.calls.length, before + 1, 'no delay for UNFOCUSED');
    h.mm.stop();
});

test('helper path: capture failure emits error (with listener) and clears in-flight state', async () => {
    const h = harness({}, { helper: true });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.helper!.calls[0].d.reject(new Error('window gone'));
    await flush();
    assert.equal(h.errors.length, 1);
    // in-flight cleared: next event schedules a new capture
    h.mm.handleWindowEvent(ev('TITLE_CHANGED', { title: 'x' }));
    await sleep(5);
    assert.equal(h.helper!.calls.length, 2);
    h.mm.stop();
});

test('helper path: capture failure without an error listener does not throw', async () => {
    const helperCalls: Array<() => void> = [];
    const mm = new MaterialManager({
        storageMode: 'remote',
        captureDelayMs: 1,
        screenStreamHelper: {
            captureWindow: () =>
                new Promise((_res, rej) => helperCalls.push(() => rej(new Error('nope')))),
        },
    });
    (mm as unknown as { running: boolean }).running = true;
    mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    helperCalls[0]();
    await flush();
    mm.stop();
});

test('helper path: title change during an in-flight capture is captured after it finishes', async () => {
    const h = harness({}, { helper: true });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    assert.equal(h.helper!.calls.length, 1);
    // tab switches while the first capture is still running
    h.mm.handleWindowEvent(ev('TITLE_CHANGED', { title: 'Doc 2' }));
    await sleep(5);
    h.helper!.calls[0].d.resolve({ data: Buffer.from('doc1-pixels'), width: 1, height: 1 });
    await flush();
    if (h.reader.images.length) {
        h.reader.images[0].d.resolve(analysis('h1', -1));
        await flush();
    }
    assert.ok(
        !h.frames.some((f) => f.title === 'Doc 2' && f.data.toString() === 'doc1-pixels'),
        'capture started for Doc 1 must not be stored as Doc 2',
    );
    await sleep(10);
    const last = h.helper!.calls[h.helper!.calls.length - 1];
    assert.ok(h.helper!.calls.length >= 2, 'the Doc 2 capture was dropped');
    last.d.resolve({ data: Buffer.from('doc2-pixels'), width: 1, height: 1 });
    await flush();
    h.reader.images[h.reader.images.length - 1].d.resolve(analysis('h2', -1));
    await flush();
    const f = h.frames[h.frames.length - 1];
    assert.equal(f.title, 'Doc 2');
    assert.equal(f.data.toString(), 'doc2-pixels');
    h.mm.stop();
});

test('helper path: results arriving after stop() are neither stored nor reported', async () => {
    const h = harness({}, { helper: true });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.helper!.calls[0].d.resolve({ data: Buffer.from('a'), width: 1, height: 1 });
    await flush();
    assert.equal(h.reader.images.length, 1);
    h.mm.stop();
    await flush();
    assert.equal(h.frames.length, 0);
    assert.deepEqual(h.errors, [], 'stop() must not surface "Frame reader stopped" as an error');
});

test('local mode: stop() while processImage is in flight does not write to the closed store', async () => {
    const h = harness({ storageMode: 'local' }, { helper: true });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    await sleep(5);
    h.helper!.calls[0].d.resolve({ data: Buffer.from('a'), width: 1, height: 1 });
    await flush();
    const img = h.reader.images[0];
    // Simulate a reader that answers just before the stop lands.
    h.reader.images = [];
    (h.mm as unknown as { running: boolean }).running = false;
    img.d.resolve(analysis('x', -1));
    await flush();
    assert.equal(h.frames.length, 0);
    assert.deepEqual(h.errors, []);
    (h.mm as unknown as { running: boolean }).running = true;
    h.mm.stop();
});

// ── Storage modes ─────────────────────────────────────────────────────────

test('local mode persists materials and frames, honours maxFramesPerMaterial', async () => {
    const h = harness({ storageMode: 'local', maxFramesPerMaterial: 2, hashDistanceThreshold: 1 });
    h.mm.handleWindowEvent(ev('FOCUSED'));
    const store = h.mm.frameStore!;
    const tracker = h.mm.getTracker(7)!;
    const matId = tracker.currentMaterial!.materialId;
    assert.equal(store.getMaterial(matId)?.title, 'Doc 1');
    await sleep(5);
    const internals = h.mm as unknown as { captureFrame: (t: unknown, d: number) => void };
    h.reader.crops[0].d.resolve(crop('a', -1));
    await flush();
    for (let i = 1; i <= 3; i++) {
        internals.captureFrame(tracker, 1);
        h.reader.crops[i].d.resolve(crop(`h${i}`, 10));
        await flush();
        await sleep(2); // distinct timestamps
    }
    assert.equal(store.getFrameCount(matId), 2);
    assert.equal(h.mm.getFrames(7).length, 2);
    assert.equal(h.mm.getFramesMeta(7).length, 2);
    assert.equal(h.mm.getCurrentMaterialFrames(7).length, 2);
    assert.equal(h.mm.getCurrentMaterialFrames(12345).length, 0);
    const latest = h.mm.getLatestFrameInfo(matId) as { frameId: string; dataBase64: string };
    assert.equal(Buffer.from(latest.dataBase64, 'base64').toString(), 'h3');
    assert.ok(h.mm.getFrameById(latest.frameId));
    assert.deepEqual(h.mm.getLatestFrameInfo('mat_missing'), {});
    assert.equal(h.saved.length, 0, 'local mode does not emit storage events');
    h.mm.stop();
});

test('remote mode emits storage:save-material and caches the latest frame per material', async () => {
    const h = harness();
    h.mm.handleWindowEvent(ev('APPEAR')); // bootstrap material persisted
    h.mm.handleWindowEvent(ev('TITLE_CHANGED', { title: 'Doc 2' }));
    assert.deepEqual(h.saved.map((m) => m.title), ['Doc 1', 'Doc 2']);
    assert.equal(h.mm.frameStore, null);
    assert.deepEqual(h.mm.getFrames(7), []);
    assert.deepEqual(h.mm.getFramesMeta(7), []);
    assert.equal(h.mm.getFrameById('x'), null);
    assert.deepEqual(h.mm.getCurrentMaterialFrames(7), []);

    h.mm.handleWindowEvent(ev('FOCUSED', { title: 'Doc 2' }));
    await sleep(5);
    h.reader.crops[h.reader.crops.length - 1].d.resolve(crop('zz', -1));
    await flush();
    const info = h.mm.getLatestFrameInfo(h.frames[0].materialId) as { sizeBytes: number; frameWidth: number };
    assert.equal(info.sizeBytes, 2);
    assert.equal(info.frameWidth, 4);
    h.mm.stop();
    assert.deepEqual(h.mm.getLatestFrameInfo(h.frames[0].materialId), {}, 'cache cleared on stop');
});

test('a frame captured before any title exists is dropped (no material)', async () => {
    const h = harness();
    h.mm.handleWindowEvent(ev('FOCUSED', { title: null }));
    await sleep(5);
    h.reader.crops[0].d.resolve(crop('x', -1));
    await flush();
    assert.equal(h.frames.length, 0);
    assert.equal(h.mm.getTracker(7)!.currentMaterial, null);
    h.mm.stop();
});

test('storage failure during an event is reported, not thrown', () => {
    const h = harness({ storageMode: 'local' });
    h.mm.frameStore!.close(); // every write now throws
    assert.doesNotThrow(() => h.mm.handleWindowEvent(ev('FOCUSED')));
    assert.equal(h.errors.length, 1);
});
