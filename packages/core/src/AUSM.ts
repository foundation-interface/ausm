/**
 * Core AUSM types and base interfaces
 * 
 * Note: This file only exports types and base interfaces.
 * For the runtime implementation, import from '@ausm/core/runtime'
 */

import { AUSMUIElementData, Rect } from './types';

export interface AUSMUIElement {
    readonly type: string | null;
    readonly application: string | null;
    readonly applicationID: string | null;
    readonly applicationLocalizedName: string | null;
    readonly screenBounds: Rect | null;
    readonly screenContent: string | null;
}

export function createAUSMUIElement(data: AUSMUIElementData = {}): AUSMUIElement {
    return {
        type: data.type ?? null,
        application: data.application ?? null,
        applicationID: data.applicationID ?? null,
        applicationLocalizedName: data.applicationLocalizedName ?? null,
        screenBounds: data.screenBounds ?? null,
        screenContent: data.content ?? null,
    };
}

/** Utility: strip readonly + make partial — used for event data input types */
export type EventDataOf<T extends AUSMEvent> = { [K in Exclude<keyof T, 'kind'>]?: T[K] };

/** Discriminant kind values for each AUSM event type */
export type AUSMEventKind =
    | 'textSelection'
    | 'textInput'
    | 'screenshot'
    | 'windowState'
    | 'copyPaste'
    | 'material'
    | 'cursorPlusPlus'
    | 'spaceChange'
    | 'detector'
    | 'task';

export interface AUSMEvent {
    readonly kind: AUSMEventKind;
    readonly eventID: string | null;
    readonly timestamp: number;
    readonly displayID: string | null;
}

export function createAUSMEvent<K extends AUSMEventKind>(
    kind: K,
    data: { eventID?: string | null; timestamp?: number; displayID?: string | null } = {}
): AUSMEvent & { kind: K } {
    return {
        kind,
        eventID: data.eventID ?? null,
        timestamp: data.timestamp ?? Date.now(),
        displayID: data.displayID ?? null,
    };
}
