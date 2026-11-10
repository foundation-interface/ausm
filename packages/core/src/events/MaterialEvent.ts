import { AUSMEvent, EventDataOf, createAUSMEvent } from '../AUSM';
import { Rect } from '../types';

export enum MaterialEventType {
    /** A new significant frame was captured for a material */
    FRAME_CAPTURED = 'FRAME_CAPTURED',
    /** A new material was created (new tab/title detected) */
    MATERIAL_CREATED = 'MATERIAL_CREATED',
    /** A material was classified with a content type (code-editor, browser, etc.) */
    MATERIAL_TYPE_CLASSIFIED = 'MATERIAL_TYPE_CLASSIFIED',
    /** A material's window gained focus (user is looking at this material) */
    MATERIAL_FOCUSED = 'MATERIAL_FOCUSED',
    /** A material's window lost focus (user switched away) */
    MATERIAL_UNFOCUSED = 'MATERIAL_UNFOCUSED',
    /** New OCR text was extracted and merged into the material's content */
    MATERIAL_CONTENT_UPDATED = 'MATERIAL_CONTENT_UPDATED',
}

export interface MaterialEvent extends AUSMEvent {
    readonly kind: 'material';
    /** The type of material event */
    readonly materialEventType: MaterialEventType | null;
    /** Stable identifier for the material */
    readonly materialId: string | null;
    /** macOS CGWindowID of the parent window */
    readonly windowId: number | null;
    /** Window/tab title at the time of the event */
    readonly title: string | null;
    /** Application name */
    readonly application: string | null;
    /** Application bundle identifier */
    readonly bundleId: string | null;
    /** File URL from the macOS AXDocument attribute (null for non-document windows) */
    readonly documentPath: string | null;

    // ── Window state ──────────────────────────────────────────────────────
    /** Current window bounds in screen coordinates */
    readonly bounds: Rect | null;
    /** macOS CGDirectDisplayID of the display the window is on */
    readonly displayId: number | null;
    /** Process ID of the owning application */
    readonly pid: number | null;

    // ── Frame-specific (FRAME_CAPTURED) ──────────────────────────────────
    /** Unique identifier for the captured frame */
    readonly frameId: string | null;
    /** Frame width in pixels */
    readonly frameWidth: number | null;
    /** Frame height in pixels */
    readonly frameHeight: number | null;
    /** JPEG frame data size in bytes */
    readonly frameSizeBytes: number | null;
    /** JPEG frame data as a base64-encoded string (present on FRAME_CAPTURED events) */
    readonly frameDataBase64: string | null;
    /** Why this frame was captured. Values: APPEAR, FOCUSED, TITLE_CHANGED, UNFOCUSED, PERIODIC */
    readonly captureReason: string | null;

    // ── Material lifecycle ─────────────────────────────────────────────────
    /** Whether this is a newly created material */
    readonly isNew: boolean;
    /** Timestamp when the material was first seen */
    readonly firstSeen: number | null;
    /** Timestamp of the most recent activity */
    readonly lastSeen: number | null;

    // ── Material type (LLM-classified) ─────────────────────────────────────
    /** Content type (e.g. code-editor, browser, terminal) */
    readonly materialType: string | null;
    /** Confidence of material type classification (0–1) */
    readonly materialTypeConfidence: number | null;

    // ── Application metadata (extractor-populated) ─────────────────────────
    /**
     * Application-specific metadata extracted by a MaterialMetadataExtractor.
     * Examples: `{ url, hostname }` for browsers; `{ file, filename }` for IDEs.
     * Null when no extractor matched or produced data.
     */
    readonly appMetadata: Record<string, string | null> | null;

    // ── OCR content (MATERIAL_CONTENT_UPDATED) ─────────────────────────────
    /** Total length (chars) of the material's accumulated OCR text */
    readonly contentLength: number | null;
    /** Number of deduplicated OCR lines accumulated for this material */
    readonly contentLineCount: number | null;
    /** First ~300 chars of the accumulated OCR text (full text via runtime.getMaterialContent) */
    readonly contentPreview: string | null;
    /** Number of new lines added by the OCR run that produced this event */
    readonly contentAddedLines: number | null;

    // ── Focus weight ───────────────────────────────────────────────────────
    /**
     * Recency-decayed importance weight in [0, 1] derived from the user's
     * cumulative focus history on this material (Option-B exponential decay,
     * 7-day half-life, 8-hour reference).
     * Null until at least one focus session has been recorded and the weight
     * cache has been populated.
     */
    readonly focusWeight: number | null;
}

export type MaterialEventData = EventDataOf<MaterialEvent>;

export function createMaterialEvent(data: MaterialEventData = {}): MaterialEvent {
    return {
        ...createAUSMEvent('material', data),
        materialEventType: data.materialEventType ?? null,
        materialId: data.materialId ?? null,
        windowId: data.windowId ?? null,
        title: data.title ?? null,
        application: data.application ?? null,
        bundleId: data.bundleId ?? null,
        documentPath: data.documentPath ?? null,
        bounds: data.bounds ?? null,
        displayId: data.displayId ?? null,
        pid: data.pid ?? null,
        frameId: data.frameId ?? null,
        frameWidth: data.frameWidth ?? null,
        frameHeight: data.frameHeight ?? null,
        frameSizeBytes: data.frameSizeBytes ?? null,
        frameDataBase64: data.frameDataBase64 ?? null,
        captureReason: data.captureReason ?? null,
        isNew: data.isNew ?? false,
        firstSeen: data.firstSeen ?? null,
        lastSeen: data.lastSeen ?? null,
        materialType: data.materialType ?? null,
        materialTypeConfidence: data.materialTypeConfidence ?? null,
        appMetadata: data.appMetadata ?? null,
        contentLength: data.contentLength ?? null,
        contentLineCount: data.contentLineCount ?? null,
        contentPreview: data.contentPreview ?? null,
        contentAddedLines: data.contentAddedLines ?? null,
        focusWeight: data.focusWeight ?? null,
    };
}
