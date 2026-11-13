/**
 * Detector Pipeline Client — Bridge between AUSM runtime and the
 * @ausm/detector-pipeline service.
 *
 * Wraps the DetectorPipelineService, manages detector specs,
 * feeds screen frames + activity events from runtime detectors
 * into the service, and converts triggered results into typed events.
 */

import { EventEmitter } from 'events';

// Type-only: '@ausm/detector-pipeline' is required lazily in the constructor, so a missing
// optional package doesn't break loading the other clients.
import type {
    DetectorPipelineService,
    DetectorPipelineConfig,
    DetectorTriggerResult as ServiceResult,
    DetectorSpec,
    PromptTrace,
} from '@ausm/detector-pipeline';

export interface DetectorPipelineClientOptions {
    /** 'vertex' (default) or 'cerebras' */
    provider?: 'vertex' | 'cerebras';
    /** Vertex AI project ID */
    projectId?: string;
    /** Cerebras API key */
    apiKey?: string;
    /** Override Cerebras API base URL */
    apiBaseUrl?: string;
    /** Vertex AI region (default: 'global') */
    location?: string;
    /** Model name */
    model?: string;
    /** Enable debug logging */
    debug?: boolean;
    /** Max concurrent Vertex calls (default: 16) */
    maxConcurrentEvals?: number;
}

export interface DetectorPipelineClientResult {
    detectorName: string;
    eventType: string;
    confidence: number;
    summary: string;
    evidence: string;
    timestamp: number;
    /** Focused application name at the time of detection */
    application?: string | null;
    /** Focused application bundle ID at the time of detection */
    bundleId?: string | null;
    /** Focused window title at the time of detection */
    windowTitle?: string | null;
    /** Other detector names suggested for follow-up evaluation */
    suggestedDetectors?: string[];
    /** Recency-weighted focus importance of the material that was active when this detector fired [0, 1]. */
    focusWeight?: number | null;
    requestTimestamp?: number;
    responseTimestamp?: number;
    rawPrompt?: string | null;
    rawModelResponse?: string | null;
    taskAction?: string | null;
    taskLabel?: string | null;
    taskDescription?: string | null;
    /** Vertex generateContent wall time (send → response), ms */
    modelLatencyMs?: number | null;
}

export interface DetectorPipelineClientEvents {
    'detector-triggered': (result: DetectorPipelineClientResult) => void;
    'prompt-trace': (trace: PromptTrace) => void;
    error: (error: Error) => void;
    status: (status: 'started' | 'stopped') => void;
}

export class DetectorPipelineClient extends EventEmitter {
    declare emit: <K extends keyof DetectorPipelineClientEvents>(
        event: K,
        ...args: Parameters<DetectorPipelineClientEvents[K]>
    ) => boolean;
    declare on: <K extends keyof DetectorPipelineClientEvents>(
        event: K,
        listener: DetectorPipelineClientEvents[K],
    ) => this;

    private service: DetectorPipelineService;
    private running = false;
    private debug: boolean;
    private cursorMoveCounter = 0;

    constructor(options: DetectorPipelineClientOptions) {
        super();
        this.debug = options.debug ?? false;

        const config: DetectorPipelineConfig = {
            provider: options.provider,
            projectId: options.projectId,
            apiKey: options.apiKey,
            apiBaseUrl: options.apiBaseUrl,
            location: options.location,
            model: options.model,
            debug: options.debug,
            maxConcurrentEvals: options.maxConcurrentEvals ?? 16,
        };

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DetectorPipelineService: Service } = require('@ausm/detector-pipeline') as typeof import('@ausm/detector-pipeline');
        this.service = new Service(config);

        this.service.on('detector-triggered', (result: ServiceResult) => {
            if (!this.running) return;

            const mapped: DetectorPipelineClientResult = {
                detectorName: result.detectorName,
                eventType: result.eventType,
                confidence: result.confidence,
                summary: result.summary,
                evidence: result.evidence,
                timestamp: result.timestamp,
                application: result.application ?? null,
                bundleId: result.bundleId ?? null,
                windowTitle: result.windowTitle ?? null,
                suggestedDetectors: result.suggestedDetectors,
                focusWeight: result.focusWeight ?? null,
                requestTimestamp: result.requestTimestamp,
                responseTimestamp: result.responseTimestamp,
                rawPrompt: result.rawPrompt ?? null,
                rawModelResponse: result.rawModelResponse ?? null,
                taskAction: result.taskAction ?? null,
                taskLabel: result.taskLabel ?? null,
                taskDescription: result.taskDescription ?? null,
                modelLatencyMs: result.modelLatencyMs ?? null,
            };
            this.emit('detector-triggered', mapped);
            if (this.debug) {
                this.logDebug(
                    `detector triggered: "${mapped.detectorName}" (${mapped.eventType}) confidence=${mapped.confidence}`,
                );
            }
        });

        this.service.on('error', (err: Error) => {
            this.emit('error', err);
        });

        this.service.on('status', (status: 'started' | 'stopped') => {
            this.emit('status', status);
        });

        this.service.on('prompt-trace', (trace: PromptTrace) => {
            this.emit('prompt-trace', trace);
        });
    }

    // ── Detector Spec Management ─────────────────────────────────────────────

    addDetector(spec: DetectorSpec): void {
        this.service.addDetector(spec);
    }

    removeDetector(name: string): void {
        this.service.removeDetector(name);
    }

    getDetectors(): DetectorSpec[] {
        return this.service.getDetectors();
    }

    // ── Screen Frame Feeding ─────────────────────────────────────────────────

    onScreenFrameAvailable(imageBase64: string): void {
        this.service.onScreenFrameAvailable(imageBase64);
    }

    setEvaluationContext(context: string | null): void {
        this.service.setEvaluationContext(context);
    }

    // ── Event Feeding ────────────────────────────────────────────────────────

    pushTextInputEvent(summary: {
        status: string;
        text?: string | null;
        application?: string | null;
    }): void {
        this.service.pushEvent('text-input', summary as Record<string, unknown>, false);
    }

    pushWindowStateEvent(summary: {
        state: string;
        application?: string | null;
        title?: string | null;
        bundleId?: string | null;
        windowId?: number | null;
    }): void {
        this.service.pushEvent('window-state', summary as Record<string, unknown>, false);
    }

    pushTextSelectionEvent(summary: {
        selectedText?: string | null;
        application?: string | null;
        selectionStage?: string | null;
        selectionMethod?: string | null;
        elementType?: string | null;
    }): void {
        this.service.pushEvent('text-selection', summary as Record<string, unknown>, false);
    }

    pushMaterialEvent(summary: {
        type: string;
        materialId?: string | null;
        title?: string | null;
        application?: string | null;
        appMetadata?: Record<string, string | null> | null;
        focusWeight?: number | null;
    }): void {
        if (this.debug) {
            this.logDebug(
                `pushMaterialEvent ${JSON.stringify({ type: summary.type, title: summary.title, application: summary.application })}`,
            );
        }
        this.service.pushEvent('material', summary as Record<string, unknown>);
    }

    pushCursorEvent(summary: {
        action: string;
        x?: number | null;
        y?: number | null;
        application?: string | null;
        uiElementRole?: string | null;
        uiElementLabel?: string | null;
    }): void {
        if (summary.action === 'move') {
            this.cursorMoveCounter++;
            if (this.cursorMoveCounter % 3 !== 0) return;
        }
        this.service.pushEvent('cursor', summary as Record<string, unknown>, false);
    }

    pushCopyPasteEvent(summary: {
        action: string;
        text?: string | null;
    }): void {
        this.service.pushEvent('copy-paste', summary as Record<string, unknown>, false);
    }

    pushScreenshotEvent(summary: {
        status: string;
        type?: string | null;
    }): void {
        this.service.pushEvent('screenshot', summary as Record<string, unknown>, false);
    }

    pushTextHighlightEvent(summary: {
        stage: string;
        highlightCount?: number | null;
    }): void {
        this.service.pushEvent('text-highlight', summary as Record<string, unknown>, false);
    }

    pushEvent(type: string, summary: Record<string, unknown>): void {
        this.service.pushEvent(type, summary);
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    start(): boolean {
        if (this.running) {
            this.logDebug('DetectorPipelineClient already running');
            return true;
        }
        const started = this.service.start();
        if (started) {
            this.running = true;
        }
        return started;
    }

    stop(): boolean {
        if (!this.running) return true;
        this.running = false;
        this.service.stop();
        return true;
    }

    isRunning(): boolean {
        return this.running;
    }

    cleanup(): void {
        this.stop();
        this.service.cleanup();
        this.removeAllListeners();
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[DetectorPipelineClient]', message);
        }
    }
}

export function createDetectorPipelineClient(
    options: DetectorPipelineClientOptions,
): DetectorPipelineClient {
    return new DetectorPipelineClient(options);
}
