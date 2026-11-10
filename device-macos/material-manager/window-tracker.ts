/**
 * Window Tracker — Per-window state for the material-manager.
 *
 * A single OS window (identified by CGWindowID) can host multiple
 * "materials" — one per distinct title.  Browsers, editors, and other
 * tab-based applications change the window title when the user switches
 * tabs, so each title maps to a separate Material with its own frame
 * history and perceptual hash.
 *
 * The tracker maintains:
 *   - A Map of all Materials seen in this window (keyed by title)
 *   - A pointer to the currently active Material
 *   - Window-level metadata (bounds, displayId, application, etc.)
 *   - A periodic capture timer
 */

import { createHash } from 'crypto';
import type { Rect, Material } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Upper bound on materials kept in memory per window.  Long-lived browser
 * windows can see thousands of distinct titles; beyond this the least
 * recently seen (non-current) material is dropped from the in-memory map.
 * Persisted materials/frames are unaffected.
 */
export const MAX_MATERIALS_PER_WINDOW = 500;

/**
 * Stable material ID: sha256(title + NUL + (bundleId ?? application)), first
 * 12 hex chars.  The same tab title in the same app maps to the same ID
 * across windows and restarts.
 */
export function generateMaterialId(title: string, bundleId: string | null, application: string | null): string {
    const appIdentifier = bundleId ?? application ?? '';
    const input = `${title}\0${appIdentifier}`;
    const hash = createHash('sha256').update(input).digest('hex').substring(0, 12);
    return `mat_${hash}`;
}

// ── WindowTracker ─────────────────────────────────────────────────────────

export class WindowTracker {
    /** macOS CGWindowID */
    readonly windowId: number;

    /** Current window bounds in logical (point) coordinates */
    bounds: Rect;

    /** Display this window is on (numeric CGDirectDisplayID) */
    displayId: number;

    /** Current window title (matches currentMaterial.title when set) */
    title: string | null;

    /** Application name */
    application: string | null;

    /** Application bundle identifier */
    bundleId: string | null;

    /** Process ID of the owning application */
    pid: number | null;

    /** File URL from macOS AXDocument attribute (null for non-document windows) */
    documentPath: string | null;

    /** Whether this window is currently active (focused / visible) */
    active: boolean;

    /** Handle for the periodic capture timer (null when paused) */
    captureTimer: ReturnType<typeof setInterval> | null;

    /** Timestamp of the last explicit (non-periodic) capture for this window.
     *  Used by the periodic timer to skip a tick that would duplicate a
     *  recent FOCUSED / TITLE_CHANGED / APPEAR capture. */
    lastExplicitCaptureAt: number;

    /**
     * All materials ever seen in this window, keyed by title.
     * Persists across tab switches so history is preserved.
     */
    readonly materials: Map<string, Material>;

    /**
     * The currently active material (corresponds to the current title).
     * null only before the first title is observed.
     */
    currentMaterial: Material | null;

    constructor(opts: {
        windowId: number;
        bounds: Rect;
        displayId: number;
        title: string | null;
        application: string | null;
        bundleId: string | null;
        pid: number | null;
        documentPath?: string | null;
    }) {
        this.windowId = opts.windowId;
        this.bounds = opts.bounds;
        this.displayId = opts.displayId;
        this.title = opts.title;
        this.application = opts.application;
        this.bundleId = opts.bundleId;
        this.pid = opts.pid;
        this.documentPath = opts.documentPath ?? null;

        this.active = false;
        this.captureTimer = null;
        this.lastExplicitCaptureAt = 0;
        this.materials = new Map();
        this.currentMaterial = null;

        // Bootstrap the first material if we have a title.
        // appMetadata is populated later by the MaterialManager after extractors run.
        if (opts.title) {
            this.currentMaterial = this.getOrCreateMaterial(opts.title);
        }
    }

    // ── Material management ──────────────────────────────────────────────

    /**
     * Get an existing material by title, or create a new one.
     * Pass `appMetadata` to set / update application-specific metadata.
     */
    getOrCreateMaterial(
        title: string,
        documentPath?: string | null,
        appMetadata?: Record<string, string | null> | null,
    ): Material {
        let mat = this.materials.get(title);
        if (!mat) {
            const now = Date.now();
            mat = {
                materialId: generateMaterialId(title, this.bundleId, this.application),
                title,
                windowId: this.windowId,
                application: this.application,
                bundleId: this.bundleId,
                documentPath: documentPath ?? this.documentPath,
                lastFrameHash: null,
                firstSeen: now,
                lastSeen: now,
                materialType: null,
                materialTypeConfidence: null,
                appMetadata: appMetadata ?? null,
            };
            this.materials.set(title, mat);
            this.evictExcessMaterials(mat);
        } else {
            if (documentPath && mat.documentPath !== documentPath) {
                mat.documentPath = documentPath;
            }
            // Always refresh metadata — it may have changed (e.g. navigation to a
            // same-title page, or the first event that had documentPath populated)
            if (appMetadata !== undefined) {
                mat.appMetadata = appMetadata ?? null;
            }
        }
        return mat;
    }

    /**
     * Switch the active material to the one matching the given title.
     * Creates a new material if this title hasn't been seen before.
     *
     * @returns {{ material, isNew, previousTitle }} information about the switch
     */
    switchMaterial(
        newTitle: string,
        documentPath?: string | null,
        appMetadata?: Record<string, string | null> | null,
    ): {
        material: Material;
        isNew: boolean;
        previousTitle: string | null;
    } {
        const previousTitle = this.currentMaterial?.title ?? null;

        // Update tracker-level documentPath
        if (documentPath !== undefined) {
            this.documentPath = documentPath ?? null;
        }

        // Same title — no switch needed, but still refresh metadata
        if (previousTitle === newTitle && this.currentMaterial) {
            this.currentMaterial.lastSeen = Date.now();
            if (documentPath && this.currentMaterial.documentPath !== documentPath) {
                this.currentMaterial.documentPath = documentPath;
            }
            if (appMetadata !== undefined) {
                this.currentMaterial.appMetadata = appMetadata ?? null;
            }
            return { material: this.currentMaterial, isNew: false, previousTitle };
        }

        const isNew = !this.materials.has(newTitle);
        const material = this.getOrCreateMaterial(newTitle, documentPath, appMetadata);
        material.lastSeen = Date.now();

        this.currentMaterial = material;
        this.title = newTitle;

        return { material, isNew, previousTitle };
    }

    // ── Frame hash ─────────────────────────────────────────────────────

    /**
     * The perceptual hash of the current material's last frame.
     * Used by the material-manager to decide whether a new capture
     * is significantly different.
     */
    get lastFrameHash(): string | null {
        return this.currentMaterial?.lastFrameHash ?? null;
    }

    /**
     * Update the current material's hash after a frame is stored.
     * Call this after FrameStore.addFrame() succeeds.
     */
    updateLastFrameHash(hash: string): void {
        if (this.currentMaterial) {
            this.currentMaterial.lastFrameHash = hash;
            this.currentMaterial.lastSeen = Date.now();
        }
    }

    /**
     * Drop least-recently-seen materials beyond MAX_MATERIALS_PER_WINDOW.
     * Never drops the current material or `keep` (the one just created —
     * with a wall clock that went backwards it can look like the oldest).
     */
    private evictExcessMaterials(keep?: Material): void {
        while (this.materials.size > MAX_MATERIALS_PER_WINDOW) {
            let oldestKey: string | null = null;
            let oldestSeen = Infinity;
            for (const [key, m] of this.materials) {
                if (m === this.currentMaterial || m === keep) continue;
                if (m.lastSeen < oldestSeen) {
                    oldestSeen = m.lastSeen;
                    oldestKey = key;
                }
            }
            if (oldestKey === null) return;
            this.materials.delete(oldestKey);
        }
    }

    /** Number of distinct materials (titles/tabs) seen. */
    get materialCount(): number {
        return this.materials.size;
    }

    // ── Timer management ─────────────────────────────────────────────────

    startCaptureTimer(intervalMs: number, onTick: () => void): void {
        this.stopCaptureTimer();
        this.captureTimer = setInterval(onTick, intervalMs);
    }

    stopCaptureTimer(): void {
        if (this.captureTimer !== null) {
            clearInterval(this.captureTimer);
            this.captureTimer = null;
        }
    }

    // ── Metadata updates ─────────────────────────────────────────────────

    updateBounds(bounds: Rect): void {
        this.bounds = bounds;
    }

    activate(): void {
        this.active = true;
    }

    deactivate(): void {
        this.active = false;
        this.stopCaptureTimer();
    }

    cleanup(): void {
        this.stopCaptureTimer();
        this.materials.clear();
        this.currentMaterial = null;
    }
}
