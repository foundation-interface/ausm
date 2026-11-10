import { AUSMEvent, EventDataOf, createAUSMEvent } from '../AUSM';
import { Rect } from '../types';

export enum ScreenshotStatus {
    STARTED = 'SCREENSHOT_STARTED',
    UPDATED = 'SCREENSHOT_UPDATED',
    FINISHED = 'SCREENSHOT_FINISHED',
}

export enum ScreenshotType {
    FULL_SCREEN = 'FULL_SCREEN',
    SELECTED_REGION = 'PARTIAL_SCREEN',
    SELECTED_WINDOW = 'WINDOW_SCREEN',
}

/** Image data for FINISHED screenshot events. Base64-encoded (JPEG or PNG). */
export interface ScreenshotImageData {
    dataBase64: string;
    width: number;
    height: number;
    mimeType?: string;
}

export interface ScreenshotEvent extends AUSMEvent {
    readonly kind: 'screenshot';
    readonly bounds: Rect | null;
    readonly status: ScreenshotStatus | null;
    readonly type: ScreenshotType | null;
    /** Image data — only populated when status is FINISHED */
    readonly imageData: ScreenshotImageData | null;
    /** Path to temp image file — used by Electron bridge to serve via custom protocol */
    readonly imagePath: string | null;
    readonly imageWidth: number | null;
    readonly imageHeight: number | null;
}

export type ScreenshotEventData = EventDataOf<ScreenshotEvent>;

export function createScreenshotEvent(data: ScreenshotEventData = {}): ScreenshotEvent {
    return {
        ...createAUSMEvent('screenshot', data),
        bounds: data.bounds ?? null,
        status: data.status ?? null,
        type: data.type ?? null,
        imageData: data.imageData ?? null,
        imagePath: data.imagePath ?? null,
        imageWidth: data.imageWidth ?? null,
        imageHeight: data.imageHeight ?? null,
    };
}
