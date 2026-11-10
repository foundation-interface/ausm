import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { VertexDetectorClient } from '../vertex-client';
import { DETECTOR_PIPELINE_SYSTEM_PROMPT } from '../prompts';
import type { PromptTrace } from '../types';
import { spec, event, blockNetwork } from './helpers';

type Generate = (req: any) => Promise<any>;

let restoreNet: () => void;
beforeEach(() => {
    restoreNet = blockNetwork();
    mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => {
    mock.timers.reset();
    restoreNet();
});

async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 100 && !done; i++) {
        await new Promise((r) => setImmediate(r));
        mock.timers.tick(60_000);
    }
    return p;
}

function client(generate: Generate, onTrace?: (t: PromptTrace) => void): { c: VertexDetectorClient; requests: any[] } {
    const requests: any[] = [];
    const c = new VertexDetectorClient({ projectId: 'test-project', location: 'global', model: 'gemini-test', onTrace });
    (c as any).ai = { models: { generateContent: (req: any) => { requests.push(req); return generate(req); } } };
    return { c, requests };
}

const text = (t: string) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });
const OK = '{"triggered":[{"name":"det","confidence":0.6,"summary":"s","evidence":"e","suggested_detectors":["x"]}]}';

describe('VertexDetectorClient', () => {
    test('request shape: model, inline image part before text, JSON schema config', async () => {
        const { c, requests } = client(async () => text(OK));
        const res = await settle(c.evaluate([spec()], [event('custom')], 'QUJD', 20, 'ctx'));
        const req = requests[0];
        assert.equal(req.model, 'gemini-test');
        assert.equal(req.contents[0].role, 'user');
        assert.deepEqual(req.contents[0].parts[0], { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } });
        assert.match(req.contents[0].parts[1].text, /Current Task State/);
        assert.equal(req.config.systemInstruction, DETECTOR_PIPELINE_SYSTEM_PROMPT);
        assert.equal(req.config.responseMimeType, 'application/json');
        assert.equal(req.config.temperature, 0);
        assert.deepEqual(req.config.responseSchema.required, ['triggered']);
        assert.equal(res.triggered[0].name, 'det');
        assert.deepEqual(res.triggered[0].suggestedDetectors, ['x']);
        assert.equal(res.attempt, 0);
        assert.equal(res.rawPrompt, req.contents[0].parts[1].text);
    });

    test('text-only evaluation sends one text part', async () => {
        const { c, requests } = client(async () => text('{"triggered":[]}'));
        await settle(c.evaluate([spec()], [], null));
        assert.equal(requests[0].contents[0].parts.length, 1);
        assert.ok('text' in requests[0].contents[0].parts[0]);
    });

    test('empty / missing candidate text is retried then throws', async () => {
        const replies = [{}, { candidates: [] }, { candidates: [{ content: { parts: [] } }] }, text('  ')];
        const { c, requests } = client(async () => replies.shift());
        await assert.rejects(settle(c.evaluate([spec()], [], null)), /empty response/);
        assert.equal(requests.length, 4);
    });

    test('invalid JSON is retried and can recover', async () => {
        const replies = [text('nope'), text(OK)];
        const { c } = client(async () => replies.shift());
        const res = await settle(c.evaluate([spec()], [], null));
        assert.equal(res.attempt, 1);
    });

    test('429 / RESOURCE_EXHAUSTED retried up to 3 times', async () => {
        let n = 0;
        const { c, requests } = client(async () => {
            n++;
            if (n === 1) throw new Error('got status: 429 Too Many Requests');
            if (n === 2) throw new Error('RESOURCE_EXHAUSTED');
            return text(OK);
        });
        const res = await settle(c.evaluate([spec()], [], null));
        assert.equal(requests.length, 3);
        assert.equal(res.attempt, 2);
    });

    test('persistent rate limiting gives up after 4 attempts with the original error', async () => {
        const { c, requests } = client(async () => { throw new Error('429'); });
        await assert.rejects(settle(c.evaluate([spec()], [], null)), /^Error: 429$/);
        assert.equal(requests.length, 4);
    });

    test('other errors (auth, permission) are not retried', async () => {
        const { c, requests } = client(async () => { throw new Error('PERMISSION_DENIED'); });
        await assert.rejects(settle(c.evaluate([spec()], [], null)), /PERMISSION_DENIED/);
        assert.equal(requests.length, 1);
    });

    test('non-Error throwables are wrapped', async () => {
        const { c } = client(async () => { throw 'boom'; });
        await assert.rejects(settle(c.evaluate([spec()], [], null)), (err: unknown) => err instanceof Error && err.message === 'boom');
    });

    test('{} / null / fenced JSON are handled without retry', async () => {
        const replies = [text('{}'), text('null'), text('```json\n' + OK + '\n```')];
        const { c, requests } = client(async () => replies.shift());
        assert.deepEqual((await settle(c.evaluate([spec()], [], null))).triggered, []);
        assert.deepEqual((await settle(c.evaluate([spec()], [], null))).triggered, []);
        assert.equal((await settle(c.evaluate([spec()], [], null))).triggered.length, 1);
        assert.equal(requests.length, 3);
    });

    test('traces on success and failure; throwing observer is ignored', async () => {
        const traces: PromptTrace[] = [];
        const replies: Array<() => any> = [() => text(OK), () => { throw new Error('denied'); }];
        const { c } = client(async () => replies.shift()!(), (t) => { traces.push(t); throw new Error('observer'); });
        await settle(c.evaluate([spec()], [], 'QQ=='));
        await assert.rejects(settle(c.evaluate([spec()], [], null)));
        assert.equal(traces.length, 2);
        assert.equal(traces[0].error, null);
        assert.equal(traces[0].hasImage, true);
        assert.equal(traces[0].parsedResult?.[0].detectorName, 'det');
        assert.equal(traces[0].model, 'gemini-test');
        assert.equal(traces[1].error, 'denied');
        assert.equal(traces[1].parsedResult, null);
    });
});
