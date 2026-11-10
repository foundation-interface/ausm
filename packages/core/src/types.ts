/**
 * Common type definitions for the ActivityMedium API
 */

// ============================================================================
// Geometry Types
// ============================================================================

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

// ============================================================================
// Base Event Types
// ============================================================================

export interface AUSMEventData {
    eventID?: string | null;
    timestamp?: number;
    displayID?: string | null;
}

// ============================================================================
// UI Element Types
// ============================================================================

export interface AUSMUIElementData {
    type?: string | null;
    application?: string | null;
    applicationID?: string | null;
    applicationLocalizedName?: string | null;
    screenBounds?: Rect | null;
    content?: string | null;
}

// ============================================================================
// Callback Types
// ============================================================================

export type EventCallback<T> = (event: T) => void;

// ============================================================================
// Application Types
// ============================================================================

export interface AUSMApplication {
    name: string;
    bundleIdentifier?: string;
    processID?: number;
}

export interface ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}