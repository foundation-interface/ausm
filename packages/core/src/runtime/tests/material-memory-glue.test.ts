/**
 * Runtime glue between the material-manager service client and the memory
 * client: material events → memory writes, focus sessions, OCR trigger,
 * weights, and the runtime's memory query / freeze APIs.  Both clients are
 * fakes; nothing is spawned and nothing reads the screen.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import Module from 'module';

import { AUSMRuntime } from '../index';
import type { MaterialEvent } from '../../events/MaterialEvent';

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeMaterialClient extends EventEmitter {
    started = false;
    stopped = false;
    sent: Record<string, unknown>[] = [];
    failStart = false;
    constructor(public options: Record<string, unknown>) {
        super();
    }
    async start() {
        if (this.failStart) throw new Error('spawn failed');
        this.started = true;
    }
    async stop() {
        this.stopped = true;
    }
    sendWindowEvent(e: Record<string, unknown>) {
        this.sent.push(e);
    }
}

type Call = [string, ...unknown[]];

function fakeMemory(over: Record<string, unknown> = {}) {
    const calls: Call[] = [];
    const rec = (name: string) => (...args: unknown[]) => {
        calls.push([name, ...args]);
    };
    const mem = {
        calls,
        addFrame: rec('addFrame'),
        saveMaterial: rec('saveMaterial'),
        updateMaterialType: rec('updateMaterialType'),
        recordFocusSession: rec('recordFocusSession'),
        getMaterialWeights: async (h?: number) => {
            calls.push(['getMaterialWeights', h]);
            return { seeded: 0.4 } as Record<string, number>;
        },
        processMaterialOcr: async (id: string) => {
            calls.push(['processMaterialOcr', id]);
            return { ok: true, addedLines: 2, lineCount: 5, textLength: 40, preview: 'p', skipped: null };
        },
        getAllMaterials: async (l: number) => [{ materialId: 'x', l }],
        getMaterialFrames: async (id: string, l: number) => [{ id, l }],
        getMaterialLatestFrame: async (id: string) => ({ id }),
        getMaterialOcr: async (id: string) => ({ materialId: id, text: 't' }),
        getScreenshots: async (l: number, s: number) => [{ l, s }],
        getScreenshot: async (id: string) => ({ id }),
        freezeMemory: async () => true,
        unfreezeMemory: async () => true,
        isMemoryFrozen: async () => true,
        ...over,
    };
    return mem;
}

let lastClient: FakeMaterialClient | null = null;
const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (request: unknown, ...rest: unknown[]) {
    if (request === '@ausm/core/clients') {
        return {
            createMaterialClient: (opts: Record<string, unknown>) => (lastClient = new FakeMaterialClient(opts)),
        };
    }
    return origLoad.call(this, request, ...rest);
};

const quiet = () => {
    const saved = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = () => {};
    return () => Object.assign(console, saved);
};
let restoreConsole: (() => void) | null = null;
afterEach(() => {
    restoreConsole?.();
    restoreConsole = null;
});

async function setup(config: Record<string, unknown> = {}, memOver: Record<string, unknown> = {}) {
    restoreConsole = quiet();
    const runtime = new AUSMRuntime({ materialManager: { enabled: true, pythonPath: '/fake/python' }, ...config });
    const internals = runtime as unknown as {
        materialManagerImpl: {
            setMemoryClient(c: unknown): void;
            start(): Promise<void>;
            stop(): Promise<void>;
            isRunning(): boolean;
            handleWindowEvent(e: unknown): void;
        };
        materialDetector: { start(): void };
        memoryClient: unknown;
    };
    const mem = fakeMemory(memOver);
    internals.memoryClient = mem;
    internals.materialManagerImpl.setMemoryClient(mem);
    internals.materialDetector.start();
    const events: MaterialEvent[] = [];
    runtime.onMaterialEvent((e) => events.push(e));
    lastClient = null;
    await internals.materialManagerImpl.start();
    return { runtime, impl: internals.materialManagerImpl, mem, client: lastClient!, events };
}

const frameMsg = (over: Record<string, unknown> = {}) => ({
    frameId: 'f1', materialId: 'm1', windowId: 3, width: 4, height: 2, timestamp: 123,
    title: 'T', application: 'A', bundleId: 'b', captureReason: 'FOCUSED',
    dataBase64: Buffer.from('jpeg').toString('base64'), sizeBytes: 4, hash: 'hh', ...over,
});

// ── Tests ────────────────────────────────────────────────────────────────

test('disabled material manager does not create a client', async () => {
    restoreConsole = quiet();
    const runtime = new AUSMRuntime({});
    const impl = (runtime as unknown as { materialManagerImpl: { start(): Promise<void>; isRunning(): boolean } }).materialManagerImpl;
    lastClient = null;
    await impl.start();
    assert.equal(lastClient, null);
    assert.equal(impl.isRunning(), false);
});

test('start seeds the weight cache and passes config through', async () => {
    const { client, mem, impl } = await setup({
        materialManager: { enabled: true, pythonPath: '/p', dbPath: '/x y/db', captureIntervalMs: 5, materialBlacklist: { apps: ['Vault'] } },
    });
    assert.equal(impl.isRunning(), true);
    assert.equal(client.started, true);
    assert.equal(client.options.pythonPath, '/p');
    assert.equal(client.options.dbPath, '/x y/db');
    assert.deepEqual(client.options.materialBlacklist, { apps: ['Vault'] });
    assert.ok(mem.calls.some((c) => c[0] === 'getMaterialWeights'));
});

test('client start failure leaves the manager stopped (and window events are dropped)', async () => {
    restoreConsole = quiet();
    const runtime = new AUSMRuntime({ materialManager: { enabled: true, pythonPath: '/p' } });
    const impl = (runtime as unknown as { materialManagerImpl: { start(): Promise<void>; isRunning(): boolean; handleWindowEvent(e: unknown): void } }).materialManagerImpl;
    const orig = FakeMaterialClient.prototype.start;
    FakeMaterialClient.prototype.start = async function () { throw new Error('spawn failed'); };
    try {
        await impl.start();
    } finally {
        FakeMaterialClient.prototype.start = orig;
    }
    assert.equal(impl.isRunning(), false);
    impl.handleWindowEvent({ windowId: 1 });
    assert.equal(lastClient!.sent.length, 0);
});

test('material-frame → memory.addFrame (decoded data + hash) and FRAME_CAPTURED with cached weight', async () => {
    const { client, mem, events } = await setup();
    client.emit('material-frame', frameMsg({ materialId: 'seeded' }));
    const add = mem.calls.find((c) => c[0] === 'addFrame')!;
    const frame = add[1] as { data: Buffer; materialId: string; captureReason: string };
    assert.equal(frame.data.toString(), 'jpeg');
    assert.equal(frame.materialId, 'seeded');
    assert.equal(add[2], 'hh');
    const ev = events.find((e) => e.materialEventType === 'FRAME_CAPTURED')!;
    assert.equal(ev.focusWeight, 0.4);
    assert.equal(ev.frameSizeBytes, 4);
});

test('material-frame without data is not persisted; null hash becomes empty string; addFrame throwing is contained', async () => {
    const throwing = await setup({}, { addFrame: () => { throw new Error('EPIPE'); } });
    assert.doesNotThrow(() => throwing.client.emit('material-frame', frameMsg()));
    const { client, mem, events } = await setup();
    client.emit('material-frame', frameMsg({ dataBase64: undefined }));
    assert.equal(mem.calls.filter((c) => c[0] === 'addFrame').length, 0);
    assert.equal(events.length, 1, 'event still emitted');
    client.emit('material-frame', frameMsg({ hash: null }));
    assert.equal(mem.calls.find((c) => c[0] === 'addFrame')![2], '');
});

test('material-save / material-type-update are persisted; missing optional fields become null', async () => {
    const { client, mem } = await setup();
    client.emit('material-save', { materialId: 'm', title: '日本語 📄', windowId: 1, firstSeen: 1, lastSeen: 2 });
    client.emit('material-type-update', { materialId: 'm', materialType: 'code', materialTypeConfidence: 0.9 });
    const save = mem.calls.find((c) => c[0] === 'saveMaterial')![1] as Record<string, unknown>;
    assert.equal(save.title, '日本語 📄');
    assert.equal(save.application, null);
    assert.equal(save.appMetadata, null);
    assert.deepEqual(mem.calls.find((c) => c[0] === 'updateMaterialType')!.slice(1), ['m', 'code', 0.9]);
});

test('focus → unfocus records a focus session and refreshes weights', async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const { client, mem, events } = await setup();
    client.emit('material-focused', { materialId: 'm', windowId: 1, title: 'T' });
    now += 90_000;
    client.emit('material-unfocused', { materialId: 'm', windowId: 1, title: 'T' });
    const rec = mem.calls.find((c) => c[0] === 'recordFocusSession')![1] as Record<string, number>;
    assert.equal(rec.startedAt, 1_000_000);
    assert.equal(rec.endedAt, 1_090_000);
    assert.equal(rec.durationMs, 90_000);
    assert.ok(mem.calls.filter((c) => c[0] === 'getMaterialWeights').length >= 2);
    assert.deepEqual(events.map((e) => e.materialEventType), ['MATERIAL_FOCUSED', 'MATERIAL_UNFOCUSED']);
});

test('focus flickers (<500 ms), backwards clock and unfocus without focus record nothing', async (t) => {
    let now = 5_000_000;
    t.mock.method(Date, 'now', () => now);
    const { client, mem } = await setup();
    client.emit('material-focused', { materialId: 'a' });
    now += 499;
    client.emit('material-unfocused', { materialId: 'a' });
    client.emit('material-focused', { materialId: 'b' });
    now -= 60_000; // clock jumps backwards
    client.emit('material-unfocused', { materialId: 'b' });
    client.emit('material-unfocused', { materialId: 'never-focused' });
    client.emit('material-unfocused', { materialId: null });
    assert.equal(mem.calls.filter((c) => c[0] === 'recordFocusSession').length, 0);
});

test('live weight while focused grows with elapsed time; cached weight wins when non-zero', async (t) => {
    let now = 10_000_000;
    t.mock.method(Date, 'now', () => now);
    const { client, events } = await setup();
    client.emit('material-focused', { materialId: 'fresh' });
    client.emit('material-frame', frameMsg({ materialId: 'fresh' }));
    now += 30 * 60_000; // 30 minutes in
    client.emit('material-frame', frameMsg({ materialId: 'fresh' }));
    client.emit('material-frame', frameMsg({ materialId: 'unknown' }));
    const w = events.filter((e) => e.materialEventType === 'FRAME_CAPTURED').map((e) => e.focusWeight);
    assert.equal(w[0], null, '< 500 ms of focus → no estimate yet');
    assert.equal(w[1], Math.round((Math.log(1.5) / Math.log(2)) * 100) / 100);
    assert.equal(w[2], null);
});

test('unfocus triggers a delayed OCR pass and MATERIAL_CONTENT_UPDATED when lines were added', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, mem, events } = await setup({ memory: { ocrEnabled: true } });
    client.emit('material-unfocused', { materialId: 'm', title: 'T' });
    assert.equal(mem.calls.filter((c) => c[0] === 'processMaterialOcr').length, 0, 'delayed');
    t.mock.timers.tick(1500);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(mem.calls.find((c) => c[0] === 'processMaterialOcr'), ['processMaterialOcr', 'm']);
    const content = events.find((e) => e.materialEventType === 'MATERIAL_CONTENT_UPDATED')!;
    assert.equal(content.contentAddedLines, 2);
    assert.equal(content.contentLineCount, 5);
});

test('OCR disabled, no new lines, or OCR failure → no content event', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const off = await setup();
    off.client.emit('material-unfocused', { materialId: 'm' });
    t.mock.timers.tick(2000);
    assert.equal(off.mem.calls.filter((c) => c[0] === 'processMaterialOcr').length, 0);

    const none = await setup({ memory: { ocrEnabled: true } }, {
        processMaterialOcr: async () => ({ ok: true, addedLines: 0, lineCount: 1, textLength: 1, preview: '', skipped: null }),
    });
    none.client.emit('material-unfocused', { materialId: 'm' });
    t.mock.timers.tick(1500);
    await new Promise((r) => setImmediate(r));
    assert.equal(none.events.filter((e) => e.materialEventType === 'MATERIAL_CONTENT_UPDATED').length, 0);

    const fail = await setup({ memory: { ocrEnabled: true } }, {
        processMaterialOcr: async () => { throw new Error('OCR worker failed to start'); },
    });
    fail.client.emit('material-unfocused', { materialId: 'm' });
    t.mock.timers.tick(1500);
    await new Promise((r) => setImmediate(r));
    assert.equal(fail.events.filter((e) => e.materialEventType === 'MATERIAL_CONTENT_UPDATED').length, 0);
});

test('window events are forwarded only while running; stop() detaches the memory client', async () => {
    const { impl, client, runtime, mem } = await setup();
    impl.handleWindowEvent({ windowId: 9, state: 'FOCUSED' });
    assert.equal(client.sent.length, 1);
    await impl.stop();
    assert.equal(client.stopped, true);
    impl.handleWindowEvent({ windowId: 9, state: 'FOCUSED' });
    assert.equal(client.sent.length, 1);
    // queries through the manager now return empty defaults
    assert.deepEqual(await runtime.getMaterials(), []);
    assert.deepEqual(await runtime.getMaterialFrames('m'), []);
    assert.equal(await runtime.getMaterialLatestFrame('m'), null);
    assert.equal(await runtime.getMaterialContent('m'), null);
    // runtime-level queries still use the runtime's own memory client
    assert.deepEqual(await runtime.getScreenshots(5, 6), [{ l: 5, s: 6 }]);
    void mem;
});

test('runtime query methods pass arguments through and swallow memory errors', async () => {
    const ok = await setup();
    assert.deepEqual(await ok.runtime.getMaterials(7), [{ materialId: 'x', l: 7 }]);
    assert.deepEqual(await ok.runtime.getMaterialFrames('m', 3), [{ id: 'm', l: 3 }]);
    assert.deepEqual(await ok.runtime.getMaterialLatestFrame('m'), { id: 'm' });
    assert.deepEqual(await ok.runtime.getMaterialContent('m'), { materialId: 'm', text: 't' });
    assert.deepEqual(await ok.runtime.getScreenshot('s'), { id: 's' });
    assert.deepEqual(await ok.runtime.getMaterialWeights(3), { seeded: 0.4 });
    assert.equal(await ok.runtime.freezeMemory(), true);
    assert.equal(await ok.runtime.unfreezeMemory(), true);
    assert.equal(await ok.runtime.isMemoryFrozen(), true);

    const boom = async () => { throw new Error('Memory request timed out'); };
    const bad = await setup({}, {
        getAllMaterials: boom, getMaterialFrames: boom, getMaterialLatestFrame: boom, getMaterialOcr: boom,
        getScreenshots: boom, getScreenshot: boom, freezeMemory: boom, unfreezeMemory: boom, isMemoryFrozen: boom,
    });
    // weights seeding failed too? no — getMaterialWeights is fine; make it fail separately below
    assert.deepEqual(await bad.runtime.getMaterials(), []);
    assert.deepEqual(await bad.runtime.getMaterialFrames('m'), []);
    assert.equal(await bad.runtime.getMaterialLatestFrame('m'), null);
    assert.equal(await bad.runtime.getMaterialContent('m'), null);
    assert.deepEqual(await bad.runtime.getScreenshots(), []);
    assert.equal(await bad.runtime.getScreenshot('s'), null);
    assert.equal(await bad.runtime.freezeMemory(), false);
    assert.equal(await bad.runtime.unfreezeMemory(), false);
    assert.equal(await bad.runtime.isMemoryFrozen(), false);

    const noWeights = await setup({}, { getMaterialWeights: boom });
    assert.equal(noWeights.impl.isRunning(), true, 'weight seeding failure is not fatal');
    assert.deepEqual(await noWeights.runtime.getMaterialWeights(), {});
});

test('runtime without a memory client returns empty defaults', async () => {
    restoreConsole = quiet();
    const runtime = new AUSMRuntime({});
    assert.deepEqual(await runtime.getMaterials(), []);
    assert.deepEqual(await runtime.getScreenshots(), []);
    assert.equal(await runtime.getScreenshot('x'), null);
    assert.deepEqual(await runtime.getMaterialWeights(), {});
    assert.equal(await runtime.freezeMemory(), false);
    assert.equal(await runtime.unfreezeMemory(), false);
    assert.equal(await runtime.isMemoryFrozen(), false);
});
