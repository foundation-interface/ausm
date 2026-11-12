/**
 * FrameReader subprocess protocol, driven by a fake worker script
 * (tests/fixtures/fake-frame-worker.js) passed as `pythonPath`.  No Python,
 * no screen access.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { FrameReader, resolveFrameReaderScript } from '../frame-reader';

const FAKE = path.join(__dirname, 'fixtures', 'fake-frame-worker.js');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ENV_KEYS = [
    'FAKE_WORKER_MODE', 'FAKE_WORKER_READY_DELAY', 'FAKE_WORKER_REPLY_DELAY',
    'FAKE_WORKER_LINGER', 'FAKE_WORKER_PIDFILE',
];
const readers: FrameReader[] = [];

function reader(env: Record<string, string> = {}): FrameReader {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    const r = new FrameReader({ pythonPath: FAKE });
    readers.push(r);
    return r;
}

afterEach(() => {
    for (const r of readers.splice(0)) r.stop();
    for (const k of ENV_KEYS) delete process.env[k];
});

const BOUNDS = { x: 0, y: 0, width: 320, height: 200 };

test('resolveFrameReaderScript finds py/frame_reader.py from source and dist layouts', () => {
    const root = path.resolve(__dirname, '..');
    const expected = path.join(root, 'py', 'frame_reader.py');
    assert.equal(resolveFrameReaderScript(root), expected);
    assert.equal(resolveFrameReaderScript(path.join(root, 'dist')), expected);
    // nothing found → first candidate (error surfaces when Python runs it)
    const nowhere = path.join(os.tmpdir(), 'no-such-dir', 'dist');
    assert.equal(resolveFrameReaderScript(nowhere), path.resolve(nowhere, '..', 'py', 'frame_reader.py'));
});

test('ready handshake (non-JSON noise before it is ignored) and crop/process_image round-trips', async () => {
    const r = reader();
    assert.equal(r.isReady(), false);
    await assert.rejects(r.requestFrame('display-1', BOUNDS, 2, null), /not ready/);
    await r.start();
    assert.equal(r.isReady(), true);
    await r.start(); // idempotent while running

    const c = await r.requestFrame('display-2', BOUNDS, 2, null);
    assert.equal(c.data.toString(), 'jpeg:display-2');
    assert.deepEqual([c.width, c.height, c.hash, c.hammingDistance, c.frameTimestamp], [320, 200, 'abc', -1, 1234]);
    assert.equal((await r.requestFrame('display-1', BOUNDS, 2, 'abc')).hammingDistance, 3);

    const a = await r.processImage(Buffer.from([0xff, 0xd8]), null);
    assert.deepEqual(a, { width: 9, height: 8, hash: 'def', hammingDistance: -1 });

    // many concurrent requests are matched by requestId
    const many = await Promise.all(
        Array.from({ length: 50 }, (_, i) => r.requestFrame(`display-${i}`, BOUNDS, 1, null)),
    );
    many.forEach((m, i) => assert.equal(m.data.toString(), `jpeg:display-${i}`));
});

test('worker error responses reject the request; missing message gets a default', async () => {
    const r = reader({ FAKE_WORKER_MODE: 'error' });
    await r.start();
    await assert.rejects(r.requestFrame('display-1', BOUNDS, 2, null), /No frame available/);
    r.stop();
    const r2 = reader({ FAKE_WORKER_MODE: 'error-no-message' });
    await r2.start();
    await assert.rejects(r2.processImage(Buffer.from('x'), null), /Unknown error from frame reader/);
});

test('garbage and malformed responses are rejected without crashing the host', async () => {
    const r = reader({ FAKE_WORKER_MODE: 'garbage' });
    await r.start();
    await assert.rejects(r.requestFrame('display-1', BOUNDS, 2, null), /malformed/i);
    assert.equal(r.isReady(), true, 'reader stays usable');
});

test('responses with wrongly-typed fields are rejected, not passed through', async () => {
    const r = reader({ FAKE_WORKER_MODE: 'bad-fields' });
    await r.start();
    await assert.rejects(r.processImage(Buffer.from('x'), null), /malformed/i);
});

test('subprocess crash mid-request rejects pending requests and auto-restarts', async () => {
    const r = reader({ FAKE_WORKER_MODE: 'crash-on-request' });
    await r.start();
    await assert.rejects(r.requestFrame('display-1', BOUNDS, 2, null), /exited/);
    assert.equal(r.isReady(), false);
    await assert.rejects(r.processImage(Buffer.from('x'), null), /not ready/);
    await sleep(1500); // RESTART_BASE_MS = 1000
    assert.equal(r.isReady(), true, 'restarted after back-off');
});

test('worker exiting before ready rejects start(); a spawn failure rejects start()', async () => {
    await assert.rejects(reader({ FAKE_WORKER_MODE: 'exit-before-ready' }).start(), /exited before ready \(code=3/);
    const bad = new FrameReader({ pythonPath: path.join(os.tmpdir(), 'definitely-missing-python') });
    readers.push(bad);
    await assert.rejects(bad.start(), /failed to start/);
    assert.equal(bad.isReady(), false);
});

test('request timeout rejects and frees the slot', async (t) => {
    const r = reader({ FAKE_WORKER_MODE: 'silent' });
    await r.start();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = r.requestFrame('display-1', BOUNDS, 2, null);
    t.mock.timers.tick(10_000);
    await assert.rejects(p, /timed out/);
    assert.equal((r as unknown as { pending: Map<string, unknown> }).pending.size, 0);
});

test('stop() rejects in-flight requests; stop() twice is safe; restart works', async () => {
    const r = reader({ FAKE_WORKER_REPLY_DELAY: '300' });
    await r.start();
    const p = r.requestFrame('display-1', BOUNDS, 2, null);
    r.stop();
    r.stop();
    await assert.rejects(p, /stopped/);
    assert.equal(r.isReady(), false);
    await r.start();
    assert.equal(r.isReady(), true);
});

test('concurrent start() calls all wait for the ready handshake', async () => {
    const r = reader({ FAKE_WORKER_READY_DELAY: '200' });
    const p1 = r.start();
    const p2 = r.start();
    await p2;
    assert.equal(r.isReady(), true, 'second start() resolved before the worker was ready');
    await p1;
});

test('a previous worker exiting late does not reject requests of the new worker', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-'));
    try {
        const r = reader({
            FAKE_WORKER_MODE: 'stubborn', // ignores SIGTERM
            FAKE_WORKER_LINGER: '300', // exits 300ms after stdin closes
            FAKE_WORKER_REPLY_DELAY: '600',
            FAKE_WORKER_PIDFILE: path.join(dir, 'pids'),
        });
        await r.start();
        r.stop();
        await r.start();
        const res = await r.requestFrame('display-1', BOUNDS, 2, null);
        assert.equal(res.hash, 'abc');
        const pids = fs.readFileSync(path.join(dir, 'pids'), 'utf8').trim().split('\n');
        assert.equal(pids.length, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a worker that never becomes ready is killed after the start timeout', async (t) => {
    const r = reader({ FAKE_WORKER_MODE: 'never-ready' });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = r.start();
    t.mock.timers.tick(15_000);
    await assert.rejects(p, /did not become ready/);
});
