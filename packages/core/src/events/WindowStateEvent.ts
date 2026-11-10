import { AUSMEvent, EventDataOf, createAUSMEvent } from '../AUSM';
import { Rect } from '../types';

export enum WindowState {
    /** A new window appeared on screen */
    APPEAR = 'APPEAR',
    /** A window lost focus */
    UNFOCUSED = 'UNFOCUSED',
    /** A window gained focus */
    FOCUSED = 'FOCUSED',
    /** A window disappeared from screen */
    VANISHED = 'VANISHED',
    /** A window was moved or resized */
    BOUNDS_CHANGED = 'BOUNDS_CHANGED',
    /** A window's title changed */
    TITLE_CHANGED = 'TITLE_CHANGED',
}

export interface WindowStateEvent extends AUSMEvent {
    readonly kind: 'windowState';
    /** Application name or bundle identifier */
    readonly application: string | null;
    /** The window lifecycle state change */
    readonly state: WindowState | null;
    /** Current bounds of the window in screen coordinates */
    readonly bounds: Rect | null;
    /** macOS CGWindowID */
    readonly windowId: number | null;
    /** Window title */
    readonly title: string | null;
    /** Application bundle identifier (e.g., "com.apple.Safari") */
    readonly bundleId: string | null;
    /** Process ID of the owning application */
    readonly pid: number | null;
    /** Previous bounds (for BOUNDS_CHANGED events) */
    readonly oldBounds: Rect | null;
    /** Previous title (for TITLE_CHANGED events) */
    readonly oldTitle: string | null;
    /** The display (monitor) the window is currently on */
    readonly displayId: number | null;
    /** File URL from the AXDocument attribute (null for non-document windows) */
    readonly documentPath: string | null;
}

export type WindowStateEventData = EventDataOf<WindowStateEvent>;

export function createWindowStateEvent(data: WindowStateEventData = {}): WindowStateEvent {
    return {
        ...createAUSMEvent('windowState', data),
        application: data.application ?? null,
        state: data.state ?? null,
        bounds: data.bounds ?? null,
        windowId: data.windowId ?? null,
        title: data.title ?? null,
        bundleId: data.bundleId ?? null,
        pid: data.pid ?? null,
        oldBounds: data.oldBounds ?? null,
        oldTitle: data.oldTitle ?? null,
        displayId: data.displayId ?? null,
        documentPath: data.documentPath ?? null,
    };
}
