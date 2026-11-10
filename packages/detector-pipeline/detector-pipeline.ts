/**
 * Detector Pipeline Service
 *
 * Evaluates DetectorSpecs against screen frames + a rolling buffer of
 * activity events using Google Vertex AI (Gemini).
 *
 * All specs are treated identically — the service doesn't distinguish
 * between file-defined detectors and runtime-added conditions.
 * Whether a spec uses vision, events, or both is determined solely
 * by its `sources` field.
 *
 * Per-group scheduling: each detector group evaluates on its own timer.
 * Screen-triggered groups evaluate immediately on new frames.
 * Focus-aware: app-scoped events are filtered to the currently focused app.
 */

import { EventEmitter } from 'events';

import sharp from 'sharp';

import type {
    DetectorPipelineConfig,
    DetectorPipelineEvents,
    DetectorTriggerResult,
    DetectorSpec,
    ActivityEvent,
    DetectorModelClient,
    DetectorEvaluateResult,
    DetectorProvider,
    PromptTrace,
} from './types';
import { VertexDetectorClient } from './vertex-client';
import { CerebrasDetectorClient, CEREBRAS_DEFAULT_MODEL } from './cerebras-client';

interface DownsampleResult {
    data: string;
    skipped: boolean;
    ms: number;
    fromKB: number;
    toKB: number;
}

/**
 * Cheap resize used only when a frame is about to be sent to the model.
 * JPEG header check avoids a re-encode when the frame already fits.
 * mozjpeg is skipped — it is much slower for little size gain at q=60.
 */
async function downsampleFrame(
    base64: string,
    maxDim: number,
    quality: number,
): Promise<DownsampleResult> {
    const t0 = performance.now();
    const fromKB = Math.round(base64.length / 1024);
    const buf = Buffer.from(base64, 'base64');

    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width > 0 && height > 0 && width <= maxDim && height <= maxDim && meta.format === 'jpeg') {
        return {
            data: base64,
            skipped: true,
            ms: Math.round(performance.now() - t0),
            fromKB,
            toKB: fromKB,
        };
    }

    const resized = await sharp(buf, { failOn: 'none' })
        .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
    const data = resized.toString('base64');
    return {
        data,
        skipped: false,
        ms: Math.round(performance.now() - t0),
        fromKB,
        toKB: Math.round(data.length / 1024),
    };
}

const APP_SCOPED_EVENT_TYPES = new Set([
    'text-input', 'text-selection', 'cursor', 'copy-paste',
]);

/**
 * Fast O(1) fingerprint for base64 image strings.
 * Combines length with characters sampled at fixed offsets to detect identical frames
 * without hashing the entire (often 100KB+) payload.
 */
function frameFingerprint(data: string): string {
    const len = data.length;
    if (len < 64) return `${len}`;
    const step = Math.floor(len / 8);
    let sample = '';
    for (let i = 0; i < 8; i++) {
        sample += data[i * step];
    }
    return `${len}:${sample}`;
}

interface DetectorGroup {
    key: string;
    specs: DetectorSpec[];
    /** True when this group was dispatched by a suggested_detectors result (prevents infinite loops). */
    dispatched?: boolean;
}

export class DetectorPipelineService extends EventEmitter {
    declare emit: <K extends keyof DetectorPipelineEvents>(
        event: K,
        ...args: Parameters<DetectorPipelineEvents[K]>
    ) => boolean;
    declare on: <K extends keyof DetectorPipelineEvents>(
        event: K,
        listener: DetectorPipelineEvents[K],
    ) => this;

    private config: Required<
        Pick<
            DetectorPipelineConfig,
            | 'maxEventBufferSize'
            | 'maxEventAgeMs'
            | 'maxScreenshotDimension'
            | 'screenshotJpegQuality'
            | 'maxConcurrentEvals'
            | 'debug'
        >
    > & DetectorPipelineConfig;

    private client: DetectorModelClient | null = null;
    private running = false;

    private detectors: Map<string, DetectorSpec> = new Map();
    private detectorLastTriggeredAt: Map<string, number> = new Map();
    private detectorLastEvaluatedAt: Map<string, number> = new Map();

    private groupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private groupLastScheduledAt: Map<string, number> = new Map();
    private groupBackoff: Map<string, number> = new Map();

    private eventBuffer: Array<{ type: string; summary: Record<string, unknown>; timestamp: number }> = [];
    private lastEvaluationEventTimestamp = 0;

    private latestScreenFrame: string | null = null;
    private latestScreenFrameTimestamp = 0;
    private latestRawFrame: string | null = null;
    private latestRawFingerprint = '';
    private latestReadyFingerprint = '';
    /** Recent raw-fingerprint → downsampled JPEG. Avoids re-encoding the same frame. */
    private downsampleCache = new Map<string, string>();
    private downsampleInFlight = new Map<string, Promise<DownsampleResult>>();
    private modelLatencySamples: number[] = [];

    private static readonly DOWNSAMPLE_CACHE_LIMIT = 16;

    private focusedApplication: string | null = null;
    private focusedBundleId: string | null = null;
    private focusedWindowTitle: string | null = null;
    private focusedWeight: number | null = null;
    private evaluationContext: string | null = null;

    private frameReceivedAt = 0;
    private lastFrameFingerprint = '';
    private duplicateFrameCount = 0;

    private evalInFlight = 0;
    private evalQueue: Array<() => void> = [];

    constructor(config: DetectorPipelineConfig) {
        super();
        const provider: DetectorProvider = config.provider === 'cerebras' ? 'cerebras' : 'vertex';
        this.config = {
            ...config,
            provider,
            location: config.location ?? 'global',
            model: config.model ?? (provider === 'cerebras' ? CEREBRAS_DEFAULT_MODEL : 'gemini-2.0-flash'),
            maxEventBufferSize: config.maxEventBufferSize ?? 60,
            maxEventAgeMs: config.maxEventAgeMs ?? 5_000,
            maxScreenshotDimension: config.maxScreenshotDimension ?? 768,
            screenshotJpegQuality: config.screenshotJpegQuality ?? 60,
            maxConcurrentEvals: config.maxConcurrentEvals ?? 16,
            debug: config.debug ?? false,
        };
    }

    // ── Detector Management ──────────────────────────────────────────────────

    addDetector(spec: DetectorSpec): void {
        this.detectors.set(spec.name, spec);
        this.logDebug(`Detector added: "${spec.name}" → event: ${spec.event}, interval: ${spec.intervalMs}ms, debounce: ${spec.debounceMs}ms, trigger: ${spec.trigger}`);
    }

    removeDetector(name: string): void {
        this.detectors.delete(name);
        this.detectorLastTriggeredAt.delete(name);
        this.detectorLastEvaluatedAt.delete(name);
        this.clearStaleGroupTimers();
        this.logDebug(`Detector removed: "${name}"`);
    }

    getDetectors(): DetectorSpec[] {
        return Array.from(this.detectors.values());
    }

    private getEvaluableSpecs(): DetectorSpec[] {
        const now = Date.now();
        return Array.from(this.detectors.values()).filter((d) => {
            if (d.dispatchOnly) return false;

            const lastTriggered = this.detectorLastTriggeredAt.get(d.name);
            if (lastTriggered && now - lastTriggered < d.cooldownMs) return false;

            const lastEvaluated = this.detectorLastEvaluatedAt.get(d.name);
            if (d.trigger === 'screen') {
                if (lastEvaluated && this.latestScreenFrameTimestamp <= lastEvaluated) return false;
            } else {
                if (lastEvaluated && now - lastEvaluated < d.intervalMs) return false;
            }
            return true;
        });
    }

    // ── Screen Frame ─────────────────────────────────────────────────────────

    onScreenFrameAvailable(imageBase64: string): void {
        const fingerprint = frameFingerprint(imageBase64);
        if (fingerprint === this.lastFrameFingerprint) {
            this.duplicateFrameCount++;
            return;
        }
        this.duplicateFrameCount = 0;
        this.lastFrameFingerprint = fingerprint;
        this.frameReceivedAt = Date.now();
        this.latestScreenFrameTimestamp = Date.now();
        // Stash the raw frame only. Resize happens once, right before Vertex.
        this.latestRawFrame = imageBase64;
        this.latestRawFingerprint = fingerprint;
    }

    private async getFrameForEval(): Promise<{ data: string | null; downsampleMs: number }> {
        if (!this.latestRawFrame) {
            return { data: this.latestScreenFrame, downsampleMs: 0 };
        }

        const fingerprint = this.latestRawFingerprint;
        const cached = this.downsampleCache.get(fingerprint);
        if (cached) {
            this.downsampleCache.delete(fingerprint);
            this.downsampleCache.set(fingerprint, cached);
            this.latestScreenFrame = cached;
            this.latestReadyFingerprint = fingerprint;
            return { data: cached, downsampleMs: 0 };
        }

        try {
            const result = await this.downsampleRawFrame(this.latestRawFrame, fingerprint);
            this.latestScreenFrame = result.data;
            this.latestReadyFingerprint = fingerprint;
            this.rememberDownsample(fingerprint, result.data);
            this.logDebug(
                result.skipped
                    ? `Frame already fits (${result.fromKB}KB, ${result.ms}ms)`
                    : `Frame downsampled: ${result.fromKB}KB → ${result.toKB}KB in ${result.ms}ms`,
            );
            return { data: result.data, downsampleMs: result.ms };
        } catch (err) {
            this.latestScreenFrame = this.latestRawFrame;
            this.latestReadyFingerprint = fingerprint;
            this.rememberDownsample(fingerprint, this.latestRawFrame);
            this.logDebug(`Frame downsample failed, using original: ${err instanceof Error ? err.message : String(err)}`);
            return { data: this.latestRawFrame, downsampleMs: 0 };
        }
    }

    private downsampleRawFrame(raw: string, fingerprint: string): Promise<DownsampleResult> {
        const existing = this.downsampleInFlight.get(fingerprint);
        if (existing) return existing;

        const work = downsampleFrame(
            raw,
            this.config.maxScreenshotDimension,
            this.config.screenshotJpegQuality,
        ).finally(() => {
            this.downsampleInFlight.delete(fingerprint);
        });
        this.downsampleInFlight.set(fingerprint, work);
        return work;
    }

    private rememberDownsample(fingerprint: string, data: string): void {
        if (this.downsampleCache.has(fingerprint)) {
            this.downsampleCache.delete(fingerprint);
        }
        this.downsampleCache.set(fingerprint, data);
        while (this.downsampleCache.size > DetectorPipelineService.DOWNSAMPLE_CACHE_LIMIT) {
            const oldest = this.downsampleCache.keys().next().value;
            if (oldest == null) break;
            this.downsampleCache.delete(oldest);
        }
    }

    // ── Event Buffer ─────────────────────────────────────────────────────────

    setEvaluationContext(context: string | null): void {
        this.evaluationContext = context;
    }

    pushEvent(type: string, summary: Record<string, unknown>, schedule = true): void {
        this.eventBuffer.push({ type, summary, timestamp: Date.now() });
        this.pruneEventBuffer();

        if (type === 'window-state' && summary.state === 'FOCUSED') {
            if (typeof summary.application === 'string') {
                this.focusedApplication = summary.application;
            }
            if (typeof summary.bundleId === 'string') {
                this.focusedBundleId = summary.bundleId;
            }
            if (typeof summary.title === 'string') {
                this.focusedWindowTitle = summary.title;
            }
        }

        if (type === 'material' && typeof summary.focusWeight === 'number') {
            this.focusedWeight = summary.focusWeight;
        }

        if (schedule) {
            this.scheduleGroups('event');
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    start(): boolean {
        if (this.running) return true;

        try {
            this.client = this.createModelClient();
            this.logDebug(`provider=${this.config.provider} model=${this.config.model}`);
        } catch (err) {
            this.safeEmitError(err instanceof Error ? err : new Error(String(err)));
            return false;
        }

        this.running = true;
        this.logDebug('DetectorPipelineService started');
        this.emit('status', 'started');
        return true;
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;
        this.clearAllGroupTimers();
        this.logDebug('DetectorPipelineService stopped');
        this.emit('status', 'stopped');
    }

    cleanup(): void {
        this.stop();
        this.client = null;
        this.detectors.clear();
        this.detectorLastTriggeredAt.clear();
        this.detectorLastEvaluatedAt.clear();
        this.groupBackoff.clear();
        this.groupLastScheduledAt.clear();
        this.evalInFlight = 0;
        this.evalQueue = [];
        this.eventBuffer = [];
        this.lastEvaluationEventTimestamp = 0;
        this.latestScreenFrame = null;
        this.latestRawFrame = null;
        this.latestRawFingerprint = '';
        this.latestReadyFingerprint = '';
        this.downsampleCache.clear();
        this.downsampleInFlight.clear();
        this.modelLatencySamples = [];
        this.focusedApplication = null;
        this.focusedBundleId = null;
        this.focusedWindowTitle = null;
        this.focusedWeight = null;
        this.evaluationContext = null;
        this.lastFrameFingerprint = '';
        this.duplicateFrameCount = 0;
        this.removeAllListeners();
    }

    isRunning(): boolean {
        return this.running;
    }

    /**
     * Force an immediate evaluation of all evaluable groups (bypasses debounce but respects cooldown).
     */
    async forceEvaluate(): Promise<DetectorTriggerResult[]> {
        const evaluable = this.getEvaluableSpecs();
        if (evaluable.length === 0 || !this.client) return [];

        const groups = this.groupByRequirements(evaluable);
        const allResults: DetectorTriggerResult[] = [];
        const promises = groups.map(async (group) => {
            const results = await this.doEvaluateGroup(group);
            allResults.push(...results);
        });
        await Promise.all(promises);
        return allResults;
    }

    // ── Per-Group Scheduling ─────────────────────────────────────────────────

    private scheduleGroups(source: 'frame' | 'event'): void {
        if (!this.running) return;

        const evaluable = this.getEvaluableSpecs();
        if (evaluable.length === 0) return;

        const groups = this.groupByRequirements(evaluable);

        for (const group of groups) {
            const hasScreenTrigger = group.specs.some(d => d.trigger === 'screen');
            if (hasScreenTrigger) {
                if (source !== 'frame') continue;
                this.tryEvaluateGroup(group);
            } else {
                const debounceMs = Math.min(...group.specs.map(d => d.debounceMs));
                if (debounceMs <= 0) {
                    this.tryEvaluateGroup(group);
                } else {
                    this.scheduleGroupTimer(group, debounceMs);
                }
            }
        }
    }

    /**
     * Throttle-with-trailing: guarantees max latency of `debounceMs` from the
     * *first* triggering event, rather than resetting on every new event.
     */
    private scheduleGroupTimer(group: DetectorGroup, debounceMs: number): void {
        const backoff = this.groupBackoff.get(group.key) ?? 1;
        const effectiveMs = Math.round(debounceMs * backoff);

        const now = Date.now();
        const lastScheduled = this.groupLastScheduledAt.get(group.key);

        if (!lastScheduled || now - lastScheduled >= effectiveMs) {
            this.groupLastScheduledAt.set(group.key, now);
            const existing = this.groupTimers.get(group.key);
            if (existing) clearTimeout(existing);
            this.groupTimers.set(group.key, setTimeout(() => {
                this.groupTimers.delete(group.key);
                this.tryEvaluateGroup(group);
            }, effectiveMs));
            return;
        }

        if (this.groupTimers.has(group.key)) return;

        const remaining = effectiveMs - (now - lastScheduled);
        this.groupTimers.set(group.key, setTimeout(() => {
            this.groupTimers.delete(group.key);
            this.groupLastScheduledAt.set(group.key, Date.now());
            this.tryEvaluateGroup(group);
        }, remaining));
    }

    private tryEvaluateGroup(group: DetectorGroup): void {
        this.doEvaluateGroup(group).catch((err) => {
            this.safeEmitError(err instanceof Error ? err : new Error(String(err)));
        });
    }

    private async doEvaluateGroup(group: DetectorGroup): Promise<DetectorTriggerResult[]> {
        if (!this.client) return [];

        const evalStartMs = Date.now();
        const frameReceivedAtSnapshot = this.frameReceivedAt;
        const detectorNames = group.specs.map(d => d.name).join(', ');

        // Eagerly mark specs as evaluated so concurrent scheduleGroups() calls
        // won't fire duplicate LLM calls for the same frame / interval window.
        for (const spec of group.specs) {
            this.detectorLastEvaluatedAt.set(spec.name, evalStartMs);
        }

        try {
            const newEvents = this.collectNewEvents();

            const hasScreen = group.specs.some(d => d.sources.includes('screen'));
            const hasEvents = group.specs.some(d => d.sources.includes('events'));
            const preparedFrame = hasScreen ? await this.getFrameForEval() : { data: null, downsampleMs: 0 };
            const imageBase64 = preparedFrame.data;

            let events = hasEvents ? newEvents : [];
            if (hasEvents) {
                const eventFilter = this.getGroupEventFilter(group.specs);
                if (eventFilter) {
                    events = events.filter(e => eventFilter.has(e.eventType));
                }
            }

            if (!imageBase64 && events.length === 0) {
                return [];
            }

            const isScreenGroup = group.specs.every(d => d.trigger === 'screen');
            const maxEvents = isScreenGroup ? 20 : undefined;

            await this.acquireEvalSlot();
            let evalResult: DetectorEvaluateResult;
            try {
                evalResult = await this.client.evaluate(
                    group.specs,
                    events,
                    imageBase64,
                    maxEvents,
                    this.evaluationContext,
                );
            } finally {
                this.releaseEvalSlot();
            }
            const { triggered, rawPrompt, rawResponse, modelLatencyMs, parseMs, promptBuildMs, attempt } = evalResult;
            const e2eMs = frameReceivedAtSnapshot > 0 ? Date.now() - frameReceivedAtSnapshot : Date.now() - evalStartMs;
            this.recordModelLatency(modelLatencyMs);

            console.log(
                `[detector-pipeline] [${detectorNames}]` +
                ` model=${modelLatencyMs}ms send→response` +
                (attempt > 0 ? ` (attempt ${attempt + 1})` : '') +
                ` avg=${this.averageModelLatency()}ms` +
                ` | downsample=${preparedFrame.downsampleMs}ms` +
                ` | prompt=${promptBuildMs}ms parse=${parseMs}ms` +
                (imageBase64 ? ` | image=${Math.round(imageBase64.length / 1024)}KB` : '') +
                ` | e2e=${e2eMs}ms` +
                ` — ${triggered.length} triggered` +
                (triggered.length > 0
                    ? '\n' + triggered.map(t =>
                        `  ▸ ${t.name} (${t.confidence}) — ${t.summary}` +
                        (t.suggestedDetectors.length > 0 ? ` → dispatch: [${t.suggestedDetectors.join(', ')}]` : ''),
                    ).join('\n')
                    : ''),
            );

            const results: DetectorTriggerResult[] = [];
            const allSuggestedNames = new Set<string>();

            for (const item of triggered) {
                const spec = this.detectors.get(item.name);
                if (!spec) continue;

                const now = Date.now();
                this.detectorLastTriggeredAt.set(item.name, now);

                const hasSuggestions = item.suggestedDetectors.length > 0;
                const result: DetectorTriggerResult = {
                    detectorName: item.name,
                    eventType: spec.event,
                    confidence: item.confidence,
                    summary: item.summary,
                    evidence: item.evidence,
                    timestamp: now,
                    requestTimestamp: now - modelLatencyMs,
                    responseTimestamp: now,
                    application: this.focusedApplication,
                    bundleId: this.focusedBundleId,
                    windowTitle: this.focusedWindowTitle,
                    focusWeight: this.focusedWeight,
                    suggestedDetectors: hasSuggestions ? item.suggestedDetectors : undefined,
                    taskAction: item.taskAction,
                    taskLabel: item.taskLabel,
                    taskDescription: item.taskDescription,
                    modelLatencyMs,
                    rawPrompt,
                    rawModelResponse: rawResponse,
                };

                results.push(result);
                this.logDebug(
                    `Detector triggered: "${item.name}" confidence=${item.confidence} — cooldown for ${spec.cooldownMs}ms`,
                );
                this.emit('detector-triggered', result);

                if (hasSuggestions) {
                    for (const name of item.suggestedDetectors) allSuggestedNames.add(name);
                }
            }

            // Dispatch suggested detectors using the same screen frame.
            // Only dispatch from non-dispatched evaluations to prevent infinite loops.
            if (allSuggestedNames.size > 0 && !group.dispatched) {
                this.dispatchSuggested(allSuggestedNames, imageBase64).then((dispatched) => {
                    results.push(...dispatched);
                }).catch((err) => {
                    this.safeEmitError(err instanceof Error ? err : new Error(String(err)));
                });
            }

            const backoff = this.groupBackoff.get(group.key) ?? 1;
            if (backoff > 1) {
                this.groupBackoff.set(group.key, Math.max(1, backoff / 2));
            }

            return results;
        } catch (err) {
            const failMs = Date.now() - evalStartMs;
            console.log(`[detector-pipeline] [${detectorNames}] error after ${failMs}ms: ${err instanceof Error ? err.message : String(err)}`);

            const isRateLimit = err instanceof Error &&
                (err.message.includes('429') || err.message.includes('RESOURCE_EXHAUSTED'));
            if (isRateLimit) {
                const current = this.groupBackoff.get(group.key) ?? 1;
                this.groupBackoff.set(group.key, Math.min(16, current * 2));
                this.logDebug(
                    `Group [${group.key}] rate limited — backoff increased to ${this.groupBackoff.get(group.key)}x`,
                );
            }
            this.safeEmitError(err instanceof Error ? err : new Error(String(err)));
            return [];
        }
    }

    // ── Suggested Detector Dispatch ────────────────────────────────────────────

    /**
     * Immediately evaluate suggested detectors, bypassing cooldown/debounce.
     * Uses the provided screen frame (the same one the dispatcher saw) so the
     * follow-up detector analyses the identical visual context.
     */
    private async dispatchSuggested(
        names: Set<string>,
        screenFrame: string | null,
    ): Promise<DetectorTriggerResult[]> {
        if (!this.client || !this.running) return [];

        const specs: DetectorSpec[] = [];
        for (const name of names) {
            const spec = this.detectors.get(name);
            if (!spec) {
                this.logDebug(`Dispatch: skipping unknown detector "${name}"`);
                continue;
            }
            specs.push(spec);
        }

        if (specs.length === 0) return [];

        console.log(`[detector-pipeline] Dispatching suggested detectors: ${specs.map(s => s.name).join(', ')}`);

        // Pin the already-prepared frame so follow-up evals skip another resize.
        const savedFrame = this.latestScreenFrame;
        const savedFrameTs = this.latestScreenFrameTimestamp;
        const savedReadyFp = this.latestReadyFingerprint;
        if (screenFrame) {
            this.latestScreenFrame = screenFrame;
            this.latestScreenFrameTimestamp = Date.now();
            this.latestReadyFingerprint = this.latestRawFingerprint;
        }

        const groups = this.groupByRequirements(specs);
        const allResults: DetectorTriggerResult[] = [];

        try {
            const promises = groups.map(async (group) => {
                group.dispatched = true;
                const results = await this.doEvaluateGroup(group);
                allResults.push(...results);
            });
            await Promise.all(promises);
        } finally {
            this.latestScreenFrame = savedFrame;
            this.latestScreenFrameTimestamp = savedFrameTs;
            this.latestReadyFingerprint = savedReadyFp;
        }

        return allResults;
    }

    // ── Grouping ─────────────────────────────────────────────────────────────

    private groupByRequirements(specs: DetectorSpec[]): DetectorGroup[] {
        const groups = new Map<string, DetectorSpec[]>();
        const isolated: DetectorGroup[] = [];

        for (const spec of specs) {
            const sourcesKey = [...spec.sources].sort().join(',');
            const eventsKey = spec.events && spec.events.length > 0
                ? [...spec.events].sort().join(',')
                : '*';
            const key = `${sourcesKey}|${eventsKey}`;

            if (spec.isolated) {
                isolated.push({ key: `isolated:${spec.name}|${key}`, specs: [spec] });
            } else {
                const group = groups.get(key);
                if (group) {
                    group.push(spec);
                } else {
                    groups.set(key, [spec]);
                }
            }
        }

        return [
            ...Array.from(groups.entries()).map(([key, specs]) => ({ key, specs })),
            ...isolated,
        ];
    }

    private getGroupEventFilter(specs: DetectorSpec[]): Set<string> | null {
        for (const spec of specs) {
            if (!spec.events || spec.events.length === 0) return null;
        }
        const allTypes = new Set<string>();
        for (const spec of specs) {
            for (const e of spec.events!) {
                allTypes.add(e);
            }
        }
        return allTypes;
    }

    // ── Event Collection ─────────────────────────────────────────────────────

    private collectNewEvents(): ActivityEvent[] {
        this.pruneEventBuffer();

        const newEvents: ActivityEvent[] = [];
        let latestTimestamp = this.lastEvaluationEventTimestamp;
        const focusApp = this.focusedApplication;

        for (const entry of this.eventBuffer) {
            if (entry.timestamp > this.lastEvaluationEventTimestamp) {
                latestTimestamp = Math.max(latestTimestamp, entry.timestamp);

                if (focusApp && APP_SCOPED_EVENT_TYPES.has(entry.type) && entry.summary.application) {
                    const eventApp = entry.summary.application as string;
                    if (eventApp !== focusApp && eventApp !== this.focusedBundleId) {
                        continue;
                    }
                }

                newEvents.push({
                    eventType: entry.type,
                    timestamp: entry.timestamp,
                    ...entry.summary,
                });
            }
        }

        this.lastEvaluationEventTimestamp = latestTimestamp;
        return newEvents;
    }

    // ── Timer Cleanup ────────────────────────────────────────────────────────

    private clearAllGroupTimers(): void {
        for (const timer of this.groupTimers.values()) {
            clearTimeout(timer);
        }
        this.groupTimers.clear();
    }

    private clearStaleGroupTimers(): void {
        const activeNames = new Set(this.detectors.keys());
        for (const [key, timer] of this.groupTimers.entries()) {
            if (key.startsWith('isolated:')) {
                const detectorName = key.split('|')[0].replace('isolated:', '');
                if (!activeNames.has(detectorName)) {
                    clearTimeout(timer);
                    this.groupTimers.delete(key);
                    this.groupBackoff.delete(key);
                }
            }
        }
    }

    // ── Concurrency Control ─────────────────────────────────────────────────

    private acquireEvalSlot(): Promise<void> {
        if (this.evalInFlight < this.config.maxConcurrentEvals) {
            this.evalInFlight++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.evalQueue.push(() => {
                this.evalInFlight++;
                resolve();
            });
        });
    }

    private releaseEvalSlot(): void {
        const next = this.evalQueue.shift();
        if (next) {
            next();
        } else {
            this.evalInFlight--;
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private pruneEventBuffer(): void {
        const now = Date.now();
        const cutoff = now - this.config.maxEventAgeMs;
        this.eventBuffer = this.eventBuffer.filter((e) => e.timestamp >= cutoff);
        if (this.eventBuffer.length > this.config.maxEventBufferSize) {
            this.eventBuffer = this.eventBuffer.slice(-this.config.maxEventBufferSize);
        }
    }

    private safeEmitError(err: Error): void {
        if (this.listenerCount('error') > 0) {
            this.emit('error', err);
        } else {
            console.error(`[detector-pipeline] Unhandled error: ${err.message}`);
        }
    }

    private recordModelLatency(ms: number): void {
        this.modelLatencySamples.push(ms);
        if (this.modelLatencySamples.length > 20) {
            this.modelLatencySamples.shift();
        }
    }

    private averageModelLatency(): number {
        if (this.modelLatencySamples.length === 0) return 0;
        const sum = this.modelLatencySamples.reduce((acc, value) => acc + value, 0);
        return Math.round(sum / this.modelLatencySamples.length);
    }

    private createModelClient(): DetectorModelClient {
        const onTrace = (trace: PromptTrace) => {
            this.emit('prompt-trace', trace);
        };

        if (this.config.provider === 'cerebras') {
            const apiKey = this.config.apiKey?.trim();
            if (!apiKey) {
                throw new Error('Cerebras detector pipeline requires CEREBRAS_API_KEY');
            }
            return new CerebrasDetectorClient({
                apiKey,
                model: this.config.model!,
                baseUrl: this.config.apiBaseUrl,
                onTrace,
            });
        }

        const projectId = this.config.projectId?.trim();
        if (!projectId) {
            throw new Error('Vertex detector pipeline requires TASK_DETECTOR_PROJECT_ID');
        }
        return new VertexDetectorClient({
            projectId,
            location: this.config.location!,
            model: this.config.model!,
            onTrace,
        });
    }

    private logDebug(msg: string): void {
        if (this.config.debug) {
            console.log(`[detector-pipeline] ${msg}`);
        }
    }
}

export function createDetectorPipeline(
    config: DetectorPipelineConfig,
): DetectorPipelineService {
    return new DetectorPipelineService(config);
}
