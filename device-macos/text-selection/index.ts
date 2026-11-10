/**
 * Selection Monitor Service for AUSM
 *
 * Provides system-wide text selection monitoring on macOS using Accessibility APIs.
 * Emits events compatible with AUSM's TextSelectionEvent format.
 *
 * Privacy: selected text, mouse and keyboard events are delivered only to
 * your listeners; this module never logs or stores their content.
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

import type {
    SelectionMonitorConfig,
    SelectionMonitorEvents,
    SelectionInfo,
    NativeSelectionData,
    NativeMouseEvent,
    NativeKeyboardEvent,
    NativeEvent,
    Rect,
    Point,
} from './types';

import {
    RetrievalMethod,
    DetectionType,
    PositionLevel,
    FilterMode,
} from './types';

// Re-export types
export * from './types';

// Platform check
const isMac = process.platform === 'darwin';

// Load native module
let nativeModule: NativeModuleType | null = null;

interface NativeModuleType {
    SelectionMonitor: new () => NativeSelectionMonitor;
}

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
    getCurrentSelection(): NativeSelectionData | null;
    writeToClipboard(text: string): boolean;
    readFromClipboard(): string | null;
    isProcessTrusted(): boolean;
    requestProcessTrust(): boolean;
}

/**
 * Package root: the directory holding binding.gyp / prebuilds / build.
 * __dirname is <root>/dist for the published bundle and <root> when running
 * the TypeScript sources directly.
 */
function packageRoot(): string {
    const candidates = [path.resolve(__dirname, '..'), __dirname];
    return candidates.find((dir) => fs.existsSync(path.join(dir, 'binding.gyp'))) ?? candidates[0];
}

try {
    if (isMac) {
        // createRequire works in both the CJS and ESM builds (tsup shims
        // __filename for ESM), unlike a bare require().
        const req = createRequire(__filename);
        const gypBuild = req('node-gyp-build') as (dir: string) => NativeModuleType;
        nativeModule = gypBuild(packageRoot());
    }
} catch (err) {
    console.error('[selection-monitor] Failed to load native module:', (err as Error).message);
}

/**
 * Converts raw native selection data to processed SelectionInfo
 */
function processSelectionData(data: NativeSelectionData): SelectionInfo {
    const startTop: Point = { x: data.startTopX, y: data.startTopY };
    const startBottom: Point = { x: data.startBottomX, y: data.startBottomY };
    const endTop: Point = { x: data.endTopX, y: data.endTopY };
    const endBottom: Point = { x: data.endBottomX, y: data.endBottomY };

    // Calculate bounding rect from corner points
    let bounds: Rect | null = null;
    if (data.posLevel >= PositionLevel.FULL) {
        const minX = Math.min(startTop.x, startBottom.x, endTop.x, endBottom.x);
        const maxX = Math.max(startTop.x, startBottom.x, endTop.x, endBottom.x);
        const minY = Math.min(startTop.y, startBottom.y, endTop.y, endBottom.y);
        const maxY = Math.max(startTop.y, startBottom.y, endTop.y, endBottom.y);

        if (maxX > minX && maxY > minY) {
            bounds = {
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
            };
        }
    }

    // Element bounds (position and size of the UI element)
    let elementBounds: Rect | null = null;
    if (data.hasElementBounds && data.elementWidth > 0 && data.elementHeight > 0) {
        elementBounds = {
            x: data.elementX,
            y: data.elementY,
            width: data.elementWidth,
            height: data.elementHeight,
        };
    }

    return {
        text: data.text,
        programName: data.programName,
        localizedName: data.localizedName,
        retrievalMethod: data.method as RetrievalMethod,
        detectionType: data.detectType as DetectionType,
        positionLevel: data.posLevel as PositionLevel,
        isFullscreen: data.isFullscreen,
        bounds,
        elementBounds,
        startTop,
        startBottom,
        endTop,
        endBottom,
        mouseStart: { x: data.mouseStartX, y: data.mouseStartY },
        mouseEnd: { x: data.mouseEndX, y: data.mouseEndY },
    };
}

/**
 * Selection Monitor Service
 *
 * Monitors system-wide text selections on macOS using Accessibility APIs.
 *
 * @example
 * ```typescript
 * const monitor = new SelectionMonitorService();
 *
 * monitor.on('selection', (info) => {
 *     console.log('Selected:', info.text);
 *     console.log('From:', info.programName);
 * });
 *
 * monitor.start();
 * ```
 */
export class SelectionMonitorService extends EventEmitter {
    private instance: NativeSelectionMonitor | null = null;
    private running = false;
    private debug = false;

    constructor() {
        super();
        if (!nativeModule) {
            throw new Error('[selection-monitor] Native module not available - only works on macOS');
        }
    }

    /**
     * Start monitoring text selections
     */
    start(config?: SelectionMonitorConfig): boolean {
        this.debug = config?.debug ?? false;

        if (this.running) {
            this.logDebug('Selection monitor already running');
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

        // Apply configuration before starting
        if (config) {
            this.applyConfig(config);
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
     * Stop monitoring text selections
     */
    stop(): boolean {
        if (!this.instance || !this.running) {
            this.logDebug('Selection monitor not running');
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
     * Get current text selection (on-demand)
     */
    getCurrentSelection(): SelectionInfo | null {
        if (!this.instance || !this.running) {
            this.logDebug('Selection monitor not running');
            return null;
        }

        try {
            const data = this.instance.getCurrentSelection();
            if (!data) return null;
            return processSelectionData(data);
        } catch (err) {
            this.handleError('Failed to get current selection', err as Error);
            return null;
        }
    }

    /**
     * Check if process has accessibility permissions (macOS)
     */
    isProcessTrusted(): boolean {
        if (!this.instance) {
            try {
                this.instance = new nativeModule!.SelectionMonitor();
            } catch {
                return false;
            }
        }

        try {
            return this.instance.isProcessTrusted();
        } catch (err) {
            this.handleError('Failed to check process trust', err as Error);
            return false;
        }
    }

    /**
     * Request accessibility permissions (macOS)
     * @returns Current permission status (may show system dialog)
     */
    requestProcessTrust(): boolean {
        if (!this.instance) {
            try {
                this.instance = new nativeModule!.SelectionMonitor();
            } catch {
                return false;
            }
        }

        try {
            return this.instance.requestProcessTrust();
        } catch (err) {
            this.handleError('Failed to request process trust', err as Error);
            return false;
        }
    }

    /**
     * Enable mouse move events (high CPU usage)
     */
    enableMouseMoveEvent(): boolean {
        if (!this.checkRunning()) return false;
        try {
            this.instance!.enableMouseMoveEvent();
            return true;
        } catch (err) {
            this.handleError('Failed to enable mouse move events', err as Error);
            return false;
        }
    }

    /**
     * Disable mouse move events
     */
    disableMouseMoveEvent(): boolean {
        if (!this.checkRunning()) return false;
        try {
            this.instance!.disableMouseMoveEvent();
            return true;
        } catch (err) {
            this.handleError('Failed to disable mouse move events', err as Error);
            return false;
        }
    }

    /**
     * Enable clipboard fallback for text retrieval.
     *
     * When the AX API returns no text, the native module posts a synthetic
     * Cmd+C to the frontmost app, reads the clipboard, and restores the
     * previous plain-text clipboard contents. Note the native default is ON;
     * pass `enableClipboard: false` to start() to avoid synthetic key events.
     */
    enableClipboard(): boolean {
        if (!this.checkRunning()) return false;
        try {
            this.instance!.enableClipboard();
            return true;
        } catch (err) {
            this.handleError('Failed to enable clipboard', err as Error);
            return false;
        }
    }

    /**
     * Disable clipboard fallback
     */
    disableClipboard(): boolean {
        if (!this.checkRunning()) return false;
        try {
            this.instance!.disableClipboard();
            return true;
        } catch (err) {
            this.handleError('Failed to disable clipboard', err as Error);
            return false;
        }
    }

    /**
     * Set clipboard filter mode
     */
    setClipboardMode(mode: FilterMode, programList: string[] = []): boolean {
        if (!this.checkRunning()) return false;
        try {
            this.instance!.setClipboardMode(mode, programList);
            return true;
        } catch (err) {
            this.handleError('Failed to set clipboard mode', err as Error);
            return false;
        }
    }

    /**
     * Set global filter mode
     */
    setGlobalFilterMode(mode: FilterMode, programList: string[] = []): boolean {
        if (!this.checkRunning()) return false;
        try {
            this.instance!.setGlobalFilterMode(mode, programList);
            return true;
        } catch (err) {
            this.handleError('Failed to set global filter mode', err as Error);
            return false;
        }
    }

    /**
     * Set passive mode (only get selection on explicit request)
     */
    setSelectionPassiveMode(passive: boolean): boolean {
        if (!this.checkRunning()) return false;
        try {
            this.instance!.setSelectionPassiveMode(passive);
            return true;
        } catch (err) {
            this.handleError('Failed to set passive mode', err as Error);
            return false;
        }
    }

    /**
     * Write text to clipboard
     */
    writeToClipboard(text: string): boolean {
        if (!this.checkRunning()) return false;
        try {
            return this.instance!.writeToClipboard(text);
        } catch (err) {
            this.handleError('Failed to write to clipboard', err as Error);
            return false;
        }
    }

    /**
     * Read text from clipboard
     */
    readFromClipboard(): string | null {
        if (!this.checkRunning()) return null;
        try {
            return this.instance!.readFromClipboard();
        } catch (err) {
            this.handleError('Failed to read from clipboard', err as Error);
            return null;
        }
    }

    /**
     * Check if monitor is running
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
    on<K extends keyof SelectionMonitorEvents>(
        event: K,
        listener: SelectionMonitorEvents[K]
    ): this {
        return super.on(event, listener);
    }

    once<K extends keyof SelectionMonitorEvents>(
        event: K,
        listener: SelectionMonitorEvents[K]
    ): this {
        return super.once(event, listener);
    }

    emit<K extends keyof SelectionMonitorEvents>(
        event: K,
        ...args: Parameters<SelectionMonitorEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    // Private methods

    private applyConfig(config: SelectionMonitorConfig): void {
        if (!this.instance) return;

        if (config.enableMouseMoveEvent !== undefined) {
            if (config.enableMouseMoveEvent) {
                this.instance.enableMouseMoveEvent();
            } else {
                this.instance.disableMouseMoveEvent();
            }
        }

        if (config.enableClipboard !== undefined) {
            if (config.enableClipboard) {
                this.instance.enableClipboard();
            } else {
                this.instance.disableClipboard();
            }
        }

        if (config.selectionPassiveMode !== undefined) {
            this.instance.setSelectionPassiveMode(config.selectionPassiveMode);
        }

        if (config.clipboardMode !== undefined || config.clipboardFilterList !== undefined) {
            this.instance.setClipboardMode(
                config.clipboardMode ?? FilterMode.DEFAULT,
                config.clipboardFilterList ?? []
            );
        }

        if (config.globalFilterMode !== undefined || config.globalFilterList !== undefined) {
            this.instance.setGlobalFilterMode(
                config.globalFilterMode ?? FilterMode.DEFAULT,
                config.globalFilterList ?? []
            );
        }
    }

    private handleNativeEvent(data: NativeEvent): void {
        switch (data.type) {
            case 'text-selection': {
                const info = processSelectionData(data);
                if (info.text && info.text.trim()) {
                    this.emit('selection', info);
                }
                break;
            }
            case 'mouse-event': {
                const mouseEvent = data as NativeMouseEvent;
                this.emit(mouseEvent.action, mouseEvent);
                break;
            }
            case 'keyboard-event': {
                const keyEvent = data as NativeKeyboardEvent;
                this.emit(keyEvent.action, keyEvent);
                break;
            }
        }
    }

    private checkRunning(): boolean {
        if (!this.instance || !this.running) {
            this.logDebug('Selection monitor not running');
            return false;
        }
        return true;
    }

    private handleError(message: string, err: Error): void {
        const errorMsg = `${message}: ${err.message}`;
        if (this.debug) {
            console.error('[selection-monitor]', errorMsg);
            if (err.stack) {
                console.error(err.stack);
            }
        }
        // EventEmitter throws on an unhandled 'error'; from inside the native
        // callback that would become an uncaught exception, so only emit
        // when someone is listening.
        if (this.listenerCount('error') > 0) {
            this.emit('error', new Error(errorMsg));
        }
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[selection-monitor]', message);
        }
    }
}

/**
 * Create a new SelectionMonitorService instance
 */
export function createSelectionMonitor(): SelectionMonitorService {
    return new SelectionMonitorService();
}

// Default export
export default SelectionMonitorService;
