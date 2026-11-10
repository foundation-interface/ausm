/**
 * Viewport Client - Bridge between AUSM runtime and a viewport monitor.
 *
 * Loads `@ausm/device-macos-viewport-manager`.
 */

import { EventEmitter } from 'events';

import type { WindowStateEventData } from '../../events/WindowStateEvent';
import { WindowState } from '../../events/WindowStateEvent';

type WindowEventType =
    | 'window-opened'
    | 'window-closed'
    | 'window-focused'
    | 'window-unfocused'
    | 'bounds-changed'
    | 'title-changed';

interface WindowEvent {
    type: WindowEventType;
    windowId: number;
    title: string;
    ownerName: string;
    bundleId: string;
    pid: number;
    bounds: { x: number; y: number; width: number; height: number };
    displayId: number;
    documentPath?: string;
    oldTitle?: string;
    oldBounds?: { x: number; y: number; width: number; height: number };
    timestamp: number;
}

interface SpaceChangeNativeEvent {
    type: 'space-changed';
    timestamp: number;
}

interface ViewportMonitorLike {
    start(config?: { debug?: boolean }): boolean;
    stop(): boolean;
    cleanup(): void;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
}

function loadMonitor(): ViewportMonitorLike {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createViewportMonitor } = require('@ausm/device-macos-viewport-manager');
    return createViewportMonitor();
}

function mapEventTypeToWindowState(eventType: WindowEventType): WindowState {
    switch (eventType) {
        case 'window-opened':
            return WindowState.APPEAR;
        case 'window-closed':
            return WindowState.VANISHED;
        case 'window-focused':
            return WindowState.FOCUSED;
        case 'window-unfocused':
            return WindowState.UNFOCUSED;
        case 'bounds-changed':
            return WindowState.BOUNDS_CHANGED;
        case 'title-changed':
            return WindowState.TITLE_CHANGED;
        default: {
            const _exhaustive: never = eventType;
            return _exhaustive;
        }
    }
}

function generateEventID(): string {
    return `win_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function toWindowStateEventData(event: WindowEvent): WindowStateEventData {
    return {
        eventID: generateEventID(),
        timestamp: event.timestamp,
        application: event.ownerName,
        state: mapEventTypeToWindowState(event.type),
        bounds: event.bounds,
        windowId: event.windowId,
        title: event.title,
        bundleId: event.bundleId,
        pid: event.pid,
        oldBounds: event.oldBounds ?? null,
        oldTitle: event.oldTitle ?? null,
        displayId: event.displayId ?? null,
        documentPath: event.documentPath ?? null,
    };
}

export interface ViewportClientOptions {
    debug?: boolean;
    autoStart?: boolean;
}

export interface ViewportClientEvents {
    'window-state': (data: WindowStateEventData) => void;
    'space-changed': (data: { timestamp: number }) => void;
    error: (error: Error) => void;
    status: (status: 'started' | 'stopped') => void;
}

export class ViewportClient extends EventEmitter {
    private monitor: ViewportMonitorLike;
    private running = false;
    private debug = false;

    constructor(options: ViewportClientOptions = {}) {
        super();
        this.debug = options.debug ?? false;
        this.monitor = loadMonitor();

        this.monitor.on('window-event', (event: unknown) => {
            if (!this.running) return;
            try {
                this.handleEvent(event as WindowEvent);
            } catch (err) {
                this.handleError('Failed to process event', err as Error);
            }
        });

        this.monitor.on('space-changed', (event: unknown) => {
            if (!this.running) return;
            this.emit('space-changed', { timestamp: (event as SpaceChangeNativeEvent).timestamp });
        });

        this.monitor.on('error', (err: unknown) => {
            this.emit('error', err as Error);
        });

        this.monitor.on('status', (status: unknown) => {
            this.emit('status', status as 'started' | 'stopped');
        });

        if (options.autoStart) {
            this.start();
        }
    }

    start(): boolean {
        if (this.running) {
            this.logDebug('ViewportClient already running');
            return true;
        }

        const started = this.monitor.start({ debug: this.debug });
        if (started) {
            this.running = true;
        }
        return started;
    }

    stop(): boolean {
        if (!this.running) {
            return true;
        }
        this.running = false;
        return this.monitor.stop();
    }

    isRunning(): boolean {
        return this.running;
    }

    cleanup(): void {
        this.stop();
        this.monitor.cleanup();
        this.removeAllListeners();
    }

    on<K extends keyof ViewportClientEvents>(
        event: K,
        listener: ViewportClientEvents[K],
    ): this {
        return super.on(event, listener);
    }

    once<K extends keyof ViewportClientEvents>(
        event: K,
        listener: ViewportClientEvents[K],
    ): this {
        return super.once(event, listener);
    }

    emit<K extends keyof ViewportClientEvents>(
        event: K,
        ...args: Parameters<ViewportClientEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    private handleEvent(event: WindowEvent): void {
        const eventData = toWindowStateEventData(event);
        this.emit('window-state', eventData);

        if (this.debug) {
            const b = event.bounds;
            const boundsStr = `(${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)})`;
            this.logDebug(
                `${event.type}: "${event.title}" [${event.bundleId}] ${boundsStr}`,
            );
        }
    }

    private handleError(message: string, err: Error): void {
        const errorMsg = `${message}: ${err.message}`;
        if (this.debug) {
            console.error('[ViewportClient]', errorMsg);
        }
        this.emit('error', new Error(errorMsg));
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[ViewportClient]', message);
        }
    }
}

export function createViewportClient(
    options?: ViewportClientOptions,
): ViewportClient {
    return new ViewportClient(options);
}
