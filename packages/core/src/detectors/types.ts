/**
 * Types for the detector system — file-based, multimodal detection specs
 * evaluated via LLM against screen frames + activity events.
 */

import { AUSMEvent, EventDataOf, createAUSMEvent } from '../AUSM';

// ============================================================================
// Detector Frontmatter (YAML header of DETECTOR.md)
// ============================================================================

export interface DetectorFrontmatter {
    /** Unique detector name */
    name: string;
    /** One-line description */
    description: string;
    /** Event type string emitted when this detector fires */
    event: string;
    /** Minimum ms between consecutive firings (default: 10000) */
    cooldown?: number;
    /** How often this detector should be evaluated in ms (default: cooldown value) */
    interval?: number;
    /** Debounce delay in ms before evaluating (default: interval / 2). Only for interval-triggered. */
    debounce?: number;
    /** What triggers evaluation: 'interval' (periodic) or 'screen' (on new frame). Default: 'interval' */
    trigger?: 'interval' | 'screen';
    /** Whether this detector is active (default: true) */
    enabled?: boolean;
    /** Input signals: 'screen' (vision), 'events' (activity stream). Default: both */
    sources?: Array<'screen' | 'events'>;
    /** Event types this detector cares about (e.g. ['window-state', 'material']). Omit for all. */
    events?: string[];
    /** When true, this detector always gets its own dedicated LLM call. Default: false */
    isolated?: boolean;
    /** When true, this detector is only evaluated when dispatched (e.g. via suggested_detectors). Default: false */
    dispatchOnly?: boolean;
}

// ============================================================================
// Detector Entry (loaded detector ready for use)
// ============================================================================

export interface DetectorEntry {
    /** Unique detector name (from frontmatter) */
    name: string;
    /** One-line description (from frontmatter) */
    description: string;
    /** Event type string emitted when fired */
    event: string;
    /** Parsed frontmatter */
    frontmatter: DetectorFrontmatter;
    /** Full DETECTOR.md body (markdown after frontmatter) — the NL detection spec */
    body: string;
    /** Absolute path to the detector directory */
    dirPath: string;
    /** Absolute path to the DETECTOR.md file */
    filePath: string;
    /** Cooldown in ms between firings */
    cooldownMs: number;
    /** How often this detector should be evaluated in ms */
    intervalMs: number;
    /** Debounce delay in ms before evaluating */
    debounceMs: number;
    /** What triggers evaluation: 'interval' or 'screen' */
    trigger: 'interval' | 'screen';
    /** Whether this detector is currently enabled */
    enabled: boolean;
    /** Input signal sources */
    sources: Array<'screen' | 'events'>;
    /** Event types this detector cares about. Undefined/empty means all. */
    events?: string[];
    /** When true, this detector always gets its own dedicated LLM call. */
    isolated?: boolean;
    /** When true, only evaluated when explicitly dispatched. */
    dispatchOnly?: boolean;
}

// ============================================================================
// Detectors Configuration
// ============================================================================

export interface DetectorsConfig {
    /** Enable the detector system. Default: true */
    enabled?: boolean;
    /** Additional directories to scan for detectors */
    extraDirs?: string[];
    /** Per-detector overrides */
    entries?: Record<string, DetectorEntryConfig>;
    /** Maximum file size per DETECTOR.md in bytes. Default: 262144 (256KB) */
    maxDetectorFileBytes?: number;
}

export interface DetectorEntryConfig {
    enabled?: boolean;
}

// ============================================================================
// Detector Event (emitted when a detector fires)
// ============================================================================

export interface DetectorEvent extends AUSMEvent {
    readonly kind: 'detector';
    /** Name of the detector that fired */
    readonly detectorName: string;
    /** Event type string from DETECTOR.md frontmatter */
    readonly eventType: string;
    /** Model confidence 0–1 */
    readonly confidence: number;
    /** Brief explanation of why the detector fired */
    readonly summary: string;
    /** Concrete observations that caused this detection (for debugging/auditing) */
    readonly evidence: string;
    /** Focused application name at the time of detection */
    readonly application: string | null;
    /** Focused application bundle ID at the time of detection */
    readonly bundleId: string | null;
    /** Focused window title at the time of detection */
    readonly windowTitle: string | null;
    /** Other detector names suggested for follow-up evaluation */
    readonly suggestedDetectors: string[];
    /** Vertex generateContent wall time (send → response), ms */
    readonly modelLatencyMs: number | null;
}

export type DetectorEventData = EventDataOf<DetectorEvent>;

export function createDetectorEvent(data: DetectorEventData = {}): DetectorEvent {
    return {
        ...createAUSMEvent('detector', data),
        detectorName: data.detectorName ?? '',
        eventType: data.eventType ?? '',
        confidence: data.confidence ?? 0,
        summary: data.summary ?? '',
        evidence: data.evidence ?? '',
        application: data.application ?? null,
        bundleId: data.bundleId ?? null,
        windowTitle: data.windowTitle ?? null,
        suggestedDetectors: data.suggestedDetectors ?? [],
        modelLatencyMs: data.modelLatencyMs ?? null,
    };
}
