#!/usr/bin/env node
/**
 * Memory Service — Standalone process for material/frame persistence.
 *
 * Runs in a separate Node.js process (system Node), communicating with
 * the parent over stdio JSON-lines. This keeps better-sqlite3 out of the
 * runtime/Electron process, avoiding Node ABI mismatch issues.
 *
 *   stdin  (parent → Memory): config, add-frame, save-material, update-material-type, save-screenshot, get-screenshot(s)
 *   stdout (Memory → parent): ready, response, error
 *   stderr: debug / log output
 */

const origConsole = { ...console };
console.log = (...args: unknown[]) => origConsole.error(...args);
console.warn = (...args: unknown[]) => origConsole.error(...args);
console.info = (...args: unknown[]) => origConsole.error(...args);

import { MemoryStore } from './memory-store';
import { embed, warmup as warmupEmbedder, EMBEDDING_DIM } from './embedder';
import { OcrWorker, LineDeduper } from './ocr-worker';

function send(msg: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

function log(message: string): void {
    process.stderr.write(`[memory-service] ${message}\n`);
}

let store: MemoryStore | null = null;
let configured = false;
let frozen = false;

// ── OCR state ──────────────────────────────────────────────────────────────
let ocrEnabled = false;
let ocrPythonPath = 'python3';
let ocrMaxFramesPerRun = 40;
let ocrWorker: OcrWorker | null = null;
let ocrWorkerStarting: Promise<void> | null = null;
/** materialIds with an OCR run currently in flight (avoids double-processing). */
const ocrInFlight = new Set<string>();

let stdinBuffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
    stdinBuffer += chunk;
    let idx: number;
    while ((idx = stdinBuffer.indexOf('\n')) !== -1) {
        const line = stdinBuffer.slice(0, idx).trim();
        stdinBuffer = stdinBuffer.slice(idx + 1);
        if (!line) continue;
        try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            handleMessage(msg);
        } catch (err) {
            log(`Parse error: ${(err as Error).message}`);
        }
    }
});

process.stdin.on('end', () => {
    log('stdin EOF — shutting down');
    shutdown();
});

function handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
        case 'config':
            handleConfig(msg);
            break;
        case 'add-frame':
            handleAddFrame(msg);
            break;
        case 'save-material':
            handleSaveMaterial(msg);
            break;
        case 'update-material-type':
            handleUpdateMaterialType(msg);
            break;
        case 'list-materials':
            handleListMaterials(msg);
            break;
        case 'get-material-frames':
            handleGetMaterialFrames(msg);
            break;
        case 'get-material-latest-frame':
            handleGetMaterialLatestFrame(msg);
            break;
        case 'save-screenshot':
            handleSaveScreenshot(msg);
            break;
        case 'get-screenshot':
            handleGetScreenshot(msg);
            break;
        case 'get-screenshots':
            handleGetScreenshots(msg);
            break;
        case 'record-focus-session':
            handleRecordFocusSession(msg);
            break;
        case 'process-material-ocr':
            handleProcessMaterialOcr(msg).catch((err) => {
                log(`process-material-ocr error: ${(err as Error).message}`);
                send({ type: 'response', requestId: msg.requestId, error: (err as Error).message });
            });
            break;
        case 'get-material-ocr':
            handleGetMaterialOcr(msg);
            break;
        case 'get-material-weights':
            handleGetMaterialWeights(msg);
            break;
        case 'search-materials':
            handleSearchMaterials(msg);
            break;
        case 'get-embedding-stats':
            handleGetEmbeddingStats(msg);
            break;
        case 'freeze':
            frozen = true;
            log('Memory frozen — writes disabled');
            send({ type: 'response', requestId: msg.requestId, frozen: true });
            break;
        case 'unfreeze':
            frozen = false;
            log('Memory unfrozen — writes enabled');
            send({ type: 'response', requestId: msg.requestId, frozen: false });
            break;
        case 'get-frozen':
            send({ type: 'response', requestId: msg.requestId, frozen });
            break;
        default:
            log(`Unknown message type: ${msg.type}`);
    }
}

function handleConfig(msg: Record<string, unknown>): void {
    if (configured) {
        log('Already configured, ignoring');
        return;
    }
    configured = true;

    const dbPath = (msg.dbPath as string) ?? ':memory:';
    const maxFramesPerMaterial = (msg.maxFramesPerMaterial as number) ?? 200;

    ocrEnabled = (msg.ocrEnabled as boolean) ?? false;
    ocrPythonPath = (msg.pythonPath as string) ?? 'python3';
    ocrMaxFramesPerRun = (msg.ocrMaxFramesPerRun as number) ?? 40;

    try {
        store = new MemoryStore({ dbPath, maxFramesPerMaterial, walMode: true });
        log('Memory store initialized');
        send({ type: 'ready' });

        // Warm up embedding model + backfill existing materials in background
        backfillEmbeddings().catch(err => {
            log(`Embedding backfill error: ${(err as Error).message}`);
        });
    } catch (err) {
        log(`Failed to start: ${(err as Error).message}`);
        send({ type: 'error', message: (err as Error).message });
        process.exit(1);
    }
}

function handleAddFrame(msg: Record<string, unknown>): void {
    if (!store || frozen) return;

    const dataBase64 = msg.dataBase64 as string | undefined;
    const hash = (msg.hash as string) ?? '';
    if (!dataBase64) return;

    try {
        const frame = {
            frameId: msg.frameId as string,
            materialId: msg.materialId as string,
            windowId: msg.windowId as number,
            timestamp: (msg.timestamp as number) ?? Date.now(),
            width: msg.width as number,
            height: msg.height as number,
            data: Buffer.from(dataBase64, 'base64'),
            title: (msg.title as string) ?? null,
            application: (msg.application as string) ?? null,
            bundleId: (msg.bundleId as string) ?? null,
            captureReason: (msg.captureReason as string) ?? 'UNKNOWN',
        };
        store.addFrame(frame, hash);
    } catch (err) {
        log(`add-frame error: ${(err as Error).message}`);
    }
}

function handleSaveMaterial(msg: Record<string, unknown>): void {
    if (!store || frozen) return;

    try {
        const material = {
            materialId: msg.materialId as string,
            title: msg.title as string,
            windowId: msg.windowId as number,
            application: (msg.application as string) ?? null,
            bundleId: (msg.bundleId as string) ?? null,
            documentPath: (msg.documentPath as string) ?? null,
            lastFrameHash: (msg.lastFrameHash as string) ?? null,
            firstSeen: msg.firstSeen as number,
            lastSeen: msg.lastSeen as number,
            materialType: (msg.materialType as string) ?? null,
            materialTypeConfidence: (msg.materialTypeConfidence as number) ?? null,
            appMetadata: (msg.appMetadata as Record<string, string | null> | null) ?? null,
            totalTimeMs: 0,
            weight: null,
        };
        store.saveMaterial(material);
        embedMaterialInBackground(material.materialId);
    } catch (err) {
        log(`save-material error: ${(err as Error).message}`);
    }
}

function handleUpdateMaterialType(msg: Record<string, unknown>): void {
    if (!store || frozen) return;

    try {
        store.updateMaterialType(
            msg.materialId as string,
            msg.materialType as string,
            msg.materialTypeConfidence as number,
        );
    } catch (err) {
        log(`update-material-type error: ${(err as Error).message}`);
    }
}

function handleListMaterials(msg: Record<string, unknown>): void {
    if (!store) {
        send({ type: 'response', requestId: msg.requestId, error: 'Not configured' });
        return;
    }
    try {
        const materials = store.getAllMaterials();
        const limit = (msg.limit as number) ?? 100;
        const limited = materials.slice(0, limit);
        send({
            type: 'response',
            requestId: msg.requestId,
            materials: limited,
        });
    } catch (err) {
        log(`list-materials error: ${(err as Error).message}`);
        send({ type: 'response', requestId: msg.requestId, error: (err as Error).message });
    }
}

function handleGetMaterialFrames(msg: Record<string, unknown>): void {
    if (!store) {
        send({ type: 'response', requestId: msg.requestId, error: 'Not configured' });
        return;
    }
    const materialId = msg.materialId as string;
    if (!materialId) {
        send({ type: 'response', requestId: msg.requestId, error: 'materialId required' });
        return;
    }
    try {
        const limit = (msg.limit as number) ?? 10;
        const frames = store.getFrames(materialId).slice(-limit);
        const serialized = frames.map((f) => ({
            frameId: f.frameId,
            materialId: f.materialId,
            windowId: f.windowId,
            timestamp: f.timestamp,
            width: f.width,
            height: f.height,
            dataBase64: f.data.toString('base64'),
            title: f.title,
            application: f.application,
            bundleId: f.bundleId,
            captureReason: f.captureReason,
        }));
        send({ type: 'response', requestId: msg.requestId, frames: serialized });
    } catch (err) {
        log(`get-material-frames error: ${(err as Error).message}`);
        send({ type: 'response', requestId: msg.requestId, error: (err as Error).message });
    }
}

function handleGetMaterialLatestFrame(msg: Record<string, unknown>): void {
    if (!store) {
        send({ type: 'response', requestId: msg.requestId, error: 'Not configured' });
        return;
    }
    const materialId = msg.materialId as string;
    if (!materialId) {
        send({ type: 'response', requestId: msg.requestId, error: 'materialId required' });
        return;
    }
    try {
        const frame = store.getLatestFrame(materialId);
        if (!frame) {
            send({ type: 'response', requestId: msg.requestId, frame: null });
            return;
        }
        send({
            type: 'response',
            requestId: msg.requestId,
            frame: {
                frameId: frame.frameId,
                materialId: frame.materialId,
                windowId: frame.windowId,
                timestamp: frame.timestamp,
                width: frame.width,
                height: frame.height,
                dataBase64: frame.data.toString('base64'),
                title: frame.title,
                application: frame.application,
                bundleId: frame.bundleId,
                captureReason: frame.captureReason,
            },
        });
    } catch (err) {
        log(`get-material-latest-frame error: ${(err as Error).message}`);
        send({ type: 'response', requestId: msg.requestId, error: (err as Error).message });
    }
}

function handleSaveScreenshot(msg: Record<string, unknown>): void {
    if (!store || frozen) return;

    const dataBase64 = msg.dataBase64 as string | undefined;
    if (!dataBase64) return;

    try {
        store.saveScreenshot({
            screenshotId: msg.screenshotId as string,
            timestamp: (msg.timestamp as number) ?? Date.now(),
            width: msg.width as number,
            height: msg.height as number,
            data: Buffer.from(dataBase64, 'base64'),
            mimeType: (msg.mimeType as string) ?? 'image/jpeg',
            boundsX: (msg.boundsX as number) ?? null,
            boundsY: (msg.boundsY as number) ?? null,
            boundsW: (msg.boundsW as number) ?? null,
            boundsH: (msg.boundsH as number) ?? null,
            screenshotType: (msg.screenshotType as string) ?? null,
        });
    } catch (err) {
        log(`save-screenshot error: ${(err as Error).message}`);
    }
}

function handleGetScreenshot(msg: Record<string, unknown>): void {
    if (!store) {
        send({ type: 'response', requestId: msg.requestId, error: 'Not configured' });
        return;
    }
    const screenshotId = msg.screenshotId as string;
    if (!screenshotId) {
        send({ type: 'response', requestId: msg.requestId, error: 'screenshotId required' });
        return;
    }
    try {
        const ss = store.getScreenshot(screenshotId);
        if (!ss) {
            send({ type: 'response', requestId: msg.requestId, screenshot: null });
            return;
        }
        send({
            type: 'response',
            requestId: msg.requestId,
            screenshot: {
                screenshotId: ss.screenshotId,
                timestamp: ss.timestamp,
                width: ss.width,
                height: ss.height,
                dataBase64: ss.data.toString('base64'),
                mimeType: ss.mimeType,
                boundsX: ss.boundsX,
                boundsY: ss.boundsY,
                boundsW: ss.boundsW,
                boundsH: ss.boundsH,
                screenshotType: ss.screenshotType,
            },
        });
    } catch (err) {
        log(`get-screenshot error: ${(err as Error).message}`);
        send({ type: 'response', requestId: msg.requestId, error: (err as Error).message });
    }
}

function handleGetScreenshots(msg: Record<string, unknown>): void {
    if (!store) {
        send({ type: 'response', requestId: msg.requestId, error: 'Not configured' });
        return;
    }
    try {
        const limit = (msg.limit as number) ?? 50;
        const since = (msg.since as number) ?? 0;
        const screenshots = store.getScreenshotsMeta(limit, since);
        send({
            type: 'response',
            requestId: msg.requestId,
            screenshots,
        });
    } catch (err) {
        log(`get-screenshots error: ${(err as Error).message}`);
        send({ type: 'response', requestId: msg.requestId, error: (err as Error).message });
    }
}

function handleRecordFocusSession(msg: Record<string, unknown>): void {
    if (!store || frozen) return;

    const sessionId  = msg.sessionId  as string | undefined;
    const materialId = msg.materialId as string | undefined;
    const startedAt  = msg.startedAt  as number | undefined;
    const endedAt    = msg.endedAt    as number | undefined;
    const durationMs = msg.durationMs as number | undefined;

    if (!sessionId || !materialId || !startedAt || !endedAt || durationMs == null) {
        log('record-focus-session: missing required fields');
        return;
    }

    try {
        store.recordFocusSession({ sessionId, materialId, startedAt, endedAt, durationMs });
    } catch (err) {
        log(`record-focus-session error: ${(err as Error).message}`);
    }
}

function handleGetMaterialWeights(msg: Record<string, unknown>): void {
    if (!store) {
        send({ type: 'response', requestId: msg.requestId, error: 'Not configured' });
        return;
    }
    try {
        const halfLifeDays = (msg.halfLifeDays as number | undefined) ?? 7;
        const weights = store.computeAllMaterialWeights(halfLifeDays);
        send({ type: 'response', requestId: msg.requestId, weights });
    } catch (err) {
        log(`get-material-weights error: ${(err as Error).message}`);
        send({ type: 'response', requestId: msg.requestId, error: (err as Error).message });
    }
}

async function handleSearchMaterials(msg: Record<string, unknown>): Promise<void> {
    if (!store) {
        send({ type: 'response', requestId: msg.requestId, error: 'Not configured' });
        return;
    }
    const query = msg.query as string;
    if (!query) {
        send({ type: 'response', requestId: msg.requestId, error: 'query required' });
        return;
    }
    try {
        const limit = (msg.limit as number) ?? 20;

        if (embeddingReady && store.getEmbeddingCount() > 0) {
            const queryVec = await embed(query);
            const materials = store.searchMaterialsSemantic(queryVec, limit);
            send({ type: 'response', requestId: msg.requestId, materials, searchMode: 'vector' });
        } else {
            const materials = store.searchMaterials(query, limit);
            send({ type: 'response', requestId: msg.requestId, materials, searchMode: 'keyword' });
        }
    } catch (err) {
        log(`search-materials error: ${(err as Error).message}`);
        send({ type: 'response', requestId: msg.requestId, error: (err as Error).message });
    }
}

function handleGetEmbeddingStats(msg: Record<string, unknown>): void {
    if (!store) {
        send({ type: 'response', requestId: msg.requestId, error: 'Not configured' });
        return;
    }
    send({
        type: 'response',
        requestId: msg.requestId,
        embeddingReady,
        embeddingCount: store.getEmbeddingCount(),
        missingCount: store.getMaterialsWithoutEmbeddings(1).length > 0 ? store.getMaterialsWithoutEmbeddings().length : 0,
        embeddingDim: EMBEDDING_DIM,
    });
}

// ── OCR (Apple Vision, via py/ocr_worker.py) ─────────────────────────

/** Lazily start the OCR worker subprocess (first OCR request spawns it). */
async function ensureOcrWorker(): Promise<OcrWorker> {
    if (ocrWorker?.isReady()) return ocrWorker;

    if (!ocrWorkerStarting) {
        ocrWorker = new OcrWorker({ pythonPath: ocrPythonPath, debug: true });
        ocrWorkerStarting = ocrWorker.start().finally(() => {
            ocrWorkerStarting = null;
        });
    }
    await ocrWorkerStarting;
    if (!ocrWorker?.isReady()) throw new Error('OCR worker failed to start');
    return ocrWorker;
}

/**
 * OCR all frames of a material that are newer than the stored cursor,
 * merge the recognized lines into the accumulated per-material text
 * (LineDeduper), and persist the result.
 *
 * Incremental: material_ocr_results.last_frame_ts records the newest frame
 * already processed, so repeated runs (one per focus session) only OCR
 * frames captured since the previous run.
 */
async function handleProcessMaterialOcr(msg: Record<string, unknown>): Promise<void> {
    const requestId = msg.requestId;
    const materialId = msg.materialId as string | undefined;

    if (!store) {
        send({ type: 'response', requestId, error: 'Not configured' });
        return;
    }
    if (!ocrEnabled) {
        send({ type: 'response', requestId, error: 'OCR disabled (set ocrEnabled in memory config)' });
        return;
    }
    if (!materialId) {
        send({ type: 'response', requestId, error: 'materialId required' });
        return;
    }
    if (frozen) {
        send({ type: 'response', requestId, ok: true, materialId, skipped: 'frozen' });
        return;
    }
    if (ocrInFlight.has(materialId)) {
        send({ type: 'response', requestId, ok: true, materialId, skipped: 'in-flight' });
        return;
    }

    ocrInFlight.add(materialId);
    try {
        const prev = store.getMaterialOcr(materialId);
        const frames = store.getFramesSince(materialId, prev?.lastFrameTs ?? 0, ocrMaxFramesPerRun);

        if (frames.length === 0) {
            send({
                type: 'response', requestId, ok: true, materialId,
                framesProcessed: 0, addedLines: 0,
                lineCount: prev?.lineCount ?? 0,
                textLength: prev?.text.length ?? 0,
            });
            return;
        }

        const worker = await ensureOcrWorker();

        // Rebuild the deduper from previously accumulated text so new lines
        // merge against everything seen in earlier focus sessions.
        const deduper = new LineDeduper();
        if (prev?.text) deduper.addLines(prev.text.split('\n'));
        const linesBefore = deduper.lineCount;

        for (const frame of frames) {
            try {
                const lines = await worker.recognize(frame.data);
                deduper.addLines(lines);
            } catch (err) {
                log(`OCR failed for frame ${frame.frameId}: ${(err as Error).message}`);
            }
        }

        const text = deduper.text();
        const addedLines = deduper.lineCount - linesBefore;
        store.upsertMaterialOcr({
            materialId,
            text,
            lineCount: deduper.lineCount,
            frameCount: (prev?.frameCount ?? 0) + frames.length,
            lastFrameTs: frames[frames.length - 1].timestamp,
        });

        log(`OCR ${materialId}: ${frames.length} frames, +${addedLines} lines (${deduper.lineCount} total)`);
        send({
            type: 'response', requestId, ok: true, materialId,
            framesProcessed: frames.length,
            addedLines,
            lineCount: deduper.lineCount,
            textLength: text.length,
            preview: text.slice(0, 300),
        });
    } finally {
        ocrInFlight.delete(materialId);
    }
}

function handleGetMaterialOcr(msg: Record<string, unknown>): void {
    if (!store) {
        send({ type: 'response', requestId: msg.requestId, error: 'Not configured' });
        return;
    }
    const materialId = msg.materialId as string;
    if (!materialId) {
        send({ type: 'response', requestId: msg.requestId, error: 'materialId required' });
        return;
    }
    try {
        const ocr = store.getMaterialOcr(materialId);
        send({ type: 'response', requestId: msg.requestId, ocr });
    } catch (err) {
        log(`get-material-ocr error: ${(err as Error).message}`);
        send({ type: 'response', requestId: msg.requestId, error: (err as Error).message });
    }
}

// ── Embedding helpers ────────────────────────────────────────────────

let embeddingReady = false;

async function backfillEmbeddings(): Promise<void> {
    log('Warming up embedding model...');
    await warmupEmbedder();
    embeddingReady = true;
    log('Embedding model ready');

    if (!store) return;

    const missing = store.getMaterialsWithoutEmbeddings(500);
    if (missing.length === 0) {
        log(`All materials have embeddings (${store.getEmbeddingCount()} total)`);
        return;
    }
    log(`Backfilling embeddings for ${missing.length} materials...`);

    let done = 0;
    for (const materialId of missing) {
        if (!store) break;
        try {
            await embedAndStoreMaterial(materialId);
            done++;
        } catch (err) {
            log(`Embed backfill error for ${materialId}: ${(err as Error).message}`);
        }
    }
    log(`Backfill complete: ${done}/${missing.length} materials embedded (${store.getEmbeddingCount()} total)`);
}

async function embedAndStoreMaterial(materialId: string): Promise<void> {
    if (!store) return;
    const material = store.getMaterial(materialId);
    if (!material) return;

    const text = MemoryStore.buildEmbeddingText(material);
    const vec = await embed(text);
    store.saveMaterialEmbedding(materialId, vec);
}

function embedMaterialInBackground(materialId: string): void {
    if (!embeddingReady || !store) return;
    embedAndStoreMaterial(materialId).catch(err => {
        log(`Background embed error for ${materialId}: ${(err as Error).message}`);
    });
}

function shutdown(): void {
    if (ocrWorker) {
        ocrWorker.stop();
        ocrWorker = null;
    }
    if (store) {
        store.close();
        store = null;
    }
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
