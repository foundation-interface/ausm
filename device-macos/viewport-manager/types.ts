// ─── Window event types from the Swift helper ───────────────────────────

export type WindowEventType =
    | 'window-opened'
    | 'window-closed'
    | 'window-focused'
    | 'window-unfocused'
    | 'bounds-changed'
    | 'title-changed';

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Raw event from the Swift ViewportHelper subprocess (JSON line).
 */
export interface NativeWindowEvent {
    type: WindowEventType;
    windowId: number;
    title: string;
    ownerName: string;
    bundleId: string;
    pid: number;
    bounds: Rect;
    /** CGDirectDisplayID of the display with the largest overlap with this window */
    displayId: number;
    /** File URL from the AXDocument attribute (nil for non-document windows) */
    documentPath?: string;
    oldTitle?: string;
    oldBounds?: Rect;
}

/**
 * Enriched event emitted by the ViewportMonitorService.
 */
export interface WindowEvent extends NativeWindowEvent {
    /** JS timestamp (Date.now()) when the event was received by the Node process */
    timestamp: number;
}

// ─── Space change event from the Swift helper ──────────────────────────

/**
 * Raw space-change event from the Swift ViewportHelper subprocess (JSON line).
 * Emitted when the user switches to a different macOS virtual desktop (Space).
 */
export interface SpaceChangeNativeEvent {
    type: 'space-changed';
    timestamp: number;
}

// ─── Permission status from the Swift helper ───────────────────────────

/**
 * TCC permission state reported by the helper at startup and whenever it changes.
 * - accessibilityTrusted: needed for instant AX focus tracking and `documentPath`
 *   (focus still works via polling without it).
 * - screenRecordingGranted: macOS hides other apps' window titles without it; untitled
 *   windows are not reported, so most windows are missing until it is granted.
 */
export interface ViewportPermissionState {
    accessibilityTrusted: boolean;
    screenRecordingGranted: boolean;
}

// ─── Monitor configuration ──────────────────────────────────────────────

export interface ViewportMonitorConfig {
    /**
     * Enable debug logging (default: false). Debug logs include window titles,
     * which can be sensitive; keep it off in production.
     */
    debug?: boolean;
    /** Restart the helper with exponential backoff if it crashes (default: true) */
    autoRestart?: boolean;
}

// ─── Typed event map ────────────────────────────────────────────────────

export interface ViewportMonitorEvents {
    /** All window events */
    'window-event': (event: WindowEvent) => void;
    /** A window became visible */
    'window-opened': (event: WindowEvent) => void;
    /** A window was destroyed / hidden */
    'window-closed': (event: WindowEvent) => void;
    /** A window gained focus */
    'window-focused': (event: WindowEvent) => void;
    /** A window lost focus */
    'window-unfocused': (event: WindowEvent) => void;
    /** A window's position or size changed */
    'bounds-changed': (event: WindowEvent) => void;
    /** A window's title changed */
    'title-changed': (event: WindowEvent) => void;
    /** The active macOS Space (virtual desktop) changed */
    'space-changed': (event: SpaceChangeNativeEvent) => void;
    /** Permission state at startup and on every change */
    permission: (state: ViewportPermissionState) => void;
    /** Monitor lifecycle status */
    status: (status: 'started' | 'stopped') => void;
    /**
     * Error (helper missing, crashed, ...). If no 'error' listener is attached the
     * message is logged with console.warn instead of throwing.
     */
    error: (error: Error) => void;
}
