import { AUSMEvent, AUSMUIElement, EventDataOf, createAUSMEvent } from '../AUSM';
import { Point } from '../types';

export enum EditableTextElementType {
    TEXT_FIELD = 'TEXT_FIELD',
    TEXT_AREA = 'TEXT_AREA',
    CONTENT_EDITABLE = 'CONTENT_EDITABLE',
    SEARCH_FIELD = 'SEARCH_FIELD',
    TERMINAL = 'TERMINAL',
    CODE_EDITOR = 'CODE_EDITOR',
    OTHER = 'OTHER',
}

export enum TextInputStatus {
    STARTED = 'TEXT_INPUT_STARTED',
    UPDATED = 'TEXT_INPUT_UPDATED',
    ENDED = 'TEXT_INPUT_ENDED',
}

export interface TextInputEvent extends AUSMEvent {
    readonly kind: 'textInput';
    readonly text: string | null;
    readonly sourceElement: AUSMUIElement | null;
    readonly status: TextInputStatus | null;
    readonly caretScreenPosition: Point | null;
}

export type TextInputEventData = EventDataOf<TextInputEvent>;

export function createTextInputEvent(data: TextInputEventData = {}): TextInputEvent {
    return {
        ...createAUSMEvent('textInput', data),
        text: data.text ?? null,
        sourceElement: data.sourceElement ?? null,
        status: data.status ?? null,
        caretScreenPosition: data.caretScreenPosition ?? null,
    };
}
