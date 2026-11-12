import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { DetectorPipelineClient, createDetectorPipelineClient, type DetectorPipelineClientResult } from '../src/runtime/clients/detector-pipeline-client';

const realFetch = globalThis.fetch;
let saved: { log: typeof console.log; error: typeof console.error };
beforeEach(() => {
    globalThis.fetch = (async () => { throw new Error('network access is blocked in tests'); }) as typeof fetch;
    saved = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
});
afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = saved.log;
    console.error = saved.error;
});

function make() {
    const client = createDetectorPipelineClient({ provider: 'cerebras', apiKey: 'fake', apiBaseUrl: 'http://fake.invalid' });
    const service = (client as any).service;
    const pushes: Array<[string, Record<string, unknown>, boolean | undefined]> = [];
    service.pushEvent = (type: string, summary: Record<string, unknown>, schedule?: boolean) => pushes.push([type, summary, schedule]);
    return { client, service, pushes };
}

const serviceResult = (over: Record<string, unknown> = {}) => ({
    detectorName: 'd', eventType: 'e', confidence: 0.5, summary: 's', evidence: 'ev', timestamp: 1, requestTimestamp: 0, responseTimestamp: 1,
    ...over,
});

describe('DetectorPipelineClient', () => {
    test('passes provider options through to the service config', () => {
        const c = new DetectorPipelineClient({ provider: 'vertex', projectId: 'p', location: 'l', model: 'm', debug: true });
        const cfg = (c as any).service.config;
        assert.deepEqual([cfg.provider, cfg.projectId, cfg.location, cfg.model, cfg.debug, cfg.maxConcurrentEvals], ['vertex', 'p', 'l', 'm', true, 16]);
        c.cleanup();
    });

    test('start succeeds with credentials, is idempotent, and stop/cleanup are safe to repeat', () => {
        const { client } = make();
        const statuses: string[] = [];
        client.on('status', (s) => statuses.push(s));
        assert.equal(client.start(), true);
        assert.equal(client.start(), true);
        assert.equal(client.isRunning(), true);
        assert.equal(client.stop(), true);
        assert.equal(client.stop(), true);
        client.cleanup();
        client.cleanup();
        assert.deepEqual(statuses, ['started', 'stopped']);
    });

    test('start fails without credentials and reports why', () => {
        const client = new DetectorPipelineClient({ provider: 'cerebras' });
        const errors: Error[] = [];
        client.on('error', (e) => errors.push(e));
        assert.equal(client.start(), false);
        assert.equal(client.isRunning(), false);
        assert.match(errors[0].message, /CEREBRAS_API_KEY/);
    });

    test('maps service results to client results with null defaults', () => {
        const { client, service } = make();
        client.start();
        const got: DetectorPipelineClientResult[] = [];
        client.on('detector-triggered', (r) => got.push(r));
        service.emit('detector-triggered', serviceResult());
        assert.equal(got.length, 1);
        assert.deepEqual(
            [got[0].application, got[0].bundleId, got[0].windowTitle, got[0].focusWeight, got[0].rawPrompt, got[0].taskAction, got[0].modelLatencyMs],
            [null, null, null, null, null, null, null],
        );
        service.emit('detector-triggered', serviceResult({ application: 'A', taskLabel: 'L', modelLatencyMs: 9, suggestedDetectors: ['x'] }));
        assert.equal(got[1].application, 'A');
        assert.equal(got[1].taskLabel, 'L');
        assert.equal(got[1].modelLatencyMs, 9);
        assert.deepEqual(got[1].suggestedDetectors, ['x']);
    });

    test('results arriving while stopped are dropped', () => {
        const { client, service } = make();
        const got: unknown[] = [];
        client.on('detector-triggered', (r) => got.push(r));
        service.emit('detector-triggered', serviceResult());
        client.start();
        client.stop();
        service.emit('detector-triggered', serviceResult());
        assert.equal(got.length, 0);
    });

    test('errors and prompt traces are forwarded', () => {
        const { client, service } = make();
        const errs: Error[] = [];
        const traces: unknown[] = [];
        client.on('error', (e) => errs.push(e));
        client.on('prompt-trace', (t) => traces.push(t));
        service.emit('error', new Error('x'));
        service.emit('prompt-trace', { traceId: 't' });
        assert.equal(errs[0].message, 'x');
        assert.equal(traces.length, 1);
    });

    test('push helpers buffer without scheduling; material and generic events schedule', () => {
        const { client, pushes } = make();
        client.pushTextInputEvent({ status: 'TYPING' });
        client.pushWindowStateEvent({ state: 'FOCUSED' });
        client.pushTextSelectionEvent({ selectedText: 't' });
        client.pushCursorEvent({ action: 'CLICK' });
        client.pushCopyPasteEvent({ action: 'COPY' });
        client.pushScreenshotEvent({ status: 'FINISHED' });
        client.pushTextHighlightEvent({ stage: 'END' });
        client.pushMaterialEvent({ type: 'FRAME_CAPTURED' });
        client.pushEvent('custom', { a: 1 });
        assert.deepEqual(pushes.map(([t, , s]) => [t, s]), [
            ['text-input', false], ['window-state', false], ['text-selection', false], ['cursor', false], ['copy-paste', false],
            ['screenshot', false], ['text-highlight', false], ['material', undefined], ['custom', undefined],
        ]);
    });

    test('cursor moves are thinned to every third; other actions always pass', () => {
        const { client, pushes } = make();
        for (let i = 0; i < 9; i++) client.pushCursorEvent({ action: 'move', x: i });
        client.pushCursorEvent({ action: 'CLICK' });
        assert.deepEqual(pushes.map(([, s]) => s.x ?? s.action), [2, 5, 8, 'CLICK']);
    });

    test('detector management and frame/context pass through', () => {
        const { client, service } = make();
        const spec = { name: 'a', description: 'd', event: 'e', body: 'b', cooldownMs: 0, intervalMs: 0, debounceMs: 0, trigger: 'interval' as const, sources: ['events' as const] };
        client.addDetector(spec);
        assert.deepEqual(client.getDetectors().map((d) => d.name), ['a']);
        client.removeDetector('a');
        assert.deepEqual(client.getDetectors(), []);
        client.setEvaluationContext('ctx');
        assert.equal(service.evaluationContext, 'ctx');
        client.onScreenFrameAvailable('F'.repeat(100));
        assert.equal(service.latestRawFrame, 'F'.repeat(100));
    });

    test('cleanup removes listeners', () => {
        const { client } = make();
        client.on('error', () => {});
        client.cleanup();
        assert.equal(client.listenerCount('error'), 0);
    });
});
