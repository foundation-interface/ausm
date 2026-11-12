/**
 * Types for the text-input service layer.
 * Kept independent of @ausm/core so the service has no hard dependency on core.
 */

export interface Point {
    x: number;
    y: number;
}

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Minimal UI element shape for text input source (matches AUSMUIElementData) */
export interface TextInputSourceElement {
    type?: string | null;
    application?: string | null;
    applicationID?: string | null;
    applicationLocalizedName?: string | null;
    screenBounds?: Rect | null;
    content?: string | null;
}

/** Text input lifecycle status (matches core TextInputStatus) */
export type TextInputStatusLike =
    | 'TEXT_EDITING_STARTED'
    | 'TEXT_EDITING_UPDATED'
    | 'TEXT_EDITING_FINISHED';

/**
 * Event payload emitted by the text-input service.
 * Compatible with TextInputEventData from @ausm/core; runtime/bridge can map directly.
 */
export interface TextInputEventLike {
    eventID?: string | null;
    timestamp?: number;
    displayID?: string | null;
    text?: string | null;
    sourceElement?: TextInputSourceElement | null;
    status?: TextInputStatusLike | null;
    caretScreenPosition?: Point | null;
}

/**
 * Raw JSON line from the Swift TextInputHelper subprocess: a text-input event (has
 * `status`), the initial `{"type":"ready","accessibilityTrusted":bool}` handshake, or a
 * `{"type":"permission","accessibilityTrusted":bool}` change notice.
 */
export interface NativeTextInputEvent {
    type?: string;
    accessibilityTrusted?: boolean;
    status?: TextInputStatusLike;
    text?: string | null;
    timestamp?: number;
    sourceElement?: TextInputSourceElement | null;
    caretScreenPosition?: Point | null;
}

export interface TextInputMonitorConfig {
    /**
     * Enable debug logging (default: false). Debug logs report event status and text
     * length only; typed text is never logged.
     */
    debug?: boolean;
    /** Restart the helper with exponential backoff if it crashes (default: true) */
    autoRestart?: boolean;
    /** Override the helper executable path (default: the bundled helper). */
    helperPath?: string;
}

/** Accessibility permission state reported by the helper at startup and on every change. */
export interface TextInputPermissionState {
    accessibilityTrusted: boolean;
}

export interface TextInputMonitorEvents {
    /** Text input event (focus/typing/unfocused in an editable element) */
    'text-input': (data: TextInputEventLike) => void;
    /** Monitor lifecycle status */
    status: (status: 'started' | 'stopped') => void;
    /** Accessibility permission state (no events are produced while it is false) */
    permission: (state: TextInputPermissionState) => void;
    /**
     * Error (helper missing, crashed, ...). If no 'error' listener is attached the
     * message is logged with console.warn instead of throwing.
     */
    error: (error: Error) => void;
}
