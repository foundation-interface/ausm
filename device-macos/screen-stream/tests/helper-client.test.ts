import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import ScreenStreamingServiceDefault, {
    HelperClient,
    HelperCommandError,
    ScreenStreamingService,
    createScreenStreamer,
    type DisplayChangeEvent,
    type HelperErrorEvent,
} from '../index';
import { makeTempDir, writeFakeHelper, waitFor, isAlive, quietConsole } from '../../test-support/fakes';
import { startCommandServer, startNotifyServer, socketHelperScript, readCommandLog } from '../../test-support/fake-socket-helper';

const dir = makeTempDir('ausm-ss-');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let seq = 0;
const sockPath = () => path.join(dir, `s${++seq}.sock`);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
});

async function attached(handler: Parameters<typeof startCommandServer>[1], debug = false) {
    const p = sockPath();
    const server = await startCommandServer(p, handler);
    cleanups.push(server.close);
    const client = new HelperClient(p, debug);
    await client.connectToExisting();
    return { client, server, path: p };
}

// ── Command transport ─────────────────────────────────────────────────────

test('connectToExisting verifies the socket with a status command', async () => {
    const { client, server } = await attached(() => ({ success: true, streaming: false }));
    assert.deepEqual(server.received, [{ command: 'status' }]);
    await client.connectToExisting(); // already ready: no second round-trip
    assert.equal(server.received.length, 1);
    assert.equal(client.isRunning(), false, 'attached clients do not own a helper process');
});

test('connectToExisting fails clearly when nothing listens or the helper refuses', async () => {
    const missing = new HelperClient(path.join(dir, 'nobody.sock'));
    await assert.rejects(missing.connectToExisting(), /Cannot connect to helper at .*nobody\.sock: .*ENOENT/);

    const p = sockPath();
    const server = await startCommandServer(p, () => ({ success: false, error: 'busy' }));
    cleanups.push(server.close);
    await assert.rejects(new HelperClient(p).connectToExisting(), /Cannot connect.*busy/);
});

test('commands before connecting are rejected without touching the socket', async () => {
    const client = new HelperClient(path.join(dir, 'unused.sock'));
    await assert.rejects(client.getDisplays(), /not running/);
    await assert.rejects(client.isStreaming(), /not running/);
    await assert.rejects(client.captureLatestFrame('display-1'), /not running/);
});

test('requests are newline-terminated JSON; replies may arrive in many small chunks with split UTF-8', async () => {
    const reply = Buffer.from(JSON.stringify({
        success: true,
        displays: [{ id: 'display-1', name: 'Built-in Retina 显示器 🖥️', width: 3456, height: 2234, isMain: true, isBuiltIn: true }],
    }), 'utf8');
    const { client } = await attached((cmd, socket) => {
        if (cmd.command === 'status') return { success: true };
        let i = 0;
        const t = setInterval(() => {
            socket.write(reply.subarray(i, i + 3));
            i += 3;
            if (i >= reply.length) { clearInterval(t); socket.end(); }
        }, 0);
        return undefined;
    });
    const displays = await client.getDisplays();
    assert.equal(displays[0].name, 'Built-in Retina 显示器 🖥️');
});

test('multi-display geometry (negative origins, Retina scale) is passed through untouched', async () => {
    const displays = [
        { id: 'display-1', name: 'A', width: 3456, height: 2234, isMain: true, isBuiltIn: true, displayId: 1, scaleFactor: 2, originX: 0, originY: 0, logicalWidth: 1728, logicalHeight: 1117 },
        { id: 'display-2', name: 'B', width: 2560, height: 1440, isMain: false, isBuiltIn: false, displayId: 4, scaleFactor: 1, originX: -2560, originY: -323, logicalWidth: 2560, logicalHeight: 1440, refreshRate: 59.94 },
    ];
    const { client } = await attached((cmd) => (cmd.command === 'displays' ? { success: true, displays } : { success: true }));
    assert.deepEqual(await client.getDisplays(), displays);
});

test('missing list fields default to empty values', async () => {
    const { client } = await attached(() => ({ success: true }));
    assert.deepEqual(await client.getDisplays(), []);
    assert.deepEqual(await client.getDisplayConfigs(), {});
    assert.equal(await client.isStreaming(), false);
});

test('isStreaming accepts either "streaming" or legacy "capturing"', async () => {
    const answers: Record<string, unknown>[] = [{}, { streaming: true }, { capturing: true }, { streaming: false, capturing: true }, {}];
    const { client } = await attached(() => ({ success: true, ...answers.shift() }));
    assert.equal(await client.isStreaming(), true);
    assert.equal(await client.isStreaming(), true);
    assert.equal(await client.isStreaming(), false, 'explicit streaming:false wins');
    assert.equal(await client.isStreaming(), false);
});

test('failed commands throw HelperCommandError carrying the helper code', async () => {
    const { client } = await attached((cmd) => {
        if (cmd.command === 'start') return { success: false, error: 'Screen Recording permission denied', code: 'permission_denied' };
        if (cmd.command === 'stop') return { error: 'not streaming' };
        if (cmd.command === 'displays') return { success: false };
        return { success: true };
    });
    await assert.rejects(client.startStream(['display-1']), (err: unknown) => {
        assert.ok(err instanceof HelperCommandError);
        assert.equal(err.name, 'HelperCommandError');
        assert.equal(err.code, 'permission_denied');
        assert.equal(err.message, 'Screen Recording permission denied');
        return true;
    });
    await assert.rejects(client.stopStream(), (err: any) => err.message === 'not streaming' && err.code === undefined);
    await assert.rejects(client.getDisplays(), /displays failed/);
});

test('invalid, empty and non-object replies are rejected', async () => {
    const replies = ['not json', '', '42', 'null', '"str"'];
    let i = 0;
    const { client } = await attached((cmd) => (cmd.command === 'status' && i === 0 ? (i++, { success: true }) : replies[i++ - 1]));
    for (const r of replies) {
        await assert.rejects(client.getDisplays(), /Invalid response from helper/, JSON.stringify(r));
    }
});

test('a helper that never answers hits the request timeout', async () => {
    const { client } = await attached((cmd) => (cmd.command === 'status' ? { success: true } : undefined));
    await assert.rejects((client as any).request({ command: 'displays' }, 100), /Command timeout after 100 ms/);
});

test('a helper that resets the connection rejects the request', async () => {
    const { client } = await attached((cmd, socket) => {
        if (cmd.command === 'status') return { success: true };
        socket.destroy();
        return undefined;
    });
    await assert.rejects(client.getDisplays(), /Invalid response|closed the connection|ECONNRESET|EPIPE/);
});

test('captureWindow / captureLatestFrame decode base64 and fill defaults', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9]);
    const { client, server } = await attached((cmd) => {
        if (cmd.command === 'captureWindow') return { success: true, data: jpeg.toString('base64'), width: 10 };
        if (cmd.command === 'captureLatestFrame') {
            return cmd.displayId === 'display-9' ? { success: true } : { success: true, data: jpeg.toString('base64'), timestamp: 123456789, frameNumber: 42 };
        }
        return { success: true };
    });
    const win = await client.captureWindow(77);
    assert.deepEqual(win, { data: jpeg, width: 10, height: 0, jpegSize: 0, windowId: 77 });
    const win2 = await client.captureWindow(78, 0.5, 'display-2');
    assert.equal(win2.windowId, 78);
    const frame = await client.captureLatestFrame('display-1');
    assert.deepEqual(frame, { data: jpeg, displayId: 'display-1', width: 0, height: 0, jpegSize: 0, timestamp: 123456789, frameNumber: 42 });
    await assert.rejects(client.captureLatestFrame('display-9'), /returned no data for display-9/);
    const sent = server.received.filter((c) => c.command !== 'status');
    assert.deepEqual(sent[0], { command: 'captureWindow', windowId: 77, jpegQuality: 0.85 });
    assert.deepEqual(sent[1], { command: 'captureWindow', windowId: 78, jpegQuality: 0.5, displayId: 'display-2' });
    assert.deepEqual(sent[2], { command: 'captureLatestFrame', displayId: 'display-1', jpegQuality: 0.7 });
});

test('configure records the config; rejected keys are tolerated', async () => {
    const logs: string[] = [];
    const saved = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
    try {
        const { client, server } = await attached((cmd) => (cmd.command === 'configure' ? { success: true, rejected: ['fps'] } : { success: true }), true);
        await client.configure({ fps: 500, targetHeight: 720 });
        assert.deepEqual(server.received[1], { command: 'configure', config: { fps: 500, targetHeight: 720 } });
    } finally {
        console.log = saved;
    }
    assert.ok(logs.some((l) => l.includes('ignored invalid config keys: fps')));
});

test('updateConfiguration: requires configure, no-op when unchanged, restarts streaming with the same displays', async () => {
    let streaming = false;
    const { client, server } = await attached((cmd) => {
        if (cmd.command === 'start') streaming = true;
        if (cmd.command === 'stop') streaming = false;
        return { success: true, streaming };
    });
    await assert.rejects(client.updateConfiguration({ fps: 5 }), /Call configure\(\) first/);
    await client.configure({ fps: 10, targetHeight: 1080 });
    await client.startStream(['display-2']);
    const mark = server.received.length;
    await client.updateConfiguration({ fps: 10 });
    assert.equal(server.received.length, mark, 'unchanged config sends nothing');
    await client.updateConfiguration({ fps: 30 });
    assert.deepEqual(server.received.slice(mark).map((c) => c.command), ['status', 'stop', 'configure', 'start']);
    assert.deepEqual(server.received[server.received.length - 1], { command: 'start', displayIds: ['display-2'] });
    assert.deepEqual(server.received[server.received.length - 2].config, { fps: 30, targetHeight: 1080 });
});

test('updateConfiguration while not streaming only reconfigures', async () => {
    const { client, server } = await attached(() => ({ success: true, streaming: false }));
    await client.configure({ fps: 10 });
    const mark = server.received.length;
    await client.updateConfiguration({ fps: 20 });
    assert.deepEqual(server.received.slice(mark).map((c) => c.command), ['status', 'configure']);
});

test('startStream without ids sends an empty list (all displays)', async () => {
    const { client, server } = await attached(() => ({ success: true }));
    await client.startStream();
    assert.deepEqual(server.received[1], { command: 'start', displayIds: [] });
    await client.configureDisplay('display-1', { fps: 2 });
    assert.deepEqual(server.received[2], { command: 'configureDisplay', displayId: 'display-1', config: { fps: 2 } });
});

// ── Notifications ─────────────────────────────────────────────────────────

async function notifying() {
    const p = sockPath();
    const notify = await startNotifyServer(p + '.notify');
    cleanups.push(notify.close);
    const client = new HelperClient(p);
    // Pretend start() succeeded: notifications are only consumed from an owned helper.
    (client as any).ready = true;
    (client as any).helperProcess = { kill() {} };
    (client as any).connectNotifications(0);
    cleanups.push(() => (client as any).closeNotifications());
    await waitFor(() => notify.connected === 1, 2000, 'notify connection');
    const displayChanges: DisplayChangeEvent[] = [];
    const helperErrors: HelperErrorEvent[] = [];
    const captures: string[] = [];
    client.onDisplayChange((e) => displayChanges.push(e));
    client.onHelperError((e) => helperErrors.push(e));
    client.on('captureStarted', () => captures.push('started'));
    client.on('captureStopped', () => captures.push('stopped'));
    return { client, notify, displayChanges, helperErrors, captures };
}

test('notifications: display changes, helper errors and capture state', async () => {
    const n = await notifying();
    n.notify.push([
        JSON.stringify({ type: 'display_change', displayId: 'display-2', event: 'added' }),
        JSON.stringify({ type: 'error', code: 'permission_denied', error: 'Screen Recording revoked', displayId: 'display-1' }),
        JSON.stringify({ type: 'error' }),
        JSON.stringify({ type: 'capture_started' }),
        JSON.stringify({ type: 'capture_stopped' }),
        '',
    ].join('\n'));
    await waitFor(() => n.captures.length === 2, 2000, 'capture events');
    assert.deepEqual(n.displayChanges, [{ type: 'display_change', displayId: 'display-2', event: 'added' }]);
    assert.deepEqual(n.helperErrors, [
        { type: 'error', code: 'permission_denied', error: 'Screen Recording revoked', displayId: 'display-1' },
        { type: 'error', code: 'unknown', error: 'Unknown helper error' },
    ]);
    assert.deepEqual(n.captures, ['started', 'stopped']);
});

test('notifications: partial lines, split UTF-8, malformed JSON and unknown types', async () => {
    const n = await notifying();
    const line = Buffer.from(JSON.stringify({ type: 'error', code: 'x', error: 'خطأ 错误 💥' }) + '\n', 'utf8');
    n.notify.push('{"type":"display_change","displayId":"d1",');
    await new Promise((r) => setTimeout(r, 20));
    n.notify.push('"event":"removed"}\nnot json\n[1]\nnull\n{"type":"frame","n":1}\n{"type":"display_change"}\n');
    for (const b of line) {
        n.notify.push(Buffer.from([b]));
    }
    await waitFor(() => n.helperErrors.length === 1, 2000, 'error notification');
    assert.deepEqual(n.displayChanges, [{ type: 'display_change', displayId: 'd1', event: 'removed' }]);
    assert.equal(n.helperErrors[0].error, 'خطأ 错误 💥');
});

test('notifications: an oversized line without newline is discarded, later lines survive', async () => {
    const n = await notifying();
    // Stay just under the 512 KB cap, then cross it in the same chunk that carries a valid line.
    n.notify.push('x'.repeat(510_000));
    await new Promise((r) => setTimeout(r, 50));
    n.notify.push('y'.repeat(5_000));
    n.notify.push('tail-of-garbage\n' + JSON.stringify({ type: 'display_change', displayId: 'd3', event: 'reconfigured' }) + '\n');
    await waitFor(() => n.displayChanges.length === 1, 2000, 'display change after garbage');
    assert.equal(n.displayChanges[0].displayId, 'd3');
});

test('notifications: the socket reconnects after the helper drops it', async () => {
    const n = await notifying();
    n.notify.dropClients();
    await waitFor(() => n.notify.connections === 2 && n.notify.connected === 1, 3000, 'reconnect');
    n.notify.push(JSON.stringify({ type: 'capture_started' }) + '\n');
    await waitFor(() => n.captures.length === 1, 2000, 'event after reconnect');
});

test('notifications: a throwing listener does not kill the notification stream', async () => {
    const n = await notifying();
    let calls = 0;
    n.client.on('captureStarted', () => {
        calls++;
        if (calls === 1) throw new Error('consumer bug');
    });
    n.notify.push(JSON.stringify({ type: 'capture_started' }) + '\n');
    n.notify.push(JSON.stringify({ type: 'capture_started' }) + '\n');
    await waitFor(() => calls === 2, 2000, 'second notification');
});

test('onDisplayChange / onHelperError return working unsubscribe functions', () => {
    const client = new HelperClient(path.join(dir, 'x.sock'));
    const seen: unknown[] = [];
    const off = client.onDisplayChange((e) => seen.push(e));
    const offErr = client.onHelperError((e) => seen.push(e));
    off();
    offErr();
    (client as any).handleNotification({ type: 'display_change', displayId: 'a', event: 'added' });
    (client as any).handleNotification({ type: 'error', code: 'c', error: 'e' });
    assert.equal(seen.length, 0);
});

// ── Owned helper lifecycle (fake helper script) ───────────────────────────

function ownedClient(name: string, opts: Partial<Parameters<typeof socketHelperScript>[0]> = {}) {
    const commandLog = path.join(dir, `${name}.log`);
    const helper = writeFakeHelper(dir, name, socketHelperScript({ commandLog, ...opts }));
    const client = new HelperClient(sockPath());
    (client as any).helperPath = helper;
    cleanups.push(() => client.stop());
    return { client, commandLog };
}

test('start(): waits for the ready marker (even split across chunks), then commands work; stop() quits gracefully', async () => {
    const { client, commandLog } = ownedClient('ss-owned', {
        splitReadyMarker: true,
        replies: { displays: { displays: [{ id: 'display-1' }] } },
        notifications: [JSON.stringify({ type: 'capture_started' })],
    });
    const started: string[] = [];
    client.on('captureStarted', () => started.push('x'));
    await client.start();
    assert.equal(client.isRunning(), true);
    assert.deepEqual((await client.getDisplays()).map((d) => d.id), ['display-1']);
    await waitFor(() => started.length === 1, 3000, 'notification from owned helper');
    await assert.rejects(client.start(), /already running/);
    const pid = (client as any).helperProcess.pid;
    const exits: any[] = [];
    client.on('exit', (e) => exits.push(e));
    await client.stop();
    assert.equal(client.isRunning(), false);
    assert.equal(isAlive(pid), false);
    assert.deepEqual(readCommandLog(commandLog).map((c) => c.command), ['displays', 'quit']);
    assert.deepEqual(exits, [{ code: 0, signal: null, expected: true }]);
    await client.stop(); // idempotent
});

test('start(): helper exiting before ready rejects and leaves the client restartable', async () => {
    const { client } = ownedClient('ss-early-exit', { exitBeforeReady: 3 });
    const exits: any[] = [];
    client.on('exit', (e) => exits.push(e));
    await assert.rejects(client.start(), /exited during startup \(code=3/);
    assert.equal(client.isRunning(), false);
    assert.equal((client as any).helperProcess, null);
    assert.deepEqual(exits, [{ code: 3, signal: null, expected: false }]);
});

test('start(): missing helper binary rejects with a build hint', async () => {
    const client = new HelperClient(sockPath());
    (client as any).helperPath = path.join(dir, 'no-helper');
    await assert.rejects(client.start(), /Helper binary not found.*build:helper/);
});

test('stop(): escalates to SIGTERM when quit is ignored', async () => {
    const { client } = ownedClient('ss-ignore-quit', { ignoreQuit: true });
    await client.start();
    const proc = (client as any).helperProcess;
    const t0 = Date.now();
    await client.stop();
    assert.equal(proc.signalCode, 'SIGTERM');
    assert.ok(Date.now() - t0 >= 2900, 'waited for the graceful quit first');
});

test('stale-resource cleanup removes leftover sockets at our path but never regular files', async () => {
    const p = sockPath();
    const client = new HelperClient(p);
    // A socket file left behind by a crashed run (python does not unlink on exit).
    const { spawnSync } = await import('child_process');
    spawnSync('python3', ['-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', p]);
    fs.writeFileSync(p + '.notify', 'regular file, not a socket');
    assert.ok(fs.lstatSync(p).isSocket());
    (client as any).cleanupStaleResources();
    assert.equal(fs.existsSync(p), false, 'stale socket removed');
    assert.equal(fs.readFileSync(p + '.notify', 'utf8'), 'regular file, not a socket');
    fs.unlinkSync(p + '.notify');
});

// ── ScreenStreamingService ────────────────────────────────────────────────

function service(name: string, opts: Partial<Parameters<typeof socketHelperScript>[0]> = {}) {
    const commandLog = path.join(dir, `${name}.log`);
    const helper = writeFakeHelper(dir, name, socketHelperScript({ commandLog, ...opts }));
    const svc = createScreenStreamer({ socketPath: sockPath(), fps: 15 });
    (svc.getHelper() as any).helperPath = helper;
    cleanups.push(() => svc.cleanup());
    return { svc, commandLog };
}

test('service start → configure → start stream; stop → stop stream → quit', async () => {
    const { svc, commandLog } = service('svc-ok');
    assert.equal(await svc.start(['display-1']), true);
    assert.equal(await svc.start(), false, 'already running');
    assert.equal(await svc.isStreaming(), true);
    assert.equal(await svc.stop(), true);
    assert.equal(await svc.isStreaming(), false);
    const log = readCommandLog(commandLog);
    assert.deepEqual(log.map((c) => c.command), ['configure', 'start', 'status', 'stop', 'quit']);
    assert.deepEqual(log[0].config, {
        fps: 15, targetHeight: 1080, sharedMemoryName: '/ausm-frames', frameCount: 5,
        enableRecording: false, outputDirectory: '', socketPath: (svc.getHelper() as any).socketPath, debug: false,
    });
    assert.deepEqual(log[1].displayIds, ['display-1']);
    assert.equal(await svc.stop(), false, 'second stop reports not running');
});

test('service start failure (permission denied) returns false and tears the helper down', async () => {
    const { svc } = service('svc-denied', { replies: { start: { success: false, error: 'denied', code: 'permission_denied' } } });
    const ok = await quietConsole(() => svc.start());
    assert.equal(ok, false);
    assert.equal(svc.getHelper().isRunning(), false);
});

test('service stop() during an in-flight start() leaves nothing running', async () => {
    const { svc } = service('svc-stop-during-start', { readyDelayMs: 300 });
    const starting = quietConsole(() => svc.start());
    await new Promise((r) => setTimeout(r, 100));
    await svc.stop();
    const started = await starting;
    assert.equal(started, false, 'start must not report success after stop');
    assert.equal(svc.getHelper().isRunning(), false);
    assert.equal(await svc.isStreaming(), false);
});

test('service recovers after the helper dies: start() can be called again', async () => {
    const { svc } = service('svc-crash');
    assert.equal(await svc.start(), true);
    const proc = (svc.getHelper() as any).helperProcess;
    proc.kill('SIGKILL');
    await waitFor(() => !svc.getHelper().isRunning(), 3000, 'helper death noticed');
    assert.equal(await svc.start(), true);
    await svc.stop();
});

test('service wrappers swallow transient failures', async () => {
    const svc = new ScreenStreamingService({ socketPath: path.join(dir, 'never.sock') });
    assert.equal(await svc.isStreaming(), false);
    assert.equal(await svc.captureLatestFrame('display-1'), null);
    assert.deepEqual(await quietConsole(() => svc.getDisplays()), []);
    await assert.rejects(svc.captureWindow(1), /not running/);
    await svc.cleanup();
    assert.equal(ScreenStreamingServiceDefault, ScreenStreamingService);
});

test('service forwards display-change and error listeners', () => {
    const svc = new ScreenStreamingService({ socketPath: path.join(dir, 'fwd.sock') });
    const seen: string[] = [];
    svc.onDisplayChange((e) => seen.push(`dc:${e.event}`));
    svc.onError((e) => seen.push(`err:${e.code}`));
    (svc.getHelper() as any).handleNotification({ type: 'display_change', displayId: 'a', event: 'added' });
    (svc.getHelper() as any).handleNotification({ type: 'error', code: 'stream_failed', error: 'x' });
    assert.deepEqual(seen, ['dc:added', 'err:stream_failed']);
});
