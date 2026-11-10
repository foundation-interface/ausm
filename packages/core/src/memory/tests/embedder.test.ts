/**
 * embedder.ts against a fake @huggingface/transformers (see
 * fixtures/register-fake-transformers.cjs, loaded with --require).  The
 * real model is never downloaded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const fakeLoaded = () => (globalThis as { __fakePipelineLoads?: number }).__fakePipelineLoads ?? 0;

test('guard: the fake transformers module is active', async () => {
    const mod = await import('@huggingface/transformers');
    assert.ok('env' in mod && typeof (mod as { pipeline: unknown }).pipeline === 'function');
    assert.equal(Object.keys(mod).sort().join(), 'env,pipeline', 'real transformers would download a model');
});

test('a failed model load is not cached forever', async () => {
    const { embed } = await import('../embedder');
    process.env.FAKE_EMBED_FAIL = 'load';
    await assert.rejects(embed('x'), /download blocked/);
    delete process.env.FAKE_EMBED_FAIL;
    const v = await embed('x');
    assert.equal(v.length, 384);
});

test('embed returns a normalized 384-dim vector; model loads once for concurrent callers', async () => {
    const { embed, warmup, EMBEDDING_DIM } = await import('../embedder');
    const loadsBefore = fakeLoaded();
    await Promise.all([warmup(), embed('a'), embed('b')]);
    assert.ok(fakeLoaded() - loadsBefore <= 0, 'pipeline already cached by previous test');
    const v = await embed('Hello hello world');
    assert.equal(EMBEDDING_DIM, 384);
    assert.equal(v.length, EMBEDDING_DIM);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-5);
    // empty / unicode text do not throw
    assert.equal((await embed('')).length, 384);
    assert.equal((await embed('日本語 テキスト')).length, 384);
});

test('embedBatch splits rows correctly even when the output is a view with a byte offset', async () => {
    const { embed, embedBatch } = await import('../embedder');
    assert.deepEqual(await embedBatch([]), []);
    process.env.FAKE_EMBED_OFFSET = '1';
    try {
        const [a, b] = await embedBatch(['alpha beta', 'gamma']);
        const ea = await embed('alpha beta');
        const eb = await embed('gamma');
        assert.deepEqual(Array.from(a), Array.from(ea));
        assert.deepEqual(Array.from(b), Array.from(eb));
    } finally {
        delete process.env.FAKE_EMBED_OFFSET;
    }
});
