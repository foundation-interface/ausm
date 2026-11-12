/**
 * Behavioural suite for the HelperProcess supervisor. Identical copies of
 * helper-process.ts live in several packages; each package runs this suite against
 * its own copy so the copies cannot drift apart silently.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { fakeSpawner, tick, FakeChild } from './fakes';

type Msg = { type: string; [key: string]: unknown };

interface HelperProcessLike {
    readonly running: boolean;
    start(): boolean;
    stop(): void;
}

type Ctor = new (opts: any) => HelperProcessLike;

function harness(HelperProcess: Ctor, extra: Record<string, unknown> = {}) {
    const sp = fakeSpawner();
    const messages: Msg[] = [];
    const errors: string[] = [];
    const statuses: string[] = [];
    const logs: string[] = [];
    const stderr: string[] = [];
    const hp = new HelperProcess({
        binary: '/fake/helper',
        args: ['--flag'],
        name: 'FakeHelper',
        onMessage: (m: Msg) => messages.push(m),
        onError: (e: Error) => errors.push(e.message),
        onStatus: (s: string) => statuses.push(s),
        log: (m: string) => logs.push(m),
        onStderr: (t: string) => stderr.push(t),
        spawn: sp.spawn,
        ...extra,
    });
    return { hp, sp, messages, errors, statuses, logs, stderr };
}

/** Let readline deliver everything written so far. */
async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await tick();
}

export function runHelperProcessSuite(label: string, HelperProcess: Ctor): void {
    const t = (name: string, fn: () => Promise<void> | void) => test(`${label} HelperProcess: ${name}`, fn);

    t('start spawns the binary with args once and reports started', () => {
        const h = harness(HelperProcess);
        assert.equal(h.hp.running, false);
        assert.equal(h.hp.start(), true);
        assert.equal(h.hp.running, true);
        assert.equal(h.sp.children.length, 1);
        assert.equal(h.sp.last.command, '/fake/helper');
        assert.deepEqual(h.sp.last.args, ['--flag']);
        assert.deepEqual(h.statuses, ['started']);
    });

    t('double start is a no-op', () => {
        const h = harness(HelperProcess);
        h.hp.start();
        assert.equal(h.hp.start(), true);
        assert.equal(h.sp.children.length, 1);
        assert.deepEqual(h.statuses, ['started']);
    });

    t('stop before start and double stop are no-ops', () => {
        const h = harness(HelperProcess);
        h.hp.stop();
        assert.deepEqual(h.statuses, []);
        h.hp.start();
        h.hp.stop();
        h.hp.stop();
        assert.deepEqual(h.statuses, ['started', 'stopped']);
        assert.deepEqual(h.sp.last.signals, ['SIGTERM']);
    });

    t('parses JSON lines with a string type; passes unknown fields through', async () => {
        const h = harness(HelperProcess);
        h.hp.start();
        h.sp.last.line({ type: 'ready' });
        h.sp.last.line({ type: 'evt', extra: { nested: [1, 2] }, unknownField: true });
        await flush();
        assert.deepEqual(h.messages, [
            { type: 'ready' },
            { type: 'evt', extra: { nested: [1, 2] }, unknownField: true },
        ]);
    });

    t('skips malformed, blank, typeless and non-object lines without crashing', async () => {
        const h = harness(HelperProcess);
        h.hp.start();
        const c = h.sp.last;
        c.stdout.write('{"type":"a"\n'); // truncated JSON
        c.stdout.write('\n   \n');
        c.stdout.write('not json at all\n');
        c.line({ notype: 1 });
        c.line({ type: 42 });
        c.line([{ type: 'array' }]);
        c.line('null');
        c.line('"string"');
        c.line(7);
        c.line({ type: 'ok' });
        await flush();
        assert.deepEqual(h.messages, [{ type: 'ok' }]);
        assert.equal(h.errors.length, 0);
        // Diagnostics never echo line contents, only lengths.
        assert.ok(h.logs.some((l) => /unparseable line \(\d+ chars\)/.test(l)));
        assert.ok(h.logs.every((l) => !l.includes('not json at all')));
    });

    t('reassembles lines split across chunks, including split multi-byte UTF-8', async () => {
        const h = harness(HelperProcess);
        h.hp.start();
        const payload = Buffer.from(JSON.stringify({ type: 'evt', text: '日本 👍🏽 שלום' }) + '\n', 'utf8');
        // Split inside the 4-byte emoji sequence and one byte at a time at the end.
        const emojiAt = payload.indexOf(Buffer.from('👍', 'utf8'));
        h.sp.last.stdout.write(payload.subarray(0, emojiAt + 2));
        await flush();
        for (const byte of payload.subarray(emojiAt + 2)) h.sp.last.stdout.write(Buffer.from([byte]));
        await flush();
        assert.deepEqual(h.messages, [{ type: 'evt', text: '日本 👍🏽 שלום' }]);
    });

    t('handles CRLF line endings and many lines in one chunk', async () => {
        const h = harness(HelperProcess);
        h.hp.start();
        const chunk = Array.from({ length: 500 }, (_, i) => JSON.stringify({ type: 'n', i })).join('\r\n') + '\r\n';
        h.sp.last.stdout.write(chunk);
        await flush();
        assert.equal(h.messages.length, 500);
        assert.deepEqual(h.messages.map((m) => m.i), Array.from({ length: 500 }, (_, i) => i));
    });

    t('a final line written just before exit is still delivered', async () => {
        const h = harness(HelperProcess, { autoRestart: false });
        h.hp.start();
        h.sp.last.stdout.write(JSON.stringify({ type: 'error', code: 'accessibility_denied' }) + '\n');
        h.sp.last.exit(1);
        await flush();
        assert.deepEqual(h.messages, [{ type: 'error', code: 'accessibility_denied' }]);
    });

    t('a final line without trailing newline is delivered when stdout ends', async () => {
        const h = harness(HelperProcess, { autoRestart: false });
        h.hp.start();
        h.sp.last.stdout.write(JSON.stringify({ type: 'last' }));
        h.sp.last.exit(0);
        await flush();
        assert.deepEqual(h.messages, [{ type: 'last' }]);
    });

    t('lines arriving after stop() are dropped', async () => {
        const h = harness(HelperProcess);
        h.hp.start();
        const c = h.sp.last;
        h.hp.stop();
        c.line({ type: 'late' });
        await flush();
        assert.deepEqual(h.messages, []);
    });

    t('a throwing onMessage listener does not break the stream (reported as error)', async () => {
        const sp = fakeSpawner();
        const seen: string[] = [];
        const errors: string[] = [];
        const hp = new HelperProcess({
            binary: '/fake', name: 'FakeHelper', spawn: sp.spawn,
            onMessage: (m: Msg) => {
                seen.push(m.type);
                if (m.type === 'boom') throw new Error('listener exploded');
            },
            onError: (e: Error) => errors.push(e.message),
            onStatus: () => {},
        });
        hp.start();
        sp.last.line({ type: 'boom' });
        sp.last.line({ type: 'after' });
        await flush();
        assert.deepEqual(seen, ['boom', 'after']);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /listener exploded/);
        hp.stop();
    });

    t('stderr is forwarded only to onStderr', async () => {
        const h = harness(HelperProcess);
        h.hp.start();
        h.sp.last.stderr.write('diagnostic\n');
        await flush();
        assert.deepEqual(h.stderr, ['diagnostic\n']);
        assert.deepEqual(h.messages, []);
    });

    t('spawn error (ENOENT) stops without restart', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        try {
            const h = harness(HelperProcess);
            h.hp.start();
            h.sp.last.failSpawn('ENOENT');
            await flush();
            assert.equal(h.hp.running, false);
            assert.match(h.errors[0], /process error: .*ENOENT.*\/fake\/helper/);
            assert.deepEqual(h.statuses, ['started', 'stopped']);
            mock.timers.tick(60_000);
            await flush();
            assert.equal(h.sp.children.length, 1);
            // Can be started again afterwards.
            assert.equal(h.hp.start(), true);
            assert.equal(h.sp.children.length, 2);
        } finally {
            mock.timers.reset();
        }
    });

    t('synchronous spawn throw reports an error and returns false', () => {
        const errors: string[] = [];
        const hp = new HelperProcess({
            binary: '/fake', name: 'FakeHelper',
            spawn: () => { throw new Error('EMFILE'); },
            onMessage: () => {}, onError: (e: Error) => errors.push(e.message), onStatus: () => {},
        });
        assert.equal(hp.start(), false);
        assert.equal(hp.running, false);
        assert.match(errors[0], /Failed to start FakeHelper: EMFILE/);
    });

    t('crash restarts with exponential backoff, then gives up after maxRestarts', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        try {
            const h = harness(HelperProcess, { maxRestarts: 3, restartWindowMs: 60_000 });
            h.hp.start();
            const delays = [500, 1000, 2000];
            for (const delay of delays) {
                const before = h.sp.children.length;
                h.sp.last.exit(1);
                await flush();
                assert.match(h.errors[h.errors.length - 1], new RegExp(`restarting in ${delay} ms`));
                assert.equal(h.hp.running, true, 'still wanted while waiting to restart');
                mock.timers.tick(delay - 1);
                assert.equal(h.sp.children.length, before);
                mock.timers.tick(1);
                assert.equal(h.sp.children.length, before + 1);
            }
            h.sp.last.exit(1);
            await flush();
            assert.match(h.errors[h.errors.length - 1], /crashed 3 times within 60000 ms.*giving up/);
            assert.equal(h.hp.running, false);
            assert.equal(h.statuses[h.statuses.length - 1], 'stopped');
            mock.timers.tick(120_000);
            assert.equal(h.sp.children.length, 4);
        } finally {
            mock.timers.reset();
        }
    });

    t('crashes spread out beyond the restart window keep restarting', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        try {
            const h = harness(HelperProcess, { maxRestarts: 2, restartWindowMs: 10_000 });
            h.hp.start();
            for (let i = 0; i < 6; i++) {
                mock.timers.tick(20_000); // run healthily for longer than the window
                h.sp.last.exit(1);
                await flush();
                mock.timers.tick(500);
            }
            assert.equal(h.hp.running, true);
            assert.equal(h.sp.children.length, 7);
        } finally {
            mock.timers.reset();
        }
    });

    t('fatal exit code is not restarted', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        try {
            const h = harness(HelperProcess, { fatalExitCodes: [2] });
            h.hp.start();
            h.sp.last.exit(2);
            await flush();
            assert.match(h.errors[0], /exited \(code=2, signal=null\); not restarting/);
            assert.equal(h.hp.running, false);
            mock.timers.tick(60_000);
            assert.equal(h.sp.children.length, 1);
        } finally {
            mock.timers.reset();
        }
    });

    t('a non-fatal exit code still restarts when fatal codes are configured', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        try {
            const h = harness(HelperProcess, { fatalExitCodes: [2] });
            h.hp.start();
            h.sp.last.exit(0); // clean but unexpected exit
            await flush();
            mock.timers.tick(500);
            assert.equal(h.sp.children.length, 2);
            h.sp.last.exit(null, 'SIGSEGV');
            await flush();
            assert.match(h.errors[h.errors.length - 1], /signal=SIGSEGV/);
            mock.timers.tick(1000);
            assert.equal(h.sp.children.length, 3);
        } finally {
            mock.timers.reset();
        }
    });

    t('autoRestart=false reports the exit and stops', async () => {
        const h = harness(HelperProcess, { autoRestart: false });
        h.hp.start();
        h.sp.last.exit(3);
        await flush();
        assert.match(h.errors[0], /exited unexpectedly \(code=3/);
        assert.equal(h.hp.running, false);
        assert.deepEqual(h.statuses, ['started', 'stopped']);
    });

    t('stop() while waiting to restart cancels the restart', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        try {
            const h = harness(HelperProcess);
            h.hp.start();
            h.sp.last.exit(1);
            await flush();
            h.hp.stop();
            assert.equal(h.hp.running, false);
            mock.timers.tick(60_000);
            assert.equal(h.sp.children.length, 1);
            assert.deepEqual(h.statuses, ['started', 'stopped']);
        } finally {
            mock.timers.reset();
        }
    });

    t('stop() then start() quickly: the old child exit does not disturb the new one', async () => {
        const h = harness(HelperProcess);
        h.hp.start();
        const first = h.sp.last;
        first.diesOnSignal = false;
        h.hp.stop();
        h.hp.start();
        const second = h.sp.last;
        assert.notEqual(first, second);
        first.line({ type: 'stale' });
        first.exit(1);
        second.line({ type: 'fresh' });
        await flush();
        assert.deepEqual(h.messages, [{ type: 'fresh' }]);
        assert.equal(h.hp.running, true);
        assert.equal(h.errors.length, 0);
        assert.deepEqual(h.statuses, ['started', 'stopped', 'started']);
    });

    t('stop escalates to SIGKILL when the helper ignores SIGTERM', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const h = harness(HelperProcess);
            h.hp.start();
            const c = h.sp.last;
            c.diesOnSignal = false;
            h.hp.stop();
            assert.deepEqual(c.signals, ['SIGTERM']);
            mock.timers.tick(1999);
            assert.deepEqual(c.signals, ['SIGTERM']);
            mock.timers.tick(1);
            assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL']);
        } finally {
            mock.timers.reset();
        }
    });

    t('no SIGKILL when the helper exits promptly after SIGTERM', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
        try {
            const h = harness(HelperProcess);
            h.hp.start();
            const c: FakeChild = h.sp.last;
            c.diesOnSignal = false;
            h.hp.stop();
            c.exit(null, 'SIGTERM');
            mock.timers.tick(5000);
            assert.deepEqual(c.signals, ['SIGTERM']);
        } finally {
            mock.timers.reset();
        }
    });

    t('stop() of an already-exited child sends no signal', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        try {
            const h = harness(HelperProcess);
            h.hp.start();
            const c = h.sp.last;
            c.exitCode = 0; // exited, 'close' not yet delivered
            h.hp.stop();
            assert.deepEqual(c.signals, []);
        } finally {
            mock.timers.reset();
        }
    });

    t('restart window is reset by a fresh start()', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        try {
            const h = harness(HelperProcess, { maxRestarts: 1 });
            h.hp.start();
            h.sp.last.exit(1);
            await flush();
            mock.timers.tick(500);
            h.sp.last.exit(1);
            await flush();
            assert.equal(h.hp.running, false); // gave up
            h.hp.start();
            h.sp.last.exit(1);
            await flush();
            assert.equal(h.hp.running, true, 'new start() gets a fresh restart budget');
            assert.match(h.errors[h.errors.length - 1], /restarting in 500 ms/);
            h.hp.stop();
        } finally {
            mock.timers.reset();
        }
    });
}
