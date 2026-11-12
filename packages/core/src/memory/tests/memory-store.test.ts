/**
 * MemoryStore: every table, migrations from older databases, weights,
 * focus sessions, OCR results, embeddings (sqlite-vec), screenshots,
 * tasks and persons.  Uses ':memory:' or temp-dir databases only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { MemoryStore } from '../memory-store';
import type { Material, MaterialFrame } from '../types';

const DAY = 86_400_000;
const HOUR = 3_600_000;

function material(id: string, over: Partial<Material> = {}): Material {
    return {
        materialId: id,
        title: `title ${id}`,
        windowId: 1,
        application: 'App',
        bundleId: 'com.example.app',
        documentPath: null,
        lastFrameHash: null,
        firstSeen: 1,
        lastSeen: 1,
        materialType: null,
        materialTypeConfidence: null,
        totalTimeMs: 0,
        weight: null,
        appMetadata: null,
        ...over,
    };
}

let n = 0;
function frame(materialId: string, timestamp: number, over: Partial<MaterialFrame> = {}): MaterialFrame {
    return {
        frameId: `f${++n}`,
        materialId,
        windowId: 1,
        timestamp,
        width: 2,
        height: 2,
        data: Buffer.from([1, 2, 3]),
        title: 't',
        application: 'App',
        bundleId: null,
        captureReason: 'PERIODIC',
        ...over,
    };
}

function vec(seed: number, dim = 384): Float32Array {
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * 31 + i);
    return v;
}

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mem store '));
}

function session(store: MemoryStore, id: string, materialId: string, startedAt: number, durationMs: number) {
    if (materialId !== 'ghost' && !store.getMaterial(materialId)) store.saveMaterial(material(materialId));
    store.recordFocusSession({ sessionId: id, materialId, startedAt, endedAt: startedAt + durationMs, durationMs });
}

// ── Materials ─────────────────────────────────────────────────────────────

test('materials: upsert coalesces nulls, keeps max last_seen, round-trips app metadata', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('m', { documentPath: '/a', lastFrameHash: 'h', lastSeen: 100, appMetadata: { url: 'u' } }));
    s.saveMaterial(material('m', { title: 'new', documentPath: null, lastSeen: 50, appMetadata: null }));
    const m = s.getMaterial('m')!;
    assert.equal(m.title, 'new');
    assert.equal(m.documentPath, '/a');
    assert.equal(m.lastFrameHash, 'h');
    assert.equal(m.lastSeen, 100);
    assert.deepEqual(m.appMetadata, { url: 'u' });
    assert.equal(m.totalTimeMs, 0);
    assert.equal(m.weight, null);
    s.updateMaterialType('m', 'code', 0.8);
    s.updateMaterial('m', 'h2', 200, '/b');
    assert.equal(s.getMaterial('m')!.materialType, 'code');
    assert.equal(s.getMaterial('m')!.documentPath, '/b');
    assert.equal(s.getMaterial('missing'), null);
    s.close();
});

test('materials: getAllMaterials orders by last_seen DESC; corrupt metadata JSON reads as null', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('old', { lastSeen: 1 }));
    s.saveMaterial(material('new', { lastSeen: 9 }));
    assert.deepEqual(s.getAllMaterials().map((m) => m.materialId), ['new', 'old']);
    (s as unknown as { db: Database.Database }).db
        .prepare('UPDATE materials SET app_metadata_json = ? WHERE material_id = ?').run('{bad', 'old');
    assert.equal(s.getMaterial('old')!.appMetadata, null);
    s.close();
});

test('searchMaterials: keywords AND-ed across fields, case-insensitive, empty query → []', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('a', { title: 'Quarterly Report', application: 'Pages' }));
    s.saveMaterial(material('b', { title: 'Inbox', appMetadata: { url: 'https://mail.example.com' } }));
    s.saveMaterial(material('c', { title: 'Notes', documentPath: '/Users/me/日本語.txt' }));
    assert.deepEqual(s.searchMaterials('quarterly pages').map((m) => m.materialId), ['a']);
    assert.deepEqual(s.searchMaterials('MAIL.example').map((m) => m.materialId), ['b']);
    assert.deepEqual(s.searchMaterials('日本語').map((m) => m.materialId), ['c']);
    assert.deepEqual(s.searchMaterials('   '), []);
    assert.deepEqual(s.searchMaterials('quarterly inbox'), []);
    assert.equal(s.searchMaterials('title', 1).length, 0, 'title text is not "title"');
    s.close();
});

test('searchMaterials: LIKE wildcards in the query are matched literally', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('a', { title: 'Budget 100% final' }));
    s.saveMaterial(material('b', { title: 'Something else' }));
    s.saveMaterial(material('c', { title: 'snake_case.py' }));
    s.saveMaterial(material('d', { title: 'snakeXcase.py' }));
    assert.deepEqual(s.searchMaterials('%').map((m) => m.materialId), ['a']);
    assert.deepEqual(s.searchMaterials('snake_case').map((m) => m.materialId), ['c']);
    assert.deepEqual(s.searchMaterials('\\').map((m) => m.materialId), []);
    s.close();
});

test('searchMaterials: heavier materials first', () => {
    const s = new MemoryStore();
    const now = Date.now();
    s.saveMaterial(material('light', { title: 'doc light', lastSeen: 9 }));
    s.saveMaterial(material('heavy', { title: 'doc heavy', lastSeen: 1 }));
    session(s, 's1', 'heavy', now - 1000, HOUR);
    assert.deepEqual(s.searchMaterials('doc').map((m) => m.materialId), ['heavy', 'light']);
    s.close();
});

// ── Frames ────────────────────────────────────────────────────────────────

test('frames: per-material eviction, window queries, since-cursor, meta omits data', () => {
    const s = new MemoryStore({ maxFramesPerMaterial: 3 });
    s.saveMaterial(material('m'));
    for (let t = 1; t <= 5; t++) s.addFrame(frame('m', t), `h${t}`);
    assert.deepEqual(s.getFrames('m').map((f) => f.timestamp), [3, 4, 5]);
    assert.equal(s.getMaterial('m')!.lastFrameHash, 'h5');
    assert.deepEqual(s.getFramesSince('m', 3).map((f) => f.timestamp), [4, 5]);
    assert.deepEqual(s.getFramesSince('m', 0, 1).map((f) => f.timestamp), [3]);
    assert.equal(s.getFramesByWindow(1).length, 3);
    assert.equal('data' in (s.getFramesMeta('m')[0] as object), false);
    assert.equal('data' in (s.getFramesByWindowMeta(1)[0] as object), false);
    assert.equal(s.getFrameCountByWindow(1), 3);
    assert.equal(s.getLatestFrame('m')!.timestamp, 5);
    assert.equal(s.getLatestFrame('x'), null);
    assert.equal(s.getFrameById('nope'), null);
    assert.equal(s.deleteFramesOlderThan(5), 2);
    assert.equal(s.getFrameCount('m'), 1);
    s.close();
});

test('frames: last_seen does not regress when a frame has an older timestamp (clock jump)', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('m', { lastSeen: 5000 }));
    s.addFrame(frame('m', 1000), 'h');
    assert.equal(s.getMaterial('m')!.lastSeen, 5000);
    s.close();
});

test('frames: duplicate frame id leaves the material untouched', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('m'));
    const f = frame('m', 10);
    s.addFrame(f, 'h1');
    assert.throws(() => s.addFrame({ ...f, timestamp: 20 }, 'h2'), /UNIQUE/);
    assert.equal(s.getMaterial('m')!.lastFrameHash, 'h1');
    assert.equal(s.getFrameCount('m'), 1);
    s.close();
});

test('frames: huge blob round-trips; missing captureReason stored as UNKNOWN', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('m'));
    const data = Buffer.alloc(20 * 1024 * 1024, 7);
    const f = frame('m', 1, { data, captureReason: undefined as unknown as string });
    s.addFrame(f, 'h');
    const back = s.getFrameById(f.frameId)!;
    assert.ok(back.data.equals(data));
    assert.equal(back.captureReason, 'UNKNOWN');
    s.close();
});

// ── Focus sessions & weights ─────────────────────────────────────────────

test('focus sessions accumulate total time and list newest first', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('m'));
    session(s, 'a', 'm', 1000, 500);
    session(s, 'b', 'm', 5000, 1500);
    assert.equal(s.getMaterialTotalTime('m'), 2000);
    assert.equal(s.getMaterial('m')!.totalTimeMs, 2000);
    assert.deepEqual(s.getFocusSessions('m').map((x) => x.sessionId), ['b', 'a']);
    assert.equal(s.getFocusSessions('m', 1).length, 1);
    assert.equal(s.getMaterialTotalTime('unknown'), 0);
    s.close();
});

test('focus sessions: a replayed session id is not double-counted', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('m'));
    session(s, 'dup', 'm', 1000, 700);
    session(s, 'dup', 'm', 1000, 700);
    assert.equal(s.getFocusSessions('m').length, 1);
    assert.equal(s.getMaterialTotalTime('m'), 700);
    s.close();
});

test('focus sessions: negative durations (clock went backwards) do not reduce total time', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('m'));
    session(s, 'a', 'm', 1000, 1000);
    s.recordFocusSession({ sessionId: 'b', materialId: 'm', startedAt: 5000, endedAt: 2000, durationMs: -3000 });
    assert.equal(s.getMaterialTotalTime('m'), 1000);
    const w = s.computeAllMaterialWeights();
    assert.ok(Number.isFinite(w.m) && w.m >= 0, String(w.m));
    s.close();
});

test('focus sessions and OCR results require a saved material (foreign keys enforced)', () => {
    const s = new MemoryStore();
    assert.throws(() => session(s, 'a', 'ghost', Date.now(), HOUR), /FOREIGN KEY/);
    assert.throws(
        () => s.upsertMaterialOcr({ materialId: 'ghost', text: '', lineCount: 0, frameCount: 0, lastFrameTs: 0 }),
        /FOREIGN KEY/,
    );
    assert.equal(s.getFocusSessions('ghost').length, 0);
    s.close();
});

test('a frame for a material whose save was lost creates a minimal material row', () => {
    const s = new MemoryStore();
    s.addFrame(frame('lost', 50, { title: 'From frame', windowId: 4 }), 'h');
    const m = s.getMaterial('lost')!;
    assert.equal(m.title, 'From frame');
    assert.equal(m.windowId, 4);
    assert.equal(m.lastFrameHash, 'h');
    // a later save-material fills in the rest
    s.saveMaterial(material('lost', { title: 'Real', documentPath: '/d', firstSeen: 10, lastSeen: 40 }));
    assert.equal(s.getMaterial('lost')!.documentPath, '/d');
    assert.equal(s.getMaterial('lost')!.lastSeen, 50);
    s.addFrame(frame('untitled', 1, { title: null }), 'h');
    assert.equal(s.getMaterial('untitled')!.title, '');
    s.close();
});

test('weights: decay math at age 0, one half-life, huge ages', (t) => {
    const s = new MemoryStore();
    const now = 1_700_000_000_000;
    t.mock.method(Date, 'now', () => now);
    session(s, 'a', 'fresh', now, HOUR); // 1h at age 0 → log(2)/log(2) = 1
    session(s, 'b', 'half', now - 7 * DAY, 2 * HOUR); // decays to 1h → 1
    session(s, 'c', 'quarter', now - 7 * DAY, HOUR); // 0.5h → log(1.5)/log(2) = 0.58
    session(s, 'd', 'ancient', now - 10_000 * DAY, 100 * HOUR); // ~0
    session(s, 'e', 'zero', now, 0);
    const w = s.computeAllMaterialWeights();
    assert.equal(w.fresh, 1);
    assert.equal(w.half, 1);
    assert.equal(w.quarter, 0.58);
    assert.equal(w.ancient, 0);
    assert.equal(w.zero, 0);
    // capped at 1
    session(s, 'f', 'fresh', now, 100 * HOUR);
    assert.equal(s.computeAllMaterialWeights().fresh, 1);
    // custom half-life: 1 day → the 7-day-old 2h session is worth 2h/128
    assert.equal(s.computeAllMaterialWeights(1).half, 0.02);
    // infinite half-life → no decay
    assert.equal(s.computeAllMaterialWeights(Infinity).quarter, 1, '1h undecayed');
    s.close();
});

test('weights: sessions in the future (negative age) count as age 0, never NaN', (t) => {
    const s = new MemoryStore();
    const now = 1_700_000_000_000;
    t.mock.method(Date, 'now', () => now);
    session(s, 'a', 'soon', now + 7 * DAY, 15 * 60_000); // 15 min, a week "ahead"
    session(s, 'b', 'far', now + 1e6 * DAY, 0); // exp overflow × 0 duration
    const w = s.computeAllMaterialWeights();
    assert.equal(w.soon, Math.round((Math.log(1.25) / Math.log(2)) * 100) / 100);
    assert.equal(w.far, 0);
    s.close();
});

test('weights: half-life of zero, negative or NaN is rejected instead of producing NaN', () => {
    const s = new MemoryStore();
    session(s, 'a', 'm', Date.now(), HOUR);
    for (const bad of [0, -7, NaN]) {
        assert.throws(() => s.computeAllMaterialWeights(bad), RangeError, String(bad));
    }
    assert.deepEqual(new MemoryStore().computeAllMaterialWeights(), {});
    s.close();
});

// ── OCR results ───────────────────────────────────────────────────────────

test('OCR results upsert and read back', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('m'));
    s.saveMaterial(material('e'));
    assert.equal(s.getMaterialOcr('m'), null);
    s.upsertMaterialOcr({ materialId: 'm', text: 'a\nb', lineCount: 2, frameCount: 1, lastFrameTs: 10 });
    s.upsertMaterialOcr({ materialId: 'm', text: 'a\nb\n日本', lineCount: 3, frameCount: 2, lastFrameTs: 20 });
    const r = s.getMaterialOcr('m')!;
    assert.equal(r.text, 'a\nb\n日本');
    assert.equal(r.lineCount, 3);
    assert.equal(r.frameCount, 2);
    assert.equal(r.lastFrameTs, 20);
    assert.ok(r.updatedAt > 0);
    s.upsertMaterialOcr({ materialId: 'e', text: '', lineCount: 0, frameCount: 1, lastFrameTs: 1 });
    assert.equal(s.getMaterialOcr('e')!.text, '');
    s.close();
});

// ── Embeddings ────────────────────────────────────────────────────────────

test('embeddings: save, replace, KNN order, missing list, semantic enrich', () => {
    const s = new MemoryStore();
    for (const id of ['a', 'b', 'c']) s.saveMaterial(material(id));
    s.saveMaterialEmbedding('a', vec(1));
    s.saveMaterialEmbedding('b', vec(2));
    assert.equal(s.getEmbeddingCount(), 2);
    assert.deepEqual(s.getMaterialsWithoutEmbeddings(), ['c']);
    const hits = s.searchMaterialsByVector(vec(2), 2);
    assert.equal(hits[0].materialId, 'b');
    assert.ok(hits[0].distance < 1e-5);
    // replace a's vector with b's → both now equidistant
    s.saveMaterialEmbedding('a', vec(2));
    assert.equal(s.getEmbeddingCount(), 2);
    assert.ok(s.searchMaterialsByVector(vec(2), 2).every((h) => h.distance < 1e-5));
    assert.deepEqual(s.searchMaterialsSemantic(vec(2), 5).map((m) => m.materialId).sort(), ['a', 'b']);
    // embedding of a material later removed from materials is skipped by semantic search
    (s as unknown as { db: Database.Database }).db.prepare("DELETE FROM materials WHERE material_id='a'").run();
    assert.deepEqual(s.searchMaterialsSemantic(vec(2), 5).map((m) => m.materialId), ['b']);
    s.close();
});

test('embeddings: wrong dimension is rejected and the previous vector survives', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('a'));
    s.saveMaterialEmbedding('a', vec(1));
    assert.throws(() => s.saveMaterialEmbedding('a', vec(1, 10)));
    assert.equal(s.getEmbeddingCount(), 1);
    assert.equal(s.searchMaterialsByVector(vec(1), 1)[0]?.materialId, 'a');
    assert.throws(() => s.searchMaterialsByVector(vec(1, 128), 1));
    s.close();
});

test('embeddings: Float32Array views with a byte offset are handled', () => {
    const s = new MemoryStore();
    s.saveMaterial(material('a'));
    s.saveMaterial(material('b'));
    const backing = new Float32Array(384 * 3);
    backing.set(vec(1), 0);
    backing.set(vec(2), 384);
    const viewA = backing.subarray(0, 384);
    const viewB = backing.subarray(384, 768);
    s.saveMaterialEmbedding('a', viewA);
    s.saveMaterialEmbedding('b', viewB);
    assert.equal(s.searchMaterialsByVector(viewB, 1)[0].materialId, 'b');
    assert.equal(s.searchMaterialsByVector(viewA, 1)[0].materialId, 'a');
    s.close();
});

test('buildEmbeddingText joins the useful fields and tolerates bad JSON', () => {
    assert.equal(
        MemoryStore.buildEmbeddingText({
            title: 'T', application: 'App', documentPath: '/p',
            appMetadata: { url: 'https://x', hostname: 'x', filename: 'f.ts', other: 'ignored' },
        }),
        'T | App | /p | https://x | x | f.ts',
    );
    assert.equal(MemoryStore.buildEmbeddingText({ title: 'T', appMetadataJson: '{"hostname":"h"}' }), 'T | h');
    assert.equal(MemoryStore.buildEmbeddingText({ title: 'T', appMetadataJson: '{oops' }), 'T');
    assert.equal(MemoryStore.buildEmbeddingText({ title: '' }), '');
});

// ── Screenshots ───────────────────────────────────────────────────────────

test('screenshots: replace by id, since/limit filter, meta omits data', () => {
    const s = new MemoryStore();
    const shot = (id: string, ts: number) => ({
        screenshotId: id, timestamp: ts, width: 10, height: 5, data: Buffer.from(id),
        mimeType: 'image/png', boundsX: 1.5, boundsY: null, boundsW: 3, boundsH: null, screenshotType: 'area',
    });
    s.saveScreenshot(shot('a', 100));
    s.saveScreenshot(shot('b', 200));
    s.saveScreenshot({ ...shot('a', 300), data: Buffer.from('a2') });
    assert.equal(s.getScreenshot('a')!.data.toString(), 'a2');
    assert.equal(s.getScreenshot('a')!.boundsX, 1.5);
    assert.equal(s.getScreenshot('nope'), null);
    assert.deepEqual(s.getScreenshots().map((x) => x.screenshotId), ['a', 'b']);
    assert.deepEqual(s.getScreenshots(1).map((x) => x.screenshotId), ['a']);
    assert.deepEqual(s.getScreenshots(50, 250).map((x) => x.screenshotId), ['a']);
    const meta = s.getScreenshotsMeta() as unknown as Record<string, unknown>[];
    assert.equal('data' in meta[0], false);
    assert.equal(meta[0].mimeType, 'image/png');
    assert.equal(s.getStats().screenshotCount, 2);
    s.close();
});

// ── Tasks ─────────────────────────────────────────────────────────────────

test('tasks: upsert coalesces, last_seen is monotonic, events dedupe by eventId', () => {
    const s = new MemoryStore();
    assert.equal(s.ingestTaskEvent({ eventId: 'e1', taskId: 't', taskLabel: 'Write', status: 'TASK_STARTED', timestamp: 100, level: 'leaf' }), true);
    assert.equal(s.ingestTaskEvent({ eventId: 'e1', taskId: 't', taskLabel: 'Write', timestamp: 100 }), false);
    s.ingestTaskEvent({ eventId: 'e2', taskId: 't', taskDescription: 'desc', timestamp: 50 });
    const [task] = s.getTasks();
    assert.equal(task.label, 'Write', 'missing label falls back to "Unknown task" only on insert');
    assert.equal(task.description, 'desc');
    assert.equal(task.lastSeen, 100);
    assert.equal(task.firstSeen, 100);
    assert.equal(s.getTaskHistory('t').length, 2);
    // events without eventId are never deduplicated
    s.ingestTaskEvent({ taskId: 't', timestamp: 1 });
    s.ingestTaskEvent({ taskId: 't', timestamp: 1 });
    assert.equal(s.getRecentTaskEvents().length, 4);
    assert.equal(s.getRecentTaskEvents(1)[0].eventId, 'e1');
    s.close();
});

test('tasks: label/status/level defaults, timestamp 0 → now, parent/child and level queries', () => {
    const s = new MemoryStore();
    const before = Date.now();
    s.ingestTaskEvent({ taskId: 'g', taskLabel: 'Goal', level: 'goal', timestamp: 0 });
    s.ingestTaskEvent({ taskId: 'c1', parentTaskId: 'g', timestamp: 5 });
    const g = s.getTasksByLevel('goal')[0];
    assert.ok(g.firstSeen >= before);
    const c = s.getChildTasks('g')[0];
    assert.equal(c.label, 'Unknown task');
    assert.equal(c.status, 'TASK_DETECTED');
    assert.equal(c.level, 'action');
    assert.equal(s.getChildTasks('none').length, 0);
    assert.equal(s.getTasks(1).length, 1);
    s.close();
});

// ── Persons ───────────────────────────────────────────────────────────────

test('persons: dedupe tiers (email, name+company, name, prefix+context, unique prefix)', () => {
    const s = new MemoryStore();
    const enc = (id: string, over: Record<string, unknown>) => s.ingestPersonEncounter({
        encounterId: id, name: 'x', context: 'ctx', confidence: 0.9, timestamp: Number(id.slice(1)), ...over,
    } as Parameters<MemoryStore['ingestPersonEncounter']>[0]);
    const a = enc('e1', { name: '  Julie   Conner ', email: 'J@X.com', platform: 'Gmail' });
    assert.equal(a.isNew, true);
    assert.equal(s.getPerson(a.personId)!.name, 'Julie Conner');
    assert.equal(enc('e2', { name: 'Totally Different', email: 'j@x.com' }).personId, a.personId, 'email tier');
    assert.equal(enc('e3', { name: 'julie conner' }).personId, a.personId, 'name tier');
    assert.equal(enc('e4', { name: 'Julie', platform: 'gmail' }).personId, a.personId, 'prefix + context');
    const bob = enc('e5', { name: 'Bob', company: 'Acme' });
    assert.equal(enc('e6', { name: 'bob', company: 'ACME' }).personId, bob.personId, 'name + company');
    const bobFull = enc('e7', { name: 'Bob Stone' });
    assert.equal(bobFull.personId, bob.personId, 'unique prefix');
    assert.equal(s.getPerson(bob.personId)!.name, 'Bob Stone', 'name upgraded to fuller form');
    s.close();
});

test('persons: replayed encounter (same encounterId / detectorEventId) is not counted twice', () => {
    const s = new MemoryStore();
    const e = { encounterId: 'e1', name: 'Ann', context: 'c', confidence: 1, timestamp: 10, detectorEventId: 'd1' };
    const first = s.ingestPersonEncounter(e);
    const again = s.ingestPersonEncounter(e);
    assert.equal(again.personId, first.personId);
    assert.equal(again.isNew, false);
    s.ingestPersonEncounter({ ...e, encounterId: 'e2', name: 'Someone Else' }); // same detector event
    assert.equal(s.getPerson(first.personId)!.encounterCount, 1);
    assert.equal(s.getPersons().length, 1, 'no orphan person created by a duplicate detector event');
    assert.equal(s.getPersonEncounters(first.personId).length, 1);
    s.close();
});

test('persons: profile aggregates, weights decay, relationship update', () => {
    const s = new MemoryStore();
    const now = Date.now();
    const p = s.ingestPersonEncounter({ encounterId: 'a', name: 'Kim', context: 'c', confidence: 1, timestamp: now - 10,
        email: 'k@a.com', company: 'A', role: 'Eng', weight: 1, relationship: ' colleague ' });
    s.ingestPersonEncounter({ encounterId: 'b', name: 'Kim', context: 'c', confidence: 1, timestamp: now,
        email: 'k@b.com', company: 'B', handle: '@kim' });
    const prof = s.getPersonProfile(p.personId)!;
    assert.equal(prof.currentCompany, 'B');
    assert.equal(prof.currentRole, 'Eng');
    assert.equal(prof.currentRelationship, 'colleague');
    assert.deepEqual(prof.allEmails.sort(), ['k@a.com', 'k@b.com']);
    assert.deepEqual(prof.allHandles, ['@kim']);
    assert.equal(s.getPersonProfile('nobody'), null);
    assert.equal(s.recomputeAllPersonWeights()[p.personId], 1);
    assert.equal(s.getPersons()[0].weight, 1);
    s.updatePersonRelationship(p.personId, 'friend');
    assert.equal(s.getPerson(p.personId)!.relationship, 'friend');
    s.close();
});

// ── Files, migrations, concurrency ───────────────────────────────────────

test('on-disk database: path with spaces/unicode, owner-only permissions', () => {
    const dir = tmpDir();
    try {
        const dbPath = path.join(dir, 'nested dir', 'メモリ.db');
        const s = new MemoryStore({ dbPath });
        s.saveMaterial(material('m'));
        s.addFrame(frame('m', 1), 'h');
        assert.equal(fs.statSync(path.dirname(dbPath)).mode & 0o777, 0o700);
        for (const suffix of ['', '-wal', '-shm']) {
            if (fs.existsSync(dbPath + suffix)) {
                assert.equal(fs.statSync(dbPath + suffix).mode & 0o777, 0o600, suffix || 'db');
            }
        }
        s.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('same database opened twice: writes visible across instances, vec table shared', () => {
    const dir = tmpDir();
    try {
        const dbPath = path.join(dir, 'm.db');
        const a = new MemoryStore({ dbPath });
        const b = new MemoryStore({ dbPath });
        a.saveMaterial(material('m'));
        b.addFrame(frame('m', 1), 'h');
        b.saveMaterialEmbedding('m', vec(3));
        assert.equal(a.getFrameCount('m'), 1);
        assert.equal(a.searchMaterialsByVector(vec(3), 1)[0].materialId, 'm');
        // interleaved writes from both connections
        for (let i = 0; i < 50; i++) (i % 2 ? a : b).addFrame(frame('m', 10 + i), 'h');
        assert.equal(b.getFrameCount('m'), 51);
        a.close();
        b.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('older database schema is migrated (missing total_time, app metadata, capture_reason, person columns)', () => {
    const dir = tmpDir();
    try {
        const dbPath = path.join(dir, 'old.db');
        const old = new Database(dbPath);
        old.exec(`
            CREATE TABLE materials (material_id TEXT PRIMARY KEY, title TEXT NOT NULL, window_id INTEGER NOT NULL,
              application TEXT, bundle_id TEXT, document_path TEXT, last_frame_hash TEXT,
              first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, material_type TEXT, material_type_confidence REAL);
            CREATE TABLE frames (frame_id TEXT PRIMARY KEY, material_id TEXT NOT NULL, window_id INTEGER NOT NULL,
              timestamp INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, data BLOB NOT NULL,
              hash TEXT, title TEXT, application TEXT, bundle_id TEXT);
            CREATE TABLE persons (person_id TEXT PRIMARY KEY, name TEXT NOT NULL, notes TEXT,
              first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, encounter_count INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE person_encounters (encounter_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, context TEXT NOT NULL,
              platform TEXT, application TEXT, role TEXT, company TEXT, email TEXT, handle TEXT,
              confidence REAL NOT NULL, timestamp INTEGER NOT NULL, detector_event_id TEXT);
            INSERT INTO materials VALUES ('legacy', 'Old', 1, NULL, NULL, NULL, NULL, 1, 2, NULL, NULL);
            INSERT INTO frames VALUES ('f0', 'legacy', 1, 2, 1, 1, x'00', 'h', 'Old', NULL, NULL);
        `);
        old.close();
        const s = new MemoryStore({ dbPath });
        assert.equal(s.getMaterial('legacy')!.totalTimeMs, 0);
        assert.equal(s.getFrames('legacy')[0].captureReason, 'UNKNOWN');
        s.addFrame(frame('legacy', 3, { captureReason: 'FOCUSED' }), 'h2');
        assert.equal(s.getLatestFrame('legacy')!.captureReason, 'FOCUSED');
        s.saveMaterial(material('n', { appMetadata: { url: 'u' } }));
        assert.deepEqual(s.getMaterial('n')!.appMetadata, { url: 'u' });
        session(s, 's', 'legacy', Date.now(), 1000);
        assert.equal(s.getMaterialTotalTime('legacy'), 1000);
        const p = s.ingestPersonEncounter({ encounterId: 'e', name: 'A', context: 'c', confidence: 1, timestamp: 1, weight: 0.5 });
        assert.equal(s.getPerson(p.personId)!.weight, 0.5);
        s.close();
        new MemoryStore({ dbPath }).close(); // re-open is a no-op
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('closed store throws on use; stats on an empty store', () => {
    const s = new MemoryStore({ walMode: false });
    assert.deepEqual(
        { ...s.getStats(), dbSizeBytes: 0 },
        { materialCount: 0, frameCount: 0, screenshotCount: 0, dbSizeBytes: 0 },
    );
    s.close();
    assert.throws(() => s.getAllMaterials());
});
