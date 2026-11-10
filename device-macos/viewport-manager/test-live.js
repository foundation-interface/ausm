/**
 * Live test for the viewport monitor (subprocess-based).
 * Run: node device-macos/viewport-manager/test-live.js
 */

const path = require('path');
const { spawn } = require('child_process');
const { createInterface } = require('readline');

const published = path.resolve(__dirname, 'build', 'viewport-helper');
const dev = path.resolve(__dirname, 'swift', '.build', 'release', 'ViewportHelper');
const HELPER_BINARY = require('fs').existsSync(published) ? published : dev;

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║          Viewport Monitor — Live Test                 ║');
console.log('║  Switch windows, move/resize, open/close apps        ║');
console.log('║  Press Ctrl+C to stop                                ║');
console.log('╚════════════════════════════════════════════════════════╝');
console.log();
console.log(`Helper binary: ${HELPER_BINARY}`);
console.log();

const child = spawn(HELPER_BINARY, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
});

child.on('error', (err) => {
    console.error('Failed to start helper:', err.message);
    process.exit(1);
});

child.on('exit', (code, signal) => {
    console.log(`\nHelper exited (code=${code}, signal=${signal})`);
    process.exit(0);
});

child.stderr.on('data', (chunk) => {
    process.stderr.write(`[helper-stderr] ${chunk}`);
});

const rl = createInterface({ input: child.stdout });

const eventColors = {
    'window-opened': '\x1b[32m',   // green
    'window-closed': '\x1b[31m',   // red
    'window-focused': '\x1b[36m',  // cyan
    'window-unfocused': '\x1b[33m',  // yellow
    'bounds-changed': '\x1b[35m',  // magenta
    'title-changed': '\x1b[34m',   // blue
    'ready': '\x1b[90m',           // gray
};
const RESET = '\x1b[0m';

let eventCount = 0;

rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
        const event = JSON.parse(line);
        eventCount++;

        const color = eventColors[event.type] || '';
        const b = event.bounds;
        const boundsStr = b ? `(${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)})` : '';

        let detail = '';
        if (event.oldTitle) detail += ` was="${event.oldTitle}"`;
        if (event.oldBounds) {
            const ob = event.oldBounds;
            detail += ` was=(${Math.round(ob.x)},${Math.round(ob.y)} ${Math.round(ob.width)}x${Math.round(ob.height)})`;
        }

        console.log(
            `${color}[${String(eventCount).padStart(4)}] ${event.type.padEnd(16)}${RESET} ` +
            `"${event.title || '(untitled)'}" ` +
            `[${event.ownerName}] ` +
            `pid=${event.pid} wid=${event.windowId} ` +
            `${boundsStr}${detail}`
        );
    } catch {
        console.log('[raw]', line);
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nStopping...');
    child.kill('SIGTERM');
});

process.on('SIGTERM', () => {
    child.kill('SIGTERM');
});
