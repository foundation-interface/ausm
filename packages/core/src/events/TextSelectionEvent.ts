import { AUSMEvent, AUSMUIElement, EventDataOf, createAUSMEvent } from '../AUSM';
import { Rect } from '../types';

export enum TextElementType {
    DOCUMENT_EDITOR = 'DOCUMENT_EDITOR',
    CODE_EDITOR = 'CODE_EDITOR',
    SEARCH_INPUT = 'SEARCH_INPUT',
    EMAIL_INPUT = 'EMAIL_INPUT',
    MESSAGE_INPUT = 'MESSAGE_INPUT',
    ITEM_NAME = 'ITEM_NAME',
    COMMENT_BOX = 'COMMENT_BOX',
    CANVAS_TEXT = 'CANVAS_TEXT',
    PASSWORD_INPUT = 'PASSWORD_INPUT',
    /** Non-editable text in a PDF file */
    PDF_TEXT = 'PDF_TEXT',
    /** Non-editable text on a web page */
    WEB_NON_EDITABLE_TEXT = 'WEB_NON_EDITABLE_TEXT',
    /** A message in a chat */
    MESSAGE = 'MESSAGE',
    /** An email in an email client */
    EMAIL = 'EMAIL',
    /** Other types of text */
    OTHER = 'OTHER',
}

export enum SelectionMethod {
    MOUSE = 'MOUSE',
    KEYBOARD = 'KEYBOARD',
    DOUBLE_CLICK = 'DOUBLE_CLICK',
    TRIPLE_CLICK = 'TRIPLE_CLICK',
    OTHER = 'OTHER',
}

export enum SelectionStage {
    START = 'START',
    UPDATE = 'UPDATE',
    END = 'END',
}

export enum DetectionSource {
    /** Native accessibility API (macOS) */
    NATIVE = 'NATIVE',
    /** Computer vision based detection */
    CV = 'CV',
    /** Clipboard-based fallback */
    CLIPBOARD = 'CLIPBOARD',
    /** Unknown or unspecified source */
    UNKNOWN = 'UNKNOWN',
}

export interface TextSelectionEvent extends AUSMEvent {
    readonly kind: 'textSelection';
    readonly screenBound: Rect | null;
    readonly selectedText: string;
    readonly sourceElement: AUSMUIElement | null;
    readonly selectionMethod: SelectionMethod | null;
    readonly selectionStage: SelectionStage | null;
    readonly detectionSource: DetectionSource | null;
}

export type TextSelectionEventData = EventDataOf<TextSelectionEvent>;

export function createTextSelectionEvent(data: TextSelectionEventData = {}): TextSelectionEvent {
    return {
        ...createAUSMEvent('textSelection', data),
        screenBound: data.screenBound ?? null,
        selectedText: data.selectedText ?? '',
        sourceElement: data.sourceElement ?? null,
        selectionMethod: data.selectionMethod ?? null,
        selectionStage: data.selectionStage ?? null,
        detectionSource: data.detectionSource ?? null,
    };
}
