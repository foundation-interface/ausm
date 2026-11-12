import { test, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import CameraStreamingServiceDefault, {
    CameraStreamingService,
    HelperClient,
    createCameraStreamer,
    type CaptureErrorEvent,
    type DeviceChangeEvent,
} from '../index';
import { makeTempDir, writeFakeHelper, waitFor, isAlive, quietConsole, tick } from '../../test-support/fakes';
import { startCommandServer, startNotifyServer, socketHelperScript, readCommandLog } from '../../test-support/fake-socket-helper';

const dir = makeTempDir('ausm-cam-');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let seq = 0;
const sockPath = () => path.join(dir, `c${++seq}.sock`);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
});

async function attached(handler: Parameters<typeof startCommandServer>[1]) {
    const p = sockPath();
    const server = await startCommandServer(p, handler);
    cleanups.push(server.close);
    const client = new HelperClient(p);
    await client.connectToExisting();
    return { client, server };
}

// ── Command transport ─────────────────────────────────────────────────────

test('connectToExisting: success, refusal, and nothing listening', async () => {
    const { client, server } = await attached(() => ({ success: true }));
    assert.deepEqual(server.received, [{ command: 'status' }]);
    await client.connectToExisting();
    assert.equal(server.received.length, 1);

    await assert.rejects(new HelperClient(path.join(dir, 'none.sock')).connectToExisting(), /Cannot connect to helper.*ENOENT/);
    const p = sockPath();
    const refusing = await startCommandServer(p, () => ({ success: false, error: 'no camera' }));
    cleanups.push(refusing.close);
    await assert.rejects(new HelperClient(p).connectToExisting(), /no camera/);
});

test('commands before connecting are rejected', async () => {
    const client = new HelperClient(path.join(dir, 'u.sock'));
    await assert.rejects(client.getDevices(), /not running/);
    await assert.rejects(client.captureLatestFrame('cam'), /not running/);
});

test('device list (unicode names) and defaults', async () => {
    const devices = [
        { id: 'FaceTime-1', name: 'FaceTime HD カメラ', position: 'front', active: true, manufacturer: 'Apple Inc.' },
        { id: 'usb-2', name: 'Logitech BRIO 📷', position: 'unspecified', active: false },
    ];
    const replies: Record<string, unknown>[] = [{ success: true, devices }, { success: true }, { success: true }, { success: true, streaming: true }, { success: true }];
    const { client } = await attached((cmd) => (cmd.command === 'status' && replies.length === 5 ? { success: true } : replies.shift()));
    assert.deepEqual(await client.getDevices(), devices);
    assert.deepEqual(await client.getDevices(), []);
    assert.deepEqual(await client.getDeviceConfigs(), {});
    assert.equal(await client.isStreaming(), true);
    assert.equal(await client.isStreaming(), false);
});

test('reply split into tiny chunks with split multi-byte UTF-8 decodes correctly', async () => {
    const reply = Buffer.from(JSON.stringify({ success: true, devices: [{ id: 'x', name: 'Câmera 前置 📸', position: 'front', active: true }] }), 'utf8');
    const { client } = await attached((cmd, socket) => {
        if (cmd.command === 'status') return { success: true };
        let i = 0;
        const t = setInterval(() => {
            socket.write(reply.subarray(i, i + 1));
            i += 1;
            if (i >= reply.length) { clearInterval(t); socket.end(); }
        }, 0);
        return undefined;
    });
    assert.equal((await client.getDevices())[0].name, 'Câmera 前置 📸');
});

test('errors in replies are thrown; invalid replies are rejected', async () => {
    const replies: unknown[] = [{ error: 'device busy' }, { error: 'bad config' }, 'garbage', '', 'null'];
    const { client } = await attached((cmd) => (cmd.command === 'status' && replies.length === 5 ? { success: true } : replies.shift()));
    await assert.rejects(client.startStream(['cam']), /device busy/);
    await assert.rejects(client.configure({ fps: 1 }), /bad config/);
    for (let i = 0; i < 3; i++) await assert.rejects(client.getDevices(), /Invalid response from camera helper \(\d+ bytes\)/);
});

test('invalid replies never echo their contents (they may contain frame data)', async () => {
    const { client } = await attached((cmd) => (cmd.command === 'status' ? { success: true } : 'SENSITIVE-PAYLOAD{'));
    await assert.rejects(client.getDevices(), (err: Error) => !err.message.includes('SENSITIVE'));
});

test('a helper that never answers times out', async () => {
    const { client } = await attached((cmd) => (cmd.command === 'status' ? { success: true } : undefined));
    await assert.rejects((client as any).sendCommandDirect({ command: 'devices' }, 100), /Command timeout/);
});

test('captureLatestFrame: decodes data, requires success, fills defaults', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const { client, server } = await attached((cmd) => {
        if (cmd.command !== 'captureLatestFrame') return { success: true };
        if (cmd.deviceId === 'none') return { success: true };
        if (cmd.deviceId === 'nosuccess') return { data: jpeg.toString('base64') };
        if (cmd.deviceId === 'err') return { success: false, error: 'no frame yet' };
        return { success: true, data: jpeg.toString('base64'), width: 1280, height: 720, frameNumber: 9 };
    });
    assert.deepEqual(await client.captureLatestFrame('cam'), {
        data: jpeg, deviceId: 'cam', width: 1280, height: 720, jpegSize: 0, timestamp: 0, frameNumber: 9,
    });
    await assert.rejects(client.captureLatestFrame('none'), /returned no data for none/);
    await assert.rejects(client.captureLatestFrame('nosuccess'), /captureLatestFrame failed for nosuccess/);
    await assert.rejects(client.captureLatestFrame('err'), /no frame yet/);
    assert.deepEqual(server.received[1], { command: 'captureLatestFrame', deviceId: 'cam', jpegQuality: 0.7 });
});

test('updateConfiguration: requires configure; no-op when unchanged; restarts streaming devices', async () => {
    let streaming = false;
    const { client, server } = await attached((cmd) => {
        if (cmd.command === 'start') streaming = true;
        if (cmd.command === 'stop') streaming = false;
        return { success: true, streaming };
    });
    await assert.rejects(client.updateConfiguration({ fps: 5 }), /Call configure\(\) first/);
    await client.configure({ fps: 10 });
    await client.startStream(['cam-1']);
    const mark = server.received.length;
    await client.updateConfiguration({ fps: 10 });
    assert.deepEqual(server.received.slice(mark).map((c) => c.command), ['status']);
    await client.updateConfiguration({ fps: 30 });
    assert.deepEqual(server.received.slice(mark + 1).map((c) => c.command), ['status', 'stop', 'configure', 'start']);
    assert.deepEqual(server.received[server.received.length - 1].deviceIds, ['cam-1']);
    await client.configureDevice('cam-1', { fps: 5 });
    assert.deepEqual(server.received[server.received.length - 1], { command: 'configureDevice', deviceId: 'cam-1', config: { fps: 5 } });
});

test('stop() on an attached client stops accepting commands', async () => {
    const { client } = await attached(() => ({ success: true }));
    await client.stop();
    await assert.rejects(client.getDevices(), /not running/);
});

// ── Notifications ─────────────────────────────────────────────────────────

async function notifying() {
    const p = sockPath();
    const notify = await startNotifyServer(p + '.notify');
    cleanups.push(notify.close);
    const client = new HelperClient(p);
    (client as any).ready = true;
    (client as any).connectNotifications();
    cleanups.push(() => { (client as any).ready = false; (client as any).notifySocket?.destroy(); });
    await waitFor(() => notify.connected === 1, 3000, 'notify connection');
    const devices: DeviceChangeEvent[] = [];
    const errors: CaptureErrorEvent[] = [];
    client.onDeviceChange((e) => devices.push(e));
    client.onCaptureError((e) => errors.push(e));
    return { client, notify, devices, errors };
}

test('notifications: device changes and capture errors, with defaults for missing fields', async () => {
    const n = await notifying();
    n.notify.push([
        JSON.stringify({ type: 'device_change', deviceId: 'usb-1', event: 'added' }),
        JSON.stringify({ type: 'device_change', deviceId: 'usb-1', event: 'removed' }),
        JSON.stringify({ type: 'device_change', event: 'something-new' }),
        JSON.stringify({ type: 'capture_error', deviceId: 'cam', error: 'Camera in use by another app' }),
        JSON.stringify({ type: 'capture_error' }),
        JSON.stringify({ type: 'unknown_type' }),
        'not json',
        '',
    ].join('\n'));
    await waitFor(() => n.errors.length === 2, 2000, 'capture errors');
    assert.deepEqual(n.devices, [
        { type: 'device_change', deviceId: 'usb-1', event: 'added' },
        { type: 'device_change', deviceId: 'usb-1', event: 'removed' },
        { type: 'device_change', deviceId: '', event: 'reconfigured' },
    ]);
    assert.deepEqual(n.errors, [
        { type: 'capture_error', deviceId: 'cam', error: 'Camera in use by another app' },
        { type: 'capture_error', deviceId: '', error: 'Unknown capture error' },
    ]);
});

test('notifications: lines split across writes and split UTF-8', async () => {
    const n = await notifying();
    const line = Buffer.from(JSON.stringify({ type: 'capture_error', deviceId: 'c', error: 'ошибка 🎥' }) + '\n', 'utf8');
    for (const b of line) n.notify.push(Buffer.from([b]));
    await waitFor(() => n.errors.length === 1, 2000, 'error notification');
    assert.equal(n.errors[0].error, 'ошибка 🎥');
});

test('notifications: an oversized line without newline is dropped but the next valid line survives', async () => {
    const n = await notifying();
    // Stay just under the 512 KB cap, then cross it in the same chunk that carries a valid line.
    n.notify.push('x'.repeat(510_000));
    await new Promise((r) => setTimeout(r, 50));
    n.notify.push('y'.repeat(5_000));
    n.notify.push('end-of-garbage\n' + JSON.stringify({ type: 'device_change', deviceId: 'd', event: 'added' }) + '\n');
    await waitFor(() => n.devices.length === 1, 2000, 'device change after garbage');
});

test('notifications: a throwing listener does not stop later notifications', async () => {
    const n = await notifying();
    let calls = 0;
    n.client.onDeviceChange(() => {
        calls++;
        if (calls === 1) throw new Error('consumer bug');
    });
    n.notify.push(JSON.stringify({ type: 'device_change', deviceId: 'a', event: 'added' }) + '\n');
    n.notify.push(JSON.stringify({ type: 'device_change', deviceId: 'b', event: 'added' }) + '\n');
    await waitFor(() => calls === 2, 2000, 'second notification');
});

// ── Owned helper lifecycle ─────────────────────────────────────────────────

function owned(name: string, opts: Partial<Parameters<typeof socketHelperScript>[0]> = {}) {
    const commandLog = path.join(dir, `${name}.log`);
    const helper = writeFakeHelper(dir, name, socketHelperScript({ commandLog, ...opts }));
    const client = new HelperClient(sockPath());
    (client as any).helperPath = helper;
    cleanups.push(() => client.stop());
    return { client, commandLog };
}

test('start(): ready marker split across chunks, commands, graceful quit', async () => {
    const { client, commandLog } = owned('cam-owned', {
        splitReadyMarker: true,
        replies: { devices: { devices: [{ id: 'cam-1', name: 'c', position: 'front', active: true }] } },
        notifications: [JSON.stringify({ type: 'device_change', deviceId: 'cam-2', event: 'added' })],
    });
    const changes: DeviceChangeEvent[] = [];
    client.onDeviceChange((e) => changes.push(e));
    await client.start();
    assert.equal(client.isRunning(), true);
    assert.deepEqual((await client.getDevices()).map((d) => d.id), ['cam-1']);
    await waitFor(() => changes.length === 1, 3000, 'notification');
    await assert.rejects(client.start(), /already running/);
    const pid = (client as any).helperProcess.pid;
    const exits: unknown[] = [];
    client.on('exit', (e) => exits.push(e));
    await client.stop();
    assert.equal(isAlive(pid), false);
    assert.equal(client.isRunning(), false);
    assert.deepEqual(exits, [], 'no exit event for a requested stop');
    assert.deepEqual(readCommandLog(commandLog).map((c) => c.command), ['devices', 'quit']);
});

test('start(): early exit rejects and emits exit', async () => {
    const { client } = owned('cam-early', { exitBeforeReady: 5 });
    const exits: unknown[] = [];
    client.on('exit', (e) => exits.push(e));
    await assert.rejects(client.start(), /exited during startup \(code=5/);
    assert.deepEqual(exits, [{ code: 5, signal: null }]);
    assert.equal((client as any).helperProcess, null);
});

test('start(): missing binary rejects', async () => {
    const client = new HelperClient(sockPath());
    (client as any).helperPath = path.join(dir, 'missing');
    await assert.rejects(client.start(), /Helper binary not found/);
});

test('stop(): SIGTERM then SIGKILL for an unresponsive helper', async () => {
    const { client } = owned('cam-stubborn', { ignoreQuit: true, ignoreSigterm: true });
    await client.start();
    const proc = (client as any).helperProcess;
    await client.stop();
    await waitFor(() => proc.signalCode === 'SIGKILL', 3000, 'SIGKILL');
});

test('stale-resource cleanup removes leftover sockets but never regular files', () => {
    const p = sockPath();
    spawnSync('python3', ['-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', p]);
    assert.ok(fs.lstatSync(p).isSocket());
    fs.writeFileSync(p + '.notify', 'user data that happens to sit at this path');
    const client = new HelperClient(p);
    (client as any).cleanupStaleResources();
    assert.equal(fs.existsSync(p), false);
    assert.equal(fs.readFileSync(p + '.notify', 'utf8'), 'user data that happens to sit at this path');
});

// ── CameraStreamingService with a real (fake-script) helper ───────────────

function service(name: string, opts: Partial<Parameters<typeof socketHelperScript>[0]> = {}, deviceId?: string) {
    const commandLog = path.join(dir, `${name}.log`);
    const helper = writeFakeHelper(dir, name, socketHelperScript({
        commandLog,
        replies: { devices: { devices: [{ id: 'cam-a' }, { id: 'cam-b' }] } },
        ...opts,
    }));
    const svc = createCameraStreamer({ socketPath: sockPath(), deviceId });
    (svc.getHelper() as any).helperPath = helper;
    cleanups.push(() => svc.cleanup());
    return { svc, commandLog };
}

test('service start: configures, discovers all devices, starts streaming; stop is clean', async () => {
    const { svc, commandLog } = service('cam-svc');
    assert.equal(await svc.start(), true);
    assert.equal(await svc.start(), false);
    assert.equal(await svc.isStreaming(), true);
    assert.equal(await svc.stop(), true);
    const log = readCommandLog(commandLog);
    assert.deepEqual(log.map((c) => c.command), ['configure', 'devices', 'start', 'status', 'stop', 'quit']);
    assert.deepEqual(log[0].config, {
        fps: 10, targetHeight: 720, sharedMemoryName: '/ausm-camera-frames', frameCount: 5,
        socketPath: (svc.getHelper() as any).socketPath, debug: false,
    });
    assert.deepEqual(log[2].deviceIds, ['cam-a', 'cam-b']);
});

test('service start honours config.deviceId and explicit ids', async () => {
    const a = service('cam-svc-dev', {}, 'cam-z');
    assert.equal(await a.svc.start(), true);
    await a.svc.stop();
    assert.deepEqual(readCommandLog(a.commandLog).find((c) => c.command === 'start')!.deviceIds, ['cam-z']);
    const b = service('cam-svc-ids');
    assert.equal(await b.svc.start(['x', 'y']), true);
    await b.svc.stop();
    assert.deepEqual(readCommandLog(b.commandLog).find((c) => c.command === 'start')!.deviceIds, ['x', 'y']);
    assert.equal(readCommandLog(b.commandLog).some((c) => c.command === 'devices'), false);
});

test('service start failure returns false and leaves no helper', async () => {
    const { svc } = service('cam-svc-fail', { replies: { start: { error: 'camera access denied' } } });
    assert.equal(await quietConsole(() => svc.start()), false);
    assert.equal(svc.getHelper().isRunning(), false);
});

test('service stop() during an in-flight start() leaves nothing running', async () => {
    const { svc } = service('cam-svc-race', { readyDelayMs: 300 });
    const starting = quietConsole(() => svc.start());
    await new Promise((r) => setTimeout(r, 100));
    await svc.stop();
    assert.equal(await starting, false);
    assert.equal(svc.getHelper().isRunning(), false);
    assert.equal(await svc.isStreaming(), false);
});

test('service wrappers swallow transient failures; startDevices requires a running helper', async () => {
    const svc = new CameraStreamingService({ socketPath: path.join(dir, 'never.sock') });
    assert.equal(await svc.isStreaming(), false);
    assert.equal(await svc.captureLatestFrame('cam'), null);
    assert.equal(await svc.startDevices(['cam']), false);
    assert.deepEqual(await quietConsole(() => svc.getDevices()), []);
    assert.equal(await svc.stop(), false);
    assert.equal(CameraStreamingServiceDefault, CameraStreamingService);
});

// ── Restart policy (fake HelperClient, mocked timers) ─────────────────────

class FakeHelper extends EventEmitter {
    starts = 0;
    stops = 0;
    /** Results for successive start() calls: true = succeed, false = throw. */
    plan: boolean[] = [];
    running = false;
    async start() {
        this.starts++;
        const ok = this.plan.length ? this.plan.shift()! : true;
        if (!ok) throw new Error('helper failed to start');
        this.running = true;
    }
    async configure() {}
    async getDevices() { return [{ id: 'cam' }]; }
    async startStream() {}
    async stopStream() {}
    async stop() { this.stops++; this.running = false; }
    isRunning() { return this.running; }
    crash() { this.running = false; this.emit('exit', { code: 1, signal: null }); }
}

function restartHarness() {
    const svc = new CameraStreamingService({ socketPath: path.join(dir, 'r.sock') });
    const fake = new FakeHelper();
    (svc as any).helper = fake;
    fake.on('exit', (e) => (svc as any).handleHelperExit(e));
    return { svc, fake };
}

async function settle() {
    for (let i = 0; i < 20; i++) await tick();
}

test('restart: crash is restarted with exponential backoff', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
        await quietConsole(async () => {
            const { svc, fake } = restartHarness();
            assert.equal(await svc.start(), true);
            fake.crash();
            mock.timers.tick(999);
            await settle();
            assert.equal(fake.starts, 1);
            mock.timers.tick(1);
            await settle();
            assert.equal(fake.starts, 2);
            assert.equal(await svc.isStreaming(), false); // fake isStreaming is not defined → false
        });
    } finally {
        mock.timers.reset();
    }
});

test('restart: a helper that crashes right after every successful restart eventually gives up', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
        await quietConsole(async () => {
            const { svc, fake } = restartHarness();
            await svc.start();
            for (let i = 0; i < 12; i++) {
                fake.crash();
                mock.timers.tick(60_000);
                await settle();
            }
            assert.ok(fake.starts <= 1 + 5, `restarted ${fake.starts - 1} times; the limit is 5`);
        });
    } finally {
        mock.timers.reset();
    }
});

test('restart: a failed restart attempt keeps retrying with backoff instead of giving up silently', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
        await quietConsole(async () => {
            const { svc, fake } = restartHarness();
            await svc.start();
            fake.plan = [false, false, true];
            fake.crash();
            for (const d of [1000, 2000, 4000]) {
                mock.timers.tick(d);
                await settle();
            }
            assert.equal(fake.starts, 4);
            assert.equal(fake.running, true, 'service recovered after transient failures');
        });
    } finally {
        mock.timers.reset();
    }
});

test('restart: stop() cancels a pending restart, and one already in flight cannot resurrect the service', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
        await quietConsole(async () => {
            const { svc, fake } = restartHarness();
            await svc.start();
            fake.crash();
            await svc.stop();
            mock.timers.tick(60_000);
            await settle();
            assert.equal(fake.starts, 1, 'pending restart cancelled');

            // Restart fires, and stop() is called while its start() is still awaiting.
            await svc.start();
            let release!: () => void;
            fake.start = async function () {
                this.starts++;
                await new Promise<void>((r) => (release = r));
                this.running = true;
            };
            fake.crash();
            mock.timers.tick(30_000);
            await settle();
            const stopped = svc.stop();
            release();
            await stopped;
            await settle();
            assert.equal(await svc.stop(), false);
            assert.equal(fake.running, false, 'helper is not left running after stop()');
            assert.equal((svc as any).running, false);
        });
    } finally {
        mock.timers.reset();
    }
});
