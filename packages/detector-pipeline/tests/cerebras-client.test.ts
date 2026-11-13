import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { CerebrasDetectorClient, CEREBRAS_DEFAULT_BASE_URL, CEREBRAS_DEFAULT_MODEL } from '../cerebras-client';
import { DETECTOR_PIPELINE_SYSTEM_PROMPT } from '../prompts';
import type { PromptTrace } from '../types';
import { spec, event } from './helpers';

interface Call { url: string; init: RequestInit }

let calls: Call[];
let responses: Array<() => Promise<Response> | Response>;
const realFetch = globalThis.fetch;

function chat(content: unknown, status = 200): () => Response {
    return () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}
function raw(body: string, status = 200): () => Response {
    return () => new Response(body, { status });
}

beforeEach(() => {
    calls = [];
    responses = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const next = responses.shift();
        if (!next) throw new Error('unexpected fetch (no fake response queued)');
        return next();
    }) as typeof fetch;
    mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = realFetch;
});

/** Drive retry back-off timers until the promise settles. */
async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 100 && !done; i++) {
        await new Promise((r) => setImmediate(r));
        mock.timers.tick(60_000);
    }
    return p;
}

const OK = '{"triggered":[{"name":"det","confidence":0.8,"summary":"s","evidence":"e"}]}';

describe('CerebrasDetectorClient', () => {
    test('defaults: base URL and model constants', () => {
        assert.equal(CEREBRAS_DEFAULT_BASE_URL, 'https://api.cerebras.ai/v1');
        assert.equal(CEREBRAS_DEFAULT_MODEL, 'gemma-4-31b');
    });

    test('request shape: endpoint, auth header, JSON mode, system + user content with image first', async () => {
        responses.push(chat(OK));
        const client = new CerebrasDetectorClient({ apiKey: 'test-key', model: 'm1' });
        const res = await settle(client.evaluate([spec()], [event('custom', { a: 1 })], 'QUJD', undefined, 'ctx'));

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://api.cerebras.ai/v1/chat/completions');
        assert.equal(calls[0].init.method, 'POST');
        const headers = calls[0].init.headers as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer test-key');
        assert.equal(headers['Content-Type'], 'application/json');
        const body = JSON.parse(String(calls[0].init.body));
        assert.equal(body.model, 'm1');
        assert.equal(body.temperature, 0);
        assert.equal(body.max_tokens, 512);
        assert.deepEqual(body.response_format, { type: 'json_object' });
        assert.equal(body.messages[0].role, 'system');
        assert.equal(body.messages[0].content, DETECTOR_PIPELINE_SYSTEM_PROMPT);
        assert.equal(body.messages[1].content[0].type, 'image_url');
        assert.equal(body.messages[1].content[0].image_url.url, 'data:image/jpeg;base64,QUJD');
        assert.equal(body.messages[1].content[1].type, 'text');
        assert.match(body.messages[1].content[1].text, /Current Task State\n\nctx/);
        assert.match(body.messages[1].content[1].text, /Analyze the screenshot/);

        assert.equal(res.triggered[0].name, 'det');
        assert.equal(res.attempt, 0);
        assert.equal(res.rawResponse, OK);
        assert.equal(res.rawPrompt, body.messages[1].content[1].text);
    });

    test('text-only request has no image part', async () => {
        responses.push(chat('{"triggered":[]}'));
        const client = new CerebrasDetectorClient({ apiKey: 'k', model: 'm' });
        await settle(client.evaluate([spec()], [], null));
        const body = JSON.parse(String(calls[0].init.body));
        assert.equal(body.messages[1].content.length, 1);
        assert.equal(body.messages[1].content[0].type, 'text');
    });

    test('custom base URL: trailing slashes are trimmed; empty string falls back to default', async () => {
        responses.push(chat('{"triggered":[]}'), chat('{"triggered":[]}'));
        await settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm', baseUrl: 'http://local.test/v1///' }).evaluate([spec()], [], null));
        await settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm', baseUrl: '' }).evaluate([spec()], [], null));
        assert.equal(calls[0].url, 'http://local.test/v1/chat/completions');
        assert.equal(calls[1].url, 'https://api.cerebras.ai/v1/chat/completions');
    });

    test('content as an array of parts is joined', async () => {
        responses.push(chat([{ type: 'text', text: '{"triggered":' }, { type: 'text' }, { type: 'text', text: '[]}' }]));
        const res = await settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null));
        assert.deepEqual(res.triggered, []);
    });

    test('markdown-fenced JSON content is accepted', async () => {
        responses.push(chat('```json\n' + OK + '\n```'));
        const res = await settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null));
        assert.equal(res.triggered.length, 1);
    });

    test('model returning {} or null content-object yields no triggers', async () => {
        responses.push(chat('{}'), chat('null'));
        const client = new CerebrasDetectorClient({ apiKey: 'k', model: 'm' });
        assert.deepEqual((await settle(client.evaluate([spec()], [], null))).triggered, []);
        assert.deepEqual((await settle(client.evaluate([spec()], [], null))).triggered, []);
        assert.equal(calls.length, 2, 'no retries for valid-but-empty JSON');
    });

    test('empty content is retried, then succeeds', async () => {
        responses.push(chat(''), chat('   '), chat(OK));
        const res = await settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null));
        assert.equal(calls.length, 3);
        assert.equal(res.attempt, 2);
    });

    test('missing choices (no content) counts as an empty response', async () => {
        responses.push(raw('{}'), raw('{"choices":[]}'), raw('{"choices":[{}]}'), raw('{"choices":[{"message":{}}]}'));
        await assert.rejects(settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null)), /empty response/);
        assert.equal(calls.length, 4, '1 attempt + 3 retries');
    });

    test('non-JSON HTTP body is retried as invalid JSON and eventually throws', async () => {
        for (let i = 0; i < 4; i++) responses.push(raw('<html>gateway</html>'));
        await assert.rejects(settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null)), /not valid JSON/);
        assert.equal(calls.length, 4);
    });

    test('prose content (not JSON) is retried, then succeeds', async () => {
        responses.push(chat('I think nothing fired.'), chat(OK));
        const res = await settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null));
        assert.equal(res.attempt, 1);
    });

    test('HTTP 429 / 502 / 503 are retried with exponential back-off', async () => {
        responses.push(raw('{"error":{"message":"slow down"}}', 429), raw('bad gateway', 502), raw('{"error":"unavailable"}', 503), chat(OK));
        const delays: number[] = [];
        const realSetTimeout = globalThis.setTimeout;
        const client = new CerebrasDetectorClient({ apiKey: 'k', model: 'm' });
        const spy = mock.method(globalThis, 'setTimeout', (fn: () => void, ms: number) => {
            delays.push(ms);
            return realSetTimeout(fn, ms);
        });
        try {
            const res = await settle(client.evaluate([spec()], [], null));
            assert.equal(res.attempt, 3);
        } finally {
            spy.mock.restore();
        }
        // per-attempt timeouts are 30000; the back-off delays are the others
        assert.deepEqual(delays.filter((d) => d !== 30_000), [1500, 3000, 6000]);
    });

    test('HTTP 4xx errors are not retried and surface the API message', async () => {
        responses.push(raw('{"error":{"message":"invalid api key"}}', 401));
        await assert.rejects(
            settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null)),
            /^Error: Cerebras HTTP 401: invalid api key$/,
        );
        assert.equal(calls.length, 1);
    });

    test('a 4xx whose body happens to mention 503 or 429 is not retried', async () => {
        responses.push(raw('{"error":{"message":"field max_tokens must be < 4290 (code 503)"}}', 400));
        await assert.rejects(settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null)), /HTTP 400/);
        assert.equal(calls.length, 1);
    });

    test('string error body and raw text body are reported', async () => {
        responses.push(raw('{"error":"nope"}', 404), raw('x'.repeat(1000), 500));
        const client = new CerebrasDetectorClient({ apiKey: 'k', model: 'm' });
        await assert.rejects(settle(client.evaluate([spec()], [], null)), /Cerebras HTTP 404: nope$/);
        await assert.rejects(settle(client.evaluate([spec()], [], null)), (err: Error) => {
            assert.match(err.message, /^Cerebras HTTP 500: x+$/);
            assert.equal(err.message.length, 'Cerebras HTTP 500: '.length + 400, 'body truncated to 400 chars');
            return true;
        });
    });

    test('error field inside a 200 body is thrown (and retried if it is a rate limit)', async () => {
        responses.push(raw('{"error":{"message":"bad request shape"}}'));
        await assert.rejects(settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null)), /bad request shape/);
        assert.equal(calls.length, 1);

        responses.push(raw('{"error":{"message":"RESOURCE_EXHAUSTED"}}'), chat(OK));
        const res = await settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null));
        assert.equal(res.attempt, 1);
    });

    test('network errors are not retried', async () => {
        responses.push(() => Promise.reject(new TypeError('fetch failed')));
        await assert.rejects(settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null)), /fetch failed/);
        assert.equal(calls.length, 1);
    });

    test('a hung request is aborted after timeoutMs and not retried', async () => {
        responses.push(() => new Promise<Response>((_resolve, reject) => {
            const signal = calls[calls.length - 1].init.signal!;
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        const p = new CerebrasDetectorClient({ apiKey: 'k', model: 'm', timeoutMs: 5030 }).evaluate([spec()], [], null);
        await assert.rejects(settle(p), /timed out after 5030ms/);
        assert.equal(calls.length, 1);
    });

    test('traces: success trace carries parsed result, failure trace carries the error', async () => {
        const traces: PromptTrace[] = [];
        responses.push(chat(OK), raw('{"error":{"message":"denied"}}', 403));
        const client = new CerebrasDetectorClient({ apiKey: 'k', model: 'm', onTrace: (t) => traces.push(t) });
        await settle(client.evaluate([spec()], [], 'QQ=='));
        await assert.rejects(settle(client.evaluate([spec()], [], null)));
        assert.equal(traces.length, 2);
        assert.equal(traces[0].hasImage, true);
        assert.equal(traces[0].error, null);
        assert.equal(traces[0].parsedResult?.[0].detectorName, 'det');
        assert.equal(traces[0].model, 'm');
        assert.equal(traces[1].hasImage, false);
        assert.equal(traces[1].rawResponse, null);
        assert.match(traces[1].error ?? '', /denied/);
    });

    test('a throwing trace observer does not break evaluation', async () => {
        responses.push(chat(OK));
        const client = new CerebrasDetectorClient({ apiKey: 'k', model: 'm', onTrace: () => { throw new Error('observer'); } });
        const res = await settle(client.evaluate([spec()], [], null));
        assert.equal(res.triggered.length, 1);
    });

    test('unknown detector names and out-of-range confidence are normalised by the parser', async () => {
        responses.push(chat('{"triggered":[{"name":"ghost","confidence":3}]}'));
        const res = await settle(new CerebrasDetectorClient({ apiKey: 'k', model: 'm' }).evaluate([spec()], [], null));
        assert.equal(res.triggered[0].name, 'ghost');
        assert.equal(res.triggered[0].confidence, 1);
    });
});
