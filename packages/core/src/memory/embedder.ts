/**
 * Local embedding generator using all-MiniLM-L6-v2 via @huggingface/transformers.
 * Produces 384-dimensional float32 vectors for semantic search.
 *
 * The model is loaded lazily on first use (~1-2s cold start, ~80MB disk).
 * Subsequent calls reuse the cached pipeline.
 */

let pipelineInstance: any = null;
let loadingPromise: Promise<any> | null = null;

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

async function getExtractor(): Promise<any> {
    if (pipelineInstance) return pipelineInstance;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
        const { pipeline } = await import('@huggingface/transformers');
        pipelineInstance = await pipeline('feature-extraction', MODEL_ID, {
            dtype: 'fp32',
        });
        return pipelineInstance;
    })();

    return loadingPromise;
}

/**
 * Generate a 384-dim embedding for a single text string.
 */
export async function embed(text: string): Promise<Float32Array> {
    const extractor = await getExtractor();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
}

/**
 * Generate embeddings for multiple texts in a single batch.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await getExtractor();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });

    const results: Float32Array[] = [];
    const raw = output.data as Float32Array;
    for (let i = 0; i < texts.length; i++) {
        results.push(new Float32Array(raw.buffer, i * EMBEDDING_DIM * 4, EMBEDDING_DIM));
    }
    return results;
}

/**
 * Pre-warm the model so the first real embed() call is fast.
 */
export async function warmup(): Promise<void> {
    await getExtractor();
}
