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
