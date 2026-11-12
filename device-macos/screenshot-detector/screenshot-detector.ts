/**
 * Screenshot Detector Service
 *
 * Monitors macOS screenshot activity (Cmd+Shift+3/4/5, with or without Ctrl) and
 * reproduces the captured image.
 *
 * Architecture:
 *   Swift subprocess (ScreenshotHelper, a thin wrapper over ScreenshotMonitorKit)
 *     └─ Polls for screencapture via libproc; its argv names the mode
 *        (-z keyboard.screen | keyboard.selection | keyboard.interactive[.clipboard])
 *     └─ CGEventTap → selection rect, Space/Return/Esc, mouse-up = capture
 *        (the screencapture process exits before the user finishes selecting on
 *        modern macOS, so the gesture — not process exit — ends the session)
 *     └─ ScreenCaptureKit capture excluding the Screenshot UI, at true backing scale
 *     └─ stdout: one JSON object per line (protocol in swift/Sources/ScreenshotHelper/main.swift)
 *
 *   Node.js (this module)
 *     └─ HelperProcess: spawn, restart with backoff on crash, SIGTERM→SIGKILL on stop
 *     └─ readline on stdout → parse JSON → map to ScreenshotEvent → emit
 */

import { EventEmitter } from 'events';
import { HelperProcess } from './helper-process';
import { resolveHelperBinary } from './resolve-helper';

import {
    createScreenshotEvent,
    ScreenshotStatus,
    ScreenshotType,
} from '@ausm/core';
import type { Rect, ScreenshotEvent } from '@ausm/core';

export interface ScreenshotDetectorConfig {
    /** Log helper diagnostics to the console (default: false). */
    debug?: boolean;
    /** Restart the helper with backoff if it crashes (default: true). */
    autoRestart?: boolean;
    /** Override the helper executable path (default: bundled build/screenshot-helper). */
    helperPath?: string;
    /**
     * Only report sessions started by the system screenshot hotkeys (Cmd+Shift+3/4/5); ignore
     * other programs running the `screencapture` CLI (default: false).
     */
    hotkeyOnly?: boolean;
}

export interface ScreenshotDetectorEvents {
    'screenshot-event': (event: ScreenshotEvent) => void;
    status: (status: 'started' | 'stopped') => void;
    /** Helper crashes/restarts, missing permissions, failed captures. */
    error: (err: Error) => void;
}

/** One JSON line from ScreenshotHelper (see swift/Sources/ScreenshotHelper/main.swift). */
interface NativeScreenshotEvent {
    type: string;
    pid?: number;
    rect?: { x: number; y: number; width: number; height: number };
    displayId?: string;
    timestamp?: number;
    /** Only present for screencapture_ended (FINISHED) - path to temp image file (0600) */
    imagePath?: string;
    imageWidth?: number;
    imageHeight?: number;
    imageMimeType?: string;
    /** Pixels per point of the captured display */
    scale?: number;
    /** screen | selection | window | interactive | unknown */
    mode?: string;
    /** file | clipboard | unknown */
    destination?: string;
    /** hotkey | cli | unknown: who launched screencapture */
    origin?: string;
    /** screencapture_ended without an image: Esc, timeout, superseded, or capture failure */
    cancelled?: boolean;
    /** screenshot_capture_failed */
    reason?: string;
    /** error: accessibility_denied | screen_recording_denied | event_tap_disabled */
    code?: string;
    message?: string;
}

function helperBinary(): string {
    return resolveHelperBinary(__dirname, 'screenshot-helper', 'ScreenshotHelper');
}

function makeEventId(): string {
    return `ss_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function rectFromNative(rect?: { x: number; y: number; width: number; height: number }): Rect | null {
    if (
        !rect ||
        typeof rect.x !== 'number' ||
        typeof rect.y !== 'number' ||
        typeof rect.width !== 'number' ||
        typeof rect.height !== 'number'
    ) {
        return null;
    }
    return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    };
}

function typeFor(mode: string | undefined, hasRect: boolean): ScreenshotType {
    if (mode === 'window') return ScreenshotType.SELECTED_WINDOW;
    if (hasRect || mode === 'selection') return ScreenshotType.SELECTED_REGION;
    return ScreenshotType.FULL_SCREEN;
}

export class ScreenshotDetectorService extends EventEmitter {
    private helper: HelperProcess | null = null;
    private debug = false;
    private autoRestart: boolean;
    private helperPath: string | undefined;
    private hotkeyOnly: boolean;
    /** A screencapture session is open (between started and ended). */
    private sessionOpen = false;
    /** The open session was synthesized from screencaptureui_started. */
    private uiSessionOpen = false;

    constructor(config: ScreenshotDetectorConfig = {}) {
        super();
        this.debug = config.debug ?? false;
        this.autoRestart = config.autoRestart ?? true;
        this.helperPath = config.helperPath;
        this.hotkeyOnly = config.hotkeyOnly ?? false;
    }

    // Type-safe EventEmitter overrides
    on<K extends keyof ScreenshotDetectorEvents>(event: K, listener: ScreenshotDetectorEvents[K]): this {
        return super.on(event, listener);
    }
    once<K extends keyof ScreenshotDetectorEvents>(event: K, listener: ScreenshotDetectorEvents[K]): this {
        return super.once(event, listener);
    }
    emit<K extends keyof ScreenshotDetectorEvents>(
        event: K,
        ...args: Parameters<ScreenshotDetectorEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    start(): boolean {
        if (this.helper?.running) {
            this.logDebug('ScreenshotDetectorService already running');
            return true;
        }

        if (process.platform !== 'darwin') {
            this.handleError('ScreenshotDetectorService only works on macOS');
            return false;
        }

        this.sessionOpen = false;
        this.uiSessionOpen = false;
        this.helper = new HelperProcess({
            binary: this.helperPath ?? helperBinary(),
            args: [...(this.debug ? ['--debug'] : []), ...(this.hotkeyOnly ? ['--hotkey-only'] : [])],
            name: 'ScreenshotHelper',
            autoRestart: this.autoRestart,
            onMessage: (msg) => this.handleNativeEvent(msg as NativeScreenshotEvent),
            onError: (err) => this.handleError(err.message),
            onStatus: (status) => {
                if (status === 'stopped') {
                    this.sessionOpen = false;
                    this.uiSessionOpen = false;
                }
                (this as EventEmitter).emit('status', status);
                this.logDebug(`ScreenshotDetectorService ${status}`);
            },
            log: this.debug ? (m) => this.logDebug(m) : undefined,
            onStderr: this.debug ? (text) => process.stderr.write(`[screenshot-detector] ${text}`) : undefined,
        });
        return this.helper.start();
    }

    stop(): boolean {
        this.helper?.stop();
        this.helper = null;
        return true;
    }

    isRunning(): boolean {
        return this.helper?.running ?? false;
    }

    private handleNativeEvent(data: NativeScreenshotEvent): void {
        if (data.type === 'ready') {
            this.logDebug('Helper subprocess ready');
            return;
        }

        const timestamp = typeof data.timestamp === 'number' ? data.timestamp : Date.now();
        const eventID = makeEventId();
        const displayID = typeof data.displayId === 'string' ? data.displayId : null;

        switch (data.type) {
            case 'screencapture_started': {
                this.sessionOpen = true;
                this.uiSessionOpen = false;
                const event = createScreenshotEvent({
                    eventID,
                    timestamp,
                    status: ScreenshotStatus.STARTED,
                    type: typeFor(data.mode, false),
                    displayID,
                });
                (this as EventEmitter).emit('screenshot-event', event);
                this.logDebug(`screencapture started mode=${data.mode ?? '?'} dest=${data.destination ?? '?'}`);
                break;
            }

            case 'screencapture_ended': {
                this.sessionOpen = false;
                this.uiSessionOpen = false;
                // Image is written to a temp file by Swift. Pass imagePath for Electron (IPC can't handle
                // multi-MB base64); the consumer owns the file and should delete it after reading.
                const imagePath =
                    typeof data.imagePath === 'string' && data.imageWidth && data.imageHeight ? data.imagePath : null;
                const bounds = rectFromNative(data.rect);
                // Cancelled sessions (Esc, timeout, failure) are FINISHED with no image.
                const event = createScreenshotEvent({
                    eventID,
                    timestamp,
                    status: ScreenshotStatus.FINISHED,
                    type: typeFor(data.mode, bounds != null),
                    bounds,
                    displayID,
                    imageData: null,
                    imagePath,
                    imageWidth: data.imageWidth ?? null,
                    imageHeight: data.imageHeight ?? null,
                });
                (this as EventEmitter).emit('screenshot-event', event);
                this.logDebug(
                    `screencapture ended mode=${data.mode ?? '?'} dest=${data.destination ?? '?'}` +
                        (data.cancelled ? ' (cancelled)' : '') +
                        (imagePath ? ` (image ${data.imageWidth}x${data.imageHeight})` : ''),
                );
                break;
            }

            case 'screencaptureui_started': {
                // The Screenshot UI agent normally appears inside a screencapture session; only
                // treat it as a session start when no screencapture session is open.
                if (this.sessionOpen) break;
                this.sessionOpen = true;
                this.uiSessionOpen = true;
                const event = createScreenshotEvent({
                    eventID,
                    timestamp,
                    status: ScreenshotStatus.STARTED,
                    type: ScreenshotType.FULL_SCREEN,
                    displayID,
                });
                (this as EventEmitter).emit('screenshot-event', event);
                this.logDebug('screencaptureui started (no screencapture session)');
                break;
            }

            case 'screencaptureui_ended': {
                // Only close a session that screencaptureui_started opened (no image: toolbar closed).
                if (!this.uiSessionOpen) break;
                this.sessionOpen = false;
                this.uiSessionOpen = false;
                const event = createScreenshotEvent({
                    eventID,
                    timestamp,
                    status: ScreenshotStatus.FINISHED,
                    type: ScreenshotType.FULL_SCREEN,
                    displayID,
                });
                (this as EventEmitter).emit('screenshot-event', event);
                this.logDebug('screencaptureui ended');
                break;
            }

            case 'selection_rect_changed': {
                const bounds = rectFromNative(data.rect);
                const event = createScreenshotEvent({
                    eventID,
                    timestamp,
                    status: ScreenshotStatus.UPDATED,
                    type: bounds ? ScreenshotType.SELECTED_REGION : ScreenshotType.FULL_SCREEN,
                    bounds,
                    displayID,
                });
                (this as EventEmitter).emit('screenshot-event', event);
                if (bounds) {
                    this.logDebug(
                        `selection rect: x=${bounds.x} y=${bounds.y} w=${bounds.width} h=${bounds.height}`,
                    );
                }
                break;
            }

            case 'screenshot_capture_failed':
                this.handleError(`Screenshot capture failed: ${data.reason ?? 'unknown'}`);
                break;

            case 'error':
                this.handleError(`${data.code ?? 'error'}: ${data.message ?? 'unknown helper error'}`);
                break;

            default:
                this.logDebug(`Unknown event type: ${data.type}`);
        }
    }

    private handleError(message: string): void {
        if (this.debug) {
            console.error('[screenshot-detector]', message);
        }
        // An unhandled 'error' event would throw and crash the host; warn instead.
        if (this.listenerCount('error') > 0) {
            (this as EventEmitter).emit('error', new Error(message));
        } else if (!this.debug) {
            console.warn('[screenshot-detector]', message);
        }
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[screenshot-detector]', message);
        }
    }
}

export function createScreenshotDetector(config?: ScreenshotDetectorConfig): ScreenshotDetectorService {
    return new ScreenshotDetectorService(config);
}
