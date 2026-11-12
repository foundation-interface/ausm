/*
 * Stand-in for @huggingface/transformers: never downloads a model.
 * `pipeline()` returns a deterministic bag-of-words embedder.
 *   FAKE_EMBED_DIM   — output dimension (default 384; set another to
 *                      simulate a dimension mismatch)
 *   FAKE_EMBED_FAIL  — "load" makes pipeline() reject
 *   FAKE_EMBED_DELAY — ms to wait per embedding call
 *   FAKE_EMBED_OFFSET — return output.data as a view with a byte offset
 */
export const env = {};
function embedOne(text, dim) {
    const v = new Float32Array(dim);
    for (const word of String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
        let h = 2166136261;
        for (const ch of word) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
        v[h % dim] += 1;
    }
    let norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
}
export async function pipeline(task, model) {
    if (process.env.FAKE_EMBED_FAIL === 'load') throw new Error('model download blocked in tests');
    globalThis.__fakePipelineLoads = (globalThis.__fakePipelineLoads ?? 0) + 1;
    const dim = Number(process.env.FAKE_EMBED_DIM || 384);
    return async (input) => {
        const delay = Number(process.env.FAKE_EMBED_DELAY || 0);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const texts = Array.isArray(input) ? input : [input];
        const offset = process.env.FAKE_EMBED_OFFSET ? 7 : 0;
        const flat = new Float32Array(offset + texts.length * dim);
        texts.forEach((t, i) => flat.set(embedOne(t, dim), offset + i * dim));
        return { data: flat.subarray(offset), dims: [texts.length, dim] };
    };
}
