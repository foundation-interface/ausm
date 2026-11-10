import { AUSMEvent, EventDataOf, createAUSMEvent } from '../AUSM';

export interface InteractionScreenshot {
    /** JPEG-encoded image data, base64 */
    dataBase64: string;
    /** Width in pixels */
    width: number;
    /** Height in pixels */
    height: number;
    /** MIME type of the encoded image */
    mimeType: 'image/jpeg';
}

export enum MouseAction {
    MOVE = 'MOVE',
    CLICK = 'CLICK',
    DOUBLE_CLICK = 'DOUBLE_CLICK',
    RIGHT_CLICK = 'RIGHT_CLICK',
    SCROLL = 'SCROLL',
    HOLD_START = 'HOLD_START',
    HOLD_END = 'HOLD_END',
    DRAG = 'DRAG',
}

export interface CursorPlusPlusEvent extends AUSMEvent {
    readonly kind: 'cursorPlusPlus';
    readonly action: MouseAction | null;
    /** Screen-space cursor X (logical points) */
    readonly x: number | null;
    /** Screen-space cursor Y (logical points) */
    readonly y: number | null;
    /** Mouse button: 0 = left, 1 = middle, 2 = right */
    readonly button: number | null;
    /** Number of rapid clicks (1 = single, 2 = double, etc.) */
    readonly clickCount: number | null;
    /** Horizontal scroll delta (points) */
    readonly scrollDeltaX: number | null;
    /** Vertical scroll delta (points) */
    readonly scrollDeltaY: number | null;
    /** Duration of the hold in ms (populated on HOLD_END) */
    readonly holdDurationMs: number | null;
    /** macOS CGWindowID of the window under the cursor */
    readonly windowId: number | null;
    /** Window title at the time of interaction */
    readonly windowTitle: string | null;
    /** Application name (e.g. "Safari") */
    readonly application: string | null;
    /** Application bundle identifier (e.g. "com.apple.Safari") */
    readonly bundleId: string | null;
    /** Material identifier from material-manager, if resolved */
    readonly materialId: string | null;
    /** Accessibility role of the UI element at cursor (e.g. "AXButton") */
    readonly uiElementRole: string | null;
    /** Accessibility label / title of the element */
    readonly uiElementLabel: string | null;
    /** Accessibility description of the element */
    readonly uiElementDescription: string | null;
    /** Accessibility value of the element (e.g. text content) */
    readonly uiElementValue: string | null;
    /** Small JPEG crop around the cursor position at the moment of interaction */
    readonly interactionScreenshot: InteractionScreenshot | null;
}

export type CursorPlusPlusEventData = EventDataOf<CursorPlusPlusEvent>;

export function createCursorPlusPlusEvent(data: CursorPlusPlusEventData = {}): CursorPlusPlusEvent {
    return {
        ...createAUSMEvent('cursorPlusPlus', data),
        action: data.action ?? null,
        x: data.x ?? null,
        y: data.y ?? null,
        button: data.button ?? null,
        clickCount: data.clickCount ?? null,
        scrollDeltaX: data.scrollDeltaX ?? null,
        scrollDeltaY: data.scrollDeltaY ?? null,
        holdDurationMs: data.holdDurationMs ?? null,
        windowId: data.windowId ?? null,
        windowTitle: data.windowTitle ?? null,
        application: data.application ?? null,
        bundleId: data.bundleId ?? null,
        materialId: data.materialId ?? null,
        uiElementRole: data.uiElementRole ?? null,
        uiElementLabel: data.uiElementLabel ?? null,
        uiElementDescription: data.uiElementDescription ?? null,
        uiElementValue: data.uiElementValue ?? null,
        interactionScreenshot: data.interactionScreenshot ?? null,
    };
}
