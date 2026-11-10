import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MaterialManager, type WindowStateEventLike } from '../material-manager';

/**
 * Exercises event handling / focus bookkeeping without the Python worker:
 * the frame reader is never started, so every capture path is a no-op.
 */
function startedManager(config: ConstructorParameters<typeof MaterialManager>[0] = {}) {
    const mm = new MaterialManager({ storageMode: 'remote', captureDelayMs: 1, ...config });
    (mm as unknown as { running: boolean }).running = true;
    const events: string[] = [];
    mm.on('material-created', (m) => events.push(`created:${m.title}`));
    mm.on('material-focused', (_w, m) => events.push(`focused:${m.title}`));
    mm.on('material-unfocused', (_w, m) => events.push(`unfocused:${m.title}`));
    mm.on('tracker-removed', (w) => events.push(`removed:${w}`));
    return { mm, events };
}

function ev(state: string, over: Partial<WindowStateEventLike> = {}): WindowStateEventLike {
    return {
        windowId: 7,
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        displayId: 1,
        title: 'Doc 1',
        application: 'Editor',
        bundleId: 'com.example.editor',
        pid: 10,
        state,
        documentPath: null,
        ...over,
    };
}

test('focus/title/unfocus emit deduplicated material events', () => {
    const { mm, events } = startedManager();
    mm.handleWindowEvent(ev('APPEAR'));
    mm.handleWindowEvent(ev('FOCUSED'));
    mm.handleWindowEvent(ev('FOCUSED')); // duplicate → no new events
    mm.handleWindowEvent(ev('TITLE_CHANGED', { title: 'Doc 2' }));
    mm.handleWindowEvent(ev('UNFOCUSED'));
    mm.handleWindowEvent(ev('UNFOCUSED')); // duplicate
    assert.deepEqual(events, [
        'focused:Doc 1',
        'created:Doc 2',
        'unfocused:Doc 1',
        'focused:Doc 2',
        'unfocused:Doc 2',
    ]);
    assert.equal(mm.getMaterials(7).length, 2);
    mm.stop();
});

test('VANISHED without bounds still deactivates the tracker', () => {
    const { mm, events } = startedManager();
    mm.handleWindowEvent(ev('FOCUSED'));
    mm.handleWindowEvent(ev('VANISHED', { bounds: null }));
    assert.equal(mm.getTracker(7)?.active, false);
    assert.equal(mm.getTracker(7)?.captureTimer, null);
    assert.deepEqual(events.slice(-2), ['unfocused:Doc 1', 'removed:7']);
    mm.stop();
});

test('events for unknown windows without bounds are ignored', () => {
    const { mm } = startedManager();
    mm.handleWindowEvent(ev('FOCUSED', { bounds: null }));
    assert.equal(mm.getTracker(7), undefined);
    mm.stop();
});

test('blacklist suppresses materials', () => {
    const { mm, events } = startedManager({ materialBlacklist: { titleIncludes: ['secret'] } });
    mm.handleWindowEvent(ev('FOCUSED', { title: 'My SECRET doc' }));
    assert.equal(mm.getTracker(7), undefined);
    assert.deepEqual(events, []);
    mm.stop();
});

test('vanished trackers are bounded', () => {
    const { mm } = startedManager();
    for (let id = 1; id <= 100; id++) {
        mm.handleWindowEvent(ev('APPEAR', { windowId: id, title: `w${id}` }));
        mm.handleWindowEvent(ev('VANISHED', { windowId: id }));
    }
    assert.ok(mm.getAllTrackers().size <= 64);
    assert.ok(mm.getTracker(100));
    assert.equal(mm.getTracker(1), undefined);
    mm.stop();
});

test('throwing metadata extractor does not break event handling', () => {
    const { mm, events } = startedManager({
        metadataExtractors: [{ matches: () => true, extract: () => { throw new Error('x'); } }],
    });
    mm.handleWindowEvent(ev('FOCUSED'));
    assert.deepEqual(events, ['focused:Doc 1']);
    mm.stop();
});

test('local mode cannot be restarted after stop', async () => {
    const mm = new MaterialManager({ storageMode: 'local' });
    (mm as unknown as { running: boolean }).running = true;
    mm.stop();
    await assert.rejects(mm.start(), /cannot be restarted/);
});

// ── Focus bookkeeping corner cases ────────────────────────────────────────

test('same title in two windows of the same app: focus follows the window', () => {
    const { mm, events } = startedManager();
    mm.handleWindowEvent(ev('FOCUSED', { windowId: 1, title: 'Inbox' }));
    // the user switches to a second window showing the same title; the
    // viewport monitor reports the new FOCUSED before the old UNFOCUSED
    mm.handleWindowEvent(ev('FOCUSED', { windowId: 2, title: 'Inbox' }));
    mm.handleWindowEvent(ev('UNFOCUSED', { windowId: 1, title: 'Inbox' }));
    // both windows share one stable material id
    assert.equal(mm.getMaterials(1)[0].materialId, mm.getMaterials(2)[0].materialId);
    // window 2 is in front, so its material must still be focused
    const focused = (mm as unknown as { focusedMaterial: { windowId: number } | null }).focusedMaterial;
    assert.equal(focused?.windowId, 2, `focus lost: ${JSON.stringify(events)}`);
    assert.deepEqual(events, ['focused:Inbox']);
    mm.handleWindowEvent(ev('UNFOCUSED', { windowId: 2, title: 'Inbox' }));
    assert.deepEqual(events, ['focused:Inbox', 'unfocused:Inbox']);
    mm.stop();
});

test('focus flapping between two windows emits strictly alternating events', () => {
    const { mm, events } = startedManager();
    for (let i = 0; i < 5; i++) {
        mm.handleWindowEvent(ev('FOCUSED', { windowId: 1, title: 'A' }));
        mm.handleWindowEvent(ev('FOCUSED', { windowId: 2, title: 'B' }));
    }
    const focusEvents = events.filter((e) => e.startsWith('focused') || e.startsWith('unfocused'));
    // F:A, then (U:A F:B U:B F:A)... — never two focuses in a row
    for (let i = 1; i < focusEvents.length; i++) {
        assert.notEqual(focusEvents[i].split(':')[0], focusEvents[i - 1].split(':')[0]);
    }
    assert.equal(focusEvents[focusEvents.length - 1], 'focused:B');
    mm.stop();
});

test('APPEAR for a known window with a new title switches material before capturing', () => {
    const { mm, events } = startedManager();
    mm.handleWindowEvent(ev('APPEAR', { title: 'Old' }));
    mm.handleWindowEvent(ev('VANISHED', { title: 'Old' }));
    mm.handleWindowEvent(ev('APPEAR', { title: 'New' }));
    assert.equal(mm.getTracker(7)!.currentMaterial!.title, 'New');
    assert.ok(events.includes('created:New'));
    mm.stop();
});

test('title changing to a blacklisted title stops attributing frames to the previous material', () => {
    const { mm, events } = startedManager({ materialBlacklist: { titleIncludes: ['private'] } });
    mm.handleWindowEvent(ev('FOCUSED', { title: 'Docs' }));
    mm.handleWindowEvent(ev('TITLE_CHANGED', { title: 'Private Browsing' }));
    const tracker = mm.getTracker(7)!;
    // nothing may be captured under "Docs" while the private tab is showing
    assert.equal(tracker.currentMaterial, null);
    assert.ok(events.includes('unfocused:Docs'));
    assert.ok(!mm.getAllMaterials().some((m) => m.title.includes('Private')));
    // switching back resumes tracking
    mm.handleWindowEvent(ev('TITLE_CHANGED', { title: 'Docs' }));
    assert.equal(tracker.currentMaterial!.title, 'Docs');
    assert.equal(events[events.length - 1], 'focused:Docs');
    mm.stop();
});

test('VANISHED / UNFOCUSED carrying a blacklisted title still deactivate the tracker', () => {
    const { mm } = startedManager({ materialBlacklist: { apps: ['vault'] } });
    mm.handleWindowEvent(ev('FOCUSED', { windowId: 3, application: 'Notes' }));
    // the app name changes mid-life (helper re-resolves it) to a blacklisted one
    mm.handleWindowEvent(ev('UNFOCUSED', { windowId: 3, application: 'Vault' }));
    assert.equal(mm.getTracker(3)!.active, false);
    assert.equal(mm.getTracker(3)!.captureTimer, null);
    mm.handleWindowEvent(ev('FOCUSED', { windowId: 4, title: 'x', application: 'Notes' }));
    mm.handleWindowEvent(ev('VANISHED', { windowId: 4, title: 'x', application: 'VAULT' }));
    assert.equal(mm.getTracker(4)!.active, false);
    mm.stop();
});

test('blacklist matching is case-insensitive for apps, bundle ids and titles', () => {
    const { mm } = startedManager({
        materialBlacklist: { apps: ['1Password'], bundleIds: ['COM.Secret.App'], titleIncludes: ['Bank'] },
    });
    mm.handleWindowEvent(ev('FOCUSED', { windowId: 1, application: '1PASSWORD' }));
    mm.handleWindowEvent(ev('FOCUSED', { windowId: 2, bundleId: 'com.secret.app' }));
    mm.handleWindowEvent(ev('FOCUSED', { windowId: 3, title: 'my bank account' }));
    mm.handleWindowEvent(ev('FOCUSED', { windowId: 4, title: 'Banana' }));
    assert.deepEqual([...mm.getAllTrackers().keys()], [4]);
    mm.stop();
});

// ── Titles ────────────────────────────────────────────────────────────────

test('empty, unicode, very long and RTL titles each become their own material', () => {
    const { mm, events } = startedManager();
    mm.handleWindowEvent(ev('FOCUSED', { title: '' }));
    assert.equal(mm.getTracker(7)!.currentMaterial, null, 'empty title → no material');
    const titles = ['日本語のドキュメント 📄', 'x'.repeat(10_000), 'مرحبا بالعالم', 'é', 'é'];
    for (const t of titles) mm.handleWindowEvent(ev('TITLE_CHANGED', { title: t }));
    assert.equal(mm.getMaterials(7).length, titles.length);
    // NFC/NFD forms are distinct titles — no silent merging
    assert.equal(new Set(mm.getMaterials(7).map((m) => m.materialId)).size, titles.length);
    // clearing the title keeps the current material
    mm.handleWindowEvent(ev('TITLE_CHANGED', { title: '' }));
    assert.equal(mm.getTracker(7)!.currentMaterial!.title, 'é');
    assert.ok(events.includes(`created:${titles[0]}`));
    mm.stop();
});

test('identical titles in different apps are different materials', () => {
    const { mm } = startedManager();
    mm.handleWindowEvent(ev('APPEAR', { windowId: 1, title: 'Untitled', bundleId: 'com.a' }));
    mm.handleWindowEvent(ev('APPEAR', { windowId: 2, title: 'Untitled', bundleId: 'com.b' }));
    const [a, b] = mm.getAllMaterials();
    assert.notEqual(a.materialId, b.materialId);
    mm.stop();
});

test('title changes in a background window update material state without focus events', () => {
    const { mm, events } = startedManager();
    mm.handleWindowEvent(ev('APPEAR', { title: 'A' }));
    mm.handleWindowEvent(ev('TITLE_CHANGED', { title: 'B' }));
    assert.deepEqual(events, ['created:B']);
    // focusing later reconciles to the current title
    mm.handleWindowEvent(ev('FOCUSED', { title: 'C' }));
    assert.deepEqual(events.slice(1), ['created:C', 'focused:C']);
    mm.stop();
});

test('TITLE_CHANGED / UNFOCUSED for unknown windows are ignored', () => {
    const { mm, events } = startedManager();
    mm.handleWindowEvent(ev('TITLE_CHANGED', { windowId: 50 }));
    mm.handleWindowEvent(ev('UNFOCUSED', { windowId: 50, bounds: null }));
    mm.handleWindowEvent(ev('VANISHED', { windowId: 50, bounds: null }));
    mm.handleWindowEvent(ev('SOMETHING_ELSE', { windowId: 50 }));
    mm.handleWindowEvent(ev('FOCUSED', { windowId: null }));
    assert.deepEqual(events, []);
    mm.stop();
});

test('events before start() and after stop() are ignored', () => {
    const mm = new MaterialManager({ storageMode: 'remote' });
    mm.handleWindowEvent(ev('FOCUSED'));
    assert.equal(mm.getTracker(7), undefined);
    assert.equal(mm.isRunning(), false);
    mm.stop(); // no-op when not running
});

test('metadata: FOCUSED without documentPath reuses the cached URL', () => {
    const { mm } = startedManager();
    mm.handleWindowEvent(ev('APPEAR', { bundleId: 'com.apple.Safari', title: 'Page', documentPath: 'https://a.example/x' }));
    mm.handleWindowEvent(ev('FOCUSED', { bundleId: 'com.apple.Safari', title: 'Page', documentPath: null }));
    assert.equal(mm.getTracker(7)!.currentMaterial!.appMetadata?.hostname, 'a.example');
    // navigation to a same-title page refreshes the URL
    mm.handleWindowEvent(ev('FOCUSED', { bundleId: 'com.apple.Safari', title: 'Page', documentPath: 'https://b.example/' }));
    assert.equal(mm.getTracker(7)!.currentMaterial!.appMetadata?.hostname, 'b.example');
    mm.stop();
});

test('re-appearing window is removed from the vanished list (not evicted later)', () => {
    const { mm } = startedManager();
    mm.handleWindowEvent(ev('APPEAR', { windowId: 1, title: 'keep' }));
    mm.handleWindowEvent(ev('VANISHED', { windowId: 1 }));
    mm.handleWindowEvent(ev('FOCUSED', { windowId: 1, title: 'keep' }));
    for (let id = 100; id < 200; id++) {
        mm.handleWindowEvent(ev('APPEAR', { windowId: id, title: `w${id}` }));
        mm.handleWindowEvent(ev('VANISHED', { windowId: id }));
    }
    assert.ok(mm.getTracker(1), 'live window evicted');
    assert.equal(mm.getActiveWindows().map((t) => t.windowId).join(), '1');
    mm.stop();
});

test('stop() clears trackers and focus; createMaterialManager returns an instance', async () => {
    const { mm } = startedManager();
    const statuses: string[] = [];
    mm.on('status', (s) => statuses.push(s));
    mm.handleWindowEvent(ev('FOCUSED'));
    mm.stop();
    assert.equal(mm.getAllTrackers().size, 0);
    assert.deepEqual(mm.getAllMaterials(), []);
    assert.deepEqual(statuses, ['stopped']);
    const { createMaterialManager } = await import('../material-manager');
    assert.ok(createMaterialManager({ storageMode: 'remote' }) instanceof MaterialManager);
});
