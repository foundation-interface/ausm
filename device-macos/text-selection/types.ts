/**
 * Type definitions for the selection monitor service
 */

/**
 * How the text was retrieved (native method)
 */
export enum RetrievalMethod {
    NONE = 0,
    /** Retrieved via macOS Accessibility API */
    AXAPI = 11,
    /** Retrieved via clipboard (Cmd+C fallback) */
    CLIPBOARD = 99,
}

/**
 * How the selection was detected
 */
export enum DetectionType {
    NONE = 0,
    /** Mouse drag selection */
    DRAG = 1,
    /** Double-click word selection */
    DOUBLE_CLICK = 2,
    /** Shift-click range selection */
    SHIFT_CLICK = 3,
}

/**
 * Position accuracy level
 */
export enum PositionLevel {
    /** No position information available */
    NONE = 0,
    /** Only current mouse cursor position is known */
    MOUSE_SINGLE = 1,
    /** Mouse start and end positions are known */
    MOUSE_DUAL = 2,
    /** Full selection bounds from AX API */
    FULL = 3,
    /** Detailed selection coordinates */
    DETAILED = 4,
}

/**
 * Filter mode for applications
 */
export enum FilterMode {
    /** No filtering */
    DEFAULT = 0,
    /** Only process applications in the list */
    INCLUDE_LIST = 1,
    /** Process all applications except those in the list */
    EXCLUDE_LIST = 2,
}

/**
 * Point coordinates
 */
export interface Point {
    x: number;
    y: number;
}

/**
 * Rectangle bounds
 */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Raw selection data from native module
 */
export interface NativeSelectionData {
    type: 'text-selection';
    text: string;
    /** Bundle identifier (e.g., "com.apple.Safari") */
    programName: string;
    /** Human-readable name (e.g., "Safari") */
    localizedName: string;
    method: number;
    posLevel: number;
    detectType: number;
    isFullscreen: boolean;
    startTopX: number;
    startTopY: number;
    startBottomX: number;
    startBottomY: number;
    endTopX: number;
    endTopY: number;
    endBottomX: number;
    endBottomY: number;
    mouseStartX: number;
    mouseStartY: number;
    mouseEndX: number;
    mouseEndY: number;
    /** Whether element bounds are available */
    hasElementBounds: boolean;
    /** UI element X position */
    elementX: number;
    /** UI element Y position */
    elementY: number;
    /** UI element width */
    elementWidth: number;
    /** UI element height */
    elementHeight: number;
}

/**
 * Raw mouse event data from native module
 */
export interface NativeMouseEvent {
    type: 'mouse-event';
    action: 'mouse-down' | 'mouse-up' | 'mouse-move' | 'mouse-wheel';
    x: number;
    y: number;
    button: number;
    flag: number;
}

/**
 * Raw keyboard event data from native module
 */
export interface NativeKeyboardEvent {
    type: 'keyboard-event';
    action: 'key-down' | 'key-up';
    uniKey: string;
    vkCode: number;
    sys: boolean;
    flags: number;
}

/**
 * Union type for all native events
 */
export type NativeEvent = NativeSelectionData | NativeMouseEvent | NativeKeyboardEvent;

/**
 * Processed selection info with computed bounds
 */
export interface SelectionInfo {
    /** The selected text content */
    text: string;
    /** Bundle identifier of the source application */
    programName: string;
    /** Human-readable application name (e.g., "Safari", "Cursor") */
    localizedName: string;
    /** How the text was retrieved */
    retrievalMethod: RetrievalMethod;
    /** How the selection was detected */
    detectionType: DetectionType;
    /** Position accuracy level */
    positionLevel: PositionLevel;
    /** Whether the source window is fullscreen */
    isFullscreen: boolean;
    /** Bounding rectangle of the selection (in screen coordinates) */
    bounds: Rect | null;
    /** Bounding rectangle of the UI element containing the selection */
    elementBounds: Rect | null;
    /** Start position of selection */
    startTop: Point;
    startBottom: Point;
    /** End position of selection */
    endTop: Point;
    endBottom: Point;
    /** Mouse positions during selection */
    mouseStart: Point;
    mouseEnd: Point;
}

/**
 * Configuration options for the selection monitor
 */
export interface SelectionMonitorConfig {
    /** Enable debug logging */
    debug?: boolean;
    /** Enable mouse move events (high CPU usage) */
    enableMouseMoveEvent?: boolean;
    /**
     * Clipboard fallback for text retrieval: when AX yields nothing, send a
     * synthetic Cmd+C to the frontmost app and read the clipboard (previous
     * plain-text contents are restored). The native default is ON; set
     * `false` to never synthesize key events.
     */
    enableClipboard?: boolean;
    /** Passive mode - only get selection on explicit request */
    selectionPassiveMode?: boolean;
    /** Clipboard filter mode */
    clipboardMode?: FilterMode;
    /** Global filter mode */
    globalFilterMode?: FilterMode;
    /** Applications for clipboard filtering */
    clipboardFilterList?: string[];
    /** Applications for global filtering */
    globalFilterList?: string[];
}

/**
 * Event types emitted by SelectionMonitorService
 */
export interface SelectionMonitorEvents {
    'selection': (info: SelectionInfo) => void;
    'mouse-down': (event: NativeMouseEvent) => void;
    'mouse-up': (event: NativeMouseEvent) => void;
    'mouse-move': (event: NativeMouseEvent) => void;
    'mouse-wheel': (event: NativeMouseEvent) => void;
    'key-down': (event: NativeKeyboardEvent) => void;
    'key-up': (event: NativeKeyboardEvent) => void;
    'error': (error: Error) => void;
    'status': (status: 'started' | 'stopped') => void;
}
