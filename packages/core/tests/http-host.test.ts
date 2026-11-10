import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import childProcess from 'child_process';
import path from 'path';

import { HttpHost } from '../src/runtime/http-host';

class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    pid: number | undefined = 4242;
    exitCode: number | null = null;
    killed = false;
    signals: string[] = [];
    kill(signal = 'SIGTERM'): boolean {
        this.signals.push(signal);
        this.killed = true;
        return true;
    }
    exit(code: number | null): void {
        this.exitCode = code;
        this.emit('exit', code, null);
    }
}

interface SpawnCall { cmd: string; args: string[]; opts: any; child: FakeChild }
let spawns: SpawnCall[];
let saved: { warn: typeof console.warn; log: typeof console.log; write: typeof process.stderr.write };

beforeEach(() => {
    spawns = [];
    mock.method(childProcess, 'spawn', (cmd: string, args: string[], opts: unknown) => {
        const child = new FakeChild();
        spawns.push({ cmd, args, opts, child });
        return child;
    });
    saved = { warn: console.warn, log: console.log, write: process.stderr.write };
    console.warn = () => {};
    console.log = () => {};
    process.stderr.write = (() => true) as typeof process.stderr.write;
});
afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
    console.warn = saved.warn;
    console.log = saved.log;
    process.stderr.write = saved.write;
});

const tick = () => new Promise((r) => setImmediate(r));

describe('HttpHost', () => {
    test('spawns material-chat with the right env and resolves once it reports listening', async () => {
        const host = new HttpHost({ port: 9911, dbPath: '/tmp/test.db', nodePath: '/fake/bin/node', materialChat: { dataDir: '/tmp/mc-data' } });
        const p = host.start();
        await tick();
        assert.equal(spawns.length, 1);
        const { cmd, args, opts, child } = spawns[0];
        assert.equal(cmd, '/fake/bin/node');
        assert.ok(args[args.length - 1].endsWith(path.join('material-chat', 'dist', 'server.js')) || args.includes('tsx'));
        assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
        assert.equal(opts.env.AUSM_DB, '/tmp/test.db');
        assert.equal(opts.env.AUSM_PORT, '9911');
        assert.equal(opts.env.AUSM_URL, 'http://127.0.0.1:9911');
        assert.equal(opts.env.MATERIAL_CHAT_DATA_DIR, '/tmp/mc-data');
        assert.equal(opts.env.PATH.split(path.delimiter)[0], '/fake/bin');
        assert.ok(String(opts.env.NODE_PATH).includes('node_modules'));
        assert.equal(host.getUrl(), null, 'no URL before listening');

        child.stderr.emit('data', Buffer.from('[material-chat] booting\n'));
        child.stderr.emit('data', Buffer.from('[material-chat] listening on http://localhost:9911\n'));
        assert.equal(await p, 'http://127.0.0.1:9911');
        assert.equal(host.getUrl(), 'http://127.0.0.1:9911');
    });

    test('defaults: port 8788, in-memory db, no data dir override', async () => {
        const host = new HttpHost({ nodePath: '/fake/node' });
        const p = host.start();
        await tick();
        const { opts, child } = spawns[0];
        assert.equal(opts.env.AUSM_PORT, '8788');
        assert.equal(opts.env.AUSM_DB, ':memory:');
        assert.equal(opts.env.MATERIAL_CHAT_DATA_DIR, process.env.MATERIAL_CHAT_DATA_DIR);
        child.stdout.emit('data', 'listening on 8788');
        assert.equal(await p, 'http://127.0.0.1:8788');
    });

    test('start() after a successful start returns the same URL without spawning again', async () => {
        const host = new HttpHost({ nodePath: '/n' });
        const p = host.start();
        await tick();
        spawns[0].child.stderr.emit('data', 'listening on');
        await p;
        assert.equal(await host.start(), 'http://127.0.0.1:8788');
        assert.equal(spawns.length, 1);
    });

    test('port in use: child exits before listening → start rejects and URL stays null', async () => {
        const host = new HttpHost({ nodePath: '/n', port: 8788 });
        const p = host.start();
        await tick();
        spawns[0].child.stderr.emit('data', 'Error: listen EADDRINUSE: address already in use :::8788');
        spawns[0].child.exit(1);
        await assert.rejects(p, /exited before listen \(code 1\)/);
        assert.equal(host.getUrl(), null);
        assert.equal((host as any).process, null);
    });

    test('spawn failure (ENOENT) rejects immediately instead of waiting for the 15s timeout', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const host = new HttpHost({ nodePath: '/does/not/exist' });
        const p = host.start();
        await tick();
        const child = spawns[0].child;
        child.pid = undefined;
        const err = Object.assign(new Error('spawn /does/not/exist ENOENT'), { code: 'ENOENT' });
        child.emit('error', err);
        await assert.rejects(p, /failed to spawn: spawn \/does\/not\/exist ENOENT/);
        assert.equal((host as any).process, null);
        assert.deepEqual(child.signals, [], 'nothing to kill');
    });

    test('listen timeout rejects after 15s and kills the orphaned child', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const host = new HttpHost({ nodePath: '/n', port: 9999 });
        const p = host.start();
        await tick();
        mock.timers.tick(15_000);
        await assert.rejects(p, /did not start on port 9999 within 15s/);
        assert.deepEqual(spawns[0].child.signals, ['SIGTERM']);
        assert.equal((host as any).process, null);
    });

    test('stop() sends SIGTERM and resolves on exit; repeated stop is a no-op', async () => {
        const host = new HttpHost({ nodePath: '/n' });
        const p = host.start();
        await tick();
        const child = spawns[0].child;
        child.stderr.emit('data', 'listening on');
        await p;
        const stopped = host.stop();
        assert.deepEqual(child.signals, ['SIGTERM']);
        child.exit(0);
        await stopped;
        assert.equal(host.getUrl(), null);
        await host.stop();
        assert.deepEqual(child.signals, ['SIGTERM']);
    });

    test('stop() escalates to SIGKILL after 3s when the child ignores SIGTERM', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const host = new HttpHost({ nodePath: '/n' });
        const p = host.start();
        await tick();
        const child = spawns[0].child;
        child.stderr.emit('data', 'listening on');
        await p;
        child.kill = function (signal = 'SIGTERM') { this.signals.push(signal); return true; };
        const stopped = host.stop();
        mock.timers.tick(3000);
        await stopped;
        assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    });

    test('stop() before start resolves', async () => {
        await new HttpHost().stop();
    });

    test('an unexpected exit after listening clears the URL', async () => {
        const host = new HttpHost({ nodePath: '/n' });
        const p = host.start();
        await tick();
        spawns[0].child.stderr.emit('data', 'listening on');
        await p;
        spawns[0].child.exit(137);
        assert.equal(host.getUrl(), null);
    });

    test('a previous child exiting late does not clobber a restarted one', async () => {
        const host = new HttpHost({ nodePath: '/n' });
        const p1 = host.start();
        await tick();
        const first = spawns[0].child;
        first.stderr.emit('data', 'listening on');
        await p1;
        const stopping = host.stop(); // SIGTERM sent, exit not yet delivered
        const p2 = host.start();
        await tick();
        const second = spawns[1].child;
        second.stderr.emit('data', 'listening on');
        await p2;
        first.exit(0);
        await stopping;
        assert.equal(host.getUrl(), 'http://127.0.0.1:8788');
        assert.equal((host as any).process, second);
    });
});
