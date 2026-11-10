/**
 * Material Manager — Main orchestrator for per-window material tracking.
 *
 * Subscribes to window lifecycle events from the viewport-manager (via
 * WindowStateEvent), maintains a WindowTracker per window, and coordinates
 * with the Python FrameReader subprocess to capture, deduplicate, and
 * curate significant screen frames.
 *
 * Key concept — MATERIALS:
 *   Many apps (browsers, editors, terminals) use tabs.  Each tab has a
 *   different title even though it lives in the same OS window.  When a
 *   title change is detected we treat it as a material switch: the old
 *   material's frame history is preserved and a new (or previously-seen)
 *   material becomes active with its own independent frame history and
 *   perceptual hash.
 *
 * Event handling:
 *   APPEAR         → create tracker + initial material, capture via window API*
 *   FOCUSED        → activate tracker, capture via window API*, start periodic timer
 *   TITLE_CHANGED  → **switch material**, capture via window API*
 *   BOUNDS_CHANGED → update bounds, capture from display stream (crop)
 *   UNFOCUSED      → capture from display stream (crop), pause periodic timer
 *   PERIODIC       → capture from display stream (crop)
 *   VANISHED       → deactivate (window is gone, skip capture)
 *
 * Capture modes:
 *   *When a screenStreamHelper is provided, APPEAR/FOCUSED/TITLE_CHANGED use
 *   CGWindowListCreateImage to read the window's backing store directly.
 *   This gives correct content regardless of window Z-order or timing.
 *   Without the helper, those events fall back to delayed display-stream crop.
 *
 *   PERIODIC, UNFOCUSED, and BOUNDS_CHANGED always use the cheap display-stream
 *   crop path (shared memory), because the window is already focused/visible
 *   and the stream content is current — no need for the heavier per-window API.
 */

import { EventEmitter } from 'events';

import type {
    Rect,
    Material,
    MaterialFrame,
    MaterialManagerConfig,
    MaterialManagerEvents,
} from './types';
import { FrameReader } from './frame-reader';
import { FrameStore } from './frame-store';
import { WindowTracker } from './window-tracker';
import {
    DEFAULT_METADATA_EXTRACTORS,
    runExtractors,
    type MaterialMetadataExtractor,
} from './metadata-extractors';

// ── Helpers ───────────────────────────────────────────────────────────────

function generateFrameId(): string {
    return `frm_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Vanished windows keep their tracker (and in-memory materials) so recent
 * history stays queryable, but only the most recent N are retained to keep
 * memory bounded over long sessions.
 */
const MAX_VANISHED_TRACKERS = 64;

// Default configuration values
const DEFAULTS = {
    hashDistanceThreshold: 8,
    captureIntervalMs: 2000,
    maxFramesPerMaterial: 200,
    jpegQuality: 85,
    captureDelayMs: 150,
    maxFreshnessRetries: 3,
    freshnessRetryBaseMs: 150,
    hashGrid: 4,
} as const;

/**
 * Minimal shape of a WindowStateEvent to avoid a hard dependency on
 * @ausm/core at the service layer.  The runtime integration
 * passes real WindowStateEvent instances that satisfy this interface.
 */
export interface WindowStateEventLike {
    windowId: number | null;
    bounds: Rect | null;
    displayId: number | null;
    title: string | null;
    application: string | null;
    bundleId: string | null;
    pid: number | null;
    state: string | null;
    /** File URL from macOS AXDocument attribute (null for non-document windows) */
    documentPath?: string | null;
}

/**
 * Convert a numeric CGDirectDisplayID to the string ID used by
 * screen-stream (e.g., 1 → "display-1").
 */
function toDisplayString(numericId: number | null): string {
    if (numericId === null || numericId === undefined) return 'display-1';
    return `display-${numericId}`;
}

export class MaterialManager extends EventEmitter {
    /** Per-window trackers, keyed by CGWindowID. */
    private trackers = new Map<number, WindowTracker>();

    /** Python frame reader subprocess (image analysis: pHash). */
    private frameReader: FrameReader;

    /** SQLite-backed persistent frame storage (only when storageMode is 'local'). */
    readonly frameStore: FrameStore | null;

    /** When storageMode is 'remote', cache of last frame per material for snapshot. */
    private lastFrameMap = new Map<string, { frameId: string; data: Buffer; width: number; height: number }>();

    /** When storageMode is 'remote', approximate frame count per window for logging. */
    private windowFrameCount = new Map<number, number>();

    private storageMode: 'local' | 'remote';

    /**
     * Optional screen-stream helper for per-window capture.
     * When set, APPEAR/FOCUSED/TITLE_CHANGED use CGWindowListCreateImage
     * (via the helper) instead of cropping from the display stream.
     */
    private screenStreamHelper: MaterialManagerConfig['screenStreamHelper'];

    /**
     * Registered metadata extractors. Called on every content-changing event
     * (APPEAR, FOCUSED, TITLE_CHANGED) to populate `Material.appMetadata`.
     */
    private metadataExtractors: MaterialMetadataExtractor[];

    /** Resolved configuration. */
    private config: Required<
        Pick<
            MaterialManagerConfig,
            | 'hashDistanceThreshold'
            | 'captureIntervalMs'
            | 'maxFramesPerMaterial'
            | 'jpegQuality'
            | 'captureDelayMs'
            | 'maxFreshnessRetries'
            | 'freshnessRetryBaseMs'
            | 'hashGrid'
            | 'debug'
        >
    >;

    /** Pre-normalized blacklist rules (all lowercase for fast comparison). */
    private blacklist: {
        apps: Set<string>;
        titleIncludes: string[];
        bundleIds: Set<string>;
    };

    private running = false;

    /**
     * Fallback logical→pixel scale for display-stream crops.  The Python
     * worker uses the real per-display scale from the screen-stream registry
     * and only falls back to this when the display is unknown to it.
     */
    private defaultScaleFactor = 2.0;

    /** Freshness-retry timers (so stop() can cancel them). */
    private retryTimers = new Set<ReturnType<typeof setTimeout>>();

    /** Vanished window IDs in vanish order (oldest first), for tracker eviction. */
    private vanishedOrder: number[] = [];

    /**
     * Pending delayed-capture timers, keyed by windowId.
     * When a new content-changing event arrives for the same window before
     * the delay fires, we cancel the previous timer to avoid capturing
     * an intermediate (still-stale) frame.
     */
    private pendingCaptures = new Map<number, ReturnType<typeof setTimeout>>();

    /**
     * Windows with an in-flight per-window capture (timer already fired,
     * async captureWindow → processImage chain is running).  Prevents a
     * second capture from starting while the first is still in progress,
     * which would cause duplicate material-frame emissions (both read
     * lastFrameHash before either updates it).
     */
    private inflightCaptures = new Set<number>();

    /**
     * Content-changing events that arrived while a per-window capture was
     * in flight (windowId → reason).  Re-scheduled once the in-flight capture
     * finishes so e.g. a tab switch during a capture is not lost.
     */
    private recaptureRequests = new Map<number, string>();

    /**
     * Pending bounds-settle timers, keyed by windowId.
     * While a window is being resized/moved, periodic capture is paused
     * because the display-stream crop would include wrong content.
     * Once bounds stop changing for `captureDelayMs * 2` the timer fires,
     * resuming periodic capture.
     */
    private boundsSettleTimers = new Map<number, ReturnType<typeof setTimeout>>();

    /**
     * Global focused material — the single material the user is currently
     * looking at.  Only ONE material is ever focused at a time.
     *
     * All MATERIAL_FOCUSED / MATERIAL_UNFOCUSED emissions go through
     * `setFocusedMaterial()` which compares against this state, naturally
     * deduplicating spurious events from the viewport monitor.
     */
    private focusedMaterial: { windowId: number; material: Material } | null = null;

    constructor(config: MaterialManagerConfig = {}) {
        super();
        this.frameReader = new FrameReader(config);
        this.screenStreamHelper = config.screenStreamHelper;

        const maxFramesPerMaterial =
            config.maxFramesPerMaterial ??
            config.maxFramesPerWindow ??
            DEFAULTS.maxFramesPerMaterial;

        this.config = {
            hashDistanceThreshold:
                config.hashDistanceThreshold ?? DEFAULTS.hashDistanceThreshold,
            captureIntervalMs:
                config.captureIntervalMs ?? DEFAULTS.captureIntervalMs,
            maxFramesPerMaterial,
            jpegQuality: config.jpegQuality ?? DEFAULTS.jpegQuality,
            captureDelayMs:
                config.captureDelayMs ?? DEFAULTS.captureDelayMs,
            maxFreshnessRetries:
                config.maxFreshnessRetries ?? DEFAULTS.maxFreshnessRetries,
            freshnessRetryBaseMs:
                config.freshnessRetryBaseMs ?? DEFAULTS.freshnessRetryBaseMs,
            hashGrid: config.hashGrid ?? DEFAULTS.hashGrid,
            debug: config.debug ?? false,
        };

        this.storageMode = config.storageMode ?? 'local';

        // Metadata extractors — use provided list or fall back to defaults
        this.metadataExtractors = config.metadataExtractors ?? DEFAULT_METADATA_EXTRACTORS;

        // Initialize SQLite frame store only when using local storage
        this.frameStore =
            this.storageMode === 'local'
                ? new FrameStore({
                      dbPath: config.dbPath ?? ':memory:',
                      maxFramesPerMaterial,
                      walMode: true,
                      ...(config.maxTotalFrames !== undefined && { maxTotalFrames: config.maxTotalFrames }),
                      ...(config.maxFrameAgeMs !== undefined && { maxFrameAgeMs: config.maxFrameAgeMs }),
                  })
                : null;

        // Normalize blacklist for fast case-insensitive matching
        const bl = config.materialBlacklist;
        this.blacklist = {
            apps: new Set((bl?.apps ?? []).map(s => s.toLowerCase())),
            titleIncludes: (bl?.titleIncludes ?? []).map(s => s.toLowerCase()),
            bundleIds: new Set((bl?.bundleIds ?? []).map(s => s.toLowerCase())),
        };
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    /** Start the material manager and its Python subprocess. */
    async start(): Promise<void> {
        if (this.running) return;
        if (this.frameStore && !this.frameStore.isOpen) {
            throw new Error(
                'MaterialManager cannot be restarted after stop() in local storage mode ' +
                '(the frame store is closed); create a new instance instead',
            );
        }

        this.logDebug('Starting material manager...');
        await this.frameReader.start();
        this.running = true;
        this.emit('status', 'started');
        this.logDebug('Material manager started');
    }

    /** Stop the material manager, all trackers, and the subprocess. */
    stop(): void {
        if (!this.running) return;

        this.logDebug('Stopping material manager...');
        this.running = false;

        // Cancel pending delayed captures
        for (const [, timer] of this.pendingCaptures) {
            clearTimeout(timer);
        }
        this.pendingCaptures.clear();
        this.inflightCaptures.clear();
        this.recaptureRequests.clear();
        for (const timer of this.retryTimers) clearTimeout(timer);
        this.retryTimers.clear();

        // Cancel pending bounds-settle timers
        for (const [, timer] of this.boundsSettleTimers) {
            clearTimeout(timer);
        }
        this.boundsSettleTimers.clear();

        // Stop all trackers
        for (const [, tracker] of this.trackers) {
            tracker.cleanup();
        }
        this.trackers.clear();
        this.vanishedOrder = [];
        this.focusedMaterial = null;

        // Stop the subprocess
        this.frameReader.stop();

        // Close the frame store (flushes WAL) when using local storage
        if (this.frameStore) this.frameStore.close();
        this.lastFrameMap.clear();
        this.windowFrameCount.clear();

        this.emit('status', 'stopped');
    }

    /** Whether the manager is running. */
    isRunning(): boolean {
        return this.running;
    }

    // ── Global focus management ──────────────────────────────────────────

    /**
     * Set the globally focused material.  This is the single chokepoint
     * for all MATERIAL_FOCUSED and MATERIAL_UNFOCUSED emissions.
     *
     * - If the new material is the same as the current → no-op (dedup).
     * - If different → MATERIAL_UNFOCUSED for the old, MATERIAL_FOCUSED
     *   for the new.
     * - Pass `null` to unfocus the current material without focusing a new one.
     */
    private setFocusedMaterial(
        windowId: number | null,
        material: Material | null,
    ): void {
        const oldId = this.focusedMaterial?.material.materialId ?? null;
        const newId = material?.materialId ?? null;

        // Same material — nothing to emit.  The same title in two windows of
        // one app shares a material id; keep tracking which window holds it
        // so a later UNFOCUSED from the other window does not clear focus.
        if (oldId === newId) {
            if (this.focusedMaterial && material && windowId != null) {
                this.focusedMaterial = { windowId, material };
            }
            return;
        }

        // Unfocus the previously focused material
        if (this.focusedMaterial) {
            this.emit(
                'material-unfocused',
                this.focusedMaterial.windowId,
                this.focusedMaterial.material,
            );
        }

        // Focus the new material (or clear)
        if (material && windowId != null) {
            this.focusedMaterial = { windowId, material };
            this.emit('material-focused', windowId, material);
        } else {
            this.focusedMaterial = null;
        }
    }

    // ── Event handling ───────────────────────────────────────────────────

    /**
     * Check whether a window event should be ignored based on the blacklist.
     */
    private isBlacklisted(event: WindowStateEventLike): boolean {
        const bl = this.blacklist;
        if (bl.apps.size === 0 && bl.titleIncludes.length === 0 && bl.bundleIds.size === 0) {
            return false;
        }
        if (event.application && bl.apps.has(event.application.toLowerCase())) {
            return true;
        }
        if (event.bundleId && bl.bundleIds.has(event.bundleId.toLowerCase())) {
            return true;
        }
        if (event.title) {
            const lower = event.title.toLowerCase();
            for (const substr of bl.titleIncludes) {
                if (lower.includes(substr)) return true;
            }
        }
        return false;
    }

    /**
     * Handle a window state event from the viewport-manager.
     * This is the main entry point called by the AUSM runtime.
     */
    handleWindowEvent(event: WindowStateEventLike): void {
        if (!this.running) return;
        if (event.windowId === null || event.windowId === undefined) return;
        // Bounds are required to create a tracker; events for an existing
        // tracker (notably VANISHED / UNFOCUSED) are handled without them.
        if (!event.bounds && !this.trackers.has(event.windowId)) return;
        try {
            if (this.isBlacklisted(event)) {
                this.suppressBlacklistedWindow(event.windowId, event);
                return;
            }
            this.dispatchWindowEvent(event.windowId, event);
        } catch (err) {
            // e.g. a SQLite write failure or a throwing custom extractor —
            // never let it propagate into the caller's event loop.
            this.emitError(err);
        }
    }

    /**
     * A blacklisted event for a window we already track (e.g. a tab switched
     * to a private title): stop attributing anything to the previous
     * material — drop focus, detach the current material so in-flight and
     * periodic captures store nothing — and still honour UNFOCUSED/VANISHED
     * so the tracker is deactivated.
     */
    private suppressBlacklistedWindow(windowId: number, event: WindowStateEventLike): void {
        const tracker = this.trackers.get(windowId);
        if (!tracker) return;
        if (this.focusedMaterial?.windowId === windowId) {
            this.setFocusedMaterial(null, null);
        }
        tracker.currentMaterial = null;
        tracker.title = null;
        const pending = this.pendingCaptures.get(windowId);
        if (pending) {
            clearTimeout(pending);
            this.pendingCaptures.delete(windowId);
        }
        this.recaptureRequests.delete(windowId);
        if (event.state === 'UNFOCUSED' || event.state === 'VANISHED') {
            this.dispatchWindowEvent(windowId, event);
        }
    }

    private dispatchWindowEvent(windowId: number, event: WindowStateEventLike): void {
        // A window that re-appears after VANISHED is live again.
        if (event.state !== 'VANISHED' && this.vanishedOrder.includes(windowId)) {
            this.vanishedOrder = this.vanishedOrder.filter((id) => id !== windowId);
        }

        switch (event.state) {
            case 'APPEAR':
                this.onAppear(windowId, event);
                break;
            case 'FOCUSED':
                this.onFocused(windowId, event);
                break;
            case 'TITLE_CHANGED':
                this.onTitleChanged(windowId, event);
                break;
            case 'BOUNDS_CHANGED':
                this.onBoundsChanged(windowId, event);
                break;
            case 'UNFOCUSED':
                this.onUnfocused(windowId, event);
                break;
            case 'VANISHED':
                this.onVanished(windowId, event);
                break;
        }
    }

    private onAppear(windowId: number, event: WindowStateEventLike): void {
        const tracker = this.getOrCreateTracker(windowId, event);

        // Keep the tracker's display/bounds up-to-date so periodic capture
        // reads from the correct display stream (handles monitor changes).
        if (event.displayId != null) tracker.displayId = event.displayId;
        if (event.bounds) tracker.updateBounds(event.bounds);

        // Ensure the initial material is set up (title may have arrived
        // with the APPEAR event itself, or differ from the one we last saw
        // if the window re-appears after VANISHED).
        if (event.title && tracker.currentMaterial?.title !== event.title) {
            const appMetadata = this.extractAppMetadata(event, tracker.documentPath);
            const { material, isNew } = tracker.switchMaterial(event.title, event.documentPath, appMetadata);
            if (isNew) {
                this.persistMaterial(material);
                this.emit('material-created', material);
            }
            if (tracker.active) this.setFocusedMaterial(windowId, material);
        }

        // Capture the window once (per-window CGWindowListCreateImage is
        // preferred: it reads the window's backing store directly and
        // doesn't depend on the display stream timing).
        this.captureWindowOrFallback(tracker, event.displayId, 'APPEAR');

        // Do NOT start periodic capture here.  APPEAR fires for every
        // visible window (including all background ones on startup).
        // Periodic capture should only run for the focused window and is
        // started by onFocused().  If a FOCUSED event follows this APPEAR
        // (which is the normal case for the frontmost window), it will
        // activate the tracker and start the timer there.
    }

    private onFocused(windowId: number, event: WindowStateEventLike): void {
        const tracker = this.getOrCreateTracker(windowId, event);
        tracker.activate();

        // Keep display/bounds up-to-date (window may have moved to another display).
        if (event.displayId != null) tracker.displayId = event.displayId;
        if (event.bounds) tracker.updateBounds(event.bounds);

        // Ensure the material matches the current title.  The title may
        // have changed while the window was in the background (title-change
        // events update material state but skip capture for inactive windows).
        // Now that the window is focused we reconcile, capture, and refresh metadata.
        if (event.title) {
            const currentTitle = tracker.currentMaterial?.title ?? null;
            // Pass tracker.documentPath as fallback: FOCUSED events from the
            // Swift helper often arrive without documentPath (AXDocument is not
            // re-queried on focus), so we use the value cached from the last
            // TITLE_CHANGED or APPEAR event.
            const appMetadata = this.extractAppMetadata(event, tracker.documentPath);
            if (!tracker.currentMaterial || currentTitle !== event.title) {
                const { material, isNew } = tracker.switchMaterial(event.title, event.documentPath, appMetadata);
                if (isNew) {
                    this.persistMaterial(material);
                    this.emit('material-created', material);
                }
                this.logDebug(
                    `[${windowId}] Material reconciled on focus: ` +
                    `"${currentTitle}" → "${event.title}"`,
                );
            } else if (tracker.currentMaterial) {
                // Same title — still refresh metadata (URL may have changed via navigation)
                tracker.switchMaterial(event.title, event.documentPath, appMetadata);
            }
        }

        // Update global focus — handles unfocus of old + focus of new.
        // Naturally deduplicates: if the same material is already focused,
        // setFocusedMaterial is a no-op.
        if (tracker.currentMaterial) {
            this.setFocusedMaterial(windowId, tracker.currentMaterial);
        }

        // Capture the window directly via its backing store
        this.captureWindowOrFallback(tracker, event.displayId, 'FOCUSED');

        // Reset periodic capture so the first PERIODIC tick is a full
        // interval after this FOCUSED capture — avoids a near-immediate
        // duplicate when the timer was already ticking from a prior session.
        this.restartPeriodicCapture(tracker);
    }

    /**
     * Start the periodic capture timer if it isn't already running.
     * Uses the cheap shared-memory crop path since the window is focused/visible.
     *
     * The callback reads `tracker.displayId` at invocation time (not
     * closure time) so that periodic captures automatically adapt when a
     * window migrates to a different display (e.g. monitor unplugged).
     */
    private ensurePeriodicCapture(tracker: WindowTracker): void {
        if (tracker.captureTimer !== null) return; // already ticking
        this.startPeriodicCapture(tracker);
    }

    /**
     * Stop and restart the periodic capture timer, guaranteeing the first
     * tick is a full `captureIntervalMs` away.  Used after an explicit
     * capture (e.g. FOCUSED, TITLE_CHANGED) to avoid a near-immediate
     * duplicate from a timer that was already mid-interval.
     */
    private restartPeriodicCapture(tracker: WindowTracker): void {
        tracker.stopCaptureTimer();
        this.startPeriodicCapture(tracker);
    }

    private startPeriodicCapture(tracker: WindowTracker): void {
        const intervalMs = this.config.captureIntervalMs;
        tracker.startCaptureTimer(intervalMs, () => {
            if (!this.running || !tracker.active) return;

            // Skip if an explicit capture (FOCUSED, TITLE_CHANGED, APPEAR)
            // happened recently — that frame is still fresh and a periodic
            // capture would just duplicate it.
            const sinceLast = Date.now() - tracker.lastExplicitCaptureAt;
            // (A negative value means the wall clock moved backwards; don't
            // let that suppress periodic capture until it catches up.)
            if (sinceLast >= 0 && sinceLast < intervalMs) {
                this.logDebug(
                    `[${tracker.windowId}] Skipping periodic capture — explicit capture ${sinceLast}ms ago`,
                );
                return;
            }

            this.captureFrame(tracker, tracker.displayId);
        });
    }

    private onTitleChanged(windowId: number, event: WindowStateEventLike): void {
        const tracker = this.trackers.get(windowId);
        if (!tracker) return;

        const newTitle = event.title;
        if (!newTitle) {
            // Title cleared — nothing meaningful to track
            return;
        }

        // Switch to the material for this title (creates if new).
        // We ALWAYS update the material state regardless of visibility,
        // so the tracking is correct when the window later becomes focused.
        // TITLE_CHANGED events typically carry documentPath, but pass the
        // tracker's cached value as fallback in case this one doesn't.
        const appMetadata = this.extractAppMetadata(event, tracker.documentPath);
        const { material, isNew, previousTitle } = tracker.switchMaterial(newTitle, event.documentPath, appMetadata);

        if (isNew) {
            this.persistMaterial(material);
            this.emit('material-created', material);
            this.logDebug(
                `[${windowId}] New material created for "${newTitle}" ` +
                `(previous: "${previousTitle}", materials: ${tracker.materialCount})`,
            );
        }

        // If this window is active, update global focus to the new material.
        // setFocusedMaterial handles unfocus of old + focus of new, and is a
        // no-op if the material didn't actually change.
        if (tracker.active) {
            this.setFocusedMaterial(windowId, material);
        }

        this.logDebug(
            `[${windowId}] Material switched: "${previousTitle}" → "${newTitle}" ` +
            `(materialId=${material.materialId}, isNew=${isNew})`,
        );

        // With per-window capture (CGWindowListCreateImage), we can safely
        // capture any window — even background ones — because it reads the
        // window's own backing store, not the composited screen.
        tracker.lastExplicitCaptureAt = Date.now();
        if (this.screenStreamHelper) {
            this.captureWindowFrame(tracker, 'TITLE_CHANGED');
            if (tracker.active) this.restartPeriodicCapture(tracker);
            return;
        }

        // Fallback: display-stream crop — only works for active windows
        if (!tracker.active) {
            this.logDebug(
                `[${windowId}] Skipping capture — window is not active ` +
                `(title changed in background, no screenStreamHelper)`,
            );
            return;
        }

        this.captureFrameDelayed(tracker, event.displayId, 'TITLE_CHANGED');
        this.restartPeriodicCapture(tracker);
    }

    private onBoundsChanged(windowId: number, event: WindowStateEventLike): void {
        const tracker = this.trackers.get(windowId);
        if (!tracker) return;

        // Always update bounds metadata regardless of visibility
        if (event.bounds) {
            tracker.updateBounds(event.bounds);
        }

        // Update display — window may have been dragged to a different monitor
        if (event.displayId != null) tracker.displayId = event.displayId;

        if (!tracker.active) {
            this.logDebug(
                `[${windowId}] Bounds changed in background — metadata updated`,
            );
            return;
        }

        // Pause periodic capture while bounds are changing — the
        // display-stream crop uses the old/intermediate bounds and would
        // capture the wrong portion of the screen.
        tracker.stopCaptureTimer();

        // Debounce: cancel any previous settle timer for this window
        const existing = this.boundsSettleTimers.get(windowId);
        if (existing) clearTimeout(existing);

        const settleDelay = this.config.captureDelayMs * 2;
        const timer = setTimeout(() => {
            this.boundsSettleTimers.delete(windowId);
            if (!this.running || !tracker.active) return;

            this.logDebug(
                `[${windowId}] Bounds settled — resuming periodic capture`,
            );

            // Resume periodic capture with the updated bounds
            this.ensurePeriodicCapture(tracker);
        }, settleDelay);

        this.boundsSettleTimers.set(windowId, timer);
    }

    private onUnfocused(windowId: number, event: WindowStateEventLike): void {
        const tracker = this.trackers.get(windowId);
        if (!tracker) return;

        // Guard: if the tracker is already inactive, this is a duplicate
        // UNFOCUSED event — skip entirely.
        if (!tracker.active) return;

        // Clear global focus if this window's material is the focused one.
        // setFocusedMaterial(null) emits material-unfocused for the old material.
        if (
            this.focusedMaterial &&
            this.focusedMaterial.windowId === windowId
        ) {
            this.setFocusedMaterial(null, null);
        }

        // Deactivate — stops periodic capture and marks the tracker
        // inactive so any in-flight display-stream crops are discarded.
        tracker.deactivate();

        // Grab one last frame directly from the window's backing store
        // (CGWindowListCreateImage).  The display-stream crop is unreliable
        // here because by the time the async result returns, the composited
        // screen already shows the newly focused window.  Per-window capture
        // reads the correct content regardless of compositing order.
        // No delay needed — the content is already rendered.
        if (this.screenStreamHelper) {
            this.captureWindowFrameImmediate(tracker, 'UNFOCUSED');
        }
    }

    private onVanished(windowId: number, event: WindowStateEventLike): void {
        const tracker = this.trackers.get(windowId);
        if (!tracker) return;

        // Clear global focus if this window held it
        if (this.focusedMaterial?.windowId === windowId) {
            this.setFocusedMaterial(null, null);
        }

        // The window is already gone — CGWindowListCreateImage will return
        // nil and the display-stream crop would get the wrong content.
        // Skip capture and just deactivate.
        tracker.deactivate();

        // Cancel any pending delayed capture / bounds-settle timer
        const pending = this.pendingCaptures.get(windowId);
        if (pending) {
            clearTimeout(pending);
            this.pendingCaptures.delete(windowId);
        }
        const settleTimer = this.boundsSettleTimers.get(windowId);
        if (settleTimer) {
            clearTimeout(settleTimer);
            this.boundsSettleTimers.delete(windowId);
        }
        this.recaptureRequests.delete(windowId);

        // Keep the tracker for now so its materials stay queryable, but
        // bound the number of retained vanished trackers.
        this.vanishedOrder = this.vanishedOrder.filter((id) => id !== windowId);
        this.vanishedOrder.push(windowId);
        while (this.vanishedOrder.length > MAX_VANISHED_TRACKERS) {
            const evictId = this.vanishedOrder.shift()!;
            const evict = this.trackers.get(evictId);
            if (evict && !evict.active) {
                evict.cleanup();
                this.trackers.delete(evictId);
            }
        }

        this.emit('tracker-removed', windowId);
    }

    // ── Frame capture ────────────────────────────────────────────────────

    /**
     * Capture via per-window CGWindowListCreateImage if the helper is
     * available, otherwise fall back to delayed display-stream crop.
     * Used for content-changing events (APPEAR, FOCUSED, TITLE_CHANGED).
     */
    private captureWindowOrFallback(
        tracker: WindowTracker,
        displayId: number | null,
        reason: string,
    ): void {
        tracker.lastExplicitCaptureAt = Date.now();
        if (this.screenStreamHelper) {
            this.captureWindowFrame(tracker, reason);
        } else {
            this.captureFrameDelayed(tracker, displayId, reason);
        }
    }

    /**
     * Capture a specific window using CGWindowListCreateImage via the
     * screen-stream helper.  This reads directly from the window's
     * backing store — no display stream cropping, no timing issues,
     * and works even when the window is behind other windows.
     *
     * A small delay (captureDelayMs) is still applied because the
     * application may not have finished rendering the new content
     * into its backing store yet (e.g., right after a tab switch).
     */
    private captureWindowFrame(
        tracker: WindowTracker,
        reason: string,
    ): void {
        if (!this.screenStreamHelper || !this.running) return;

        const windowId = tracker.windowId;

        // Cancel any pending delayed capture for this window
        const existing = this.pendingCaptures.get(windowId);
        if (existing) {
            clearTimeout(existing);
        }

        // If a capture is already in-flight (timer fired, async chain running),
        // skip scheduling another — the in-flight one will produce the frame.
        if (this.inflightCaptures.has(windowId)) {
            this.logDebug(
                `[${windowId}] Window capture in-flight — re-capturing after it finishes (${reason})`,
            );
            this.recaptureRequests.set(windowId, reason);
            return;
        }

        const delay = this.config.captureDelayMs;
        this.logDebug(
            `[${windowId}] Window capture scheduled in ${delay}ms (${reason})`,
        );

        const timer = setTimeout(() => {
            this.pendingCaptures.delete(windowId);
            if (!this.running || !this.screenStreamHelper) return;

            this.inflightCaptures.add(windowId);
            const material = tracker.currentMaterial;
            const displayStr = toDisplayString(tracker.displayId);
            this.screenStreamHelper
                .captureWindow(windowId, this.config.jpegQuality / 100, displayStr)
                .then((capture) => {
                    if (!this.running || tracker.currentMaterial !== material) return;

                    const jpegData = capture.data;

                    // Send to Python for pHash analysis
                    return this.frameReader
                        .processImage(jpegData, tracker.lastFrameHash)
                        .then((analysis) => {
                            // Superseded (stopped, or the title changed while
                            // the capture was in flight — the pixels belong to
                            // the previous material).
                            if (!this.running || tracker.currentMaterial !== material) return;
                            this.processWindowCapture(
                                tracker, jpegData,
                                capture.width, capture.height,
                                analysis.hash, analysis.hammingDistance,
                                reason,
                            );
                        });
                })
                .catch((err) => {
                    if (!this.running) return; // e.g. "Frame reader stopped"
                    this.logDebug(
                        `[${windowId}] Window capture failed: ${(err as Error).message}`,
                    );
                    this.emitError(err);
                })
                .finally(() => {
                    this.inflightCaptures.delete(windowId);
                    const again = this.recaptureRequests.get(windowId);
                    if (again !== undefined) {
                        this.recaptureRequests.delete(windowId);
                        if (this.running && this.trackers.get(windowId) === tracker) {
                            this.captureWindowFrame(tracker, again);
                        }
                    }
                });
        }, delay);

        this.pendingCaptures.set(windowId, timer);
    }

    /**
     * Capture a window immediately (no delay) via CGWindowListCreateImage.
     * Used for events where the content is already rendered and we just
     * need one last snapshot (e.g., UNFOCUSED — the window is losing focus
     * but its backing store still has the correct content).
     */
    private captureWindowFrameImmediate(
        tracker: WindowTracker,
        reason: string,
    ): void {
        if (!this.screenStreamHelper || !this.running) return;

        const windowId = tracker.windowId;
        const displayStr = toDisplayString(tracker.displayId);

        // Another capture for this window is already running; it will
        // produce an equivalent frame (and avoids a duplicate emission).
        if (this.inflightCaptures.has(windowId)) return;

        this.logDebug(`[${windowId}] Immediate window capture (${reason})`);

        this.inflightCaptures.add(windowId);
        const material = tracker.currentMaterial;
        this.screenStreamHelper
            .captureWindow(windowId, this.config.jpegQuality / 100, displayStr)
            .then((capture) => {
                if (!this.running || tracker.currentMaterial !== material) return;

                const jpegData = capture.data;

                return this.frameReader
                    .processImage(jpegData, tracker.lastFrameHash)
                    .then((analysis) => {
                        if (!this.running || tracker.currentMaterial !== material) return;
                        this.processWindowCapture(
                            tracker, jpegData,
                            capture.width, capture.height,
                            analysis.hash, analysis.hammingDistance,
                            reason,
                        );
                    });
            })
            .catch((err) => {
                this.logDebug(
                    `[${windowId}] Window capture failed: ${(err as Error).message}`,
                );
            })
            .finally(() => {
                this.inflightCaptures.delete(windowId);
                const again = this.recaptureRequests.get(windowId);
                if (again !== undefined) {
                    this.recaptureRequests.delete(windowId);
                    if (this.running && this.trackers.get(windowId) === tracker) {
                        this.captureWindowFrame(tracker, again);
                    }
                }
            });
    }

    /**
     * Process the result of a per-window capture — deduplication + storage.
     */
    private processWindowCapture(
        tracker: WindowTracker,
        jpegData: Buffer,
        width: number,
        height: number,
        hash: string,
        hammingDistance: number,
        reason: string,
    ): void {
        const matLabel = tracker.currentMaterial
            ? `"${tracker.currentMaterial.title}"`
            : '(no material)';

        // First frame (no previous hash) → always store
        if (hammingDistance === -1) {
            const frame = this.storeFrame(tracker, jpegData, width, height, hash, reason);
            if (!frame) return;
            this.emit('material-frame', frame, hash);
            this.logDebug(
                `[${tracker.windowId}] ${matLabel} Window capture stored ` +
                `(${width}x${height}, ${jpegData.length} bytes, ${reason})`,
            );
            return;
        }

        // Significant change?
        if (hammingDistance >= this.config.hashDistanceThreshold) {
            const frame = this.storeFrame(tracker, jpegData, width, height, hash, reason);
            if (!frame) return;
            this.emit('material-frame', frame, hash);
            const fCount = this.frameStore
                ? this.frameStore.getFrameCountByWindow(tracker.windowId)
                : (this.windowFrameCount.get(tracker.windowId) ?? 0);
            this.logDebug(
                `[${tracker.windowId}] ${matLabel} Window capture stored ` +
                `(distance=${hammingDistance}, frames=${fCount}, ${reason})`,
            );
        } else {
            this.logDebug(
                `[${tracker.windowId}] ${matLabel} Window capture discarded ` +
                `(distance=${hammingDistance}, threshold=${this.config.hashDistanceThreshold})`,
            );
        }
    }

    /**
     * Schedule a delayed frame capture for content-changing events.
     *
     * The delay gives the screen pixels time to update after a window event.
     * If another content-changing event arrives for the same window before
     * the delay fires, we cancel the old timer and restart — this coalesces
     * rapid-fire events (e.g., multiple title-change events from a loading
     * page) into a single capture once things settle.
     */
    private captureFrameDelayed(
        tracker: WindowTracker,
        displayId: number | null,
        reason: string,
    ): void {
        const windowId = tracker.windowId;
        const eventTime = Date.now();

        // Cancel any pending delayed capture for this window
        const existing = this.pendingCaptures.get(windowId);
        if (existing) {
            clearTimeout(existing);
            this.logDebug(
                `[${windowId}] Cancelled pending capture (superseded by ${reason})`,
            );
        }

        const delay = this.config.captureDelayMs;
        this.logDebug(
            `[${windowId}] Scheduling delayed capture in ${delay}ms (${reason})`,
        );

        const timer = setTimeout(() => {
            this.pendingCaptures.delete(windowId);
            if (!this.running) return;

            this.captureFrameWithFreshness(tracker, displayId, eventTime, 0, reason);
        }, delay);

        this.pendingCaptures.set(windowId, timer);
    }

    /**
     * Capture a frame and validate its freshness.
     *
     * If the frame's producer timestamp predates the event that triggered
     * the capture, the frame is stale (screen-stream hasn't updated yet).
     * We retry with exponential back-off up to `maxFreshnessRetries`.
     */
    private captureFrameWithFreshness(
        tracker: WindowTracker,
        displayId: number | null,
        eventTime: number,
        retryCount: number,
        reason: string = 'UNKNOWN',
    ): void {
        if (!this.running) return;
        if (!this.frameReader.isReady()) {
            this.logDebug(`Frame reader not ready, skipping capture for window ${tracker.windowId}`);
            return;
        }

        const displayStr = toDisplayString(displayId);
        const material = tracker.currentMaterial;

        this.frameReader
            .requestFrame(
                displayStr,
                tracker.bounds,
                this.defaultScaleFactor,
                tracker.lastFrameHash,
                this.config.jpegQuality,
            )
            .then((result) => {
                // Discard if the window became inactive (or switched
                // material) while the async crop was in flight — the frame
                // now shows wrong content.
                if (!tracker.active || tracker.currentMaterial !== material) {
                    this.logDebug(
                        `[${tracker.windowId}] Discarding crop — window no longer active`,
                    );
                    return;
                }

                // ── Freshness check ──────────────────────────────────
                // The frame timestamp (epoch ms, converted from monotonic
                // clock in Python) tells us when the screen-stream producer
                // wrote this frame.  If it predates the event by more than
                // a small tolerance, the screen pixels haven't caught up
                // yet — retry after exponential back-off.
                //
                // Tolerance of 100ms accounts for:
                //  - Clock jitter between Node.js and Python processes
                //  - Slight monotonic→wall-clock conversion imprecision
                //  - Screen capture pipeline latency (frame may be written
                //    slightly before it's fully composited)
                const FRESHNESS_TOLERANCE_MS = 100;
                const frameAge = eventTime - result.frameTimestamp;

                if (
                    result.frameTimestamp > 0 &&
                    frameAge > FRESHNESS_TOLERANCE_MS &&
                    retryCount < this.config.maxFreshnessRetries
                ) {
                    const backoff =
                        this.config.freshnessRetryBaseMs * Math.pow(2, retryCount);
                    this.logDebug(
                        `[${tracker.windowId}] Stale frame ` +
                        `(age=${frameAge}ms, tolerance=${FRESHNESS_TOLERANCE_MS}ms) ` +
                        `→ retry ${retryCount + 1}/${this.config.maxFreshnessRetries} ` +
                        `in ${backoff}ms`,
                    );

                    const retryTimer = setTimeout(() => {
                        this.retryTimers.delete(retryTimer);
                        if (this.running) {
                            this.captureFrameWithFreshness(
                                tracker,
                                displayId,
                                eventTime,
                                retryCount + 1,
                                reason,
                            );
                        }
                    }, backoff);
                    this.retryTimers.add(retryTimer);
                    return;
                }

                if (retryCount > 0) {
                    this.logDebug(
                        `[${tracker.windowId}] Fresh frame acquired ` +
                        `(age=${frameAge}ms, retries=${retryCount})`,
                    );
                }

                // ── Normal processing (frame is fresh enough) ────────
                if (!this.running) return;
                this.processCapture(tracker, result, retryCount, reason);
            })
            .catch((err) => {
                // Display-stream crop failures are non-critical.  Debug log only.
                this.logDebug(
                    `[${tracker.windowId}] Frame capture failed: ${(err as Error).message}`,
                );
            });
    }

    /**
     * Immediately request a cropped frame (no delay, no freshness check).
     * Used for periodic timer ticks, unfocused, vanish, and bounds changes where
     * the screen content is already settled.
     */
    private captureFrame(tracker: WindowTracker, displayId: number | null, reason: string = 'PERIODIC'): void {
        if (!this.running) return;
        if (!this.frameReader.isReady()) {
            this.logDebug(`Frame reader not ready, skipping capture for window ${tracker.windowId}`);
            return;
        }

        const displayStr = toDisplayString(displayId);
        const material = tracker.currentMaterial;

        this.frameReader
            .requestFrame(
                displayStr,
                tracker.bounds,
                this.defaultScaleFactor,
                tracker.lastFrameHash,
                this.config.jpegQuality,
            )
            .then((result) => {
                // Discard if the window became inactive (unfocused / vanished)
                // or switched material while the async crop was in flight —
                // the frame now shows different content.
                if (!this.running || !tracker.active || tracker.currentMaterial !== material) {
                    this.logDebug(
                        `[${tracker.windowId}] Discarding crop — window no longer active`,
                    );
                    return;
                }
                this.processCapture(tracker, result, 0, reason);
            })
            .catch((err) => {
                // Display-stream crop failures are non-critical (periodic /
                // unfocused captures are best-effort).  Debug log only.
                this.logDebug(
                    `[${tracker.windowId}] Frame capture failed: ${(err as Error).message}`,
                );
            });
    }

    /**
     * Common logic for processing a capture result — deduplication +
     * storage + event emission.
     */
    private processCapture(
        tracker: WindowTracker,
        result: import('./frame-reader').CropResult,
        retryCount: number,
        reason: string = 'UNKNOWN',
    ): void {
        const matLabel = tracker.currentMaterial
            ? `"${tracker.currentMaterial.title}"`
            : '(no material)';
        const retryTag = retryCount > 0 ? ` (after ${retryCount} retries)` : '';

        // First frame (no previous hash) → always store
        if (result.hammingDistance === -1) {
            const frame = this.storeFrame(
                tracker,
                result.data,
                result.width,
                result.height,
                result.hash,
                reason,
            );
            if (!frame) return;
            this.emit('material-frame', frame, result.hash);
            this.logDebug(
                `[${tracker.windowId}] ${matLabel} Initial frame stored ` +
                `(${result.width}x${result.height}, ${result.data.length} bytes)${retryTag}`,
            );
            return;
        }

        // Significant change?
        if (result.hammingDistance >= this.config.hashDistanceThreshold) {
            const frame = this.storeFrame(
                tracker,
                result.data,
                result.width,
                result.height,
                result.hash,
                reason,
            );
            if (!frame) return;
            this.emit('material-frame', frame, result.hash);
            const fCount = this.frameStore
                ? this.frameStore.getFrameCountByWindow(tracker.windowId)
                : (this.windowFrameCount.get(tracker.windowId) ?? 0);
            this.logDebug(
                `[${tracker.windowId}] ${matLabel} Significant frame stored ` +
                `(distance=${result.hammingDistance}, ` +
                `frames=${fCount})${retryTag}`,
            );
        } else {
            this.logDebug(
                `[${tracker.windowId}] ${matLabel} Frame discarded ` +
                `(distance=${result.hammingDistance}, ` +
                `threshold=${this.config.hashDistanceThreshold})${retryTag}`,
            );
        }
    }

    // ── Storage helpers ─────────────────────────────────────────────────

    private persistMaterial(material: Material): void {
        if (this.storageMode === 'local' && this.frameStore) {
            this.frameStore.saveMaterial(material);
        } else {
            this.emit('storage:save-material', material);
        }
    }

    // ── Frame storage helper ────────────────────────────────────────────

    /**
     * Create a MaterialFrame, persist it (or emit for remote storage), update
     * the tracker's hash. In remote mode, parent (Memory) persists on material-frame.
     *
     * @returns The created MaterialFrame, or null if there is no current material.
     */
    private storeFrame(
        tracker: WindowTracker,
        data: Buffer,
        width: number,
        height: number,
        hash: string,
        reason: string,
    ): MaterialFrame | null {
        const mat = tracker.currentMaterial;
        if (!mat) return null;

        const frame: MaterialFrame = {
            frameId: generateFrameId(),
            materialId: mat.materialId,
            windowId: tracker.windowId,
            timestamp: Date.now(),
            width,
            height,
            data,
            title: mat.title,
            application: tracker.application,
            bundleId: tracker.bundleId,
            captureReason: reason,
        };

        if (this.storageMode === 'local' && this.frameStore) {
            this.frameStore.addFrame(frame, hash);
        } else {
            // Remote: cache for snapshot, parent stores on material-frame (with hash)
            this.lastFrameMap.set(mat.materialId, {
                frameId: frame.frameId,
                data,
                width,
                height,
            });
            const count = (this.windowFrameCount.get(tracker.windowId) ?? 0) + 1;
            this.windowFrameCount.set(tracker.windowId, count);
        }

        tracker.updateLastFrameHash(hash);

        return frame;
    }

    // ── Query API ────────────────────────────────────────────────────────

    /**
     * Get latest frame snapshot for a material (for lifecycle event attachment).
     * Works in both local and remote storage modes.
     */
    getLatestFrameInfo(materialId: string): {
        frameId: string;
        dataBase64: string;
        sizeBytes: number;
        frameWidth: number;
        frameHeight: number;
    } | Record<string, never> {
        if (this.storageMode === 'local' && this.frameStore) {
            const frame = this.frameStore.getLatestFrame(materialId);
            if (!frame) return {};
            return {
                frameId: frame.frameId,
                dataBase64: frame.data.toString('base64'),
                sizeBytes: frame.data.length,
                frameWidth: frame.width,
                frameHeight: frame.height,
            };
        }
        const cached = this.lastFrameMap.get(materialId);
        if (!cached) return {};
        return {
            frameId: cached.frameId,
            dataBase64: cached.data.toString('base64'),
            sizeBytes: cached.data.length,
            frameWidth: cached.width,
            frameHeight: cached.height,
        };
    }

    /** Get all stored frames for a window (across all materials, with BLOB data). */
    getFrames(windowId: number): MaterialFrame[] {
        return this.frameStore ? this.frameStore.getFramesByWindow(windowId) : [];
    }

    /** Get frame metadata (no BLOB data) for a window. */
    getFramesMeta(windowId: number): Omit<MaterialFrame, 'data'>[] {
        return this.frameStore ? this.frameStore.getFramesByWindowMeta(windowId) : [];
    }

    /** Get frames for the current material of a window only. */
    getCurrentMaterialFrames(windowId: number): MaterialFrame[] {
        if (!this.frameStore) return [];
        const tracker = this.trackers.get(windowId);
        if (!tracker?.currentMaterial) return [];
        return this.frameStore.getFrames(tracker.currentMaterial.materialId);
    }

    /** Get a specific frame by ID. */
    getFrameById(frameId: string): MaterialFrame | null {
        return this.frameStore ? this.frameStore.getFrameById(frameId) : null;
    }

    /** Get all materials tracked for a specific window (in-memory + DB). */
    getMaterials(windowId: number): Material[] {
        const tracker = this.trackers.get(windowId);
        if (!tracker) return [];
        return Array.from(tracker.materials.values());
    }

    /** Get a flattened list of all materials across all windows. */
    getAllMaterials(): Material[] {
        const all: Material[] = [];
        for (const [, tracker] of this.trackers) {
            for (const [, mat] of tracker.materials) {
                all.push(mat);
            }
        }
        return all;
    }

    /** Get the tracker for a specific window. */
    getTracker(windowId: number): WindowTracker | undefined {
        return this.trackers.get(windowId);
    }

    /** Get all trackers. */
    getAllTrackers(): Map<number, WindowTracker> {
        return new Map(this.trackers);
    }

    /** Get all currently active (focused) window trackers. */
    getActiveWindows(): WindowTracker[] {
        const active: WindowTracker[] = [];
        for (const [, tracker] of this.trackers) {
            if (tracker.active) {
                active.push(tracker);
            }
        }
        return active;
    }

    // ── Type-safe event emitter ──────────────────────────────────────────

    on<K extends keyof MaterialManagerEvents>(
        event: K,
        listener: MaterialManagerEvents[K],
    ): this {
        return super.on(event, listener);
    }

    once<K extends keyof MaterialManagerEvents>(
        event: K,
        listener: MaterialManagerEvents[K],
    ): this {
        return super.once(event, listener);
    }

    emit<K extends keyof MaterialManagerEvents>(
        event: K,
        ...args: Parameters<MaterialManagerEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    private getOrCreateTracker(
        windowId: number,
        event: WindowStateEventLike,
    ): WindowTracker {
        let tracker = this.trackers.get(windowId);
        if (!tracker) {
            tracker = new WindowTracker({
                windowId,
                bounds: event.bounds!,
                displayId: event.displayId ?? 0,
                title: event.title,
                application: event.application,
                bundleId: event.bundleId,
                pid: event.pid,
                documentPath: event.documentPath,
            });
            this.trackers.set(windowId, tracker);

            // The constructor bootstraps the first material in memory when
            // a title is provided.  Persist it so parent Memory / local store has it.
            if (tracker.currentMaterial) {
                this.persistMaterial(tracker.currentMaterial);
            }

            this.emit('tracker-created', windowId, event.title);
            this.logDebug(
                `Tracker created for window ${windowId} ` +
                `("${event.title}" / ${event.bundleId})` +
                (event.documentPath ? ` doc=${event.documentPath}` : ''),
            );
        } else if (event.documentPath && tracker.documentPath !== event.documentPath) {
            // Update documentPath when it changes (e.g., a different file was opened)
            tracker.documentPath = event.documentPath;
        }
        return tracker;
    }

    /**
     * Run registered metadata extractors against a window event and return
     * the merged result. Returns null when no extractor matched or produced data.
     *
     * @param event - The window state event to extract metadata from.
     * @param fallbackDocumentPath - Used when `event.documentPath` is null.
     *   FOCUSED events from the Swift helper do not re-query AXDocument, so
     *   passing the tracker's cached documentPath ensures browser URLs are
     *   available even on focus events that don't carry documentPath themselves.
     */
    private extractAppMetadata(
        event: WindowStateEventLike,
        fallbackDocumentPath?: string | null,
    ): Record<string, string | null> | null {
        if (this.metadataExtractors.length === 0) return null;

        // Patch the event with the cached documentPath when the event itself
        // doesn't carry one (common for FOCUSED events on macOS).
        const effectiveEvent =
            !event.documentPath && fallbackDocumentPath
                ? { ...event, documentPath: fallbackDocumentPath }
                : event;

        const metadata = runExtractors(this.metadataExtractors, effectiveEvent, (err) =>
            this.logDebug(`Metadata extractor threw: ${(err as Error)?.message ?? String(err)}`),
        );
        if (metadata) {
            // Keys only — values (URLs, file paths) are user content.
            this.logDebug(
                `[${event.windowId}] appMetadata extracted (${Object.keys(metadata).join(', ')})`,
            );
        }
        return metadata;
    }

    /**
     * Emit 'error' only when someone is listening.  EventEmitter throws on
     * an unhandled 'error' event, which from inside a promise chain would
     * surface as an unhandled rejection and can crash the host.
     */
    private emitError(err: unknown): void {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.listenerCount('error') > 0) {
            this.emit('error', error);
        } else {
            this.logDebug(`Error (no 'error' listener): ${error.message}`);
        }
    }

    private logDebug(message: string): void {
        if (this.config.debug) {
            console.log('[material-manager]', message);
        }
    }
}

/** Factory function. */
export function createMaterialManager(
    config?: MaterialManagerConfig,
): MaterialManager {
    return new MaterialManager(config);
}
