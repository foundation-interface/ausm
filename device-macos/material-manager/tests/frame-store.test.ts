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
