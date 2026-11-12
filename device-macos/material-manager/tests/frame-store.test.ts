import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { FrameStore } from '../frame-store';
import type { Material, MaterialFrame } from '../types';

function material(id: string, windowId = 1): Material {
    return {
        materialId: id,
        title: `title ${id}`,
        windowId,
        application: 'App',
        bundleId: 'com.example.app',
        documentPath: null,
        lastFrameHash: null,
        firstSeen: 1,
        lastSeen: 1,
        materialType: null,
        materialTypeConfidence: null,
        appMetadata: { url: 'https://example.com' },
    };
}

let n = 0;
function frame(materialId: string, timestamp: number, windowId = 1): MaterialFrame {
    return {
        frameId: `f${++n}`,
        materialId,
        windowId,
        timestamp,
        width: 10,
        height: 10,
        data: Buffer.from([1, 2, 3]),
        title: 'x',
        application: 'App',
        bundleId: 'com.example.app',
        captureReason: 'PERIODIC',
    };
}

test('per-material cap evicts oldest frames', () => {
    const store = new FrameStore({ maxFramesPerMaterial: 3, maxTotalFrames: 0 });
    store.saveMaterial(material('m1'));
    for (let t = 1; t <= 5; t++) store.addFrame(frame('m1', t), 'h');
    const frames = store.getFrames('m1');
    assert.deepEqual(frames.map((f) => f.timestamp), [3, 4, 5]);
    assert.equal(frames[0].captureReason, 'PERIODIC');
    assert.equal(store.getFramesMeta('m1')[0].captureReason, 'PERIODIC');
    assert.equal(store.getLatestFrame('m1')?.timestamp, 5);
    assert.equal(store.getMaterial('m1')?.lastFrameHash, 'h');
    assert.deepEqual(store.getMaterial('m1')?.appMetadata, { url: 'https://example.com' });
    store.close();
    store.close(); // idempotent
    assert.equal(store.isOpen, false);
});

test('global cap and age retention bound total frames', () => {
    const store = new FrameStore({ maxFramesPerMaterial: 1000, maxTotalFrames: 10 });
    store.saveMaterial(material('a'));
    store.saveMaterial(material('b'));
    for (let t = 1; t <= 30; t++) store.addFrame(frame(t % 2 ? 'a' : 'b', t), 'h');
    store.enforceGlobalRetention();
    assert.equal(store.getStats().frameCount, 10);
    // the newest frames survive
    const all = [...store.getFrames('a'), ...store.getFrames('b')].map((f) => f.timestamp).sort((x, y) => x - y);
    assert.deepEqual(all, [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    store.close();

    const aged = new FrameStore({ maxTotalFrames: 0, maxFrameAgeMs: 1000 });
    aged.saveMaterial(material('c'));
    aged.addFrame(frame('c', Date.now() - 10_000), 'h');
    aged.addFrame(frame('c', Date.now()), 'h');
    assert.equal(aged.enforceGlobalRetention(), 1);
    assert.equal(aged.getFrameCount('c'), 1);
    aged.close();
});

test('on-disk database is owner-only and older schemas are migrated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-store-'));
    try {
        const dbPath = path.join(dir, 'nested', 'frames.db');

        // Simulate a database created by an older version (no capture_reason / app_metadata).
        fs.mkdirSync(path.dirname(dbPath), { mode: 0o755 });
        const old = new Database(dbPath);
        old.exec(`
            CREATE TABLE materials (material_id TEXT PRIMARY KEY, title TEXT NOT NULL, window_id INTEGER NOT NULL,
              application TEXT, bundle_id TEXT, document_path TEXT, last_frame_hash TEXT,
              first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
            CREATE TABLE frames (frame_id TEXT PRIMARY KEY, material_id TEXT NOT NULL, window_id INTEGER NOT NULL,
              timestamp INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, data BLOB NOT NULL,
              hash TEXT, title TEXT, application TEXT, bundle_id TEXT);
        `);
        old.close();
        fs.chmodSync(dbPath, 0o644);

        const store = new FrameStore({ dbPath });
        assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
        store.saveMaterial(material('m'));
        store.addFrame(frame('m', 1), 'h');
        assert.equal(store.getFrames('m')[0].captureReason, 'PERIODIC');
        assert.deepEqual(store.getMaterial('m')?.appMetadata, { url: 'https://example.com' });
        store.close();

        // Fresh path in a directory that does not exist yet → dir 0700, file 0600.
        const fresh = path.join(dir, 'new-dir', 'frames.db');
        const s2 = new FrameStore({ dbPath: fresh });
        s2.close();
        assert.equal(fs.statSync(path.dirname(fresh)).mode & 0o777, 0o700);
        assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mm store '));
}

test('last_seen never moves backwards when a frame carries an older timestamp (clock jump)', () => {
    const store = new FrameStore();
    const m = material('m');
    m.lastSeen = 5_000;
    store.saveMaterial(m);
    store.addFrame(frame('m', 9_000), 'h1');
    store.addFrame(frame('m', 1_000), 'h2'); // wall clock went backwards
    assert.equal(store.getMaterial('m')!.lastSeen, 9_000);
    assert.equal(store.getMaterial('m')!.lastFrameHash, 'h2', 'hash still tracks the newest insert');
    store.close();
});

test('per-material eviction with identical timestamps drops insertion-oldest first', () => {
    const store = new FrameStore({ maxFramesPerMaterial: 2, maxTotalFrames: 0 });
    store.saveMaterial(material('m'));
    const ids = [frame('m', 5), frame('m', 5), frame('m', 5)].map((f) => {
        store.addFrame(f, 'h');
        return f.frameId;
    });
    assert.deepEqual(store.getFrames('m').map((f) => f.frameId).sort(), ids.slice(1).sort());
    store.close();
});

test('maxFramesPerMaterial 0 keeps nothing; eviction is per material', () => {
    const store = new FrameStore({ maxFramesPerMaterial: 1, maxTotalFrames: 0 });
    store.saveMaterial(material('a'));
    store.saveMaterial(material('b'));
    store.addFrame(frame('a', 1), 'h');
    store.addFrame(frame('a', 2), 'h');
    store.addFrame(frame('b', 3), 'h');
    assert.equal(store.getFrameCount('a'), 1);
    assert.equal(store.getFrameCount('b'), 1);
    assert.equal(store.evictOldFrames('a'), 0);
    store.close();

    const none = new FrameStore({ maxFramesPerMaterial: 0, maxTotalFrames: 0 });
    none.saveMaterial(material('a'));
    assert.equal(none.addFrame(frame('a', 1), 'h'), 1);
    assert.equal(none.getFrameCount('a'), 0);
    none.close();
});

test('global retention runs automatically every 25 inserts', () => {
    const store = new FrameStore({ maxFramesPerMaterial: 1000, maxTotalFrames: 5 });
    store.saveMaterial(material('a'));
    let evicted = 0;
    for (let t = 1; t <= 24; t++) evicted += store.addFrame(frame('a', t), 'h');
    assert.equal(evicted, 0);
    assert.equal(store.getStats().frameCount, 24);
    evicted += store.addFrame(frame('a', 25), 'h');
    assert.equal(evicted, 20);
    assert.equal(store.getStats().frameCount, 5);
    store.close();
});

test('saveMaterial upsert keeps known fields when the update carries nulls', () => {
    const store = new FrameStore();
    const m = material('m');
    m.documentPath = 'file:///a';
    m.lastFrameHash = 'h0';
    m.materialType = 'code';
    m.materialTypeConfidence = 0.9;
    m.lastSeen = 100;
    store.saveMaterial(m);
    store.saveMaterial({
        ...m, title: 'renamed', windowId: 9, documentPath: null, lastFrameHash: null,
        materialType: null, materialTypeConfidence: null, appMetadata: null, lastSeen: 50,
    });
    const got = store.getMaterial('m')!;
    assert.equal(got.title, 'renamed');
    assert.equal(got.windowId, 9);
    assert.equal(got.documentPath, 'file:///a');
    assert.equal(got.lastFrameHash, 'h0');
    assert.equal(got.materialType, 'code');
    assert.equal(got.materialTypeConfidence, 0.9);
    assert.deepEqual(got.appMetadata, { url: 'https://example.com' });
    assert.equal(got.lastSeen, 100);
    assert.equal(got.firstSeen, 1);

    store.updateMaterialType('m', 'article', 0.4);
    store.updateMaterial('m', 'h9', 200, null);
    const upd = store.getMaterial('m')!;
    assert.equal(upd.materialType, 'article');
    assert.equal(upd.lastFrameHash, 'h9');
    assert.equal(upd.documentPath, 'file:///a');
    assert.equal(store.getMaterial('nope'), null);
    assert.equal(store.getAllMaterials().length, 1);
    store.close();
});

test('unicode / huge titles and app metadata round-trip; corrupt JSON reads as null', () => {
    const store = new FrameStore();
    const m = material('u');
    m.title = '📄 '.repeat(50_000);
    m.appMetadata = { url: 'https://例え.jp/?q="quotes"', note: null };
    store.saveMaterial(m);
    assert.equal(store.getMaterial('u')!.title, m.title);
    assert.deepEqual(store.getMaterial('u')!.appMetadata, m.appMetadata);
    const db = (store as unknown as { db: Database.Database }).db;
    for (const bad of ['{not json', '[1,2]', '"str"', 'null', '']) {
        db.prepare('UPDATE materials SET app_metadata = ? WHERE material_id = ?').run(bad, 'u');
        assert.equal(store.getMaterial('u')!.appMetadata, null, bad);
    }
    store.close();
});

test('huge frame blobs round-trip byte-exact', () => {
    const store = new FrameStore();
    store.saveMaterial(material('big'));
    const data = Buffer.alloc(24 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 4096) data[i] = i & 0xff;
    const f = { ...frame('big', 1), data };
    store.addFrame(f, 'h');
    const back = store.getFrameById(f.frameId)!;
    assert.equal(back.data.length, data.length);
    assert.ok(back.data.equals(data));
    assert.ok(store.getStats().dbSizeBytes > data.length);
    store.close();
});

test('missing capture_reason reads as UNKNOWN; window queries and meta omit data', () => {
    const store = new FrameStore();
    store.saveMaterial(material('m', 3));
    const f = { ...frame('m', 1, 3), captureReason: undefined as unknown as string };
    store.addFrame(f, 'h');
    assert.equal(store.getFrames('m')[0].captureReason, 'UNKNOWN');
    assert.equal(store.getFramesByWindow(3).length, 1);
    const meta = store.getFramesByWindowMeta(3)[0] as Record<string, unknown>;
    assert.equal('data' in meta, false);
    assert.equal(store.getFrameCountByWindow(3), 1);
    assert.equal(store.getFrameCountByWindow(4), 0);
    assert.equal(store.getLatestFrame('none'), null);
    assert.equal(store.getFrameById('none'), null);
    assert.equal(store.deleteFramesOlderThan(2), 1);
    store.close();
});

test('duplicate frame id is rejected and leaves the store consistent', () => {
    const store = new FrameStore();
    store.saveMaterial(material('m'));
    const f = frame('m', 1);
    store.addFrame(f, 'h1');
    assert.throws(() => store.addFrame({ ...f, timestamp: 2 }, 'h2'), /UNIQUE/);
    assert.equal(store.getFrameCount('m'), 1);
    assert.equal(store.getMaterial('m')!.lastFrameHash, 'h1', 'material update rolled back');
    store.close();
});

test('using a closed store throws; close is idempotent', () => {
    const store = new FrameStore();
    store.close();
    assert.equal(store.isOpen, false);
    assert.throws(() => store.saveMaterial(material('x')));
    store.close();
});

test('same database opened twice (two processes / instances) sees each other\'s writes', () => {
    const dir = tmpDir();
    try {
        const dbPath = path.join(dir, 'frames.db');
        const a = new FrameStore({ dbPath });
        const b = new FrameStore({ dbPath });
        a.saveMaterial(material('m'));
        b.addFrame(frame('m', 1), 'hb');
        assert.equal(a.getFrameCount('m'), 1);
        assert.equal(a.getMaterial('m')!.lastFrameHash, 'hb');
        a.close();
        b.addFrame(frame('m', 2), 'hc');
        b.close();
        const c = new FrameStore({ dbPath });
        assert.equal(c.getFrameCount('m'), 2);
        c.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('paths with spaces and unicode work; WAL side files are owner-only', () => {
    const dir = tmpDir();
    try {
        const dbPath = path.join(dir, 'sub dir', 'データ frames.db');
        const s = new FrameStore({ dbPath });
        s.saveMaterial(material('m'));
        s.addFrame(frame('m', 1), 'h');
        for (const suffix of ['', '-wal', '-shm']) {
            const p = dbPath + suffix;
            if (fs.existsSync(p)) assert.equal(fs.statSync(p).mode & 0o777, 0o600, p);
        }
        assert.ok(fs.existsSync(dbPath + '-wal'), 'WAL mode is on by default');
        s.close();
        const noWal = new FrameStore({ dbPath: path.join(dir, 'nowal.db'), walMode: false });
        noWal.close();
        assert.equal(fs.existsSync(path.join(dir, 'nowal.db-wal')), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test(':memory: store creates no files in the working directory', () => {
    const before = fs.readdirSync(process.cwd());
    const s = new FrameStore({ dbPath: ':memory:' });
    s.saveMaterial(material('m'));
    s.close();
    assert.deepEqual(fs.readdirSync(process.cwd()), before);
});

test('older schema variants migrate: missing confidence only, missing frames columns', () => {
    const dir = tmpDir();
    try {
        const dbPath = path.join(dir, 'old.db');
        const old = new Database(dbPath);
        old.exec(`
            CREATE TABLE materials (material_id TEXT PRIMARY KEY, title TEXT NOT NULL, window_id INTEGER NOT NULL,
              application TEXT, bundle_id TEXT, document_path TEXT, last_frame_hash TEXT,
              first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, material_type TEXT);
            CREATE TABLE frames (frame_id TEXT PRIMARY KEY, material_id TEXT NOT NULL, window_id INTEGER NOT NULL,
              timestamp INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, data BLOB NOT NULL,
              hash TEXT, title TEXT, application TEXT, bundle_id TEXT);
            INSERT INTO materials VALUES ('legacy', 'Old title', 1, 'App', NULL, NULL, 'oh', 1, 2, NULL);
            INSERT INTO frames VALUES ('f-old', 'legacy', 1, 2, 1, 1, x'00', 'oh', 'Old title', 'App', NULL);
        `);
        old.close();

        const store = new FrameStore({ dbPath });
        assert.equal(store.getMaterial('legacy')!.title, 'Old title');
        assert.equal(store.getMaterial('legacy')!.materialTypeConfidence, null);
        assert.equal(store.getFrames('legacy')[0].captureReason, 'UNKNOWN');
        store.saveMaterial(material('new'));
        store.updateMaterialType('new', 'doc', 0.5);
        assert.equal(store.getMaterial('new')!.materialTypeConfidence, 0.5);
        store.close();
        // re-opening an already-migrated DB is a no-op
        new FrameStore({ dbPath }).close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('existing world-readable directory permissions are left alone (only new dirs are 0700)', () => {
    const dir = tmpDir();
    try {
        fs.chmodSync(dir, 0o755);
        const s = new FrameStore({ dbPath: path.join(dir, 'f.db') });
        s.close();
        assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
