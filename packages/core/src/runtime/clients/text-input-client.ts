/**
 * Text Input Client - Bridge between AUSM runtime and text-input monitor service
 *
 * Connects the text-input monitor service to the AUSM event system,
 * converting service events to TextInputEventData format.
 */

import { EventEmitter } from 'events';

import type { TextInputEventData } from '../../events/TextInputEvent';
import { createAUSMUIElement } from '../../AUSM';

import {
    TextInputMonitorService,
    type TextInputEventLike,
} from '@ausm/device-macos-text-input';

/**
 * Generate a unique event ID
 */
function generateEventID(): string {
    return `txt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Convert text-input service payload to TextInputEventData
 */
function toTextInputEventData(like: TextInputEventLike): TextInputEventData {
    return {
        eventID: like.eventID ?? generateEventID(),
        timestamp: like.timestamp ?? Date.now(),
        displayID: like.displayID ?? null,
        text: like.text ?? null,
        sourceElement: like.sourceElement
            ? createAUSMUIElement(like.sourceElement)
            : null,
        status: (like.status ?? null) as TextInputEventData['status'],
        caretScreenPosition: like.caretScreenPosition ?? null,
    };
}

export interface TextInputClientOptions {
    /** Enable debug logging */
    debug?: boolean;
    /** Auto-start when created */
    autoStart?: boolean;
}

export interface TextInputClientEvents {
    'text-input': (data: TextInputEventData) => void;
    error: (error: Error) => void;
    status: (status: 'started' | 'stopped') => void;
}

/**
 * Text Input Client
 *
 * Bridges the text-input monitor service with the AUSM event system.
 * Emits TextInputEventData compatible events for the AUSM runtime.
 */
export class TextInputClient extends EventEmitter {
    private monitor: TextInputMonitorService;
    private running = false;
    private debug = false;

    constructor(options: TextInputClientOptions = {}) {
        super();
        this.debug = options.debug ?? false;
        this.monitor = new TextInputMonitorService();

        this.monitor.on('text-input', (data: TextInputEventLike) => {
            if (!this.running) return;
            try {
                const eventData = toTextInputEventData(data);
                this.emit('text-input', eventData);
                if (this.debug) {
                    this.logDebug(
                        `text-input: status=${eventData.status} <${(eventData.text ?? '').length} chars>`,
                    );
                }
            } catch (err) {
                this.handleError('Failed to process text-input event', err as Error);
            }
        });

        this.monitor.on('error', (err: Error) => {
            this.emit('error', err);
        });

        this.monitor.on('status', (status: 'started' | 'stopped') => {
            this.emit('status', status);
        });

        if (options.autoStart) {
            this.start();
        }
    }

    start(): boolean {
        if (this.running) {
            this.logDebug('TextInputClient already running');
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

    on<K extends keyof TextInputClientEvents>(
        event: K,
        listener: TextInputClientEvents[K],
    ): this {
        return super.on(event, listener);
    }

    once<K extends keyof TextInputClientEvents>(
        event: K,
        listener: TextInputClientEvents[K],
    ): this {
        return super.once(event, listener);
    }

    emit<K extends keyof TextInputClientEvents>(
        event: K,
        ...args: Parameters<TextInputClientEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    private handleError(message: string, err: Error): void {
        const errorMsg = `${message}: ${err.message}`;
        if (this.debug) {
            console.error('[TextInputClient]', errorMsg);
        }
        this.emit('error', new Error(errorMsg));
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[TextInputClient]', message);
        }
    }
}

export function createTextInputClient(
    options?: TextInputClientOptions,
): TextInputClient {
    return new TextInputClient(options);
}
