/**
 * Memory service message protocol, end to end through MemoryClient:
 * the real service process (src/memory/service.ts via tsx) with a fake
 * embedding model and a fake OCR worker.  Synthetic data only.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MemoryClient, type MemoryClientOptions } from '../../runtime/clients/memory-client';

const ENTRY = path.join(__dirname, 'fixtures', 'memory-service-entry.cjs');
const FAKE_OCR = path.join(__dirname, 'fixtures', 'fake-ocr-worker.js');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ENV = ['FAKE_EMBED_DIM', 'FAKE_EMBED_DELAY', 'FAKE_EMBED_FAIL', 'OCR_FAKE_DELAY', 'OCR_FAKE_MODE'];
const clients: MemoryClient[] = [];

async function client(opts: MemoryClientOptions = {}, env: Record<string, string> = {}): Promise<MemoryClient> {
    for (const k of ENV) delete process.env[k];
    Object.assign(process.env, env);
    const c = new MemoryClient({
        nodePath: process.execPath,
        servicePath: ENTRY,
        stopTimeoutMs: 3000,
        pythonPath: FAKE_OCR,
        ...opts,
    });
    clients.push(c);
    await c.start();
    return c;
}

afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.stop()));
    for (const k of ENV) delete process.env[k];
});

const mat = (id: string, over: Record<string, unknown> = {}) => ({
    materialId: id, title: `Title ${id}`, windowId: 1, application: 'App', bundleId: 'com.app',
    documentPath: null, lastFrameHash: null, firstSeen: 1, lastSeen: 1,
    materialType: null, materialTypeConfidence: null, appMetadata: null, ...over,
});
let fid = 0;
const frm = (materialId: string, ts: number, text = 'x') => ({
    frameId: `f${++fid}`, materialId, windowId: 1, timestamp: ts, width: 2, height: 1,
    data: Buffer.from(text, 'utf8'), title: `Title ${materialId}`, application: 'App', bundleId: null,
    captureReason: 'PERIODIC',
});

async function waitFor(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return;
        await sleep(25);
    }
    throw new Error('condition not met in time');
}

test('materials and frames: write, list, frame history with limits, latest frame', async () => {
    const c = await client();
    c.saveMaterial(mat('m', { appMetadata: { url: 'https://example.com' } }));
    for (let t = 1; t <= 4; t++) c.addFrame(frm('m', t * 10, `frame${t}`), `h${t}`);
    c.updateMaterialType('m', 'article', 0.7);
    const [m] = (await c.getAllMaterials()) as Array<Record<string, unknown>>;
    assert.equal(m.materialId, 'm');
    assert.equal(m.materialType, 'article');
    assert.deepEqual(m.appMetadata, { url: 'https://example.com' });
    const two = await c.getMaterialFrames('m', 2);
    assert.deepEqual(two.map((f) => f.timestamp), [30, 40]);
    assert.equal(Buffer.from(two[1].dataBase64, 'base64').toString(), 'frame4');
    assert.deepEqual(await c.getMaterialFrames('m', 0), [], 'limit 0 returns nothing, not everything');
    assert.equal((await c.getMaterialFrames('m', 100)).length, 4);
    assert.equal((await c.getMaterialLatestFrame('m'))!.timestamp, 40);
    assert.equal(await c.getMaterialLatestFrame('missing'), null);
    await assert.rejects(c.getMaterialFrames(''), /materialId required/);
    assert.equal((await c.getAllMaterials(0)).length, 0);
});

test('screenshots round-trip; ids and since/limit filters', async () => {
    const c = await client();
    const png = Buffer.from('synthetic-png').toString('base64');
    c.saveScreenshot({ screenshotId: 's1', dataBase64: png, width: 3, height: 2, timestamp: 100,
        bounds: { x: 1, y: 2, width: 3, height: 4 }, screenshotType: 'area' });
    c.saveScreenshot({ screenshotId: 's2', dataBase64: png, width: 3, height: 2, timestamp: 200 });
    c.saveScreenshot({ screenshotId: 's3', dataBase64: '', width: 3, height: 2 }); // no data → ignored
    const one = await c.getScreenshot('s1');
    assert.equal(Buffer.from(one!.dataBase64, 'base64').toString(), 'synthetic-png');
    assert.equal(one!.boundsW, 3);
    assert.equal(await c.getScreenshot('nope'), null);
    assert.deepEqual((await c.getScreenshots()).map((s) => s.screenshotId), ['s2', 's1']);
    assert.deepEqual((await c.getScreenshots(50, 150)).map((s) => s.screenshotId), ['s2']);
    assert.equal('dataBase64' in (await c.getScreenshots())[0], false);
});

test('focus sessions feed weights; invalid half-life is reported as an error', async () => {
    const c = await client();
    c.saveMaterial(mat('m'));
    const now = Date.now();
    c.recordFocusSession({ sessionId: 's', materialId: 'm', startedAt: now - 3_600_000, endedAt: now, durationMs: 3_600_000 });
    c.recordFocusSession({ sessionId: 's', materialId: 'm', startedAt: now - 3_600_000, endedAt: now, durationMs: 3_600_000 });
    // missing fields are dropped
    c.recordFocusSession({ sessionId: '', materialId: 'm', startedAt: 1, endedAt: 2, durationMs: 1 });
    assert.deepEqual(await c.getMaterialWeights(), { m: 1 });
    const [m] = (await c.getAllMaterials()) as unknown as Array<{ totalTimeMs: number }>;
    assert.equal(m.totalTimeMs, 3_600_000);
    await assert.rejects(c.getMaterialWeights(0), /halfLifeDays/);
    await assert.rejects(c.getMaterialWeights(-1), /halfLifeDays/);
});

test('freeze: every write is a no-op, reads keep working, unfreeze resumes', async () => {
    const c = await client();
    c.saveMaterial(mat('before'));
    assert.equal(await c.freezeMemory(), true);
    assert.equal(await c.isMemoryFrozen(), true);
    c.saveMaterial(mat('during'));
    c.addFrame(frm('before', 5), 'h');
    c.updateMaterialType('before', 'x', 1);
    c.saveScreenshot({ screenshotId: 'ss', dataBase64: 'AA==', width: 1, height: 1 });
    c.recordFocusSession({ sessionId: 'z', materialId: 'before', startedAt: 1, endedAt: 2, durationMs: 1000 });
    const mats = (await c.getAllMaterials()) as Array<Record<string, unknown>>;
    assert.deepEqual(mats.map((m) => m.materialId), ['before']);
    assert.equal(mats[0].materialType, null);
    assert.deepEqual(await c.getMaterialFrames('before'), []);
    assert.deepEqual(await c.getScreenshots(), []);
    assert.deepEqual(await c.getMaterialWeights(), {});
    assert.equal(await c.unfreezeMemory(), true);
    assert.equal(await c.isMemoryFrozen(), false);
    // the material created while frozen was never saved; its frames must
    // still be kept once writes resume
    c.addFrame(frm('during', 7), 'h');
    assert.equal((await c.getMaterialFrames('during')).length, 1);
});

test('frozen: true in the config freezes before the store accepts any write', async () => {
    const c = await client({ frozen: true });
    assert.equal(await c.isMemoryFrozen(), true);
    c.saveMaterial(mat('m'));
    assert.deepEqual(await c.getAllMaterials(), []);
});

test('OCR: lines merged across frames (duplicates/empties dropped), incremental cursor', async () => {
    const c = await client({ ocrEnabled: true });
    c.saveMaterial(mat('m'));
    c.addFrame(frm('m', 10, 'Header\n\nBody text line\n  '), 'h');
    c.addFrame(frm('m', 20, 'header\nBody text line.\nNew paragraph'), 'h');
    c.addFrame(frm('m', 30, 'FAIL'), 'h'); // OCR error on one frame does not abort the run
    const r1 = await c.processMaterialOcr('m');
    assert.equal(r1.ok, true);
    assert.equal(r1.framesProcessed, 3);
    assert.equal(r1.lineCount, 3);
    const ocr = await c.getMaterialOcr('m');
    assert.equal(ocr!.text, 'Header\nBody text line\nNew paragraph');
    assert.equal(ocr!.lastFrameTs, 30);
    // nothing new → no work
    const r2 = await c.processMaterialOcr('m');
    assert.equal(r2.framesProcessed, 0);
    assert.equal(r2.lineCount, 3);
    c.addFrame(frm('m', 40, 'New paragraph\nFooter'), 'h');
    const r3 = await c.processMaterialOcr('m');
    assert.deepEqual([r3.framesProcessed, r3.addedLines, r3.lineCount], [1, 1, 4]);
    assert.equal((await c.getMaterialOcr('m'))!.frameCount, 4);
    assert.equal(await c.getMaterialOcr('never'), null);
});

test('OCR: disabled, missing id, concurrent run skipped as in-flight', async () => {
    const off = await client();
    await assert.rejects(off.processMaterialOcr('m'), /OCR disabled/);
    const c = await client({ ocrEnabled: true }, { OCR_FAKE_DELAY: '200' });
    c.saveMaterial(mat('m'));
    c.addFrame(frm('m', 1, 'abc line'), 'h');
    const [a, b] = await Promise.all([c.processMaterialOcr('m'), c.processMaterialOcr('m')]);
    assert.deepEqual([a.skipped, b.skipped].sort(), [null, 'in-flight'].sort());
    await assert.rejects(c.processMaterialOcr(''), /materialId required/);
});

test('OCR: freezing while a run is in flight leaves the stored text untouched', async () => {
    const c = await client({ ocrEnabled: true }, { OCR_FAKE_DELAY: '300' });
    c.saveMaterial(mat('m'));
    c.addFrame(frm('m', 1, 'secret line one'), 'h');
    const run = c.processMaterialOcr('m');
    await sleep(100);
    await c.freezeMemory();
    const res = await run;
    assert.equal(res.skipped, 'frozen');
    assert.equal(await c.getMaterialOcr('m'), null, 'OCR result written while frozen');
    // when frozen up front the run is skipped entirely
    assert.equal((await c.processMaterialOcr('m')).skipped, 'frozen');
});

test('embeddings: semantic search once the model is ready; backfill covers existing rows', async () => {
    const c = await client();
    c.saveMaterial(mat('a', { title: 'quarterly budget spreadsheet' }));
    c.saveMaterial(mat('b', { title: 'holiday photos album' }));
    await waitFor(async () => (await c.getEmbeddingStats()).embeddingCount === 2);
    const stats = await c.getEmbeddingStats();
    assert.equal(stats.embeddingReady, true);
    assert.equal(stats.missingCount, 0);
    assert.equal(stats.embeddingDim, 384);
    const res = await c.searchMaterials('budget');
    assert.equal(res.searchMode, 'vector');
    assert.equal(res.materials[0].materialId, 'a');
    await assert.rejects(c.searchMaterials(''), /query required/);
});

test('embeddings: model with the wrong dimension → keyword search, service keeps running', async () => {
    const c = await client({}, { FAKE_EMBED_DIM: '10' });
    c.saveMaterial(mat('a', { title: 'quarterly budget' }));
    await waitFor(async () => (await c.getEmbeddingStats()).embeddingReady);
    await sleep(100);
    const stats = await c.getEmbeddingStats();
    assert.equal(stats.embeddingCount, 0);
    assert.equal(stats.missingCount, 1);
    const res = await c.searchMaterials('budget');
    assert.equal(res.searchMode, 'keyword');
    assert.deepEqual(res.materials.map((m) => m.materialId), ['a']);
});

test('embeddings: model load failure falls back to keyword search', async () => {
    const c = await client({}, { FAKE_EMBED_FAIL: 'load' });
    c.saveMaterial(mat('a', { title: 'budget' }));
    await sleep(200);
    assert.equal((await c.getEmbeddingStats()).embeddingReady, false);
    assert.equal((await c.searchMaterials('budget')).searchMode, 'keyword');
});

test('embeddings: an embedding computed while frozen is not written', async () => {
    const c = await client({}, { FAKE_EMBED_DELAY: '250' });
    await waitFor(async () => (await c.getEmbeddingStats()).embeddingReady);
    c.saveMaterial(mat('a', { title: 'something to embed' }));
    await sleep(50);
    await c.freezeMemory();
    await sleep(400);
    await c.unfreezeMemory();
    assert.equal((await c.getEmbeddingStats()).embeddingCount, 0);
});

test('garbage on stdin and unknown message types are ignored', async () => {
    const c = await client();
    const stdin = (c as unknown as { process: { stdin: NodeJS.WritableStream } }).process.stdin;
    stdin.write('{not json\n\n[]\nnull\n{"type":"no-such-type"}\n{"type":"add-frame"}\n');
    c.saveMaterial(mat('ok'));
    assert.deepEqual(((await c.getAllMaterials()) as Array<{ materialId: string }>).map((m) => m.materialId), ['ok']);
});

test('on-disk DB with spaces in the path persists across service restarts; second config ignored', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem svc '));
    try {
        const dbPath = path.join(dir, 'my data', 'memory.db');
        const a = await client({ dbPath });
        a.saveMaterial(mat('persisted'));
        a.addFrame(frm('persisted', 1, 'big'.repeat(100_000)), 'h');
        await a.getAllMaterials(); // barrier
        await a.stop();
        const b = await client({ dbPath });
        const frames = await b.getMaterialFrames('persisted');
        assert.equal(Buffer.from(frames[0].dataBase64, 'base64').length, 300_000);
        assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('client: requests fail fast when the service is not running or dies', async () => {
    const idle = new MemoryClient({ nodePath: process.execPath, servicePath: ENTRY });
    const t0 = Date.now();
    await assert.rejects(idle.getAllMaterials(), /not running/);
    assert.ok(Date.now() - t0 < 1000);
    idle.saveMaterial(mat('x')); // fire-and-forget on a stopped client is a no-op

    const c = await client({ ocrEnabled: true }, { OCR_FAKE_DELAY: '2000' });
    c.saveMaterial(mat('m'));
    c.addFrame(frm('m', 1, 'line'), 'h');
    const pending = c.processMaterialOcr('m');
    await sleep(200);
    (c as unknown as { process: { kill: (s: string) => void } }).process.kill('SIGKILL');
    const t1 = Date.now();
    await assert.rejects(pending, /exited/);
    assert.ok(Date.now() - t1 < 1500, 'pending request waited for its timeout');
    const t2 = Date.now();
    await c.stop();
    assert.ok(Date.now() - t2 < 500, 'stop() on an already-exited child returns at once');
    await assert.rejects(c.getAllMaterials(), /not running/);
});

test('client: service that fails to start rejects start()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem bad '));
    try {
        fs.writeFileSync(path.join(dir, 'file'), '');
        // parent "directory" is a regular file → the store cannot be created
        const c = new MemoryClient({
            nodePath: process.execPath, servicePath: ENTRY,
            dbPath: path.join(dir, 'file', 'db.sqlite'),
        });
        clients.push(c);
        await assert.rejects(c.start());
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
