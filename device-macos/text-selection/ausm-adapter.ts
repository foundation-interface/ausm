/**
 * AUSM Adapter
 *
 * Utilities to convert SelectionInfo from the selection monitor
 * to AUSM's TextSelectionEvent format.
 */

import type { SelectionInfo } from './types';
import { DetectionType, RetrievalMethod } from './types';

/**
 * Maps to AUSM's SelectionMethod enum
 * @see packages/core/src/events/TextSelectionEvent.ts
 */
export enum AUSMSelectionMethod {
    MOUSE = 'MOUSE',
    KEYBOARD = 'KEYBOARD',
    DOUBLE_CLICK = 'DOUBLE_CLICK',
    TRIPLE_CLICK = 'TRIPLE_CLICK',
    OTHER = 'OTHER',
}

/**
 * Maps to AUSM's TextElementType enum
 * @see packages/core/src/events/TextSelectionEvent.ts
 */
export enum AUSMTextElementType {
    DOCUMENT_EDITOR = 'DOCUMENT_EDITOR',
    CODE_EDITOR = 'CODE_EDITOR',
    SEARCH_INPUT = 'SEARCH_INPUT',
    EMAIL_INPUT = 'EMAIL_INPUT',
    MESSAGE_INPUT = 'MESSAGE_INPUT',
    ITEM_NAME = 'ITEM_NAME',
    COMMENT_BOX = 'COMMENT_BOX',
    CANVAS_TEXT = 'CANVAS_TEXT',
    PASSWORD_INPUT = 'PASSWORD_INPUT',
    PDF_TEXT = 'PDF_TEXT',
    WEB_NON_EDITABLE_TEXT = 'WEB_NON_EDITABLE_TEXT',
    MESSAGE = 'MESSAGE',
    EMAIL = 'EMAIL',
    OTHER = 'OTHER',
}

/**
 * AUSM Rect type
 */
export interface AUSMRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * AUSM Point type
 */
export interface AUSMPoint {
    x: number;
    y: number;
}

/**
 * AUSM UIElement type (simplified)
 */
export interface AUSMUIElement {
    type: string | null;
    application: string | null;
    position: AUSMPoint | null;
    content: string | null;
}

/**
 * Data structure compatible with AUSM's TextSelectionEventData
 */
export interface AUSMTextSelectionEventData {
    eventID?: string | null;
    timestamp?: number;
    displayID?: string | null;
    screenBound?: AUSMRect | null;
    selectedText?: string;
    sourceElement?: AUSMUIElement | null;
    selectionMethod?: AUSMSelectionMethod | null;
}

/**
 * Convert DetectionType to AUSM SelectionMethod
 */
export function mapDetectionTypeToSelectionMethod(detectType: DetectionType): AUSMSelectionMethod {
    switch (detectType) {
        case DetectionType.DRAG:
            return AUSMSelectionMethod.MOUSE;
        case DetectionType.DOUBLE_CLICK:
            return AUSMSelectionMethod.DOUBLE_CLICK;
        case DetectionType.SHIFT_CLICK:
            return AUSMSelectionMethod.MOUSE;
        default:
            return AUSMSelectionMethod.OTHER;
    }
}

/**
 * Split a bundle id / app name into lowercase word tokens
 * ("com.microsoft.VSCode" → ["com", "microsoft", "vscode"]).
 */
function tokenize(name: string): string[] {
    return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Infer text element type from program name (bundle identifier) or localized name.
 *
 * Matching is on whole words of the bundle id / app name (multi-word
 * patterns match a contiguous word sequence), so e.g. "1Password" does not
 * match "word" and "Knowledge" does not match "edge".
 */
export function inferTextElementType(programName: string, localizedName?: string): AUSMTextElementType {
    const tokenLists = [tokenize(programName), tokenize(localizedName || '')];

    const matchesAny = (patterns: string[]) =>
        patterns.some((pattern) => {
            const words = tokenize(pattern);
            return tokenLists.some((tokens) =>
                tokens.some((_, i) => words.every((w, j) => tokens[i + j] === w)),
            );
        });

    // Code editors
    if (matchesAny([
        'vscode', 'vscodeinsiders', 'cursor', 'xcode', 'sublime', 'sublimetext', 'atom',
        'jetbrains', 'intellij', 'webstorm', 'pycharm', 'zed',
        'vim', 'neovim', 'macvim', 'emacs', 'visual studio code'
    ])) {
        return AUSMTextElementType.CODE_EDITOR;
    }

    // Document editors
    if (matchesAny([
        'pages', 'word', 'docs', 'notes', 'textedit',
        'notion', 'obsidian', 'bear', 'microsoft word'
    ])) {
        return AUSMTextElementType.DOCUMENT_EDITOR;
    }

    // Email clients
    if (matchesAny(['mail', 'outlook', 'thunderbird', 'airmail', 'spark'])) {
        return AUSMTextElementType.EMAIL;
    }

    // Messaging apps
    if (matchesAny(['messages', 'slack', 'slackmacgap', 'discord', 'telegram', 'whatsapp', 'teams'])) {
        return AUSMTextElementType.MESSAGE;
    }

    // PDF readers
    if (matchesAny(['preview', 'pdf', 'acrobat'])) {
        return AUSMTextElementType.PDF_TEXT;
    }

    // Web browsers (typically non-editable content)
    if (matchesAny(['safari', 'chrome', 'firefox', 'edge', 'edgemac', 'arc', 'brave', 'opera', 'vivaldi'])) {
        return AUSMTextElementType.WEB_NON_EDITABLE_TEXT;
    }

    return AUSMTextElementType.OTHER;
}

/**
 * Generate a unique event ID
 */
function generateEventID(): string {
    return `sel_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Convert SelectionInfo to AUSM TextSelectionEventData format
 */
export function toAUSMTextSelectionEventData(info: SelectionInfo): AUSMTextSelectionEventData {
    const elementType = inferTextElementType(info.programName, info.localizedName);

    const sourceElement: AUSMUIElement = {
        type: elementType,
        application: info.programName,
        position: info.bounds ? { x: info.bounds.x, y: info.bounds.y } : null,
        content: null, // Could be populated with surrounding context if available
    };

    return {
        eventID: generateEventID(),
        timestamp: Date.now(),
        displayID: null, // Could be populated from screen info
        screenBound: info.bounds,
        selectedText: info.text,
        sourceElement,
        selectionMethod: mapDetectionTypeToSelectionMethod(info.detectionType),
    };
}

/**
 * Extended AUSM event data with additional metadata from the native module
 */
export interface ExtendedAUSMTextSelectionEventData extends AUSMTextSelectionEventData {
    /** Human-readable application name (e.g., "Safari", "Cursor") */
    localizedName?: string;
    /** How the text was retrieved (AXAPI or Clipboard) */
    retrievalMethod?: 'AXAPI' | 'CLIPBOARD' | 'NONE';
    /** Whether the source window is in fullscreen mode */
    isFullscreen?: boolean;
    /** Mouse start position during selection */
    mouseStart?: AUSMPoint;
    /** Mouse end position during selection */
    mouseEnd?: AUSMPoint;
}

/**
 * Convert SelectionInfo to extended AUSM format with additional metadata
 */
export function toExtendedAUSMEventData(info: SelectionInfo): ExtendedAUSMTextSelectionEventData {
    const baseData = toAUSMTextSelectionEventData(info);

    let retrievalMethodStr: 'AXAPI' | 'CLIPBOARD' | 'NONE' = 'NONE';
    if (info.retrievalMethod === RetrievalMethod.AXAPI) {
        retrievalMethodStr = 'AXAPI';
    } else if (info.retrievalMethod === RetrievalMethod.CLIPBOARD) {
        retrievalMethodStr = 'CLIPBOARD';
    }

    return {
        ...baseData,
        localizedName: info.localizedName,
        retrievalMethod: retrievalMethodStr,
        isFullscreen: info.isFullscreen,
        mouseStart: info.mouseStart,
        mouseEnd: info.mouseEnd,
    };
}
