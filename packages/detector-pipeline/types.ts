/**
 * Types for the detector-pipeline service layer.
 * Kept independent of @ausm/core so the service has no hard dependency on core.
 *
 * All specs are DetectorSpecs — whether file-defined or runtime-added.
 * The service makes no distinction; the caller decides how to route results.
 */

// ── Detector spec ────────────────────────────────────────────────────────────

export interface DetectorSpec {
    name: string;
    description: string;
    event: string;
    body: string;
    cooldownMs: number;
    /** How often this detector should be evaluated in ms (default: 10000) */
    intervalMs: number;
    /** Debounce delay in ms before evaluating (default: intervalMs / 2). Only for interval-triggered detectors. */
    debounceMs: number;
    /** What triggers evaluation: 'interval' (periodic) or 'screen' (on new frame). Default: 'interval' */
    trigger: 'interval' | 'screen';
    sources: Array<'screen' | 'events'>;
    /** Event types this detector cares about (e.g. ['window-state', 'material']). Omit or empty for all. */
    events?: string[];
    /** When true, this detector always gets its own dedicated LLM call, never bundled with others. */
    isolated?: boolean;
    /** When true, this detector is only evaluated when explicitly dispatched (e.g. via suggested_detectors), not on normal schedule. */
    dispatchOnly?: boolean;
}

// ── Evaluation result ────────────────────────────────────────────────────────

export interface DetectorTriggerResult {
    /** Which detector fired */
    detectorName: string;
    /** Event type string from spec */
    eventType: string;
    /** Model confidence 0–1 */
    confidence: number;
    /** Why the detector fired / actionable response */
    summary: string;
    /** Concrete observations that caused this detection (for debugging/auditing) */
    evidence: string;
    timestamp: number;
    requestTimestamp: number;
    responseTimestamp: number;
    /** Focused application name at the time of detection */
    application?: string | null;
    /** Focused application bundle ID at the time of detection */
    bundleId?: string | null;
    /** Focused window title at the time of detection */
    windowTitle?: string | null;
    /** Other detector names suggested for follow-up evaluation */
    suggestedDetectors?: string[];
    /** Task-tracker fields (rapid-task). Optional for other detectors. */
    taskAction?: string | null;
    taskLabel?: string | null;
    taskDescription?: string | null;
    /** Recency-weighted focus importance of the material active at detection time [0, 1]. */
    focusWeight?: number | null;
    /** Vertex generateContent wall time (send → first response), ms */
    modelLatencyMs?: number | null;
    rawPrompt?: string | null;
    rawModelResponse?: string | null;
}

// ── Activity event (shared shape with task-detector) ─────────────────────────

export interface ActivityEvent {
    eventType: string;
    timestamp: number;
    [key: string]: unknown;
}

// ── Configuration ────────────────────────────────────────────────────────────

export type DetectorProvider = 'vertex' | 'cerebras';

export interface DetectorEvaluateResult {
    triggered: Array<{
        name: string;
        confidence: number;
        summary: string;
        evidence: string;
        suggestedDetectors: string[];
        taskAction?: string;
        taskLabel?: string;
        taskDescription?: string;
    }>;
    rawPrompt: string;
    rawResponse: string;
    modelLatencyMs: number;
    parseMs: number;
    promptBuildMs: number;
    attempt: number;
}

export interface DetectorModelClient {
    evaluate(
        detectors: DetectorSpec[],
        events: ActivityEvent[],
        imageBase64: string | null,
        maxEvents?: number,
        evaluationContext?: string | null,
    ): Promise<DetectorEvaluateResult>;
}

export interface DetectorPipelineConfig {
    /** Model provider. Default: 'vertex'. */
    provider?: DetectorProvider;
    /** Google Cloud project ID for Vertex AI */
    projectId?: string;
    /** Cerebras (or other OpenAI-compatible) API key */
    apiKey?: string;
    /** Override Cerebras API base URL (default: https://api.cerebras.ai/v1) */
    apiBaseUrl?: string;
    /** Google Cloud region (default: 'global') */
    location?: string;
    /** Model name (Vertex default: gemini-2.0-flash; Cerebras default: gemma-4-31b) */
    model?: string;
    /** Maximum events in the rolling buffer (default: 60) */
    maxEventBufferSize?: number;
    /** Maximum age of buffered events in ms (default: 5000) */
    maxEventAgeMs?: number;
    /** Max pixel dimension (longest side) for screen frames sent to the LLM (default: 768) */
    maxScreenshotDimension?: number;
    /** JPEG quality for downsampled screen frames, 1-100 (default: 60) */
    screenshotJpegQuality?: number;
    /** Maximum concurrent Vertex AI evaluate calls (default: 16). Excess calls queue in FIFO order. */
    maxConcurrentEvals?: number;
    /** Enable debug logging */
    debug?: boolean;
}

// ── Prompt trace (observability) ─────────────────────────────────────────────

export interface PromptTrace {
    traceId: string;
    timestamp: number;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    hasImage: boolean;
    rawResponse: string | null;
    parsedResult: DetectorTriggerResult[] | null;
    latencyMs: number;
    /** Vertex generateContent wall time (send → response), ms */
    modelLatencyMs?: number;
    error: string | null;
}

// ── Service events ───────────────────────────────────────────────────────────

export interface DetectorPipelineEvents {
    'detector-triggered': (result: DetectorTriggerResult) => void;
    'prompt-trace': (trace: PromptTrace) => void;
    status: (status: 'started' | 'stopped') => void;
    error: (error: Error) => void;
}
