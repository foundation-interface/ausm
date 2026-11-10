#!/usr/bin/env npx tsx
/**
 * DEV-ONLY: Live Visual Dashboard for the material-manager.
 *
 * Not part of the published package (excluded by package.json "files" and
 * not built by tsup).  Run from a repo checkout only.
 *
 * Starts a web server bound to 127.0.0.1:3210 that shows captured window
 * frames in real-time as you switch between windows.  The page streams
 * screenshots of your windows: it only accepts requests whose Host header
 * is localhost/127.0.0.1 (DNS-rebinding guard) and sends no CORS headers,
 * so other origins cannot read the stream.
 *
 * Uses Server-Sent Events (SSE) to push frames to the browser instantly.
 *
 * Requirements: Screen Recording + Accessibility permission for the
 * terminal, the screen-stream helper built, and a Python with numpy +
 * opencv (set AUSM_PYTHON, default: python3).
 *
 * Usage:
 *   npx tsx device-macos/material-manager/test-visual-dashboard.ts
 *   Then open http://localhost:3210 in your browser.
 */

import http from 'http';
import path from 'path';
import { execFile } from 'child_process';
import { ViewportMonitorService, type WindowEvent } from '../viewport-manager';
import { HelperClient } from '../screen-stream';
import { MaterialManager } from './material-manager';
import type { MaterialFrame } from './types';
import type { WindowTracker } from './window-tracker';

const PORT = 3210;
const HOST = '127.0.0.1';
const PYTHON_PATH = process.env.AUSM_PYTHON ?? 'python3';
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const SCREEN_STREAM_READER_PATH = path.resolve(__dirname, '../internal-lib/screen-stream-reader');

// ── SSE clients ───────────────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        res.write(payload);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
    // 1. Start viewport monitor
    const viewport = new ViewportMonitorService();
    if (!viewport.start({ debug: false })) {
        console.error('Failed to start viewport monitor.');
        process.exit(1);
    }

    // 2. Start screen-stream helper (provides per-window capture + display stream)
    console.log('[dashboard] Starting screen-stream helper…');
    const helper = new HelperClient();
    await helper.start();
    await helper.configure({ fps: 5, targetHeight: 1080, frameCount: 5, sharedMemoryName: '/ausm-frames' });
    await helper.startStream();
    console.log('[dashboard] Screen-stream helper running.');

    // 3. Start material manager
    const mm = new MaterialManager({
        enabled: true,
        debug: true,
        hashDistanceThreshold: 6,
        captureIntervalMs: 2000,
        maxFramesPerMaterial: 200,
        jpegQuality: 80,
        pythonPath: PYTHON_PATH,
        screenStreamReaderPath: SCREEN_STREAM_READER_PATH,
        // Per-window capture via CGWindowListCreateImage
        screenStreamHelper: helper,
        // Delay before capturing (window may still be rendering)
        captureDelayMs: 200,
        // Fallback freshness retries (only used when screenStreamHelper is absent)
        maxFreshnessRetries: 3,
        freshnessRetryBaseMs: 150,
    });

    await mm.start();

    // Wire viewport → material manager
    const stateMap: Record<string, string> = {
        'window-opened': 'APPEAR', 'window-closed': 'VANISHED',
        'window-focused': 'FOCUSED', 'window-unfocused': 'UNFOCUSED',
        'bounds-changed': 'BOUNDS_CHANGED', 'title-changed': 'TITLE_CHANGED',
    };

    viewport.on('window-event', (event: WindowEvent) => {
        mm.handleWindowEvent({
            windowId: event.windowId, bounds: event.bounds,
            displayId: event.displayId, title: event.title,
            application: event.ownerName, bundleId: event.bundleId,
            pid: event.pid, state: stateMap[event.type] ?? null,
            documentPath: event.documentPath ?? null,
        });

        // Broadcast focus/unfocused to dashboard
        if (event.type === 'window-focused' || event.type === 'window-unfocused') {
            broadcast('window-event', {
                type: event.type, windowId: event.windowId,
                title: event.title, app: event.ownerName,
            });
        }
    });

    // Broadcast new frames
    mm.on('material-frame', (frame: MaterialFrame) => {
        const b64 = frame.data.toString('base64');
        broadcast('frame', {
            windowId: frame.windowId,
            materialId: frame.materialId,
            width: frame.width,
            height: frame.height,
            sizeBytes: frame.data.length,
            title: frame.title,
            application: frame.application,
            bundleId: frame.bundleId,
            captureReason: frame.captureReason,
            timestamp: frame.timestamp,
            dataUrl: `data:image/jpeg;base64,${b64}`,
            frameCount: mm.frameStore!.getFrameCountByWindow(frame.windowId),
        });
    });

    // Broadcast material lifecycle events
    mm.on('material-created', (material) => {
        broadcast('material-created', {
            materialId: material.materialId,
            windowId: material.windowId,
            title: material.title,
            application: material.application,
            documentPath: material.documentPath,
        });
    });

    mm.on('material-focused', (windowId, material) => {
        broadcast('material-focused', {
            windowId,
            materialId: material.materialId,
            title: material.title,
            application: material.application,
            documentPath: material.documentPath,
        });
    });

    mm.on('material-unfocused', (windowId, material) => {
        broadcast('material-unfocused', {
            windowId,
            materialId: material.materialId,
            title: material.title,
            application: material.application,
            documentPath: material.documentPath,
        });
    });

    // Handle errors gracefully (prevent unhandled 'error' event crash)
    mm.on('error', (err: Error) => {
        console.error('[dashboard] MaterialManager error:', err.message);
    });

    // Periodic stats
    setInterval(() => {
        const trackers = mm.getAllTrackers();
        const stats: Record<string, unknown>[] = [];
        for (const [wid, t] of trackers) {
            const tracker = t as WindowTracker;
            const materials = Array.from(tracker.materials.values()).map(m => ({
                materialId: m.materialId,
                title: m.title,
                documentPath: m.documentPath,
                frameCount: mm.frameStore!.getFrameCount(m.materialId),
                firstSeen: m.firstSeen,
                lastSeen: m.lastSeen,
                isCurrent: tracker.currentMaterial === m,
            }));
            stats.push({
                windowId: wid, active: tracker.active,
                frameCount: mm.frameStore!.getFrameCountByWindow(wid),
                title: tracker.title,
                application: tracker.application, bounds: tracker.bounds,
                documentPath: tracker.documentPath,
                materialCount: tracker.materialCount,
                currentMaterialId: tracker.currentMaterial?.materialId ?? null,
                materials,
            });
        }
        broadcast('stats', { trackers: stats, storeStats: mm.frameStore!.getStats() });
    }, 3000);

    // 3. HTTP server
    const server = http.createServer((req, res) => {
        // DNS-rebinding guard: only serve requests addressed to localhost.
        if (!req.headers.host || !ALLOWED_HOSTS.has(req.headers.host)) {
            res.writeHead(403);
            res.end();
            return;
        }
        if (req.url === '/events') {
            // SSE endpoint (same-origin only — no CORS headers on purpose)
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            });
            res.write('\n');
            sseClients.add(res);
            req.on('close', () => sseClients.delete(res));
            return;
        }

        // Serve the dashboard HTML
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
    });

    server.listen(PORT, HOST, () => {
        console.log('');
        console.log('='.repeat(60));
        console.log('  Material Manager — Live Visual Dashboard');
        console.log('='.repeat(60));
        console.log('');
        console.log(`  Open in browser:  http://localhost:${PORT}`);
        console.log('');
        console.log('  Switch between windows to see frames appear live.');
        console.log('  Press Ctrl+C to stop.');
        console.log('');

        // Auto-open in browser (argv, no shell)
        execFile('open', [`http://localhost:${PORT}`], () => { /* ignore */ });
    });

    process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        mm.stop();
        viewport.cleanup();
        try { await helper.stop(); } catch { /* ignore */ }
        server.close();
        process.exit(0);
    });
}

// ── Dashboard HTML ────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Material Manager — Live Dashboard</title>
<style>
:root {
    --bg: #0f0f1a;
    --surface: #1a1a2e;
    --surface2: #16213e;
    --border: #2a2a4a;
    --text: #e0e0e0;
    --text2: #888;
    --accent: #4fc3f7;
    --green: #66bb6a;
    --dim: #555;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text);
    padding: 20px;
}
header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid var(--border);
}
header h1 { font-size: 20px; font-weight: 600; }
#status { font-size: 12px; color: var(--green); }
#status.disconnected { color: #e57373; }

.stats-bar {
    display: flex; gap: 24px; margin-bottom: 20px;
    font-size: 13px; color: var(--text2);
}
.stat-val { color: var(--accent); font-weight: 600; margin-left: 4px; }

#windows { display: flex; flex-direction: column; gap: 24px; }

.window-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; overflow: hidden;
    transition: border-color 0.3s;
}
.window-card.active { border-color: var(--accent); }
.window-card.flash { border-color: var(--green); }

.window-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; background: var(--surface2);
    border-bottom: 1px solid var(--border);
}
.window-title {
    font-size: 13px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60%;
}
.window-meta { font-size: 11px; color: var(--text2); display: flex; gap: 12px; }

.material-section {
    border-top: 1px solid var(--border);
}
.material-section.current { background: rgba(79, 195, 247, 0.04); }
.material-header {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 14px; font-size: 11px; color: var(--text2);
}
.material-header .material-title {
    font-weight: 600; color: var(--text); max-width: 50%;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.material-header .material-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--border); color: var(--text2);
}
.material-header .material-badge.active {
    background: var(--accent); color: #000;
}
.material-header .material-frames-count { margin-left: auto; }
.material-doc {
    padding: 0 14px 4px;
    font-size: 10px; color: var(--dim);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-family: "SF Mono", "Menlo", "Monaco", monospace;
    max-width: 100%;
}
.material-doc a {
    color: var(--dim); text-decoration: none;
}
.material-doc a:hover { color: var(--accent); text-decoration: underline; }
.material-doc .doc-label { color: var(--text2); }

.frames-strip {
    display: flex; overflow-x: auto; gap: 2px; padding: 4px 8px 8px;
    scroll-behavior: smooth;
}
.frames-strip::-webkit-scrollbar { height: 6px; }
.frames-strip::-webkit-scrollbar-track { background: var(--surface); }
.frames-strip::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

.frame-thumb {
    flex-shrink: 0; position: relative;
    border: 2px solid transparent; border-radius: 6px; overflow: hidden;
    cursor: pointer; transition: border-color 0.2s;
    max-height: 180px;
}
.frame-thumb:hover { border-color: var(--accent); }
.frame-thumb.latest { border-color: var(--green); }
.frame-thumb img { display: block; height: 160px; width: auto; }
.frame-label {
    position: absolute; bottom: 0; left: 0; right: 0;
    font-size: 9px; color: #fff; background: rgba(0,0,0,0.65);
    padding: 2px 5px; text-align: center;
}

/* Lightbox */
#lightbox {
    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.92); z-index: 100;
    justify-content: center; align-items: center; flex-direction: column;
    cursor: pointer;
}
#lightbox.open { display: flex; }
#lightbox img {
    max-width: 95vw; max-height: 85vh; border-radius: 8px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.6);
}
#lightbox .caption {
    margin-top: 12px; font-size: 13px; color: var(--text2); text-align: center;
}

.empty-state {
    text-align: center; padding: 80px 20px; color: var(--dim); font-size: 15px;
}
.empty-state .hint { margin-top: 8px; font-size: 13px; }
</style>
</head>
<body>

<header>
    <h1>Material Manager &mdash; Live Dashboard</h1>
    <span id="status">Connecting...</span>
</header>

<div class="stats-bar">
    <span>Windows: <span class="stat-val" id="stat-windows">0</span></span>
    <span>Active: <span class="stat-val" id="stat-active">0</span></span>
    <span>Materials: <span class="stat-val" id="stat-materials">0</span></span>
    <span>Frames: <span class="stat-val" id="stat-frames">0</span></span>
    <span>Events: <span class="stat-val" id="stat-events">0</span></span>
    <span>DB: <span class="stat-val" id="stat-db">-</span></span>
</div>

<div id="windows">
    <div class="empty-state" id="empty">
        Waiting for window events...<br/>
        <span class="hint">Switch between windows on your Mac to start capturing.</span>
    </div>
</div>

<div id="lightbox" onclick="closeLightbox()">
    <img id="lb-img" src="" />
    <div class="caption" id="lb-caption"></div>
</div>

<script>
const windowsEl = document.getElementById('windows');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const lbEl = document.getElementById('lightbox');
const lbImg = document.getElementById('lb-img');
const lbCaption = document.getElementById('lb-caption');

// State
// windowCards: windowId -> { el, materialsContainer, materials: Map<materialId, { sectionEl, strip, frames[], title }> }
const windowCards = new Map();
let totalFrames = 0;
let totalEvents = 0;
let totalMaterials = 0;

function openLightbox(dataUrl, caption) {
    lbImg.src = dataUrl;
    lbCaption.textContent = caption;
    lbEl.classList.add('open');
}
function closeLightbox() {
    lbEl.classList.remove('open');
    lbImg.src = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

function formatDocPath(docPath) {
    if (!docPath) return '';
    return '<span class="doc-label">doc:</span> ' + esc(docPath);
}

function getOrCreateCard(windowId, title, app) {
    if (windowCards.has(windowId)) return windowCards.get(windowId);

    emptyEl.style.display = 'none';

    const card = document.createElement('div');
    card.className = 'window-card';
    card.innerHTML = \`
        <div class="window-header">
            <div class="window-title" id="title-\${windowId}">\${esc(title || 'untitled')}</div>
            <div class="window-meta">
                <span id="app-\${windowId}">\${esc(app || '')}</span>
                <span id="mcount-\${windowId}">0 materials</span>
                <span id="fcount-\${windowId}">0 frames</span>
                <span>wid: \${windowId}</span>
            </div>
        </div>
        <div class="materials-container" id="mats-\${windowId}"></div>
    \`;
    windowsEl.prepend(card);

    const entry = {
        el: card,
        materialsContainer: card.querySelector('.materials-container'),
        materials: new Map(),
        currentMaterialId: null,
    };
    windowCards.set(windowId, entry);
    return entry;
}

function getOrCreateMaterialSection(card, materialId, title, windowId, documentPath) {
    if (card.materials.has(materialId)) {
        const existing = card.materials.get(materialId);
        // Update documentPath if provided and changed
        if (documentPath && existing.documentPath !== documentPath) {
            existing.documentPath = documentPath;
            const docEl = existing.sectionEl.querySelector('.material-doc');
            if (docEl) docEl.innerHTML = formatDocPath(documentPath);
        }
        return existing;
    }

    const section = document.createElement('div');
    section.className = 'material-section current';
    section.innerHTML = \`
        <div class="material-header">
            <span class="material-badge active">active</span>
            <span class="material-title">\${esc(title || 'untitled')}</span>
            <span class="material-frames-count">0 frames</span>
        </div>
        <div class="material-doc">\${documentPath ? formatDocPath(documentPath) : ''}</div>
        <div class="frames-strip"></div>
    \`;

    // Remove "current" and "active" badge from previous sections
    for (const [, mat] of card.materials) {
        mat.sectionEl.classList.remove('current');
        const badge = mat.sectionEl.querySelector('.material-badge');
        if (badge) { badge.classList.remove('active'); badge.textContent = 'tab'; }
    }

    // Insert at the top of the container
    card.materialsContainer.prepend(section);

    const matEntry = {
        sectionEl: section,
        strip: section.querySelector('.frames-strip'),
        frames: [],
        title: title,
        documentPath: documentPath || null,
    };
    card.materials.set(materialId, matEntry);
    card.currentMaterialId = materialId;

    totalMaterials++;
    document.getElementById('stat-materials').textContent = totalMaterials;

    // Update material count
    const mcountEl = document.getElementById('mcount-' + windowId);
    if (mcountEl) mcountEl.textContent = card.materials.size + ' materials';

    return matEntry;
}

function addFrame(data) {
    const card = getOrCreateCard(data.windowId, data.title, data.application);

    // Update window title to current
    const titleEl = document.getElementById('title-' + data.windowId);
    if (titleEl && data.title) titleEl.textContent = data.title;

    // Find or create the material section for this frame
    const materialId = data.materialId || '__default__';
    const mat = getOrCreateMaterialSection(card, materialId, data.title, data.windowId);

    // Remove "latest" from previous thumbs in this material
    const prev = mat.strip.querySelector('.latest');
    if (prev) prev.classList.remove('latest');

    // Create thumbnail
    const sizeKB = (data.sizeBytes / 1024).toFixed(1);
    const time = new Date(data.timestamp).toLocaleTimeString();
    const idx = mat.frames.length + 1;

    const thumb = document.createElement('div');
    thumb.className = 'frame-thumb latest';
    thumb.innerHTML = \`
        <img src="\${data.dataUrl}" />
        <div class="frame-label">#\${idx} \${data.width}x\${data.height} \${sizeKB}KB</div>
    \`;
    thumb.onclick = (e) => {
        e.stopPropagation();
        openLightbox(data.dataUrl, \`#\${idx} — \${data.width}x\${data.height} — \${sizeKB}KB — \${time} — \${data.title || ''}\`);
    };

    mat.strip.prepend(thumb);
    mat.frames.unshift(data);
    mat.strip.scrollLeft = 0;

    // Update material frame count
    const fcLabel = mat.sectionEl.querySelector('.material-frames-count');
    if (fcLabel) fcLabel.textContent = mat.frames.length + ' frames';

    // Flash border
    card.el.classList.add('flash');
    setTimeout(() => card.el.classList.remove('flash'), 600);

    // Move material section to top within the card
    card.materialsContainer.prepend(mat.sectionEl);

    // Move window card to top
    windowsEl.prepend(card.el);

    // Update total frame count
    let cardTotalFrames = 0;
    for (const [, m] of card.materials) cardTotalFrames += m.frames.length;
    const fcountEl = document.getElementById('fcount-' + data.windowId);
    if (fcountEl) fcountEl.textContent = cardTotalFrames + ' frames';

    totalFrames++;
    document.getElementById('stat-frames').textContent = totalFrames;
}

function handleMaterialFocused(data) {
    const card = windowCards.get(data.windowId);
    if (!card) return;

    // Mark the focused material as active
    const matEntry = card.materials.get(data.materialId);
    if (matEntry) {
        matEntry.sectionEl.classList.add('current');
        const badge = matEntry.sectionEl.querySelector('.material-badge');
        if (badge) { badge.classList.add('active'); badge.textContent = 'active'; }
        // Update documentPath if provided
        if (data.documentPath) {
            matEntry.documentPath = data.documentPath;
            const docEl = matEntry.sectionEl.querySelector('.material-doc');
            if (docEl) docEl.innerHTML = formatDocPath(data.documentPath);
        }
        // Move to top
        card.materialsContainer.prepend(matEntry.sectionEl);
    }
}

function handleMaterialUnfocused(data) {
    const card = windowCards.get(data.windowId);
    if (!card) return;

    const matEntry = card.materials.get(data.materialId);
    if (matEntry) {
        matEntry.sectionEl.classList.remove('current');
        const badge = matEntry.sectionEl.querySelector('.material-badge');
        if (badge) { badge.classList.remove('active'); badge.textContent = 'tab'; }
    }

    card.currentMaterialId = data.materialId;
}

function handleWindowEvent(data) {
    totalEvents++;
    document.getElementById('stat-events').textContent = totalEvents;

    const card = windowCards.get(data.windowId);
    if (!card) return;

    if (data.type === 'window-focused') {
        for (const [, c] of windowCards) c.el.classList.remove('active');
        card.el.classList.add('active');
        windowsEl.prepend(card.el);
    } else if (data.type === 'window-unfocused') {
        card.el.classList.remove('active');
    }
}

function handleStats(data) {
    document.getElementById('stat-windows').textContent = data.trackers.length;
    const activeCount = data.trackers.filter(t => t.active).length;
    document.getElementById('stat-active').textContent = activeCount;

    let totalMats = 0;
    for (const t of data.trackers) totalMats += (t.materialCount || 0);
    document.getElementById('stat-materials').textContent = totalMats;

    if (data.storeStats) {
        const bytes = data.storeStats.dbSizeBytes;
        let size;
        if (bytes < 1024) size = bytes + ' B';
        else if (bytes < 1048576) size = (bytes / 1024).toFixed(1) + ' KB';
        else size = (bytes / 1048576).toFixed(1) + ' MB';
        document.getElementById('stat-db').textContent = size + ' (' + data.storeStats.frameCount + ' stored)';
    }
}

// SSE connection
function connectSSE() {
    const es = new EventSource('/events');

    es.addEventListener('frame', (e) => {
        const data = JSON.parse(e.data);
        addFrame(data);
    });

    es.addEventListener('material-focused', (e) => {
        const data = JSON.parse(e.data);
        handleMaterialFocused(data);
    });

    es.addEventListener('material-unfocused', (e) => {
        const data = JSON.parse(e.data);
        handleMaterialUnfocused(data);
    });

    es.addEventListener('material-created', (e) => {
        const data = JSON.parse(e.data);
        // Pre-create the material section so it shows immediately
        const card = getOrCreateCard(data.windowId, data.title, data.application);
        getOrCreateMaterialSection(card, data.materialId, data.title, data.windowId, data.documentPath);
    });

    es.addEventListener('window-event', (e) => {
        const data = JSON.parse(e.data);
        handleWindowEvent(data);
    });

    es.addEventListener('stats', (e) => {
        const data = JSON.parse(e.data);
        handleStats(data);
    });

    es.onopen = () => {
        statusEl.textContent = 'Connected';
        statusEl.className = '';
    };

    es.onerror = () => {
        statusEl.textContent = 'Disconnected';
        statusEl.className = 'disconnected';
    };
}

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

connectSSE();
</script>
</body>
</html>`;

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
