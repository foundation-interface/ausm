import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { DetectorPipelineService, createDetectorPipeline } from '../detector-pipeline';
import type {
    ActivityEvent,
    DetectorEvaluateResult,
    DetectorModelClient,
    DetectorSpec,
    DetectorTriggerResult,
    PromptTrace,
} from '../types';
import { spec, blockNetwork, quietConsole } from './helpers';

// ── Fake model client ───────────────────────────────────────────────────────

interface EvalCall {
    specs: DetectorSpec[];
    events: ActivityEvent[];
    image: string | null;
    maxEvents?: number;
    context?: string | null;
    resolve: (triggered?: DetectorEvaluateResult['triggered'], latency?: number) => void;
    reject: (err: Error) => void;
}

type Triggered = DetectorEvaluateResult['triggered'][number];

function hit(name: string, extra: Partial<Triggered> = {}): Triggered {
    return { name, confidence: 0.9, summary: `${name} fired`, evidence: 'ev', suggestedDetectors: [], ...extra };
}

class FakeClient implements DetectorModelClient {
    calls: EvalCall[] = [];
    /** When set, every call resolves immediately with this result. */
    auto: ((call: EvalCall) => Triggered[]) | null = () => [];

    evaluate(specs: DetectorSpec[], events: ActivityEvent[], image: string | null, maxEvents?: number, context?: string | null): Promise<DetectorEvaluateResult> {
        return new Promise((res, rej) => {
            const call: EvalCall = {
                specs, events, image, maxEvents, context,
                resolve: (triggered = [], latency = 5) => res({
                    triggered, rawPrompt: 'prompt', rawResponse: 'response', modelLatencyMs: latency, parseMs: 0, promptBuildMs: 0, attempt: 0,
                }),
                reject: rej,
            };
            this.calls.push(call);
            if (this.auto) call.resolve(this.auto(call));
        });
    }
}

// ── Harness ─────────────────────────────────────────────────────────────────

const T0 = 1_800_000_000_000;
let restoreNet: () => void;
let restoreConsole: () => void;

beforeEach(() => {
    restoreNet = blockNetwork();
    restoreConsole = quietConsole();
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
});
afterEach(() => {
    mock.timers.reset();
    restoreConsole();
    restoreNet();
});

function makeService(config: Record<string, unknown> = {}): { svc: DetectorPipelineService; client: FakeClient; results: DetectorTriggerResult[]; errors: Error[] } {
    const svc = new DetectorPipelineService({ provider: 'cerebras', apiKey: 'test-key', ...config });
    assert.equal(svc.start(), true);
    const client = new FakeClient();
    (svc as any).client = client;
    const results: DetectorTriggerResult[] = [];
    const errors: Error[] = [];
    svc.on('detector-triggered', (r) => results.push(r));
    svc.on('error', (e) => errors.push(e));
    return { svc, client, results, errors };
}

/** Let promise chains (and sharp's thread-pool work) finish without advancing fake time. */
async function flush(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

async function until(cond: () => boolean, rounds = 500): Promise<void> {
    for (let i = 0; i < rounds && !cond(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(cond(), 'condition not reached');
}

function advance(ms: number): void {
    mock.timers.tick(ms);
}

// ── Lifecycle & config ──────────────────────────────────────────────────────

describe('lifecycle', () => {
    test('vertex without projectId fails to start and emits an error', () => {
        const svc = new DetectorPipelineService({});
        const errors: Error[] = [];
        svc.on('error', (e) => errors.push(e));
        assert.equal(svc.start(), false);
        assert.equal(svc.isRunning(), false);
        assert.match(errors[0].message, /TASK_DETECTOR_PROJECT_ID/);
    });

    test('cerebras without an API key (missing, empty or whitespace) fails to start', () => {
        for (const apiKey of [undefined, '', '   ']) {
            const svc = new DetectorPipelineService({ provider: 'cerebras', apiKey });
            const errors: Error[] = [];
            svc.on('error', (e) => errors.push(e));
            assert.equal(svc.start(), false);
            assert.match(errors[0].message, /CEREBRAS_API_KEY/);
        }
    });

    test('start failure without an error listener does not throw', () => {
        const svc = new DetectorPipelineService({ projectId: '  ' });
        assert.equal(svc.start(), false);
    });

    test('vertex with a projectId starts without touching the network', () => {
        const svc = new DetectorPipelineService({ projectId: 'p' });
        assert.equal(svc.start(), true);
        svc.cleanup();
    });

    test('start/stop are idempotent and emit status once each', () => {
        const svc = new DetectorPipelineService({ provider: 'cerebras', apiKey: 'k' });
        const statuses: string[] = [];
        svc.on('status', (s) => statuses.push(s));
        assert.equal(svc.start(), true);
        assert.equal(svc.start(), true);
        svc.stop();
        svc.stop();
        assert.deepEqual(statuses, ['started', 'stopped']);
        assert.equal(svc.isRunning(), false);
    });

    test('provider typo falls back to vertex', () => {
        const svc = new DetectorPipelineService({ provider: 'cerebrass' as any, apiKey: 'k' });
        assert.equal((svc as any).config.provider, 'vertex');
        assert.equal(svc.start(), false, 'vertex needs a projectId');
    });

    test('default models per provider; empty-string model/location fall back to defaults', () => {
        assert.equal((new DetectorPipelineService({}) as any).config.model, 'gemini-2.0-flash');
        assert.equal((new DetectorPipelineService({ provider: 'cerebras' }) as any).config.model, 'gemma-4-31b');
        const blank = new DetectorPipelineService({ model: '', location: '' }) as any;
        assert.equal(blank.config.model, 'gemini-2.0-flash');
        assert.equal(blank.config.location, 'global');
        assert.equal((new DetectorPipelineService({ model: 'custom' }) as any).config.model, 'custom');
    });

    test('createDetectorPipeline returns a service', () => {
        assert.ok(createDetectorPipeline({}) instanceof DetectorPipelineService);
    });

    test('cleanup clears detectors and listeners', () => {
        const { svc } = makeService();
        svc.addDetector(spec());
        svc.cleanup();
        assert.deepEqual(svc.getDetectors(), []);
        assert.equal(svc.listenerCount('detector-triggered'), 0);
        assert.equal(svc.isRunning(), false);
    });

    test('forceEvaluate before start returns [] without a client', async () => {
        const svc = new DetectorPipelineService({ provider: 'cerebras', apiKey: 'k' });
        svc.addDetector(spec());
        svc.pushEvent('custom', {}, false);
        assert.deepEqual(await svc.forceEvaluate(), []);
    });
});

// ── Detector management ─────────────────────────────────────────────────────

describe('detector management', () => {
    test('add, replace by name, remove', () => {
        const { svc } = makeService();
        svc.addDetector(spec({ name: 'a', body: 'one' }));
        svc.addDetector(spec({ name: 'a', body: 'two' }));
        svc.addDetector(spec({ name: 'b' }));
        assert.deepEqual(svc.getDetectors().map((d) => [d.name, d.body]), [['a', 'two'], ['b', spec().body]]);
        svc.removeDetector('a');
        svc.removeDetector('missing');
        assert.deepEqual(svc.getDetectors().map((d) => d.name), ['b']);
    });

    test('zero detectors: events schedule nothing and forceEvaluate returns []', async () => {
        const { svc, client } = makeService();
        svc.pushEvent('custom', { a: 1 });
        advance(60_000);
        await flush();
        assert.equal(client.calls.length, 0);
        assert.deepEqual(await svc.forceEvaluate(), []);
    });

    test('dispatchOnly detectors are never scheduled', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ dispatchOnly: true }));
        svc.pushEvent('custom', {});
        await flush();
        assert.equal(client.calls.length, 0);
        assert.deepEqual(await svc.forceEvaluate(), []);
    });
});

// ── Grouping ────────────────────────────────────────────────────────────────

describe('grouping', () => {
    test('100 detectors with the same requirements share one model call', async () => {
        const { svc, client } = makeService();
        for (let i = 0; i < 100; i++) svc.addDetector(spec({ name: `d${i}` }));
        svc.pushEvent('custom', {});
        await flush();
        assert.equal(client.calls.length, 1);
        assert.equal(client.calls[0].specs.length, 100);
    });

    test('100 isolated detectors each get their own call', async () => {
        const { svc, client } = makeService();
        for (let i = 0; i < 100; i++) svc.addDetector(spec({ name: `d${i}`, isolated: true }));
        svc.pushEvent('custom', {});
        await flush();
        assert.equal(client.calls.length, 100);
        assert.ok(client.calls.every((c) => c.specs.length === 1));
        assert.equal(new Set(client.calls.map((c) => c.specs[0].name)).size, 100);
    });

    test('source order does not matter; different event filters split groups', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ name: 'a', sources: ['events', 'screen'], events: ['x', 'y'] }));
        svc.addDetector(spec({ name: 'b', sources: ['screen', 'events'], events: ['y', 'x'] }));
        svc.addDetector(spec({ name: 'c', sources: ['events'], events: ['x'] }));
        svc.pushEvent('x', {});
        await flush();
        const groups = client.calls.map((c) => c.specs.map((s) => s.name).sort().join(',')).sort();
        assert.deepEqual(groups, ['a,b', 'c']);
    });

    test('an interval detector is not starved by sharing a group with a screen-triggered one', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ name: 'screeny', trigger: 'screen' }));
        svc.addDetector(spec({ name: 'periodic', trigger: 'interval' }));
        svc.pushEvent('custom', {});
        await flush();
        assert.equal(client.calls.length, 1);
        assert.deepEqual(client.calls[0].specs.map((s) => s.name), ['periodic']);
    });

    test('event filter: each group only sees its event types; an unfiltered member disables the filter', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ name: 'only-x', events: ['x'] }));
        svc.addDetector(spec({ name: 'all', isolated: true }));
        svc.pushEvent('x', { n: 1 }, false);
        svc.pushEvent('y', { n: 2 });
        await flush();
        const byName = Object.fromEntries(client.calls.map((c) => [c.specs[0].name, c.events.map((e) => e.eventType)]));
        assert.deepEqual(byName['only-x'], ['x']);
        assert.deepEqual(byName['all'], ['x', 'y']);
    });
});

// ── Scheduling ──────────────────────────────────────────────────────────────

describe('scheduling', () => {
    test('debounce 0 evaluates immediately on a scheduling event', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec());
        svc.pushEvent('custom', {});
        await flush();
        assert.equal(client.calls.length, 1);
    });

    test('schedule=false buffers without evaluating; the next scheduling event includes the buffered ones', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec());
        svc.pushEvent('a', {}, false);
        svc.pushEvent('b', {}, false);
        await flush();
        assert.equal(client.calls.length, 0);
        svc.pushEvent('c', {});
        await flush();
        assert.deepEqual(client.calls[0].events.map((e) => e.eventType), ['a', 'b', 'c']);
    });

    test('throttle-with-trailing: one evaluation per debounce window, not reset by later events', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ debounceMs: 1000, intervalMs: 0 }));
        svc.pushEvent('e', { n: 1 });
        advance(600);
        svc.pushEvent('e', { n: 2 });
        advance(399);
        await flush();
        assert.equal(client.calls.length, 0);
        advance(1);
        await flush();
        assert.equal(client.calls.length, 1, 'fires 1000ms after the first event');
        assert.deepEqual(client.calls[0].events.map((e) => e.n), [1, 2]);

        // A later burst gets a fresh window.
        svc.pushEvent('e', { n: 3 });
        advance(1000);
        await flush();
        assert.equal(client.calls.length, 2);
        assert.deepEqual(client.calls[1].events.map((e) => e.n), [3]);
    });

    test('trailing timer for an event arriving inside the window', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ debounceMs: 1000 }));
        svc.pushEvent('e', { n: 1 });
        advance(1000);
        await flush();
        assert.equal(client.calls.length, 1);
        advance(200);
        svc.pushEvent('e', { n: 2 });
        // lastScheduled was at t=0, so the window has already elapsed: fresh full window.
        advance(999);
        await flush();
        assert.equal(client.calls.length, 1);
        advance(1);
        await flush();
        assert.equal(client.calls.length, 2);
    });

    test('the smallest debounce in a group wins', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ name: 'slow', debounceMs: 5000 }));
        svc.addDetector(spec({ name: 'fast', debounceMs: 100 }));
        svc.pushEvent('e', {});
        advance(100);
        await flush();
        assert.equal(client.calls.length, 1);
        assert.equal(client.calls[0].specs.length, 2);
    });

    test('trigger: screen groups are not scheduled by events or frames, only by forceEvaluate', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ name: 's', trigger: 'screen', sources: ['screen'] }));
        svc.onScreenFrameAvailable('A'.repeat(100));
        svc.pushEvent('e', {});
        advance(60_000);
        await flush();
        assert.equal(client.calls.length, 0);
        await svc.forceEvaluate();
        assert.equal(client.calls.length, 1);
        assert.equal(client.calls[0].maxEvents, 20, 'screen-only groups cap events at 20');
    });

    test('interval gating: not re-evaluated before intervalMs, evaluable at exactly intervalMs', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ intervalMs: 1000 }));
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls.length, 1);
        advance(999);
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls.length, 1);
        advance(1);
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls.length, 2);
    });

    test('cooldown boundary: blocked at cooldown-1ms, evaluable at exactly cooldownMs', async () => {
        const { svc, client, results } = makeService();
        client.auto = () => [hit('det')];
        svc.addDetector(spec({ cooldownMs: 5000 }));
        svc.pushEvent('e', {});
        await flush();
        assert.equal(results.length, 1);
        advance(4999);
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls.length, 1);
        advance(1);
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls.length, 2);
    });

    test('a trigger recorded at epoch 0 (injected clock) still starts the cooldown', async () => {
        mock.timers.setTime(0);
        const { svc, client } = makeService();
        client.auto = () => [hit('det')];
        svc.addDetector(spec({ cooldownMs: 1000 }));
        svc.pushEvent('e', {});
        await flush();
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls.length, 1);
    });

    test('clock skew backwards keeps the cooldown in force until the clock catches up', async () => {
        const { svc, client } = makeService();
        client.auto = () => [hit('det')];
        svc.addDetector(spec({ cooldownMs: 1000 }));
        svc.pushEvent('e', {});
        await flush();
        mock.timers.setTime(T0 - 10_000);
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls.length, 1);
        mock.timers.setTime(T0 + 1000);
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls.length, 2);
    });

    test('stop() cancels pending timers: nothing fires during/after shutdown', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ debounceMs: 500 }));
        svc.pushEvent('e', {});
        svc.stop();
        advance(10_000);
        await flush();
        assert.equal(client.calls.length, 0);
        svc.pushEvent('e', {});
        advance(10_000);
        await flush();
        assert.equal(client.calls.length, 0, 'stopped service does not schedule');
    });

    test('cleanup() during a pending timer prevents evaluation', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ debounceMs: 500 }));
        svc.pushEvent('e', {});
        svc.cleanup();
        advance(10_000);
        await flush();
        assert.equal(client.calls.length, 0);
    });

    test('a pending timer re-checks evaluability: removed detectors are not sent to the model', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ name: 'keep', debounceMs: 500 }));
        svc.addDetector(spec({ name: 'gone', debounceMs: 500 }));
        svc.pushEvent('e', {});
        svc.removeDetector('gone');
        advance(500);
        await flush();
        assert.equal(client.calls.length, 1);
        assert.deepEqual(client.calls[0].specs.map((s) => s.name), ['keep']);
    });

    test('removing an isolated detector cancels its pending timer', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ name: 'iso', isolated: true, debounceMs: 500 }));
        svc.pushEvent('e', {});
        assert.equal((svc as any).groupTimers.size, 1);
        svc.removeDetector('iso');
        assert.equal((svc as any).groupTimers.size, 0);
        advance(500);
        await flush();
        assert.equal(client.calls.length, 0);
    });

    test('a pending timer respects a cooldown started by forceEvaluate in the meantime', async () => {
        const { svc, client, results } = makeService();
        client.auto = () => [hit('det')];
        svc.addDetector(spec({ debounceMs: 500, cooldownMs: 60_000 }));
        svc.pushEvent('e', {});
        await svc.forceEvaluate();
        assert.equal(results.length, 1);
        advance(500);
        await flush();
        assert.equal(client.calls.length, 1, 'timer must not re-evaluate inside the cooldown');
        assert.equal(results.length, 1);
    });

    test('rate-limit errors double the debounce (capped at 16x); success halves it', async () => {
        const { svc, client, errors } = makeService();
        client.auto = null;
        svc.addDetector(spec({ debounceMs: 100 }));
        const key = 'events|*|interval';

        const failOnce = async () => {
            svc.pushEvent('e', {});
            const before = client.calls.length;
            advance(100 * ((svc as any).groupBackoff.get(key) ?? 1));
            await until(() => client.calls.length > before);
            client.calls[client.calls.length - 1].reject(new Error('Cerebras HTTP 429: slow down'));
            await flush();
        };
        for (let i = 0; i < 6; i++) await failOnce();
        assert.equal((svc as any).groupBackoff.get(key), 16);
        assert.equal(errors.length, 6);

        svc.pushEvent('e', {});
        advance(1599);
        await flush();
        const n = client.calls.length;
        advance(1);
        await until(() => client.calls.length > n);
        client.calls[client.calls.length - 1].resolve([]);
        await flush();
        assert.equal((svc as any).groupBackoff.get(key), 8);
    });

    test('non-rate-limit errors are emitted but do not change backoff', async () => {
        const { svc, client, errors } = makeService();
        client.auto = null;
        svc.addDetector(spec());
        svc.pushEvent('e', {});
        await flush();
        client.calls[0].reject(new Error('boom'));
        await flush();
        assert.equal(errors[0].message, 'boom');
        assert.equal((svc as any).groupBackoff.size, 0);
    });

    test('errors with no error listener are logged, not thrown', async () => {
        const svc = new DetectorPipelineService({ provider: 'cerebras', apiKey: 'k' });
        svc.start();
        const client = new FakeClient();
        client.auto = null;
        (svc as any).client = client;
        svc.addDetector(spec());
        svc.pushEvent('e', {});
        await flush();
        client.calls[0].reject(new Error('boom'));
        await flush();
        svc.cleanup();
    });
});

// ── Overlap & concurrency ───────────────────────────────────────────────────

describe('overlap and concurrency', () => {
    test('model latency longer than the interval: overlapping evaluations both run', async () => {
        const { svc, client } = makeService();
        client.auto = null;
        svc.addDetector(spec({ intervalMs: 100 }));
        svc.pushEvent('e', { n: 1 });
        await flush();
        advance(100);
        svc.pushEvent('e', { n: 2 });
        await flush();
        assert.equal(client.calls.length, 2);
        assert.deepEqual(client.calls[1].events.map((e) => e.n), [2], 'second call only sees new events');
    });

    test('an older evaluation finishing after a newer one is discarded (no stale results)', async () => {
        const { svc, client, results } = makeService();
        client.auto = null;
        svc.addDetector(spec());
        svc.pushEvent('e', {});
        await flush();
        advance(10);
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls.length, 2);
        client.calls[1].resolve([hit('det', { summary: 'new' })]);
        await flush();
        client.calls[0].resolve([hit('det', { summary: 'old' })]);
        await flush();
        assert.deepEqual(results.map((r) => r.summary), ['new']);
    });

    test('in-order completion emits both results', async () => {
        const { svc, client, results } = makeService();
        client.auto = null;
        svc.addDetector(spec());
        svc.pushEvent('e', {});
        await flush();
        svc.pushEvent('e', {});
        await flush();
        client.calls[0].resolve([hit('det', { summary: 'first' })]);
        await flush();
        client.calls[1].resolve([hit('det', { summary: 'second' })]);
        await flush();
        assert.deepEqual(results.map((r) => r.summary), ['first', 'second']);
    });

    test('maxConcurrentEvals limits in-flight calls; queued calls start FIFO', async () => {
        const { svc, client } = makeService({ maxConcurrentEvals: 2 });
        client.auto = null;
        for (let i = 0; i < 5; i++) svc.addDetector(spec({ name: `d${i}`, isolated: true }));
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls.length, 2);
        client.calls[0].resolve([]);
        await flush();
        assert.equal(client.calls.length, 3);
        client.calls[1].resolve([]);
        client.calls[2].resolve([]);
        await flush();
        assert.equal(client.calls.length, 5);
        assert.deepEqual(client.calls.map((c) => c.specs[0].name), ['d0', 'd1', 'd2', 'd3', 'd4']);
    });

    test('after the queue drains, all slots are free again (no permanent slot leak / deadlock)', async () => {
        const { svc, client } = makeService({ maxConcurrentEvals: 2 });
        client.auto = null;
        for (let i = 0; i < 5; i++) svc.addDetector(spec({ name: `d${i}`, isolated: true }));
        svc.pushEvent('e', {});
        await flush();
        for (let i = 0; i < 5; i++) {
            await until(() => client.calls.length > i);
            client.calls[i].resolve([]);
            await flush();
        }
        assert.equal((svc as any).evalInFlight, 0);
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls.length, 7, 'new evaluations still get slots');
    });

    test('cleanup while calls are queued resolves the waiters instead of hanging', async () => {
        const { svc, client } = makeService({ maxConcurrentEvals: 1 });
        client.auto = null;
        svc.addDetector(spec({ name: 'a', isolated: true }));
        svc.addDetector(spec({ name: 'b', isolated: true }));
        svc.pushEvent('e', {}, false);
        const forced = svc.forceEvaluate();
        await flush();
        assert.equal(client.calls.length, 1);
        svc.cleanup();
        client.calls[0].resolve([]);
        const out = await forced;
        assert.deepEqual(out, []);
        assert.equal(client.calls.length, 1, 'the queued call never reached the model');
    });

    test('cleanup with evaluations in flight never drives the slot counter negative', async () => {
        const { svc, client } = makeService({ maxConcurrentEvals: 1 });
        client.auto = null;
        svc.addDetector(spec());
        svc.pushEvent('e', {});
        await flush();
        const pending = client.calls[0];
        svc.cleanup();
        pending.resolve([]);
        await flush();
        assert.ok((svc as any).evalInFlight >= 0);
    });
});

// ── Event buffer & focus ────────────────────────────────────────────────────

describe('event buffer and focus', () => {
    test('buffer keeps only the newest maxEventBufferSize events', async () => {
        const { svc, client } = makeService({ maxEventBufferSize: 5 });
        svc.addDetector(spec());
        for (let i = 0; i < 12; i++) svc.pushEvent('e', { n: i }, false);
        await svc.forceEvaluate();
        assert.deepEqual(client.calls[0].events.map((e) => e.n), [7, 8, 9, 10, 11]);
    });

    test('events older than maxEventAgeMs are pruned (boundary inclusive)', async () => {
        const { svc, client } = makeService({ maxEventAgeMs: 1000 });
        svc.addDetector(spec());
        svc.pushEvent('e', { n: 'old' }, false);
        advance(1);
        svc.pushEvent('e', { n: 'edge' }, false);
        advance(1000);
        await svc.forceEvaluate();
        assert.deepEqual(client.calls[0].events.map((e) => e.n), ['edge']);
    });

    test('no events and no frame: no model call', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ sources: ['screen'] }));
        assert.deepEqual(await svc.forceEvaluate(), []);
        assert.equal(client.calls.length, 0, 'sources:[screen] with no frame is skipped');
    });

    test('events-only detectors never receive a frame', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ sources: ['events'] }));
        svc.onScreenFrameAvailable('Z'.repeat(200));
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls[0].image, null);
    });

    test('screen-only detectors receive no events', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ sources: ['screen'] }));
        svc.onScreenFrameAvailable('not-an-image-'.repeat(20));
        svc.pushEvent('e', {});
        await until(() => client.calls.length === 1);
        assert.deepEqual(client.calls[0].events, []);
        assert.ok(client.calls[0].image, 'undecodable frame falls back to the raw data');
    });

    test('events are delivered to a group once', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec());
        svc.pushEvent('e', { n: 1 });
        await flush();
        await svc.forceEvaluate();
        assert.equal(client.calls.length, 1, 'second evaluation has nothing new');
    });

    test('each group has its own cursor: one group evaluating does not consume another group\'s events', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ name: 'wx', events: ['x'], debounceMs: 100 }));
        svc.addDetector(spec({ name: 'wy', events: ['y'], debounceMs: 300 }));
        svc.pushEvent('x', {}, false);
        svc.pushEvent('y', {});
        advance(100);
        await flush();
        advance(200);
        await flush();
        const byName = Object.fromEntries(client.calls.map((c) => [c.specs[0].name, c.events.map((e) => e.eventType)]));
        assert.deepEqual(byName, { wx: ['x'], wy: ['y'] });
    });

    test('events pushed in the same millisecond as an evaluation are not lost', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ intervalMs: 0 }));
        svc.pushEvent('e', { n: 1 });
        await flush();
        svc.pushEvent('e', { n: 2 }); // same fake millisecond
        await flush();
        const seen = client.calls.flatMap((c) => c.events.map((e) => e.n));
        assert.deepEqual(seen, [1, 2]);
    });

    test('summary fields cannot override eventType/timestamp', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ events: ['text-input'] }));
        svc.pushEvent('text-input', { eventType: 'spoof', timestamp: undefined, status: 'TYPING' });
        await flush();
        assert.equal(client.calls.length, 1);
        assert.equal(client.calls[0].events[0].eventType, 'text-input');
        assert.equal(client.calls[0].events[0].timestamp, T0);
    });

    test('focus-aware filtering of app-scoped events', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec());
        svc.pushEvent('window-state', { state: 'FOCUSED', application: 'Editor', bundleId: 'com.editor', title: 'Doc' }, false);
        svc.pushEvent('text-input', { application: 'Chat' }, false);        // other app → dropped
        svc.pushEvent('text-input', { application: 'Editor' }, false);      // focused app name → kept
        svc.pushEvent('cursor', { application: 'com.editor' }, false);      // focused bundle → kept
        svc.pushEvent('copy-paste', {}, false);                             // no app → kept
        svc.pushEvent('material', { application: 'Chat' }, false);          // not app-scoped → kept
        svc.pushEvent('text-selection', { application: 'Chat' });           // dropped
        await flush();
        const evs = client.calls[0].events.map((e) => `${e.eventType}:${e.application ?? '-'}`);
        assert.deepEqual(evs, ['window-state:Editor', 'text-input:Editor', 'cursor:com.editor', 'copy-paste:-', 'material:Chat']);
    });

    test('non-FOCUSED window events and non-string fields do not change focus', async () => {
        const { svc, client } = makeService();
        client.auto = () => [hit('det')];
        const results: DetectorTriggerResult[] = [];
        svc.on('detector-triggered', (r) => results.push(r));
        svc.addDetector(spec());
        svc.pushEvent('window-state', { state: 'FOCUSED', application: 'A', bundleId: 'com.a', title: 'T' }, false);
        svc.pushEvent('window-state', { state: 'BLUR', application: 'B' }, false);
        svc.pushEvent('window-state', { state: 'FOCUSED', application: 42, title: null }, false);
        svc.pushEvent('material', { focusWeight: 0.25 });
        await flush();
        assert.equal(results[0].application, 'A');
        assert.equal(results[0].bundleId, 'com.a');
        assert.equal(results[0].windowTitle, 'T');
        assert.equal(results[0].focusWeight, 0.25);
    });
});

// ── Results ─────────────────────────────────────────────────────────────────

describe('results', () => {
    test('maps triggered items into DetectorTriggerResults', async () => {
        const { svc, client, results } = makeService();
        client.auto = null;
        svc.setEvaluationContext('ctx-1');
        svc.addDetector(spec({ name: 'det', event: 'my-event' }));
        svc.pushEvent('e', {});
        await flush();
        assert.equal(client.calls[0].context, 'ctx-1');
        assert.equal(client.calls[0].maxEvents, undefined);
        advance(250);
        client.calls[0].resolve([hit('det', { taskAction: 'begin', taskLabel: 'L', taskDescription: 'D' })], 250);
        await flush();
        const r = results[0];
        assert.equal(r.detectorName, 'det');
        assert.equal(r.eventType, 'my-event');
        assert.equal(r.confidence, 0.9);
        assert.equal(r.timestamp, T0 + 250);
        assert.equal(r.requestTimestamp, T0);
        assert.equal(r.responseTimestamp, T0 + 250);
        assert.equal(r.modelLatencyMs, 250);
        assert.equal(r.suggestedDetectors, undefined);
        assert.deepEqual([r.taskAction, r.taskLabel, r.taskDescription], ['begin', 'L', 'D']);
        assert.equal(r.rawPrompt, 'prompt');
        assert.equal(r.rawModelResponse, 'response');
        assert.equal(r.application, null);
    });

    test('unknown detector names in the model output are ignored', async () => {
        const { svc, client, results } = makeService();
        client.auto = () => [hit('ghost'), hit('det')];
        svc.addDetector(spec());
        const forced = await (async () => { svc.pushEvent('e', {}, false); return svc.forceEvaluate(); })();
        assert.deepEqual(forced.map((r) => r.detectorName), ['det']);
        assert.deepEqual(results.map((r) => r.detectorName), ['det']);
    });

    test('a detector removed while its evaluation is in flight produces no result', async () => {
        const { svc, client, results } = makeService();
        client.auto = null;
        svc.addDetector(spec());
        svc.pushEvent('e', {});
        await flush();
        svc.removeDetector('det');
        client.calls[0].resolve([hit('det')]);
        await flush();
        assert.equal(results.length, 0);
    });

    test('suggested detectors are dispatched once with the same frame, bypassing dispatchOnly', async () => {
        const { svc, client, results } = makeService();
        client.auto = (call) => call.specs[0].name === 'a'
            ? [hit('a', { suggestedDetectors: ['b', 'nope'] })]
            : [hit('b', { suggestedDetectors: ['a'] })];
        svc.addDetector(spec({ name: 'a', sources: ['screen', 'events'] }));
        svc.addDetector(spec({ name: 'b', sources: ['screen'], dispatchOnly: true }));
        svc.onScreenFrameAvailable('frame-data-'.repeat(20));
        svc.pushEvent('e', {});
        await until(() => results.length === 2);
        await flush();
        assert.deepEqual(results.map((r) => r.detectorName), ['a', 'b']);
        assert.equal(client.calls.length, 2, 'b suggesting a does not loop');
        assert.equal(client.calls[1].image, client.calls[0].image);
        assert.deepEqual(results[0].suggestedDetectors, ['b', 'nope']);
    });

    test('no dispatch after the service is stopped', async () => {
        const { svc, client } = makeService();
        client.auto = null;
        svc.addDetector(spec({ name: 'a' }));
        svc.addDetector(spec({ name: 'b', dispatchOnly: true }));
        svc.pushEvent('e', {});
        await flush();
        svc.stop();
        client.calls[0].resolve([hit('a', { suggestedDetectors: ['b'] })]);
        await flush();
        assert.equal(client.calls.length, 1);
    });

    test('forceEvaluate returns results from all groups', async () => {
        const { svc, client } = makeService();
        client.auto = (call) => call.specs.map((s) => hit(s.name));
        svc.addDetector(spec({ name: 'a', isolated: true }));
        svc.addDetector(spec({ name: 'b', isolated: true }));
        svc.pushEvent('e', {}, false);
        const out = await svc.forceEvaluate();
        assert.deepEqual(out.map((r) => r.detectorName).sort(), ['a', 'b']);
    });
});

// ── Frames ──────────────────────────────────────────────────────────────────

describe('frames', () => {
    test('duplicate frames (same fingerprint) are ignored', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ trigger: 'screen', sources: ['screen'] }));
        const frame = 'Q'.repeat(500);
        svc.onScreenFrameAvailable(frame);
        await svc.forceEvaluate();
        advance(10);
        svc.onScreenFrameAvailable(frame);
        await svc.forceEvaluate();
        assert.equal(client.calls.length, 1, 'same frame does not make a screen detector evaluable again');
        assert.equal((svc as any).duplicateFrameCount, 1);
        advance(10);
        svc.onScreenFrameAvailable('R'.repeat(500));
        await svc.forceEvaluate();
        assert.equal(client.calls.length, 2);
    });

    test('short frames (<64 chars) fingerprint by length only', () => {
        const { svc } = makeService();
        svc.onScreenFrameAvailable('abc');
        svc.onScreenFrameAvailable('xyz');
        assert.equal((svc as any).duplicateFrameCount, 1);
    });

    test('large frames are downsampled to a JPEG within maxScreenshotDimension', async () => {
        const { svc, client } = makeService({ maxScreenshotDimension: 256 });
        svc.addDetector(spec({ sources: ['screen'] }));
        const png = await sharp({ create: { width: 1200, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
        svc.onScreenFrameAvailable(png.toString('base64'));
        mock.timers.reset(); // sharp + forceEvaluate need real scheduling for this one
        await svc.forceEvaluate();
        const meta = await sharp(Buffer.from(client.calls[0].image!, 'base64')).metadata();
        assert.equal(meta.format, 'jpeg');
        assert.equal(meta.width, 256);
        assert.equal(meta.height, 128);
    });

    test('a JPEG that already fits is passed through unchanged', async () => {
        const { svc, client } = makeService();
        svc.addDetector(spec({ sources: ['screen'] }));
        const jpeg = (await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).jpeg().toBuffer()).toString('base64');
        svc.onScreenFrameAvailable(jpeg);
        mock.timers.reset();
        await svc.forceEvaluate();
        assert.equal(client.calls[0].image, jpeg);
    });

    test('downsample cache: the same frame is resized once across evaluations', async () => {
        const { svc, client } = makeService({ maxScreenshotDimension: 32 });
        svc.addDetector(spec({ name: 'a', sources: ['screen'], isolated: true }));
        svc.addDetector(spec({ name: 'b', sources: ['screen'], isolated: true }));
        const png = (await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000' } }).png().toBuffer()).toString('base64');
        svc.onScreenFrameAvailable(png);
        mock.timers.reset();
        await svc.forceEvaluate();
        assert.equal(client.calls.length, 2);
        assert.equal(client.calls[0].image, client.calls[1].image);
        assert.ok((svc as any).downsampleCache.size <= 1);
    });
});

// ── End-to-end with the real Cerebras client and a fake fetch ───────────────

describe('end to end (fake fetch)', () => {
    test('prompt-trace and detector-triggered flow from a fake HTTP response', async () => {
        mock.timers.reset();
        const realFetch = globalThis.fetch;
        const bodies: any[] = [];
        globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ choices: [{ message: { content: '{"triggered":[{"name":"det","confidence":0.7,"summary":"ok","evidence":"e"}]}' } }] }));
        }) as typeof fetch;
        try {
            const svc = new DetectorPipelineService({ provider: 'cerebras', apiKey: 'fake', apiBaseUrl: 'http://fake.invalid/v1' });
            const traces: PromptTrace[] = [];
            const results: DetectorTriggerResult[] = [];
            svc.on('prompt-trace', (t) => traces.push(t));
            svc.on('detector-triggered', (r) => results.push(r));
            assert.equal(svc.start(), true);
            svc.addDetector(spec());
            svc.pushEvent('e', {});
            await until(() => results.length === 1);
            assert.equal(traces.length, 1);
            assert.equal(bodies[0].model, 'gemma-4-31b');
            assert.equal(results[0].summary, 'ok');
            svc.cleanup();
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});
