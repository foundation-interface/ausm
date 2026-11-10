#!/usr/bin/env node
/**
 * Demo: Screenshot Detector
 *
 * Run and trigger a screenshot (Cmd+Shift+3, Cmd+Shift+4, or Cmd+Shift+5).
 * You should see ScreenshotEvent emissions.
 */

const { createScreenshotDetector } = require('../dist/index.js');

const detector = createScreenshotDetector({ debug: true });

detector.on('screenshot-event', (event) => {
    const hasImage = event.imageData != null;
    console.log('[EVENT]', {
        status: event.status,
        type: event.type,
        bounds: event.bounds,
        displayID: event.displayID,
        imageData: hasImage ? `${event.imageData.width}x${event.imageData.height}` : null,
        timestamp: new Date(event.timestamp).toISOString(),
    });
    if (event.status === 'SCREENSHOT_FINISHED' && !hasImage) {
        console.log('  → imageData is null. Grant Screen Recording permission: System Settings → Privacy & Security → Screen Recording');
    }
});

detector.on('status', (status) => {
    console.log('[STATUS]', status);
});

detector.on('error', (err) => {
    console.error('[ERROR]', err.message);
});

const started = detector.start();
if (!started) {
    console.error('Failed to start. macOS only.');
    process.exit(1);
}

console.log('Screenshot detector running. Press Cmd+Shift+3/4/5 to capture. Ctrl+C to stop.\n');

process.on('SIGINT', () => {
    detector.stop();
    process.exit(0);
});
