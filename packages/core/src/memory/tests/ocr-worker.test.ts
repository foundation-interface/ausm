/**
 * LineDeduper merge rules and the OcrWorker subprocess protocol (driven by
 * a fake worker script passed as pythonPath — no Vision, no screenshots).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { LineDeduper, OcrWorker } from '../ocr-worker';

const FAKE = path.join(__dirname, 'fixtures', 'fake-ocr-worker.js');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ENV = ['OCR_FAKE_MODE', 'OCR_FAKE_DELAY', 'OCR_FAKE_READY_DELAY', 'OCR_FAKE_PIDFILE'];
const workers: OcrWorker[] = [];

function worker(env: Record<string, string> = {}, opts: { requestTimeoutMs?: number } = {}): OcrWorker {
    for (const k of ENV) delete process.env[k];
    Object.assign(process.env, env);
    const w = new OcrWorker({ pythonPath: FAKE, ...opts });
    workers.push(w);
    return w;
}

afterEach(() => {
    for (const w of workers.splice(0)) w.stop();
    for (const k of ENV) delete process.env[k];
});

const img = (text: string) => Buffer.from(text, 'utf8');

// ── LineDeduper ──────────────────────────────────────────────────────────

test('LineDeduper: exact, case, whitespace and edge-punctuation duplicates collapse; order kept', () => {
    const d = new LineDeduper();
    d.addLines(['Hello World', 'hello   world', '  HELLO WORLD!  ', '"Hello World."', 'Second line']);
    assert.equal(d.text(), 'Hello World\nSecond line');
    assert.equal(d.lineCount, 2);
});

test('LineDeduper: empty, whitespace-only, single-char and punctuation-only lines are dropped', () => {
    const d = new LineDeduper();
    d.addLines(['', '   ', 'a', '.', '—', '...', '()', 'ok']);
    assert.equal(d.text(), 'ok');
    const empty = new LineDeduper();
    empty.addLines([]);
    assert.equal(empty.text(), '');
    assert.equal(empty.lineCount, 0);
});

test('LineDeduper: substring containment only applies to long (>20 char) lines', () => {
    const d = new LineDeduper();
    const long = 'The quick brown fox jumps over the lazy dog';
    d.addLines([long]);
    d.addLines(['quick brown fox jumps over', 'lazy dog', 'fox']);
    // the long fragment is a partial re-read; short fragments are kept
    assert.deepEqual(d.text().split('\n'), [long, 'lazy dog', 'fox']);
    // a longer line seen later does not retroactively remove shorter ones
    const d2 = new LineDeduper();
    d2.addLines(['quick brown fox jumps over', long]);
    assert.equal(d2.lineCount, 2);
});

test('LineDeduper: unicode text, internal punctuation and many duplicate frames', () => {
    const d = new LineDeduper();
    for (let i = 0; i < 100; i++) d.addLines(['日本語のテキスト', 'Ünïcödé', 'a-b', 'a b', 'e-mail: x@y.z']);
    assert.deepEqual(d.text().split('\n'), ['日本語のテキスト', 'Ünïcödé', 'a-b', 'a b', 'e-mail: x@y.z']);
});

test('LineDeduper: rebuilding from stored text is idempotent', () => {
    const a = new LineDeduper();
    a.addLines(['one line', 'two line', 'One Line.']);
    const b = new LineDeduper();
    b.addLines(a.text().split('\n'));
    b.addLines(['two line', 'three line']);
    assert.equal(b.text(), 'one line\ntwo line\nthree line');
});

test('LineDeduper: non-string entries are skipped instead of throwing', () => {
    const d = new LineDeduper();
    d.addLines(['valid', null, 42, undefined, { a: 1 }, 'also valid'] as unknown as string[]);
    assert.equal(d.text(), 'valid\nalso valid');
});

// ── OcrWorker protocol ───────────────────────────────────────────────────

test('OcrWorker: ready handshake, recognize round-trip, error responses, not-ready rejection', async () => {
    const w = worker();
    await assert.rejects(w.recognize(img('x')), /not ready/);
    await w.start();
    assert.equal(w.isReady(), true);
    assert.deepEqual(await w.recognize(img('line one\nline two')), ['line one', 'line two']);
    assert.deepEqual(await w.recognize(img('')), []);
    await assert.rejects(w.recognize(img('FAIL')), /bad frame/);
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => w.recognize(img(`n${i}`))));
    many.forEach((m, i) => assert.deepEqual(m, [`n${i}`]));
});

test('OcrWorker: non-array / mixed `lines` are sanitized to string arrays', async () => {
    const w = worker({ OCR_FAKE_MODE: 'non-array' });
    await w.start();
    assert.deepEqual(await w.recognize(img('x')), []);
    w.stop();
    const m = worker({ OCR_FAKE_MODE: 'mixed' });
    await m.start();
    assert.deepEqual(await m.recognize(img('x')), ['ok line', 'another line']);
});

test('OcrWorker: crash mid-request rejects; exit before ready rejects start', async () => {
    const w = worker({ OCR_FAKE_MODE: 'crash' });
    await w.start();
    await assert.rejects(w.recognize(img('x')), /exited/);
    assert.equal(w.isReady(), false);
    await assert.rejects(worker({ OCR_FAKE_MODE: 'exit-before-ready' }).start(), /exited before ready/);
    const missing = new OcrWorker({ pythonPath: path.join(os.tmpdir(), 'no-such-python-binary') });
    await assert.rejects(missing.start(), /failed to start/);
});

test('OcrWorker: request timeout rejects', async () => {
    const w = worker({ OCR_FAKE_MODE: 'silent' }, { requestTimeoutMs: 50 });
    await w.start();
    await assert.rejects(w.recognize(img('x')), /timed out/);
});

test('OcrWorker: answered requests do not leave their timeout timer running', async () => {
    const w = worker({}, { requestTimeoutMs: 60_000 });
    await w.start();
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timers();
    for (let i = 0; i < 5; i++) await w.recognize(img('x'));
    assert.equal(timers(), before, 'a 60s timer per request keeps the process alive');
});

test('OcrWorker: stop() before ready kills the child', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
    try {
        const pidfile = path.join(dir, 'pid');
        const w = worker({ OCR_FAKE_READY_DELAY: '300', OCR_FAKE_PIDFILE: pidfile });
        const started = w.start().catch((e: Error) => e);
        await sleep(100);
        w.stop();
        const res = await started;
        assert.ok(res instanceof Error, 'start() should reject when stopped before ready');
        await sleep(100);
        const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
        assert.throws(() => process.kill(pid, 0), /ESRCH/, 'orphaned OCR worker still running');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('OcrWorker: concurrent start() spawns one worker', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
    try {
        const pidfile = path.join(dir, 'pid');
        const w = worker({ OCR_FAKE_READY_DELAY: '100', OCR_FAKE_PIDFILE: pidfile });
        await Promise.all([w.start(), w.start()]);
        await sleep(50);
        assert.equal(fs.readFileSync(pidfile, 'utf8').trim().split('\n').length, 1);
        assert.deepEqual(await w.recognize(img('a')), ['a']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
