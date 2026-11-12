/**
 * Clipboard Monitor Service
 *
 * Monitors macOS clipboard by polling NSPasteboard.changeCount. When the count
 * changes, the clipboard content was modified (copy/cut). Emits CopyPasteEvent.
 *
 * Architecture (similar to screenshot-detector):
 *   Swift subprocess (ClipboardHelper)
 *     └─ Polls NSPasteboard.general.changeCount
 *     └─ stdout: one JSON object per line when clipboard changes
 *
 *   Node.js (this module)
 *     └─ HelperProcess: spawn, restart with backoff on crash, SIGTERM→SIGKILL on stop
 *     └─ readline on stdout → parse JSON → map to CopyPasteEvent → emit
 *
 * Privacy: with `includeContent: false` the helper never reads clipboard contents
 * (only the content type). Pasteboards marked concealed/transient by password
 * managers never carry content. Debug logs never include clipboard contents.
 */

import { EventEmitter } from 'events';
import { HelperProcess } from './helper-process';
import { resolveHelperBinary } from './resolve-helper';

import { createCopyPasteEvent, CopyPasteAction, CopyPasteContentType, type CopyPasteEvent } from '@ausm/core';

export interface ClipboardMonitorConfig {
    /** Log helper diagnostics to the console (default: false). Never logs clipboard contents. */
    debug?: boolean;
    /**
     * Include content in events (default: true). Set false for privacy: the helper then
     * reports only the content type and never reads the clipboard's contents.
     */
    includeContent?: boolean;
    /** Cap on `content` size in UTF-8 bytes (default: 1 MiB); longer content is truncated. */
    maxContentBytes?: number;
    /** Restart the helper with backoff if it crashes (default: true). */
    autoRestart?: boolean;
    /** Override the helper executable path (default: bundled build/clipboard-helper). */
    helperPath?: string;
}

export interface ClipboardMonitorEvents {
    'copy-paste-event': (event: CopyPasteEvent) => void;
    status: (status: 'started' | 'stopped') => void;
    error: (err: Error) => void;
}

/** One JSON line from ClipboardHelper (see swift/Sources/ClipboardHelper/main.swift). */
interface NativeClipboardEvent {
    type: string;
    contentType?: string;
    content?: string;
    contentPaths?: string[];
    changeCount?: number;
    timestamp?: number;
    /** content was cut at maxContentBytes */
    contentTruncated?: boolean;
    /** pasteboard marked concealed/transient (password manager): no content */
    concealed?: boolean;
}

function helperBinary(): string {
    return resolveHelperBinary(__dirname, 'clipboard-helper', 'ClipboardHelper');
}

function makeEventId(): string {
    return `cp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export class ClipboardMonitorService extends EventEmitter {
    private helper: HelperProcess | null = null;
    private debug = false;
    private includeContent = true;
    private maxContentBytes: number | undefined;
    private autoRestart: boolean;
    private helperPath: string | undefined;

    constructor(config: ClipboardMonitorConfig = {}) {
        super();
        this.debug = config.debug ?? false;
        this.includeContent = config.includeContent ?? true;
        this.maxContentBytes = config.maxContentBytes;
        this.autoRestart = config.autoRestart ?? true;
        this.helperPath = config.helperPath;
    }

    // Type-safe EventEmitter overrides
    on<K extends keyof ClipboardMonitorEvents>(event: K, listener: ClipboardMonitorEvents[K]): this {
        return super.on(event, listener);
    }
    once<K extends keyof ClipboardMonitorEvents>(event: K, listener: ClipboardMonitorEvents[K]): this {
        return super.once(event, listener);
    }
    emit<K extends keyof ClipboardMonitorEvents>(
        event: K,
        ...args: Parameters<ClipboardMonitorEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    start(): boolean {
        if (this.helper?.running) {
            this.logDebug('ClipboardMonitorService already running');
            return true;
        }

        if (process.platform !== 'darwin') {
            this.handleError('ClipboardMonitorService only works on macOS');
            return false;
        }

        const args: string[] = [];
        if (!this.includeContent) args.push('--no-content');
        if (this.maxContentBytes && this.maxContentBytes > 0) {
            args.push('--max-content-bytes', String(Math.floor(this.maxContentBytes)));
        }

        this.helper = new HelperProcess({
            binary: this.helperPath ?? helperBinary(),
            args,
            name: 'ClipboardHelper',
            autoRestart: this.autoRestart,
            onMessage: (msg) => this.handleNativeEvent(msg as NativeClipboardEvent),
            onError: (err) => this.handleError(err.message),
            onStatus: (status) => {
                (this as EventEmitter).emit('status', status);
                this.logDebug(`ClipboardMonitorService ${status}`);
            },
            log: this.debug ? (m) => this.logDebug(m) : undefined,
            onStderr: this.debug ? (text) => process.stderr.write(`[clipboard-monitor] ${text}`) : undefined,
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

    private handleNativeEvent(data: NativeClipboardEvent): void {
        if (data.type === 'ready') {
            this.logDebug('Helper subprocess ready');
            return;
        }

        if (data.type !== 'clipboard_changed') {
            this.logDebug(`Unknown event type: ${data.type}`);
            return;
        }

        const timestamp = typeof data.timestamp === 'number' ? data.timestamp : Date.now();
        const eventID = makeEventId();
        const contentType = this.parseContentType(data.contentType);
        const content = this.includeContent && typeof data.content === 'string' ? data.content : null;
        const paths =
            this.includeContent && Array.isArray(data.contentPaths)
                ? data.contentPaths.filter((p): p is string => typeof p === 'string')
                : [];
        const contentPaths = paths.length ? paths : null;

        const event = createCopyPasteEvent({
            eventID,
            timestamp,
            action: CopyPasteAction.COPY,
            contentType,
            content,
            contentPaths,
            changeCount: typeof data.changeCount === 'number' ? data.changeCount : null,
        });

        (this as EventEmitter).emit('copy-paste-event', event);
        if (this.debug) {
            const detail =
                content != null
                    ? ` (${content.length} chars${data.contentTruncated ? ', truncated' : ''})`
                    : contentPaths
                      ? ` (${contentPaths.length} files)`
                      : data.concealed
                        ? ' (concealed)'
                        : '';
            this.logDebug(`clipboard changed type=${contentType ?? '?'}${detail}`);
        }
    }

    private parseContentType(s: string | undefined): CopyPasteContentType | null {
        if (!s) return null;
        const t = s as CopyPasteContentType;
        if (Object.values(CopyPasteContentType).includes(t)) return t;
        return null;
    }

    private handleError(message: string): void {
        if (this.debug) {
            console.error('[clipboard-monitor]', message);
        }
        // An unhandled 'error' event would throw and crash the host; warn instead.
        if (this.listenerCount('error') > 0) {
            (this as EventEmitter).emit('error', new Error(message));
        } else if (!this.debug) {
            console.warn('[clipboard-monitor]', message);
        }
    }

    private logDebug(message: string): void {
        if (this.debug) {
            console.log('[clipboard-monitor]', message);
        }
    }
}

export function createClipboardMonitor(config?: ClipboardMonitorConfig): ClipboardMonitorService {
    return new ClipboardMonitorService(config);
}
