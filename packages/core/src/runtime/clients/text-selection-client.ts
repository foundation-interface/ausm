/**
 * Selection Client - Bridge between AUSM runtime and selection monitor service
 * 
 * Connects the native selection monitor to the AUSM event system,
 * converting native selection events to TextSelectionEvent format.
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import type { TextSelectionEventData } from '../../events/TextSelectionEvent';
import { SelectionMethod, TextElementType, DetectionSource } from '../../events/TextSelectionEvent';
import { createAUSMUIElement } from '../../AUSM';

// Types from the selection service
interface SelectionInfo {
    text: string;
    programName: string;
    retrievalMethod: number;
    detectionType: number;
    positionLevel: number;
    isFullscreen: boolean;
    bounds: { x: number; y: number; width: number; height: number } | null;
    startTop: { x: number; y: number };
    startBottom: { x: number; y: number };
    endTop: { x: number; y: number };
    endBottom: { x: number; y: number };
    mouseStart: { x: number; y: number };
    mouseEnd: { x: number; y: number };
}

interface NativeMouseEvent {
    type: 'mouse-event';
    action: 'mouse-down' | 'mouse-up' | 'mouse-move' | 'mouse-wheel';
    x: number;
    y: number;
    button: number;
    flag: number;
}

interface NativeKeyboardEvent {
    type: 'keyboard-event';
    action: 'key-down' | 'key-up';
    uniKey: string;
    vkCode: number;
    sys: boolean;
    flags: number;
}

type NativeEvent = 
    | { type: 'text-selection'; text: string; programName: string; localizedName: string; method: number; detectType: number; posLevel: number; isFullscreen: boolean; startTopX: number; startTopY: number; startBottomX: number; startBottomY: number; endTopX: number; endTopY: number; endBottomX: number; endBottomY: number; mouseStartX: number; mouseStartY: number; mouseEndX: number; mouseEndY: number; hasElementBounds: boolean; elementX: number; elementY: number; elementWidth: number; elementHeight: number }
    | NativeMouseEvent
    | NativeKeyboardEvent;

// Detection types from native module
enum DetectionType {
    NONE = 0,
    DRAG = 1,
    DOUBLE_CLICK = 2,
    SHIFT_CLICK = 3,
}

// Position levels from native module
enum PositionLevel {
    NONE = 0,
    MOUSE_SINGLE = 1,
    MOUSE_DUAL = 2,
    FULL = 3,
    DETAILED = 4,
}

/**
 * Options for the selection client
 */
export interface SelectionClientOptions {
    /** Enable debug logging */
    debug?: boolean;
    /** Enable clipboard fallback for text retrieval */
    enableClipboard?: boolean;
    /** Auto-start when created */
    autoStart?: boolean;
}

/**
 * Selection client events
 */
export interface SelectionClientEvents {
    'selection': (data: TextSelectionEventData) => void;
    'mouse-down': (event: NativeMouseEvent) => void;
    'mouse-up': (event: NativeMouseEvent) => void;
    'mouse-move': (event: NativeMouseEvent) => void;
    'mouse-wheel': (event: NativeMouseEvent) => void;
    'key-down': (event: NativeKeyboardEvent) => void;
    'key-up': (event: NativeKeyboardEvent) => void;
    'error': (error: Error) => void;
    'status': (status: 'started' | 'stopped') => void;
}

// Native module types
interface NativeSelectionMonitor {
    start(callback: (data: NativeEvent) => void): void;
    stop(): void;
    enableMouseMoveEvent(): void;
    disableMouseMoveEvent(): void;
    enableClipboard(): void;
    disableClipboard(): void;
    setClipboardMode(mode: number, list: string[]): void;
    setGlobalFilterMode(mode: number, list: string[]): void;
    setSelectionPassiveMode(passive: boolean): void;
    getCurrentSelection(): NativeEvent | null;
    writeToClipboard(text: string): boolean;
    readFromClipboard(): string | null;
    isProcessTrusted(): boolean;
    requestProcessTrust(): boolean;
}

interface NativeModuleType {
    SelectionMonitor: new () => NativeSelectionMonitor;
}

// Load native module
let nativeModule: NativeModuleType | null = null;
const isMac = process.platform === 'darwin';

function loadNativeModule(): NativeModuleType | null {
    if (!isMac) return null;

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const gypBuild = require('node-gyp-build');
        let selectionServicePath: string | null = null;
        try {
            selectionServicePath = path.dirname(
                require.resolve('@ausm/device-macos-text-selection/package.json'),
            );
        } catch {
            const fallback = path.resolve(__dirname, '../../../device-macos/text-selection');
            if (fs.existsSync(fallback)) selectionServicePath = fallback;
        }
        if (!selectionServicePath) {
            throw new Error('@ausm/device-macos-text-selection is not installed');
        }
        return gypBuild(selectionServicePath);
    } catch (err) {
        console.error('[SelectionClient] Failed to load native module:', (err as Error).message);
        return null;
    }
}

/** Lowercase word tokens of a bundle id / app name ("com.microsoft.VSCode" → com, microsoft, vscode). */
function tokenize(name: string): string[] {
    return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Infer text element type from bundle identifier or localized name.
 *
 * Matches whole words (multi-word patterns match a contiguous word run), the same
 * rules as @ausm/device-macos-text-selection's adapter: "1Password" is not "word",
 * "Research" is not "arc".
 */
function inferTextElementType(programName: string, localizedName?: string): TextElementType {
    const tokenLists = [tokenize(programName || ''), tokenize(localizedName || '')];
    const matchesAny = (patterns: string[]) =>
        patterns.some((pattern) => {
            const words = tokenize(pattern);
            return tokenLists.some((tokens) => tokens.some((_, i) => words.every((w, j) => tokens[i + j] === w)));
        });

    if (matchesAny([
        'vscode', 'vscodeinsiders', 'cursor', 'xcode', 'sublime', 'sublimetext', 'atom',
        'jetbrains', 'intellij', 'webstorm', 'pycharm', 'zed',
        'vim', 'neovim', 'macvim', 'emacs', 'visual studio code',
    ])) return TextElementType.CODE_EDITOR;
    if (matchesAny(['pages', 'word', 'docs', 'notes', 'textedit', 'notion', 'obsidian', 'bear', 'microsoft word'])) {
        return TextElementType.DOCUMENT_EDITOR;
    }
    if (matchesAny(['mail', 'outlook', 'thunderbird', 'airmail', 'spark'])) return TextElementType.EMAIL;
    if (matchesAny(['messages', 'slack', 'slackmacgap', 'discord', 'telegram', 'whatsapp', 'teams'])) {
        return TextElementType.MESSAGE;
    }
    if (matchesAny(['preview', 'pdf', 'acrobat'])) return TextElementType.PDF_TEXT;
    if (matchesAny(['safari', 'chrome', 'firefox', 'edge', 'edgemac', 'arc', 'brave', 'opera', 'vivaldi'])) {
        return TextElementType.WEB_NON_EDITABLE_TEXT;
    }
    return TextElementType.OTHER;
}

/**
 * Map detection type to selection method
 */
function mapDetectionTypeToSelectionMethod(detectType: number): SelectionMethod {
    switch (detectType) {
        case DetectionType.DRAG:
            return SelectionMethod.MOUSE;
        case DetectionType.DOUBLE_CLICK:
            return SelectionMethod.DOUBLE_CLICK;
        case DetectionType.SHIFT_CLICK:
            return SelectionMethod.MOUSE;
        default:
            return SelectionMethod.OTHER;
    }
}

/**
 * Generate a unique event ID
 */
function generateEventID(): string {
    return `sel_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Convert native selection data to TextSelectionEventData
 */
function toTextSelectionEventData(nativeData: NativeEvent & { type: 'text-selection' }): TextSelectionEventData {
    const elementType = inferTextElementType(nativeData.programName, nativeData.localizedName);
    
    // Calculate bounding rect
    let screenBound = null;
    if (nativeData.posLevel >= PositionLevel.FULL) {
        const minX = Math.min(nativeData.startTopX, nativeData.endBottomX);
        const maxX = Math.max(nativeData.startTopX, nativeData.endBottomX);
        const minY = Math.min(nativeData.startTopY, nativeData.endBottomY);
        const maxY = Math.max(nativeData.startTopY, nativeData.endBottomY);

        if (maxX > minX && maxY > minY) {
            screenBound = {
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
            };
        }
    }

    const sourceElement = createAUSMUIElement({
        type: elementType,
        application: nativeData.programName,
        applicationLocalizedName: nativeData.localizedName,
        screenBounds: nativeData.hasElementBounds && nativeData.elementWidth > 0 && nativeData.elementHeight > 0 ? {
            x: nativeData.elementX,
            y: nativeData.elementY,
            width: nativeData.elementWidth,
            height: nativeData.elementHeight,
        } : null,
        content: null,
    });

    return {
        eventID: generateEventID(),
        timestamp: Date.now(),
        displayID: null,
        screenBound,
        selectedText: nativeData.text,
        sourceElement,
        selectionMethod: mapDetectionTypeToSelectionMethod(nativeData.detectType),
        detectionSource: DetectionSource.NATIVE,
    };
}

/**
 * Selection Client
 * 
 * Bridges the native selection monitor with the AUSM event system.
 * Emits TextSelectionEventData compatible events.
 */
export class SelectionClient extends EventEmitter {
    private instance: NativeSelectionMonitor | null = null;
    private running = false;
    private debug = false;
    private options: SelectionClientOptions;

    constructor(options: SelectionClientOptions = {}) {
        super();
        this.options = options;
        this.debug = options.debug ?? false;

        // Load native module on first use
        if (!nativeModule) {
            nativeModule = loadNativeModule();
        }

        if (!nativeModule) {
            throw new Error('[SelectionClient] Native module not available - only works on macOS');
        }

        if (options.autoStart) {
            this.start();
        }
    }

    /**
     * Start monitoring text selections
     */
    start(): boolean {
        if (this.running) {
            this.logDebug('SelectionClient already running');
            return true;
        }

        if (!this.instance) {
            try {
                this.instance = new nativeModule!.SelectionMonitor();
            } catch (err) {
                this.handleError('Failed to create monitor instance', err as Error);
                return false;
            }
        }

        // Apply options
        if (this.options.enableClipboard === false) {
            this.instance.disableClipboard();
        }

        try {
            this.instance.start((data: NativeEvent) => {
                if (!data || !this.running) return;

                try {
                    this.handleNativeEvent(data);
                } catch (err) {
                    this.handleError('Failed to process event', err as Error);
                }
            });

            this.running = true;
            this.emit('status', 'started');
            return true;
        } catch (err) {
            this.handleError('Failed to start monitor', err as Error);
            return false;
        }
    }

    /**
     * Stop monitoring
     */
    stop(): boolean {
        if (!this.instance || !this.running) {
            this.logDebug('SelectionClient not running');
            return true;
        }

        try {
            this.instance.stop();
            this.running = false;
            this.emit('status', 'stopped');
            return true;
        } catch (err) {
            this.handleError('Failed to stop monitor', err as Error);
            this.running = false;
            return false;
        }
    }

    /**
     * Check if process has accessibility permissions
     */
    isProcessTrusted(): boolean {
        if (!this.instance) {
            try {
                this.instance = new nativeModule!.SelectionMonitor();
            } catch {
                return false;
            }
        }
        return this.instance.isProcessTrusted();
    }

    /**
     * Request accessibility permissions
     */
    requestProcessTrust(): boolean {
        if (!this.instance) {
            try {
                this.instance = new nativeModule!.SelectionMonitor();
            } catch {
                return false;
            }
        }
        return this.instance.requestProcessTrust();
    }

    /**
     * Check if running
     */
    isRunning(): boolean {
        return this.running;
    }

    /**
     * Clean up resources
     */
    cleanup(): void {
        this.stop();
        this.removeAllListeners();
        this.instance = null;
    }

    // Type-safe event emitter methods
    on<K extends keyof SelectionClientEvents>(event: K, listener: SelectionClientEvents[K]): this {
        return super.on(event, listener);
    }

    once<K extends keyof SelectionClientEvents>(event: K, listener: SelectionClientEvents[K]): this {
        return super.once(event, listener);
    }

    emit<K extends keyof SelectionClientEvents>(event: K, ...args: Parameters<SelectionClientEvents[K]>): boolean {
        return super.emit(event, ...args);
    }

    // Private methods

    private handleNativeEvent(data: NativeEvent): void {
        switch (data.type) {
            case 'text-selection': {
                if (data.text && data.text.trim()) {
                    const eventData = toTextSelectionEventData(data);
                    this.emit('selection', eventData);
                }
                break;
            }
            case 'mouse-event': {
                this.emit(data.action, data);
                break;
            }
            case 'keyboard-event': {
                this.emit(data.action, data);
                break;
            }
        }
    }

    private handleError(message: string, err: Error): void {
        const errorMsg = `${message}: ${err.message}`;
        if (this.debug) {
            console.error('[SelectionClient]', errorMsg);
        }
        if (this.listenerCount('error') > 0) {
            this.emit('error', new Error(errorMsg));
        } else {
            console.warn('[SelectionClient]', errorMsg);
        }
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[SelectionClient]', message);
        }
    }
}

/**
 * Create a new SelectionClient instance
 */
export function createSelectionClient(options?: SelectionClientOptions): SelectionClient {
    return new SelectionClient(options);
}
