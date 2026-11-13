/**
 * Memory Client — Bridge between AUSM runtime and the memory service process.
 *
 * Spawns the memory service as a separate Node.js process (system Node) and
 * communicates over stdio JSON-lines. This keeps better-sqlite3 out of the
 * runtime/Electron process, avoiding Node ABI mismatch issues.
 *
 *   stdin  (client → Memory): config, add-frame, save-material, update-material-type, save-screenshot, get-screenshot(s)
 *   stdout (Memory → client): ready, response, error
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';

export interface MemoryClientOptions {
    /** Path to the SQLite database file. Default: ':memory:' */
    dbPath?: string;
    /** Max frames per material. Default: 200 */
    maxFramesPerMaterial?: number;
    /** Path to the memory service script. Auto-resolved next to this client in @ausm/core. */
    servicePath?: string;
    /** Node executable path. Default: 'node' (system Node). */
    nodePath?: string;
    /** Stop timeout in ms. Default: 5000 */
    stopTimeoutMs?: number;
    /** Enable live material OCR (Apple Vision, macOS only). Default: false */
    ocrEnabled?: boolean;
    /** Python executable for the OCR worker (needs pyobjc Vision/Quartz). Default: 'python3' */
    pythonPath?: string;
    /** Max frames OCRed per process-material-ocr run. Default: 40 */
    ocrMaxFramesPerRun?: number;
    /** Start the service with writes frozen (no write window during startup). Default: false */
    frozen?: boolean;
}

function resolveDefaultServicePath(): string {
    try {
        const pkgPath = require.resolve('@ausm/core/package.json');
        return path.join(path.dirname(pkgPath), 'dist', 'memory-service.js');
    } catch {
        return path.resolve(__dirname, 'memory-service.js');
    }
}

/**
 * MemoryClient spawns the memory service process and forwards storage
 * operations to it. Used by the runtime to persist materials, frames,
 * and screenshots.
 */
type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

/** Minimal material shape for storage. */
export interface MaterialRecord {
    materialId: string;
    title: string;
    windowId: number;
    application: string | null;
    bundleId: string | null;
    documentPath: string | null;
    lastFrameHash: string | null;
    firstSeen: number;
    lastSeen: number;
    materialType: string | null;
    materialTypeConfidence: number | null;
    appMetadata?: Record<string, string | null> | null;
}

/** Minimal frame shape for storage (data as Buffer). */
export interface MaterialFrameRecord {
    frameId: string;
    materialId: string;
    windowId: number;
    timestamp: number;
    width: number;
    height: number;
    data: Buffer;
    title: string | null;
    application: string | null;
    bundleId: string | null;
    captureReason: string;
}

export class MemoryClient {
    private options: MemoryClientOptions;
    private process: ChildProcess | null = null;
    private readyPromise: Promise<void> | null = null;
    private readyResolve: (() => void) | null = null;
    private readyReject: ((err: Error) => void) | null = null;
    private requestIdCounter = 0;
    private pendingRequests = new Map<string, PendingRequest>();

    constructor(options: MemoryClientOptions = {}) {
        this.options = options;
    }

    /** Start the memory service and wait for ready. */
    async start(): Promise<void> {
        if (this.readyPromise) return this.readyPromise;

        const servicePath = this.options.servicePath ?? resolveDefaultServicePath();
        const nodePath = this.options.nodePath ?? 'node';

        this.readyPromise = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });

        this.process = spawn(nodePath, [servicePath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        this.process.stderr?.setEncoding('utf-8');
        this.process.stderr?.on('data', (chunk: string) => {
            process.stderr.write(chunk);
        });
        // EPIPE when the child dies mid-write must not crash the host; 'exit' handles the failure.
        this.process.stdin?.on('error', () => {});

        let stdoutBuffer = '';
        this.process.stdout?.setEncoding('utf-8');
        this.process.stdout?.on('data', (chunk: string) => {
            stdoutBuffer += chunk;
            let idx: number;
            while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
                const line = stdoutBuffer.slice(0, idx).trim();
                stdoutBuffer = stdoutBuffer.slice(idx + 1);
                if (!line) continue;
                try {
                    const msg = JSON.parse(line) as Record<string, unknown>;
                    if (msg.type === 'ready') {
                        this.readyResolve?.();
                        this.readyResolve = null;
                        this.readyReject = null;
                    } else if (msg.type === 'error') {
                        this.readyReject?.(new Error(msg.message as string));
                    } else if (msg.type === 'response') {
                        const reqId = String(msg.requestId ?? '');
                        const pending = this.pendingRequests.get(reqId);
                        if (pending) {
                            this.pendingRequests.delete(reqId);
                            clearTimeout(pending.timeout);
                            if (msg.error) {
                                pending.reject(new Error(msg.error as string));
                            } else {
                                pending.resolve(msg);
                            }
                        }
                    }
                } catch {
                    // Ignore parse errors
                }
            }
        });

        const child = this.process;
        child.on('exit', (code) => {
            if (this.readyReject && code !== 0) {
                this.readyReject(new Error(`Memory service exited with code ${code}`));
            }
            // Fail in-flight reads now instead of after their (30–120 s) timeout.
            if (this.process === child || this.process === null) {
                this.rejectAllPending(new Error(`Memory service exited (code ${code})`));
            }
        });

        this.process.on('error', (err) => {
            this.readyReject?.(err);
        });

        this.send({
            type: 'config',
            dbPath: this.options.dbPath ?? ':memory:',
            maxFramesPerMaterial: this.options.maxFramesPerMaterial ?? 200,
            ocrEnabled: this.options.ocrEnabled ?? false,
            pythonPath: this.options.pythonPath,
            ocrMaxFramesPerRun: this.options.ocrMaxFramesPerRun,
            frozen: this.options.frozen ?? false,
        });

        const timeout = setTimeout(() => {
            if (this.readyReject) {
                this.readyReject(new Error('Memory service timed out (10s)'));
            }
        }, 10000);

        try {
            await this.readyPromise;
        } catch (err) {
            // Startup failed or timed out: don't leave a half-started child behind.
            const proc = this.process;
            this.process = null;
            this.readyPromise = null;
            this.readyResolve = null;
            this.readyReject = null;
            proc?.kill('SIGKILL');
            throw err;
        } finally {
            clearTimeout(timeout);
        }
    }

    async stop(): Promise<void> {
        const proc = this.process;
        this.process = null;
        this.readyPromise = null;
        this.readyResolve = null;
        this.readyReject = null;

        if (!proc) return;
        if (proc.exitCode !== null || proc.signalCode !== null) return; // already exited

        const stopTimeoutMs = this.options.stopTimeoutMs ?? 5000;
        return new Promise<void>((resolve) => {
            const t = setTimeout(() => {
                proc.kill('SIGKILL');
                resolve();
            }, stopTimeoutMs);
            proc.on('exit', () => {
                clearTimeout(t);
                resolve();
            });
            proc.stdin?.end();
        });
    }

    private rejectAllPending(err: Error): void {
        for (const [, p] of this.pendingRequests) {
            clearTimeout(p.timeout);
            p.reject(err);
        }
        this.pendingRequests.clear();
    }

    private send(msg: Record<string, unknown>): void {
        if (!this.process?.stdin?.writable) return;
        this.process.stdin.write(JSON.stringify(msg) + '\n');
    }

    // ── Material/frame write operations ────────────────────────────────────

    addFrame(frame: MaterialFrameRecord, hash: string): number {
        this.send({
            type: 'add-frame',
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
            hash,
        });
        return 0; // Fire-and-forget; actual eviction count unknown
    }

    saveMaterial(material: MaterialRecord): void {
        this.send({
            type: 'save-material',
            materialId: material.materialId,
            title: material.title,
            windowId: material.windowId,
            application: material.application,
            bundleId: material.bundleId,
            documentPath: material.documentPath,
            lastFrameHash: material.lastFrameHash,
            firstSeen: material.firstSeen,
            lastSeen: material.lastSeen,
            materialType: material.materialType,
            materialTypeConfidence: material.materialTypeConfidence,
            appMetadata: material.appMetadata ?? null,
        });
    }

    updateMaterialType(materialId: string, materialType: string, materialTypeConfidence: number): void {
        this.send({
            type: 'update-material-type',
            materialId,
            materialType,
            materialTypeConfidence,
        });
    }

    // ── Read operations (request-response) ──────────────────────────────────

    private request<T = unknown>(type: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin?.writable) {
                reject(new Error(`Memory service not running (${type})`));
                return;
            }
            const requestId = `req_${++this.requestIdCounter}_${Date.now()}`;
            const timeout = setTimeout(() => {
                if (this.pendingRequests.delete(requestId)) {
                    reject(new Error(`Memory request ${type} timed out (${Math.round(timeoutMs / 1000)}s)`));
                }
            }, timeoutMs);
            this.pendingRequests.set(requestId, {
                resolve: (v) => resolve(v as T),
                reject,
                timeout,
            });
            this.send({ type, requestId, ...params });
        });
    }

    /**
     * Search materials by keyword across title, application, document_path,
     * and app_metadata. Results are sorted by weight DESC (most important first).
     */
    async searchMaterials(query: string, limit = 20): Promise<{
        materials: Array<{
            materialId: string;
            title: string;
            windowId: number;
            application: string | null;
            bundleId: string | null;
            documentPath: string | null;
            firstSeen: number;
            lastSeen: number;
            weight: number | null;
            appMetadata: Record<string, string | null> | null;
        }>;
        searchMode: 'vector' | 'keyword';
    }> {
        const res = await this.request<{ materials?: unknown[]; searchMode?: string }>('search-materials', { query, limit });
        return {
            materials: (res.materials ?? []) as Array<{
                materialId: string;
                title: string;
                windowId: number;
                application: string | null;
                bundleId: string | null;
                documentPath: string | null;
                firstSeen: number;
                lastSeen: number;
                weight: number | null;
                appMetadata: Record<string, string | null> | null;
            }>,
            searchMode: (res.searchMode as 'vector' | 'keyword') ?? 'keyword',
        };
    }

    async getEmbeddingStats(): Promise<{
        embeddingReady: boolean;
        embeddingCount: number;
        missingCount: number;
        embeddingDim: number;
    }> {
        return this.request<{
            embeddingReady: boolean;
            embeddingCount: number;
            missingCount: number;
            embeddingDim: number;
        }>('get-embedding-stats', {});
    }

    /** List all materials (metadata only). */
    async getAllMaterials(limit = 100): Promise<Array<{
        materialId: string;
        title: string;
        windowId: number;
        application: string | null;
        bundleId: string | null;
        documentPath: string | null;
        lastFrameHash: string | null;
        firstSeen: number;
        lastSeen: number;
        materialType: string | null;
        materialTypeConfidence: number | null;
    }>> {
        const res = await this.request<{ materials?: unknown[] }>('list-materials', { limit });
        return (res.materials ?? []) as Array<{
            materialId: string;
            title: string;
            windowId: number;
            application: string | null;
            bundleId: string | null;
            documentPath: string | null;
            lastFrameHash: string | null;
            firstSeen: number;
            lastSeen: number;
            materialType: string | null;
            materialTypeConfidence: number | null;
        }>;
    }

    /** Get frames for a material (with JPEG data as base64). */
    async getMaterialFrames(materialId: string, limit = 10): Promise<Array<{
        frameId: string;
        materialId: string;
        windowId: number;
        timestamp: number;
        width: number;
        height: number;
        dataBase64: string;
        title: string | null;
        application: string | null;
        bundleId: string | null;
        captureReason: string;
    }>> {
        const res = await this.request<{ frames?: unknown[] }>('get-material-frames', {
            materialId,
            limit,
        });
        return (res.frames ?? []) as Array<{
            frameId: string;
            materialId: string;
            windowId: number;
            timestamp: number;
            width: number;
            height: number;
            dataBase64: string;
            title: string | null;
            application: string | null;
            bundleId: string | null;
            captureReason: string;
        }>;
    }

    /** Get the latest frame for a material (thumbnail). */
    async getMaterialLatestFrame(materialId: string): Promise<{
        frameId: string;
        materialId: string;
        windowId: number;
        timestamp: number;
        width: number;
        height: number;
        dataBase64: string;
        title: string | null;
        application: string | null;
        bundleId: string | null;
        captureReason: string;
    } | null> {
        const res = await this.request<{ frame?: unknown }>('get-material-latest-frame', {
            materialId,
        });
        return (res.frame ?? null) as {
            frameId: string;
            materialId: string;
            windowId: number;
            timestamp: number;
            width: number;
            height: number;
            dataBase64: string;
            title: string | null;
            application: string | null;
            bundleId: string | null;
            captureReason: string;
        } | null;
    }
    // ── Screenshot operations ──────────────────────────────────────────────

    /** Persist a screenshot (fire-and-forget). */
    saveScreenshot(screenshot: {
        screenshotId: string;
        dataBase64: string;
        width: number;
        height: number;
        mimeType?: string;
        timestamp?: number;
        bounds?: { x: number; y: number; width: number; height: number } | null;
        screenshotType?: string | null;
    }): void {
        this.send({
            type: 'save-screenshot',
            screenshotId: screenshot.screenshotId,
            timestamp: screenshot.timestamp ?? Date.now(),
            width: screenshot.width,
            height: screenshot.height,
            dataBase64: screenshot.dataBase64,
            mimeType: screenshot.mimeType ?? 'image/jpeg',
            boundsX: screenshot.bounds?.x ?? null,
            boundsY: screenshot.bounds?.y ?? null,
            boundsW: screenshot.bounds?.width ?? null,
            boundsH: screenshot.bounds?.height ?? null,
            screenshotType: screenshot.screenshotType ?? null,
        });
    }

    /** Get a screenshot by ID (with image data as base64). */
    async getScreenshot(screenshotId: string): Promise<{
        screenshotId: string;
        timestamp: number;
        width: number;
        height: number;
        dataBase64: string;
        mimeType: string;
        boundsX: number | null;
        boundsY: number | null;
        boundsW: number | null;
        boundsH: number | null;
        screenshotType: string | null;
    } | null> {
        const res = await this.request<{ screenshot?: unknown }>('get-screenshot', { screenshotId });
        return (res.screenshot ?? null) as {
            screenshotId: string;
            timestamp: number;
            width: number;
            height: number;
            dataBase64: string;
            mimeType: string;
            boundsX: number | null;
            boundsY: number | null;
            boundsW: number | null;
            boundsH: number | null;
            screenshotType: string | null;
        } | null;
    }

    // ── Material OCR operations ──────────────────────────────────────────

    /**
     * OCR any frames of a material not yet processed, merging the recognized
     * text into the material's accumulated content. Incremental — typically
     * called once per focus session (on MATERIAL_UNFOCUSED).
     *
     * Long timeout: accurate Vision OCR takes 100–500 ms per frame and a
     * session batch can be up to `ocrMaxFramesPerRun` frames.
     */
    async processMaterialOcr(materialId: string): Promise<{
        ok: boolean;
        materialId: string;
        framesProcessed: number;
        addedLines: number;
        lineCount: number;
        textLength: number;
        preview: string | null;
        skipped: string | null;
    }> {
        const res = await this.request<{
            ok?: boolean;
            framesProcessed?: number;
            addedLines?: number;
            lineCount?: number;
            textLength?: number;
            preview?: string;
            skipped?: string;
        }>('process-material-ocr', { materialId }, 120000);
        return {
            ok: res.ok ?? false,
            materialId,
            framesProcessed: res.framesProcessed ?? 0,
            addedLines: res.addedLines ?? 0,
            lineCount: res.lineCount ?? 0,
            textLength: res.textLength ?? 0,
            preview: res.preview ?? null,
            skipped: res.skipped ?? null,
        };
    }

    /** Get the accumulated OCR text for a material (null if never OCRed). */
    async getMaterialOcr(materialId: string): Promise<{
        materialId: string;
        text: string;
        lineCount: number;
        frameCount: number;
        lastFrameTs: number;
        updatedAt: number;
    } | null> {
        const res = await this.request<{ ocr?: unknown }>('get-material-ocr', { materialId });
        return (res.ocr ?? null) as {
            materialId: string;
            text: string;
            lineCount: number;
            frameCount: number;
            lastFrameTs: number;
            updatedAt: number;
        } | null;
    }

    // ── Focus session operations ─────────────────────────────────────────

    /**
     * Record a completed material focus session (fire-and-forget).
     * Atomically inserts the session row and increments the material's total_time_ms.
     */
    recordFocusSession(session: {
        sessionId: string;
        materialId: string;
        startedAt: number;
        endedAt: number;
        durationMs: number;
    }): void {
        this.send({
            type:        'record-focus-session',
            sessionId:   session.sessionId,
            materialId:  session.materialId,
            startedAt:   session.startedAt,
            endedAt:     session.endedAt,
            durationMs:  session.durationMs,
        });
    }

    /**
     * Compute recency-decayed importance weights for all materials that have
     * at least one focus session. Returns a map of materialId → weight [0, 1].
     *
     * Uses Option-B exponential decay: each session's contribution decays by half
     * every `halfLifeDays` days (default: 7). Weight is log-normalized so that
     * ~8 focused hours → 1.0 and brief visits → near 0.
     */
    async getMaterialWeights(halfLifeDays = 7): Promise<Record<string, number>> {
        const res = await this.request<{ weights?: Record<string, number> }>(
            'get-material-weights',
            { halfLifeDays },
        );
        return res.weights ?? {};
    }

    // ── Freeze / unfreeze ───────────────────────────────────────────────

    /** Freeze the memory DB — all writes are silently dropped until unfrozen. Reads still work. */
    async freezeMemory(): Promise<boolean> {
        const res = await this.request<{ frozen?: boolean }>('freeze');
        return res.frozen ?? true;
    }

    /** Unfreeze the memory DB — resume normal write operations. */
    async unfreezeMemory(): Promise<boolean> {
        const res = await this.request<{ frozen?: boolean }>('unfreeze');
        return !(res.frozen ?? false);
    }

    /** Check if the memory DB is currently frozen. */
    async isMemoryFrozen(): Promise<boolean> {
        const res = await this.request<{ frozen?: boolean }>('get-frozen');
        return res.frozen ?? false;
    }

    /** List recent screenshots (metadata only, no image data). */
    async getScreenshots(limit = 50, since = 0): Promise<Array<{
        screenshotId: string;
        timestamp: number;
        width: number;
        height: number;
        mimeType: string;
        boundsX: number | null;
        boundsY: number | null;
        boundsW: number | null;
        boundsH: number | null;
        screenshotType: string | null;
    }>> {
        const res = await this.request<{ screenshots?: unknown[] }>('get-screenshots', { limit, since });
        return (res.screenshots ?? []) as Array<{
            screenshotId: string;
            timestamp: number;
            width: number;
            height: number;
            mimeType: string;
            boundsX: number | null;
            boundsY: number | null;
            boundsW: number | null;
            boundsH: number | null;
            screenshotType: string | null;
        }>;
    }
}

export function createMemoryClient(options?: MemoryClientOptions): MemoryClient {
    return new MemoryClient(options);
}
