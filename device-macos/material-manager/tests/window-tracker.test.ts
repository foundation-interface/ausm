import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WindowTracker, generateMaterialId, MAX_MATERIALS_PER_WINDOW } from '../window-tracker';

function tracker(title: string | null = 'Tab A') {
    return new WindowTracker({
        windowId: 42,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        displayId: 1,
        title,
        application: 'Safari',
        bundleId: 'com.apple.Safari',
        pid: 100,
    });
}

test('material IDs are stable and app-scoped', () => {
    const a = generateMaterialId('Inbox', 'com.apple.mail', 'Mail');
    assert.equal(a, generateMaterialId('Inbox', 'com.apple.mail', null));
    assert.notEqual(a, generateMaterialId('Inbox', 'com.google.Chrome', null));
    assert.match(a, /^mat_[0-9a-f]{12}$/);
    // falls back to application when bundleId is missing
    assert.equal(generateMaterialId('x', null, 'App'), generateMaterialId('x', 'App', null));
});

test('constructor bootstraps first material only when titled', () => {
    assert.equal(tracker().currentMaterial?.title, 'Tab A');
    assert.equal(tracker(null).currentMaterial, null);
});

test('switchMaterial tracks new/previous titles and reuses materials', () => {
    const t = tracker();
    const first = t.currentMaterial!;

    const r1 = t.switchMaterial('Tab B');
    assert.equal(r1.isNew, true);
    assert.equal(r1.previousTitle, 'Tab A');
    assert.equal(t.title, 'Tab B');
    assert.equal(t.materialCount, 2);

    const r2 = t.switchMaterial('Tab A');
    assert.equal(r2.isNew, false);
    assert.equal(r2.material, first);

    const r3 = t.switchMaterial('Tab A', undefined, { url: 'u' });
    assert.equal(r3.isNew, false);
    assert.deepEqual(r3.material.appMetadata, { url: 'u' });
    // passing null clears metadata, undefined leaves it alone
    t.switchMaterial('Tab A');
    assert.deepEqual(t.currentMaterial!.appMetadata, { url: 'u' });
    t.switchMaterial('Tab A', undefined, null);
    assert.equal(t.currentMaterial!.appMetadata, null);
});

test('lastFrameHash is per material', () => {
    const t = tracker();
    t.updateLastFrameHash('aa');
    t.switchMaterial('Tab B');
    assert.equal(t.lastFrameHash, null);
    t.switchMaterial('Tab A');
    assert.equal(t.lastFrameHash, 'aa');
});

test('documentPath updates tracker and material', () => {
    const t = tracker();
    t.switchMaterial('Doc', 'file:///a.txt');
    assert.equal(t.documentPath, 'file:///a.txt');
    assert.equal(t.currentMaterial!.documentPath, 'file:///a.txt');
});

test('in-memory materials are capped, current material is never evicted', () => {
    const t = tracker();
    t.switchMaterial('keep');
    // make 'keep' the oldest by back-dating it, but keep it current
    t.currentMaterial!.lastSeen = 0;
    for (let i = 0; i < MAX_MATERIALS_PER_WINDOW + 10; i++) {
        t.getOrCreateMaterial(`title-${i}`);
    }
    assert.equal(t.materialCount, MAX_MATERIALS_PER_WINDOW);
    assert.ok(t.materials.has('keep'));
});

test('deactivate and cleanup stop the capture timer', () => {
    const t = tracker();
    let ticks = 0;
    t.startCaptureTimer(5, () => ticks++);
    assert.notEqual(t.captureTimer, null);
    t.deactivate();
    assert.equal(t.captureTimer, null);
    assert.equal(t.active, false);
    t.startCaptureTimer(5, () => ticks++);
    t.cleanup();
    assert.equal(t.captureTimer, null);
    assert.equal(t.materialCount, 0);
});

test('generateMaterialId: empty, unicode, very long and NUL-containing inputs', () => {
    const empty = generateMaterialId('', null, null);
    assert.match(empty, /^mat_[0-9a-f]{12}$/);
    assert.notEqual(empty, generateMaterialId(' ', null, null));
    const long = 'é'.repeat(100_000);
    assert.match(generateMaterialId(long, 'b', null), /^mat_[0-9a-f]{12}$/);
    // NFC vs NFD are byte-different titles → different ids (no hidden normalization)
    assert.notEqual(generateMaterialId('é', 'b', null), generateMaterialId('é', 'b', null));
    assert.equal(generateMaterialId('日本 📄', 'b', null), generateMaterialId('日本 📄', 'b', 'ignored'));
    // title/app boundary is unambiguous for ordinary strings
    assert.notEqual(generateMaterialId('ab', 'c', null), generateMaterialId('a', 'bc', null));
});

test('switchMaterial to the same title only refreshes lastSeen/documentPath', () => {
    const t = tracker();
    const before = t.currentMaterial!;
    const r = t.switchMaterial('Tab A', 'file:///x');
    assert.equal(r.isNew, false);
    assert.equal(r.material, before);
    assert.equal(r.previousTitle, 'Tab A');
    assert.equal(before.documentPath, 'file:///x');
    // null documentPath clears the tracker-level value but keeps the material's
    t.switchMaterial('Tab A', null);
    assert.equal(t.documentPath, null);
    assert.equal(before.documentPath, 'file:///x');
});

test('switchMaterial to an empty title creates a material (callers must filter empties)', () => {
    const t = tracker(null);
    const r = t.switchMaterial('');
    assert.equal(r.isNew, true);
    assert.equal(r.previousTitle, null);
    assert.equal(t.currentMaterial!.title, '');
});

test('updateLastFrameHash without a current material is a no-op', () => {
    const t = tracker(null);
    t.updateLastFrameHash('zz');
    assert.equal(t.lastFrameHash, null);
});

test('eviction never drops the material being switched to, even when the clock goes backwards', (t) => {
    const w = tracker();
    for (let i = 0; i < MAX_MATERIALS_PER_WINDOW - 1; i++) w.getOrCreateMaterial(`t${i}`);
    assert.equal(w.materialCount, MAX_MATERIALS_PER_WINDOW);
    const realNow = Date.now();
    t.mock.method(Date, 'now', () => realNow - 86_400_000); // one day back
    const r = w.switchMaterial('brand new');
    assert.equal(w.materialCount, MAX_MATERIALS_PER_WINDOW);
    assert.ok(w.materials.has('brand new'), 'newly created material was evicted immediately');
    assert.equal(w.materials.get('brand new'), r.material);
    // and switching to it again is not "new"
    w.switchMaterial('Tab A');
    assert.equal(w.switchMaterial('brand new').isNew, false);
});

test('startCaptureTimer replaces a running timer instead of stacking', async () => {
    const t = tracker();
    let a = 0;
    let b = 0;
    t.startCaptureTimer(5, () => a++);
    t.startCaptureTimer(5, () => b++);
    await new Promise((r) => setTimeout(r, 30));
    t.stopCaptureTimer();
    t.stopCaptureTimer(); // idempotent
    assert.equal(a, 0);
    assert.ok(b > 0);
});

test('materials keep window-level identity from the tracker', () => {
    const t = tracker();
    const m = t.getOrCreateMaterial('x', undefined, { url: 'u' });
    assert.equal(m.windowId, 42);
    assert.equal(m.bundleId, 'com.apple.Safari');
    assert.deepEqual(m.appMetadata, { url: 'u' });
    t.updateBounds({ x: 1, y: 1, width: 1, height: 1 });
    assert.deepEqual(t.bounds, { x: 1, y: 1, width: 1, height: 1 });
    t.activate();
    assert.equal(t.active, true);
});
