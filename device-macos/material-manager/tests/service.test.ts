/**
 * material-manager service stdio protocol, end to end: the real service.ts
 * (via tsx) with the fake frame worker as its Python.  No screen access —
 * the fake worker returns synthetic crops.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';

const SERVICE = path.join(__dirname, '..', 'service.ts');
const FAKE = path.join(__dirname, 'fixtures', 'fake-frame-worker.js');
const procs: ChildProcess[] = [];

afterEach(() => {
    for (const p of procs.splice(0)) if (p.exitCode === null) p.kill('SIGKILL');
});

function startService() {
    const child = spawn(process.execPath, ['--import', 'tsx', SERVICE], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FAKE_WORKER_MODE: 'normal' },
    });
    procs.push(child);
    const msgs: Record<string, unknown>[] = [];
    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            msgs.push(JSON.parse(line)); // stdout must carry protocol lines only
        }
    });
    const send = (m: unknown) => child.stdin!.write((typeof m === 'string' ? m : JSON.stringify(m)) + '\n');
    const waitFor = async (pred: (m: Record<string, unknown>) => boolean, ms = 10_000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const hit = msgs.find(pred);
            if (hit) return hit;
            await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`timed out; got ${msgs.map((m) => m.type).join(',')}`);
    };
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    return { child, msgs, send, waitFor, exited };
}

const win = (state: string, over: Record<string, unknown> = {}) => ({
    type: 'window-event', windowId: 11, state, title: 'Synthetic Doc', application: 'Editor',
    bundleId: 'com.example.editor', pid: 1, displayId: 1, bounds: { x: 0, y: 0, width: 64, height: 48 }, ...over,
});

test('config → ready; FOCUSED yields save, focus and a frame with its hash', async () => {
    const s = startService();
    s.send(win('FOCUSED')); // before config: dropped
    s.send({ type: 'config', pythonPath: FAKE, captureDelayMs: 1, maxFreshnessRetries: 0, captureIntervalMs: 60_000 });
    await s.waitFor((m) => m.type === 'ready');
    s.send('not json');
    s.send('42');
    s.send({ type: 'mystery' });
    s.send({ type: 'config', pythonPath: '/nope' }); // duplicate config ignored
    s.send(win('FOCUSED'));
    const save = await s.waitFor((m) => m.type === 'material-save');
    assert.equal(save.title, 'Synthetic Doc');
    const focused = await s.waitFor((m) => m.type === 'material-focused');
    assert.equal(focused.materialId, save.materialId);
    assert.deepEqual(focused.bounds, { x: 0, y: 0, width: 64, height: 48 });
    const frame = await s.waitFor((m) => m.type === 'material-frame');
    assert.equal(frame.hash, 'abc');
    assert.equal(frame.captureReason, 'FOCUSED');
    assert.equal(Buffer.from(frame.dataBase64 as string, 'base64').toString(), 'jpeg:display-1');
    s.send(win('TITLE_CHANGED', { title: 'Second' }));
    const created = await s.waitFor((m) => m.type === 'material-created');
    assert.equal(created.title, 'Second');
    s.send(win('UNFOCUSED', { title: 'Second', bounds: null }));
    await s.waitFor((m) => m.type === 'material-unfocused' && m.title === 'Second');
    assert.equal(s.msgs.filter((m) => m.type === 'ready').length, 1);
    s.child.stdin!.end();
    assert.equal(await s.exited, 0, 'stdin EOF shuts down cleanly');
});

test('startup failure (python missing) reports an error and exits 1', async () => {
    const s = startService();
    s.send({ type: 'config', pythonPath: path.join(os.tmpdir(), 'no-python-here') });
    const err = await s.waitFor((m) => m.type === 'error');
    assert.match(String(err.message), /startup failed/);
    assert.equal(await s.exited, 1);
});
