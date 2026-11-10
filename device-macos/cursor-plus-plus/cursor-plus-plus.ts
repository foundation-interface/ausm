/**
 * CursorPlusPlus Service
 *
 * Tracks cursor position and mouse interactions (click, hold, scroll, drag)
 * on macOS. Enriches each interaction with:
 *
 *   1. Window / material context (via material-manager)
 *   2. Accessibility UI element under cursor (via macOS AX API in Swift helper)
 *   3. 80×80 interaction screenshot crop (via screen-stream)
 *
 * Architecture:
 *   Swift subprocess (CursorHelper, a thin wrapper over CursorMonitorKit)
 *     └─ CFRunLoop on main thread
 *         ├─ CGEventTap → mouse move / click / scroll / drag (MOVE/DRAG throttled
 *         │               in the helper via --move-throttle-ms)
 *         └─ AXUIElement  → element at cursor position
 *     └─ stdout: one JSON object per line (protocol in swift/Sources/CursorHelper/main.swift)
 *
 *   Node.js (this module)
 *     └─ HelperProcess: spawn, restart with backoff on crash, SIGTERM→SIGKILL on stop
 *         └─ readline on stdout → parse JSON → enrich → emit typed events
 */

import { EventEmitter } from 'events';
import { HelperProcess } from './helper-process';
import { resolveHelperBinary } from './resolve-helper';

import type {
    NativeCursorEvent,
    CursorEventLike,
    CursorPlusPlusConfig,
    CursorPlusPlusEvents,
    MouseActionLike,
    InteractionScreenshotLike,
} from './types';

const DEFAULT_ENRICH_ACTIONS: MouseActionLike[] = [
    'CLICK',
    'DOUBLE_CLICK',
    'RIGHT_CLICK',
    'SCROLL',
    'HOLD_END',
];

function helperBinary(): string {
    return resolveHelperBinary(__dirname, 'cursor-helper', 'CursorHelper');
}

const KNOWN_ACTIONS: ReadonlySet<string> = new Set<MouseActionLike>([
    'MOVE', 'CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'SCROLL', 'HOLD_START', 'HOLD_END', 'DRAG',
]);

/** CursorHelper exit code: the event tap could not be created (Accessibility missing). */
const EXIT_NO_ACCESSIBILITY = 2;

export class CursorPlusPlusService extends EventEmitter {
    private helper: HelperProcess | null = null;
    private debug = false;

    private cropWidth: number;
    private cropHeight: number;
    private cropJpegQuality: number;
    private moveThrottleMs: number;
    private enrichActions: Set<MouseActionLike>;

    private materialLookup: CursorPlusPlusConfig['materialLookup'];
    private displayStreamCrop: CursorPlusPlusConfig['displayStreamCrop'];
    private defaultScaleFactor: number;

    private lastX = 0;
    private lastY = 0;

    /** Serialises 'cursor-event' emission so slow enrichment never reorders events. */
    private emitQueue: Promise<void> = Promise.resolve();
    /** Bumped by stop(): enrichment still in flight from an earlier run is dropped. */
    private generation = 0;

    constructor(private config: CursorPlusPlusConfig = {}) {
        super();
        this.debug = config.debug ?? false;
        this.cropWidth = config.cropWidth ?? 200;
        this.cropHeight = config.cropHeight ?? 40;
        this.cropJpegQuality = config.cropJpegQuality ?? 75;
        this.moveThrottleMs = config.moveThrottleMs ?? 100;
        this.enrichActions = new Set(config.enrichActions ?? DEFAULT_ENRICH_ACTIONS);
        this.materialLookup = config.materialLookup;
        this.displayStreamCrop = config.displayStreamCrop;
        this.defaultScaleFactor = config.defaultScaleFactor ?? 2;
    }

    // ── Public API ──────────────────────────────────────────────────────

    start(): boolean {
        if (this.helper?.running) {
            this.logDebug('CursorPlusPlusService already running');
            return true;
        }

        if (process.platform !== 'darwin') {
            this.handleError('CursorPlusPlusService only works on macOS');
            return false;
        }

        const throttle = Number.isFinite(this.moveThrottleMs) && this.moveThrottleMs > 0 ? this.moveThrottleMs : 0;
        this.helper = new HelperProcess({
            binary: this.config.helperPath ?? helperBinary(),
            // The helper throttles MOVE/DRAG itself, so they never cross the pipe needlessly.
            args: ['--move-throttle-ms', String(throttle)],
            name: 'CursorHelper',
            autoRestart: this.config.autoRestart ?? true,
            fatalExitCodes: [EXIT_NO_ACCESSIBILITY],
            onMessage: (msg) => this.handleNativeEvent(msg as unknown as NativeCursorEvent),
            onError: (err) => this.handleError(err.message),
            onStatus: (status) => {
                (this as EventEmitter).emit('status', status);
                this.logDebug(`CursorPlusPlusService ${status}`);
            },
            log: this.debug ? (m) => this.logDebug(m) : undefined,
            onStderr: this.debug ? (text) => process.stderr.write(`[cursor-helper] ${text}`) : undefined,
        });
        return this.helper.start();
    }

    stop(): boolean {
        this.generation++;
        this.helper?.stop();
        this.helper = null;
        return true;
    }

    cleanup(): void {
        this.stop();
        this.removeAllListeners();
    }

    isRunning(): boolean {
        return this.helper?.running ?? false;
    }

    /** Current cursor screen position (last known). */
    getPosition(): { x: number; y: number } {
        return { x: this.lastX, y: this.lastY };
    }

    /**
     * Manually inject a cursor event (for testing or non-macOS platforms).
     */
    reportEvent(data: CursorEventLike): void {
        if (!this.isRunning()) return;
        const payload: CursorEventLike = {
            ...data,
            timestamp: data.timestamp ?? Date.now(),
            eventID: data.eventID ?? makeEventId(),
        };
        (this as EventEmitter).emit('cursor-event', payload);
    }

    // ── Type-safe EventEmitter overrides ────────────────────────────────

    on<K extends keyof CursorPlusPlusEvents>(
        event: K,
        listener: CursorPlusPlusEvents[K],
    ): this {
        return super.on(event, listener);
    }

    once<K extends keyof CursorPlusPlusEvents>(
        event: K,
        listener: CursorPlusPlusEvents[K],
    ): this {
        return super.once(event, listener);
    }

    emit<K extends keyof CursorPlusPlusEvents>(
        event: K,
        ...args: Parameters<CursorPlusPlusEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    // ── Private ─────────────────────────────────────────────────────────

    private handleNativeEvent(data: NativeCursorEvent): void {
        if (data.type === 'ready') {
            this.logDebug('Helper subprocess ready');
            return;
        }

        if (data.type === 'error') {
            this.handleError(`${data.code ?? 'error'}: ${data.message ?? 'unknown helper error'}`);
            return;
        }

        const action = data.action;
        if (!action) return;
        if (!KNOWN_ACTIONS.has(action)) {
            this.logDebug(`Ignoring unknown action: ${String(action).slice(0, 40)}`);
            return;
        }

        // Always track position
        if (data.x != null) this.lastX = data.x;
        if (data.y != null) this.lastY = data.y;

        if (action === 'MOVE') {
            (this as EventEmitter).emit('cursor-move', data.x ?? 0, data.y ?? 0);
        }

        // Enrichment (material lookup, screenshot crop) starts now and runs concurrently,
        // but events are emitted strictly in the order the helper reported them, and
        // never after stop().
        const generation = this.generation;
        const payload = action === 'MOVE' ? this.buildMovePayload(data) : this.enrich(data);
        this.emitQueue = this.emitQueue
            .then(() => payload)
            .then((p) => {
                if (generation === this.generation) (this as EventEmitter).emit('cursor-event', p);
            })
            .catch((err) => {
                this.handleError(`Enrichment failed: ${(err as Error).message}`);
            });
    }

    private buildMovePayload(data: NativeCursorEvent): Promise<CursorEventLike> {
        const now = Date.now();

        // MOVE events are lightweight — no enrichment unless explicitly requested
        if (!this.enrichActions.has('MOVE')) {
            const payload: CursorEventLike = {
                eventID: makeEventId(),
                timestamp: now,
                action: 'MOVE',
                x: data.x ?? null,
                y: data.y ?? null,
                windowId: data.windowId ?? null,
                windowTitle: data.windowTitle ?? null,
                application: data.ownerName ?? null,
                bundleId: data.bundleId ?? null,
                uiElementRole: data.uiElementRole ?? null,
                uiElementSubrole: data.uiElementSubrole ?? null,
                uiElementLabel: data.uiElementLabel ?? null,
                uiElementDescription: data.uiElementDescription ?? null,
                uiElementValue: data.uiElementValue ?? null,
                uiElementIsEditableText: data.uiElementIsEditableText ?? null,
            };
            return Promise.resolve(payload);
        }

        return this.enrich(data);
    }

    private async enrich(data: NativeCursorEvent): Promise<CursorEventLike> {
        const now = Date.now();
        const windowId = data.windowId ?? null;

        // Material lookup
        let materialId: string | null = null;
        if (windowId != null && this.materialLookup) {
            try {
                const mat = this.materialLookup.getMaterialForWindow(windowId);
                if (mat) materialId = mat.materialId;
            } catch {
                // Non-critical — proceed without material
            }
        }

        // Interaction screenshot (crop from display stream shared memory)
        let interactionScreenshot: InteractionScreenshotLike | null = null;
        if (this.displayStreamCrop && this.enrichActions.has(data.action!)) {
            try {
                interactionScreenshot = await this.captureInteractionCrop(
                    data.x ?? 0,
                    data.y ?? 0,
                );
            } catch {
                // Non-critical — proceed without screenshot
            }
        }

        const payload: CursorEventLike = {
            eventID: makeEventId(),
            timestamp: now,
            action: data.action ?? null,
            x: data.x ?? null,
            y: data.y ?? null,
            button: data.button ?? null,
            clickCount: data.clickCount ?? null,
            scrollDeltaX: data.scrollDeltaX ?? null,
            scrollDeltaY: data.scrollDeltaY ?? null,
            holdDurationMs: data.holdDurationMs ?? null,
            windowId,
            windowTitle: data.windowTitle ?? null,
            application: data.ownerName ?? null,
            bundleId: data.bundleId ?? null,
            materialId,
            uiElementRole: data.uiElementRole ?? null,
            uiElementSubrole: data.uiElementSubrole ?? null,
            uiElementLabel: data.uiElementLabel ?? null,
            uiElementDescription: data.uiElementDescription ?? null,
            uiElementValue: data.uiElementValue ?? null,
            uiElementIsEditableText: data.uiElementIsEditableText ?? null,
            interactionScreenshot,
        };

        if (this.debug) {
            this.logDebug(
                `${data.action}: (${data.x},${data.y}) ` +
                `window=${windowId} material=${materialId} ` +
                `ax=${data.uiElementRole ?? '?'} screenshot=${interactionScreenshot ? `${interactionScreenshot.width}x${interactionScreenshot.height}` : 'no'}`,
            );
        }
        return payload;
    }

    /**
     * Crop a cropWidth × cropHeight region centred on the cursor directly
     * from the screen-stream shared memory via the display stream.
     *
     * Cursor coordinates are in macOS global screen-space (logical
     * points). The CropReader's Python subprocess uses CGDisplayBounds
     * to determine which display the cursor is on, converts to
     * display-local coordinates, and returns the JPEG-encoded crop.
     */
    private async captureInteractionCrop(
        cursorX: number,
        cursorY: number,
    ): Promise<InteractionScreenshotLike | null> {
        if (!this.displayStreamCrop) return null;

        const result = await this.displayStreamCrop.cropAtCursor(
            cursorX,
            cursorY,
            this.cropWidth,
            this.cropHeight,
            this.defaultScaleFactor,
            this.cropJpegQuality,
        );

        if (!result.width || !result.height) return null;

        return {
            dataBase64: result.data.toString('base64'),
            width: result.width,
            height: result.height,
            mimeType: 'image/jpeg',
        };
    }

    private handleError(message: string): void {
        if (this.debug) {
            console.error('[cursor-plus-plus]', message);
        }
        // An unhandled 'error' event would throw and crash the host; warn instead.
        if (this.listenerCount('error') > 0) {
            (this as EventEmitter).emit('error', new Error(message));
        } else if (!this.debug) {
            console.warn('[cursor-plus-plus]', message);
        }
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[cursor-plus-plus]', message);
        }
    }
}

function makeEventId(): string {
    return `cur_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function createCursorPlusPlus(config?: CursorPlusPlusConfig): CursorPlusPlusService {
    return new CursorPlusPlusService(config);
}
