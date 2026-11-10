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
