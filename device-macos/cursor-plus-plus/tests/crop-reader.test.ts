import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { CropReader } from '../index';
import { makeTempDir, writeFakeHelper, waitFor, isAlive, quietConsole } from '../../test-support/fakes';

const dir = makeTempDir();
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * Fake "python": prints ready (unless told not to), then answers each crop request
 * according to `behaviour`, a JS function body receiving (req, reply).
 */
function fakePython(name: string, behaviour: string, opts: { ready?: boolean; preReady?: string } = {}): string {
    return writeFakeHelper(dir, name, `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(path.join(dir, name + '.argv'))}, JSON.stringify({ argv: process.argv.slice(2), pp: process.env.PYTHONPATH || null }));
const reply = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\\n');
${opts.preReady ?? ''}
${opts.ready === false ? '' : "reply({ type: 'ready' });"}
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => { const req = JSON.parse(line); (function (req, reply) { ${behaviour} })(req, reply); });
rl.on('close', () => process.exit(0));
`);
}

const okEcho = `reply({ requestId: req.requestId, ok: true, data: Buffer.from(JSON.stringify(req)).toString('base64'), width: req.cropWidth * req.scaleFactor, height: req.cropHeight * req.scaleFactor });`;

test('start resolves on ready; crops round-trip all parameters', async () => {
    const pythonPath = fakePython('py-ok', okEcho);
    const reader = new CropReader({ pythonPath, screenStreamSocketPath: '/tmp/test-sock', screenStreamReaderPath: '/lib/reader' });
    assert.equal(reader.isReady(), false);
    await reader.start();
    assert.equal(reader.isReady(), true);
    const res = await reader.cropAtCursor(-1440.5, -900, 200, 40, 2, 75);
    assert.equal(res.width, 400);
    assert.equal(res.height, 80);
    const echoed = JSON.parse(res.data.toString());
    assert.deepEqual(echoed, {
        cmd: 'crop', requestId: echoed.requestId, cursorX: -1440.5, cursorY: -900,
        cropWidth: 200, cropHeight: 40, scaleFactor: 2, jpegQuality: 75,
    });
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'py-ok.argv'), 'utf8'));
    assert.match(info.argv[0], /crop_reader\.py$/);
    assert.equal(info.argv[1], '--socket=/tmp/test-sock');
    assert.ok(info.pp.startsWith('/lib/reader'));
    reader.stop();
    assert.equal(reader.isReady(), false);
});

test('start() twice returns the same promise and spawns once', async () => {
    const pythonPath = fakePython('py-once', okEcho);
    const reader = new CropReader({ pythonPath });
    const a = reader.start();
    const b = reader.start();
    assert.equal(a, b);
    await a;
    reader.stop();
});

test('concurrent requests are matched by requestId even when answered out of order', async () => {
    const pythonPath = fakePython('py-ooo', `
        globalThis.q = globalThis.q || [];
        globalThis.q.push(req);
        if (globalThis.q.length === 3) for (const r of globalThis.q.reverse()) reply({ requestId: r.requestId, ok: true, data: '', width: r.cursorX, height: 1 });
    `);
    const reader = new CropReader({ pythonPath });
    await reader.start();
    const results = await Promise.all([1, 2, 3].map((x) => reader.cropAtCursor(x, 0, 1, 1, 1, 50)));
    assert.deepEqual(results.map((r) => r.width), [1, 2, 3]);
    reader.stop();
});

test('ok:false rejects with the helper message; missing fields default sensibly', async () => {
    const pythonPath = fakePython('py-err', `
        if (req.cursorX === 1) reply({ requestId: req.requestId, ok: false, error: 'no frame for display' });
        else if (req.cursorX === 2) reply({ requestId: req.requestId, ok: false });
        else reply({ requestId: req.requestId, ok: true });
    `);
    const reader = new CropReader({ pythonPath });
    await reader.start();
    await assert.rejects(reader.cropAtCursor(1, 0, 1, 1, 1, 1), /no frame for display/);
    await assert.rejects(reader.cropAtCursor(2, 0, 1, 1, 1, 1), /Unknown error from crop reader/);
    const empty = await reader.cropAtCursor(3, 0, 1, 1, 1, 1);
    assert.equal(empty.width, 0);
    assert.equal(empty.height, 0);
    assert.equal(empty.data.length, 0);
    reader.stop();
});

test('garbage, unknown ids and duplicate responses are ignored', async () => {
    const pythonPath = fakePython('py-noise', `
        reply('not json');
        reply('[1,2]');
        reply({ requestId: 'req_999', ok: true, width: 5, height: 5 });
        reply({ type: 'ready' });
        reply({ requestId: req.requestId, ok: true, width: 7, height: 7 });
        reply({ requestId: req.requestId, ok: true, width: 8, height: 8 });
    `);
    const reader = new CropReader({ pythonPath });
    await reader.start();
    const r = await reader.cropAtCursor(0, 0, 1, 1, 1, 1);
    assert.equal(r.width, 7);
    const r2 = await reader.cropAtCursor(0, 0, 1, 1, 1, 1);
    assert.equal(r2.width, 7, 'stale duplicate for the earlier id does not satisfy a new request');
    reader.stop();
});

test('cropAtCursor before start rejects immediately', async () => {
    const reader = new CropReader({ pythonPath: path.join(dir, 'unused') });
    await assert.rejects(reader.cropAtCursor(0, 0, 1, 1, 1, 1), /not ready/);
});

test('missing interpreter: start rejects; reader can be started again', async () => {
    const reader = new CropReader({ pythonPath: path.join(dir, 'no-such-python') });
    await assert.rejects(reader.start(), /Crop reader failed: .*ENOENT/);
    assert.equal(reader.isReady(), false);
    await assert.rejects(reader.start(), /ENOENT/, 'a second start spawns again instead of returning the failed promise');
});

test('subprocess exiting before ready rejects start with its exit code', async () => {
    const pythonPath = writeFakeHelper(dir, 'py-die', 'process.exit(3);');
    const reader = new CropReader({ pythonPath });
    await assert.rejects(reader.start(), /exited before ready \(code=3\)/);
});

test('subprocess crash rejects all pending requests', async () => {
    const pythonPath = fakePython('py-crash', `if (req.cursorX === 2) process.exit(1);`);
    const reader = new CropReader({ pythonPath });
    await reader.start();
    const p1 = reader.cropAtCursor(1, 0, 1, 1, 1, 1);
    const p2 = reader.cropAtCursor(2, 0, 1, 1, 1, 1);
    await assert.rejects(p1, /subprocess exited/);
    await assert.rejects(p2, /subprocess exited/);
    assert.equal(reader.isReady(), false);
    await assert.rejects(reader.cropAtCursor(0, 0, 1, 1, 1, 1), /not ready/);
});

test('stop() rejects in-flight requests and terminates the subprocess', async () => {
    const pythonPath = fakePython('py-hang', `/* never answers */`);
    const reader = new CropReader({ pythonPath });
    await reader.start();
    const child = (reader as any).child;
    const pending = reader.cropAtCursor(0, 0, 1, 1, 1, 1);
    reader.stop();
    await assert.rejects(pending, /Crop reader stopped/);
    await waitFor(() => !isAlive(child.pid), 3000, 'subprocess exit');
    reader.stop(); // idempotent
});

test('stop() before ready rejects the start promise', async () => {
    const pythonPath = fakePython('py-slow', okEcho, { ready: false });
    const reader = new CropReader({ pythonPath });
    const started = reader.start();
    reader.stop();
    await assert.rejects(started, /stopped before ready/);
});

test('restart after stop works and the old subprocess cannot interfere', async () => {
    const pythonPath = fakePython('py-restart', okEcho);
    const reader = new CropReader({ pythonPath });
    await reader.start();
    reader.stop();
    await reader.start();
    const r = await reader.cropAtCursor(0, 0, 3, 3, 1, 1);
    assert.equal(r.width, 3);
    reader.stop();
});

test('ready marker split by noise lines and stderr output is tolerated', async () => {
    const pythonPath = fakePython('py-noisy-start', okEcho, {
        preReady: "process.stderr.write('warming up\\n'); reply('{\"type\":\"progress\"}'); reply('');",
    });
    const reader = new CropReader({ pythonPath });
    await reader.start();
    assert.equal(reader.isReady(), true);
    reader.stop();
});

test('debug mode logs lifecycle only', async () => {
    const pythonPath = fakePython('py-debug', okEcho);
    await quietConsole(async () => {
        const reader = new CropReader({ pythonPath, debug: true });
        await reader.start();
        await reader.cropAtCursor(0, 0, 1, 1, 1, 1);
        reader.stop();
    });
});
