/**
 * Types for the cursor-plus-plus service layer.
 * Kept independent of @ausm/core so the service has no hard dependency on core.
 */

// ── Mouse action (mirrors core enum for decoupling) ─────────────────────

export type MouseActionLike =
    | 'MOVE'
    | 'CLICK'
    | 'DOUBLE_CLICK'
    | 'RIGHT_CLICK'
    | 'SCROLL'
    | 'HOLD_START'
    | 'HOLD_END'
    | 'DRAG';

// ── Interaction screenshot ───────────────────────────────────────────────

/**
 * Structured image payload for the interaction screenshot.
 * Mirrors InteractionScreenshot from @ausm/core.
 */
export interface InteractionScreenshotLike {
    dataBase64: string;
    width: number;
    height: number;
    mimeType: 'image/jpeg';
}

// ── Native helper event (JSON lines over stdout) ────────────────────────

/**
 * Raw event from the Swift CursorHelper subprocess.
 * The helper uses CGEventTap for mouse tracking and AXUIElement queries
 * for the element under the cursor.
 */
export interface NativeCursorEvent {
    /** Discriminator: 'ready' on startup handshake, 'cursor-event' for data, 'error' for problems */
    type: 'ready' | 'cursor-event' | 'error';

    action?: MouseActionLike;

    /** Screen-space cursor position (logical points) */
    x?: number;
    y?: number;

    /** Mouse button: 0 = left, 1 = middle, 2 = right */
    button?: number;
    clickCount?: number;

    scrollDeltaX?: number;
    scrollDeltaY?: number;

    /** Hold duration in ms (HOLD_START: time until the hold was recognised; HOLD_END: total) */
    holdDurationMs?: number;

    /** CGWindowID of the window under the cursor */
    windowId?: number;
    windowTitle?: string;
    ownerName?: string;
    bundleId?: string;

    /** Window bounds in screen (logical) coordinates */
    windowX?: number;
    windowY?: number;
    windowWidth?: number;
    windowHeight?: number;

    /** Accessibility element at cursor position (value is omitted for password fields) */
    uiElementRole?: string | null;
    uiElementSubrole?: string | null;
    uiElementLabel?: string | null;
    uiElementDescription?: string | null;
    uiElementValue?: string | null;
    /** True when the element accepts typed text (text field/area, web content-editable) */
    uiElementIsEditableText?: boolean | null;

    /** type === 'error': accessibility_denied | event_tap_disabled */
    code?: string;
    message?: string;
}

// ── Enriched event emitted by the TypeScript service ────────────────────

/**
 * Full cursor event with material context and interaction screenshot.
 * Compatible with CursorPlusPlusEventData from @ausm/core.
 */
export interface CursorEventLike {
    eventID?: string | null;
    timestamp?: number;
    displayID?: string | null;

    action?: MouseActionLike | null;
    x?: number | null;
    y?: number | null;
    button?: number | null;
    clickCount?: number | null;
    scrollDeltaX?: number | null;
    scrollDeltaY?: number | null;
    holdDurationMs?: number | null;

    windowId?: number | null;
    windowTitle?: string | null;
    application?: string | null;
    bundleId?: string | null;
    materialId?: string | null;

    uiElementRole?: string | null;
    uiElementSubrole?: string | null;
    uiElementLabel?: string | null;
    uiElementDescription?: string | null;
    uiElementValue?: string | null;
    uiElementIsEditableText?: boolean | null;

    /** Small JPEG crop around the cursor at the moment of interaction */
    interactionScreenshot?: InteractionScreenshotLike | null;
}

// ── Integration interfaces (dependency injection) ───────────────────────

/**
 * Material lookup — provided by the material-manager.
 * Looks up the current material by CGWindowID so the service doesn't
 * depend directly on @ausm/device-macos-material-manager.
 */
export interface MaterialLookup {
    getMaterialForWindow(windowId: number): {
        materialId: string;
        title: string;
        application: string | null;
        bundleId: string | null;
    } | null;
}

/**
 * Display-stream crop — reads from the screen-stream shared memory
 * buffer and crops a region around the cursor, returning JPEG data.
 *
 * The implementation (CropReader) uses CGDisplayBounds to resolve
 * which display the cursor is on and converts global screen
 * coordinates to display-local coordinates automatically.
 */
export interface DisplayStreamCrop {
    cropAtCursor(
        cursorX: number,
        cursorY: number,
        cropWidth: number,
        cropHeight: number,
        scaleFactor: number,
        jpegQuality: number,
    ): Promise<{ data: Buffer; width: number; height: number }>;
}

// ── Configuration ───────────────────────────────────────────────────────

export interface CursorPlusPlusConfig {
    /** Enable debug logging (default: false) */
    debug?: boolean;

    /**
     * Crop width in logical points for the interaction screenshot.
     * Default: 200
     */
    cropWidth?: number;

    /**
     * Crop height in logical points for the interaction screenshot.
     * Default: 40
     */
    cropHeight?: number;

    /** JPEG quality for the interaction screenshot crop, 1–100 (default: 75) */
    cropJpegQuality?: number;

    /**
     * Throttle interval (ms) for MOVE events (and, separately, DRAG events).
     * Applied inside the Swift helper, so faster updates never cross the pipe.
     * Set to 0 to receive every move event.
     * Default: 100
     */
    moveThrottleMs?: number;

    /**
     * Mouse actions that trigger a full enrichment pass
     * (material lookup + screenshot crop). MOVE events only update
     * the position unless included here.
     * Default: ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'SCROLL', 'HOLD_END']
     */
    enrichActions?: MouseActionLike[];

    /**
     * Optional material lookup integration.
     * When provided, enriched events include the materialId.
     */
    materialLookup?: MaterialLookup;

    /**
     * Optional display-stream crop integration. When provided, enriched
     * events include an interaction screenshot cropped directly from the
     * screen-stream shared memory buffer (no per-event screen capture).
     *
     * The CropReader (from this package) implements this interface and
     * uses CGDisplayBounds to auto-detect the correct display.
     */
    displayStreamCrop?: DisplayStreamCrop;

    /**
     * Scale factor hint for logical→physical pixel conversion.
     * The crop reader auto-detects per-display scale factors; this is
     * only used as a fallback.
     * Default: 2
     */
    defaultScaleFactor?: number;

    /** Restart the helper with backoff if it crashes (default: true). Never restarts after a
     *  missing-Accessibility exit. */
    autoRestart?: boolean;

    /** Override the helper executable path (default: bundled build/cursor-helper). */
    helperPath?: string;
}

// ── Service events ──────────────────────────────────────────────────────

export interface CursorPlusPlusEvents {
    /** Enriched cursor event (all actions) */
    'cursor-event': (data: CursorEventLike) => void;
    /** Position-only update (throttled MOVE events) */
    'cursor-move': (x: number, y: number) => void;
    /** Monitor lifecycle status */
    status: (status: 'started' | 'stopped') => void;
    /** Error */
    error: (error: Error) => void;
}
