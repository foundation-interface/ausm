import { AUSMEvent, EventDataOf, createAUSMEvent } from '../AUSM';

export enum CopyPasteAction {
    COPY = 'COPY',
    PASTE = 'PASTE',
}

/** Primary content type on the clipboard */
export enum CopyPasteContentType {
    TEXT = 'TEXT',
    HTML = 'HTML',
    RTF = 'RTF',
    IMAGE = 'IMAGE',
    FILE = 'FILE',
    URL = 'URL',
}

export interface CopyPasteEvent extends AUSMEvent {
    readonly kind: 'copyPaste';
    readonly action: CopyPasteAction | null;
    /** Primary content type (text, image, file, etc.) */
    readonly contentType: CopyPasteContentType | null;
    /** For TEXT/HTML/RTF/URL: the string. For FILE: first path or newline-joined paths. Omitted for privacy when includeContent=false */
    readonly content: string | null;
    /** For FILE: array of file paths. Only populated when includeContent=true */
    readonly contentPaths: string[] | null;
    /** Change count of the clipboard at the time of the event (macOS) */
    readonly changeCount: number | null;
}

export type CopyPasteEventData = EventDataOf<CopyPasteEvent>;

export function createCopyPasteEvent(data: CopyPasteEventData = {}): CopyPasteEvent {
    return {
        ...createAUSMEvent('copyPaste', data),
        action: data.action ?? null,
        contentType: data.contentType ?? null,
        content: data.content ?? null,
        contentPaths: data.contentPaths ?? null,
        changeCount: data.changeCount ?? null,
    };
}
