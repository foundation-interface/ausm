#!/usr/bin/env node
/**
 * Demo: @ausm/device-macos-clipboard-monitor
 *
 * Run: node examples/demo.js
 * Then copy text (Cmd+C) — you should see CopyPasteEvent logged.
 */

const { createClipboardMonitor } = require('../dist/index.js');

const monitor = createClipboardMonitor({ debug: true });

monitor.on('status', (status) => {
    console.log('[demo] status:', status);
});

monitor.on('copy-paste-event', (event) => {
    console.log('[demo] CopyPasteEvent:', {
        eventID: event.eventID,
        timestamp: event.timestamp,
        action: event.action,
        contentType: event.contentType,
        contentLength: event.content?.length ?? 0,
        contentPaths: event.contentPaths,
        contentPreview: event.content
            ? event.content.slice(0, 80) + (event.content.length > 80 ? '...' : '')
            : '(none)',
    });
});

monitor.on('error', (err) => {
    console.error('[demo] error:', err.message);
});

console.log('[demo] Starting clipboard monitor. Copy something (Cmd+C) to test.');
monitor.start();

process.on('SIGINT', () => {
    monitor.stop();
    process.exit(0);
});
