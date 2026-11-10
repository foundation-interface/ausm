#!/usr/bin/env node
/**
 * Material Manager Service — Standalone process entry point.
 *
 * Runs the MaterialManager in a separate Node.js process, communicating
 * with the parent (AUSM runtime) over stdio JSON-lines:
 *
 *   stdin  (parent → MM): config messages, window-event messages
 *   stdout (MM → parent): material-frame, material-created, material-focused, material-unfocused, ready, error
 *   stderr: debug / log output
 *
 * The service always runs in storageMode 'remote': it stores nothing on
 * disk itself; frames are sent to the parent (which owns persistence).
 * Frame data and titles are never written to stderr unless `debug` is set
 * in the config message.
 *
 * This keeps the Python worker and image processing out of the runtime
 * process.  Spawned by @ausm/core's MaterialClient; not meant to be run by
 * hand.
 */

// ── CRITICAL: Redirect console to stderr before any imports ───────────────
// stdout is reserved exclusively for JSON-line IPC with the parent process.
// All console.log / console.warn / console.error output MUST go to stderr
// so it doesn't pollute the protocol.  MaterialManager and its dependencies
// use console.log for debug output, so we intercept it here.
const origConsole = { ...console };
console.log = (...args: unknown[]) => origConsole.error(...args);
console.warn = (...args: unknown[]) => origConsole.error(...args);
console.info = (...args: unknown[]) => origConsole.error(...args);
// console.error already writes to stderr, so no change needed.

import { MaterialManager } from './material-manager';
import type { MaterialFrame, MaterialManagerConfig } from './types';
import type { WindowStateEventLike } from './material-manager';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Write a JSON-line to stdout (the IPC channel to parent). */
function send(msg: Record<string, unknown>): void {
    if (shuttingDown) return;
    const line = JSON.stringify(msg) + '\n';
    process.stdout.write(line);
}

// If the parent goes away, writes fail with EPIPE; without a listener that
// becomes an uncaught exception.  Treat it as a shutdown request.
process.stdout.on('error', () => shutdown());

/** Write a log line to stderr (visible in parent's console). */
function log(message: string): void {
    process.stderr.write(`[material-manager-service] ${message}\n`);
}

// ── State ─────────────────────────────────────────────────────────────────

let mm: MaterialManager | null = null;
let configured = false;
let shuttingDown = false;

// ── stdin JSON-line reader ────────────────────────────────────────────────

let stdinBuffer = '';

process.stdin.setEncoding('utf-8');

process.stdin.on('data', (chunk: string) => {
    stdinBuffer += chunk;

    let newlineIdx: number;
    while ((newlineIdx = stdinBuffer.indexOf('\n')) !== -1) {
        const line = stdinBuffer.slice(0, newlineIdx).trim();
        stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
        if (line) {
            let msg: unknown;
            try {
                msg = JSON.parse(line);
            } catch (err) {
                log(`Failed to parse stdin message: ${(err as Error).message}`);
                continue;
            }
            if (!msg || typeof msg !== 'object') continue;
            handleMessage(msg as Record<string, unknown>).catch((err) => {
                log(`Failed to handle ${(msg as Record<string, unknown>).type} message: ${(err as Error).message}`);
            });
        }
    }
});

process.stdin.on('end', () => {
    log('stdin EOF — shutting down');
    shutdown();
});

// ── Message handling ──────────────────────────────────────────────────────

async function handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
        case 'config':
            await handleConfig(msg);
            break;

        case 'window-event':
            handleWindowEvent(msg);
            break;

        default:
            log(`Unknown message type: ${msg.type}`);
    }
}

async function handleConfig(msg: Record<string, unknown>): Promise<void> {
    if (configured) {
        log('Already configured, ignoring duplicate config');
        return;
    }
    configured = true;

    const debug = msg.debug === true;

    try {
        // Connect to the runtime's screen-stream helper if a socket path is provided
        const screenStreamSocketPath = msg.screenStreamSocketPath as string | undefined;
        let screenStreamHelper: MaterialManagerConfig['screenStreamHelper'] | undefined;

        if (screenStreamSocketPath) {
            log(`Connecting to screen-stream helper at ${screenStreamSocketPath}…`);
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { HelperClient } = require('@ausm/device-macos-screen-stream');
            const client = new HelperClient(screenStreamSocketPath);
            // Connect to the already-running helper process (managed by the runtime).
            // connectToExisting() verifies the socket is reachable and marks the
            // client as ready without spawning a new helper subprocess.
            await client.connectToExisting();
            screenStreamHelper = client;
            log('Connected to screen-stream helper.');
        }

        // Build MaterialManager config — use remote storage; parent (Memory) persists
        const mmConfig: MaterialManagerConfig = {
            enabled: true,
            debug,
            storageMode: 'remote',
            hashDistanceThreshold: msg.hashDistanceThreshold as number | undefined,
            captureIntervalMs: msg.captureIntervalMs as number | undefined,
            maxFramesPerMaterial: msg.maxFramesPerMaterial as number | undefined,
            maxFramesPerWindow: msg.maxFramesPerWindow as number | undefined,
            jpegQuality: msg.jpegQuality as number | undefined,
            pythonPath: msg.pythonPath as string | undefined,
            screenStreamReaderPath: msg.screenStreamReaderPath as string | undefined,
            dbPath: msg.dbPath as string | undefined,
            captureDelayMs: msg.captureDelayMs as number | undefined,
            maxFreshnessRetries: msg.maxFreshnessRetries as number | undefined,
            freshnessRetryBaseMs: msg.freshnessRetryBaseMs as number | undefined,
            hashGrid: msg.hashGrid as number | undefined,
            screenStreamHelper,
            materialBlacklist: msg.materialBlacklist as MaterialManagerConfig['materialBlacklist'],
        };

        mm = new MaterialManager(mmConfig);

        // Helper: look up the tracker for a window to get live window state
        const windowInfo = (windowId: number) => {
            const tracker = mm!.getTracker(windowId);
            if (!tracker) return {};
            return {
                bounds: tracker.bounds,
                displayId: tracker.displayId,
                pid: tracker.pid,
            };
        };

        // Helper: look up the latest frame for a material and return
        // IPC-ready fields (base64 data + dimensions).  Returns {} if
        // no frame exists yet (e.g., brand-new material).
        const latestFrameInfo = (materialId: string) =>
            mm!.getLatestFrameInfo(materialId);

        // Subscribe to MM events and forward to stdout
        mm.on('material-frame', (frame: MaterialFrame, hash?: string) => {
            send({
                type: 'material-frame',
                frameId: frame.frameId,
                materialId: frame.materialId,
                windowId: frame.windowId,
                width: frame.width,
                height: frame.height,
                timestamp: frame.timestamp,
                title: frame.title,
                application: frame.application,
                bundleId: frame.bundleId,
                captureReason: frame.captureReason,
                dataBase64: frame.data.toString('base64'),
                sizeBytes: frame.data.length,
                hash: hash ?? null, // For parent Memory.addFrame
                ...windowInfo(frame.windowId),
            });
        });

        mm.on('material-created', (material) => {
            send({
                type: 'material-created',
                materialId: material.materialId,
                windowId: material.windowId,
                title: material.title,
                application: material.application,
                bundleId: material.bundleId,
                documentPath: material.documentPath,
                firstSeen: material.firstSeen,
                lastSeen: material.lastSeen,
                materialType: material.materialType,
                materialTypeConfidence: material.materialTypeConfidence,
                appMetadata: material.appMetadata ?? null,
                ...windowInfo(material.windowId),
                ...latestFrameInfo(material.materialId),
            });
        });

        mm.on('material-type-classified', (material) => {
            send({
                type: 'material-type-classified',
                materialId: material.materialId,
                windowId: material.windowId,
                title: material.title,
                application: material.application,
                bundleId: material.bundleId,
                documentPath: material.documentPath,
                materialType: material.materialType,
                materialTypeConfidence: material.materialTypeConfidence,
                appMetadata: material.appMetadata ?? null,
                firstSeen: material.firstSeen,
                lastSeen: material.lastSeen,
                ...windowInfo(material.windowId),
            });
        });

        mm.on('material-focused', (windowId, material) => {
            send({
                type: 'material-focused',
                windowId,
                materialId: material.materialId,
                title: material.title,
                application: material.application,
                bundleId: material.bundleId,
                documentPath: material.documentPath,
                firstSeen: material.firstSeen,
                lastSeen: material.lastSeen,
                materialType: material.materialType,
                materialTypeConfidence: material.materialTypeConfidence,
                appMetadata: material.appMetadata ?? null,
                ...windowInfo(windowId),
                ...latestFrameInfo(material.materialId),
            });
        });

        mm.on('material-unfocused', (windowId, material) => {
            send({
                type: 'material-unfocused',
                windowId,
                materialId: material.materialId,
                title: material.title,
                application: material.application,
                bundleId: material.bundleId,
                documentPath: material.documentPath,
                firstSeen: material.firstSeen,
                lastSeen: material.lastSeen,
                materialType: material.materialType,
                materialTypeConfidence: material.materialTypeConfidence,
                appMetadata: material.appMetadata ?? null,
                ...windowInfo(windowId),
                ...latestFrameInfo(material.materialId),
            });
        });

        mm.on('error', (error: Error) => {
            send({ type: 'error', message: error.message });
        });

        mm.on('storage:save-material', (material: import('./types').Material) => {
            send({
                type: 'material-save',
                materialId: material.materialId,
                title: material.title,
                windowId: material.windowId,
                application: material.application,
                bundleId: material.bundleId,
                documentPath: material.documentPath,
                lastFrameHash: material.lastFrameHash,
                firstSeen: material.firstSeen,
                lastSeen: material.lastSeen,
                materialType: material.materialType,
                materialTypeConfidence: material.materialTypeConfidence,
                appMetadata: material.appMetadata ?? null,
            });
        });

        mm.on('storage:update-material-type', (materialId: string, materialType: string, materialTypeConfidence: number) => {
            send({
                type: 'material-type-update',
                materialId,
                materialType,
                materialTypeConfidence,
            });
        });

        await mm.start();
        log('MaterialManager started');
        send({ type: 'ready' });
    } catch (err) {
        const message = (err as Error).message;
        log(`Failed to start: ${message}`);
        send({ type: 'error', message: `startup failed: ${message}` });
        process.exit(1);
    }
}

function handleWindowEvent(msg: Record<string, unknown>): void {
    if (!mm) {
        // Silently drop events before config is processed
        return;
    }

    const event: WindowStateEventLike = {
        windowId: (msg.windowId as number) ?? null,
        bounds: (msg.bounds as WindowStateEventLike['bounds']) ?? null,
        displayId: (msg.displayId as number) ?? null,
        title: (msg.title as string) ?? null,
        application: (msg.application as string) ?? null,
        bundleId: (msg.bundleId as string) ?? null,
        pid: (msg.pid as number) ?? null,
        state: (msg.state as string) ?? null,
        documentPath: (msg.documentPath as string) ?? null,
    };

    mm.handleWindowEvent(event);
}

// ── Shutdown ──────────────────────────────────────────────────────────────

function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    if (mm) {
        log('Stopping MaterialManager…');
        try {
            mm.stop();
        } catch (err) {
            log(`Error while stopping: ${(err as Error).message}`);
        }
        mm = null;
    }
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
