// ─── Material Manager Types ──────────────────────────────────────────────

export type { MaterialMetadataExtractor } from './metadata-extractors';

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

// ─── Material ────────────────────────────────────────────────────────────

/**
 * A Material represents a distinct content view within a window.
 *
 * Many applications use tabs (browsers, editors, terminals). Each tab
 * has a different title even though it lives in the same OS window.
 * A Material groups frames that belong to the same tab/view, identified
 * by the window title at the time of capture.
 */
export interface Material {
    /** Stable identifier for this material (derived from title) */
    materialId: string;
    /** The window title that identifies this material */
    title: string;
    /** macOS CGWindowID of the parent window */
    windowId: number;
    /** Application name */
    application: string | null;
    /** Application bundle identifier */
    bundleId: string | null;
    /** File URL from macOS AXDocument attribute (null for non-document windows) */
    documentPath: string | null;
    /** Perceptual hash of the last stored frame (hex string, for dedup) */
    lastFrameHash: string | null;
    /** Timestamp when this material was first seen */
    firstSeen: number;
    /** Timestamp of the most recent activity */
    lastSeen: number;
    /** LLM-classified content type (e.g. code-editor, browser, terminal) */
    materialType: string | null;
    /** Confidence of material type classification (0–1) */
    materialTypeConfidence: number | null;
    /**
     * Application-specific metadata extracted by a MaterialMetadataExtractor.
     * Examples: `{ url, hostname }` for browsers; `{ file, filename, extension }` for IDEs.
     * Null when no extractor matched or no metadata was found.
     */
    appMetadata: Record<string, string | null> | null;
}

// ─── Material Frame ──────────────────────────────────────────────────────

/**
 * A single curated frame captured from a window.
 * Stored as JPEG to keep memory usage bounded.
 */
export interface MaterialFrame {
    /** Unique identifier for this frame */
    frameId: string;
    /** Identifier of the Material this frame belongs to */
    materialId: string;
    /** macOS CGWindowID */
    windowId: number;
    /** JS timestamp (Date.now()) when the frame was captured */
    timestamp: number;
    /** Frame width in pixels */
    width: number;
    /** Frame height in pixels */
    height: number;
    /** JPEG-encoded frame data */
    data: Buffer;
    /** Window title at the time of capture */
    title: string | null;
    /** Application name */
    application: string | null;
    /** Application bundle identifier */
    bundleId: string | null;
    /**
     * Why this frame was captured.
     * - APPEAR: window first appeared
     * - FOCUSED: window gained focus
     * - TITLE_CHANGED: tab/title changed
     * - UNFOCUSED: last snapshot before losing focus
     * - PERIODIC: periodic timer tick while focused
     */
    captureReason: string;
}

// ─── Frame Reader (Python subprocess) ────────────────────────────────────

/**
 * Request sent to the Python frame_reader subprocess via stdin.
 */
export interface FrameReaderRequest {
    /** Command type */
    cmd: 'crop';
    /** Request ID for correlating responses */
    requestId: string;
    /** Display identifier (e.g., "display-1") */
    displayId: string;
    /** Window bounds in logical (point) coordinates */
    bounds: Rect;
    /** Display scale factor for converting logical → physical pixels */
    scaleFactor: number;
    /** Perceptual hash of the previous frame for comparison (hex string) */
    prevHash: string | null;
    /** JPEG quality (1-100) */
    jpegQuality: number;
    /**
     * Tile grid size for perceptual hashing.  The image is divided into
     * hashGrid × hashGrid tiles and a pHash is computed per tile.
     * A change in ANY tile counts as significant, which catches small
     * localized edits (e.g. typing text) that whole-image pHash misses.
     * 1 = legacy single-hash mode.  Default: 4 (4×4 = 16 tiles).
     */
    hashGrid: number;
}

/**
 * Response received from the Python frame_reader subprocess via stdout.
 */
export interface FrameReaderResponse {
    /** Echoed request ID */
    requestId: string;
    /** Whether the operation succeeded */
    ok: boolean;
    /** Error message if ok=false */
    error?: string;
    /** Base64-encoded JPEG frame data */
    frameData?: string;
    /** Frame width in pixels (after cropping) */
    width?: number;
    /** Frame height in pixels (after cropping) */
    height?: number;
    /** Perceptual hash of the cropped frame (hex string) */
    hash?: string;
    /**
     * Hamming distance between this frame's hash and prevHash.
     * 0 = identical, higher = more different.
     * -1 if prevHash was null (first frame).
     */
    hammingDistance?: number;
    /** Frame timestamp from the producer (ms) */
    frameTimestamp?: number;
}

// ─── Configuration ───────────────────────────────────────────────────────

export interface MaterialManagerConfig {
    /** Enable material tracking (default: false) */
    enabled?: boolean;

    /**
     * Storage mode: 'local' = SQLite in this process (for standalone/dashboard);
     * 'remote' = emit storage events for parent (runtime Memory) to persist.
     * Default: 'local'
     */
    storageMode?: 'local' | 'remote';

    /**
     * Path to the SQLite database file for persistent frame storage.
     * Only used when storageMode is 'local'.
     * Use ':memory:' for in-memory only (frames lost on restart).
     * The file holds window screenshots: it is created with mode 0600 and
     * its parent directory (if created) with mode 0700.  Choose a location
     * inside the user's own data directory.
     * Default: ':memory:'
     */
    dbPath?: string;

    /**
     * Max frames to retain per material in the database before oldest
     * are evicted.  Default: 200
     */
    maxFramesPerMaterial?: number;

    /**
     * Local storage only: global cap on stored frames across all materials
     * (oldest evicted first).  0 = unlimited.  Default: 5000
     */
    maxTotalFrames?: number;

    /**
     * Local storage only: delete frames older than this many ms.
     * 0 = keep until evicted by the frame caps.  Default: 0
     */
    maxFrameAgeMs?: number;
    /**
     * Hamming distance threshold for perceptual hash comparison.
     * Frames with distance >= this value are considered "significant".
     * Range: 0-64, where 0 = identical. Default: 8
     */
    hashDistanceThreshold?: number;

    /**
     * Tile grid size for perceptual hashing.  The captured image is
     * divided into hashGrid × hashGrid tiles with an independent pHash
     * per tile.  A change in ANY tile is enough to mark the frame as
     * significant.  This catches small localized edits (e.g. typing
     * text in one region of a large window) that a single whole-image
     * pHash would miss due to the 32×32 downsample averaging them away.
     *
     * - 1 = legacy single-hash mode (whole image)
     * - 4 = 4×4 grid (16 tiles) — recommended default
     *
     * Default: 4
     */
    hashGrid?: number;
    /** Periodic capture interval in ms while a window is active. Default: 2000 */
    captureIntervalMs?: number;
    /** @deprecated — use maxFramesPerMaterial instead. Kept as alias. */
    maxFramesPerWindow?: number;
    /** JPEG quality for stored frames (1-100). Default: 85 */
    jpegQuality?: number;
    /** Python executable path (needs numpy + opencv). Default: 'python3' */
    pythonPath?: string;
    /**
     * Directory containing the `screen_stream_reader` Python package; it is
     * prepended to PYTHONPATH for the worker.  Not needed if the package is
     * pip-installed into `pythonPath`'s environment.
     */
    screenStreamReaderPath?: string;
    /**
     * Enable debug logging (to console). Debug lines include window titles
     * and app names; nothing is logged by default. Default: false
     */
    debug?: boolean;

    // ── Per-window capture ───────────────────────────────────────────────

    /**
     * An object that implements `captureWindow(windowId, jpegQuality, displayId)`.
     * Typically a screen-stream HelperClient instance.
     *
     * When provided, APPEAR / FOCUSED / TITLE_CHANGED events use
     * CGWindowListCreateImage (via the helper) to capture the specific
     * window's backing store, which is correct even when the window is
     * behind other windows.  Without this, those events fall back to
     * cropping from the display stream (which only works for the
     * frontmost window).
     *
     * displayId is used to scale the captured image proportionally to
     * the display stream's resolution for that display.
     */
    screenStreamHelper?: {
        captureWindow(windowId: number, jpegQuality?: number, displayId?: string): Promise<{
            data: Buffer;
            width: number;
            height: number;
        }>;
    };

    // ── Frame freshness / timing ─────────────────────────────────────────

    /**
     * Delay (ms) before capturing after content-changing events such as
     * TITLE_CHANGED and FOCUSED.  This gives the screen pixels time to
     * update in the shared-memory buffer after the window event fires.
     *
     * Typical value: 150-500ms (macOS window animation + screen-capture lag).
     * Default: 150
     */
    captureDelayMs?: number;

    /**
     * Maximum number of freshness retries.  After the initial capture,
     * if the frame's producer timestamp predates the event we retry up to
     * this many times, with exponential back-off, until a fresh frame
     * arrives.
     *
     * Default: 3
     */
    maxFreshnessRetries?: number;

    /**
     * Initial retry interval (ms) when a stale frame is detected.
     * Doubles on each subsequent retry (exponential back-off).
     * Default: 150
     */
    freshnessRetryBaseMs?: number;

    /**
     * Metadata extractors that enrich materials with application-specific context.
     *
     * Each extractor is called when a material is created or refreshed
     * (APPEAR, FOCUSED, TITLE_CHANGED). The results are merged into
     * `Material.appMetadata` and included in every downstream event and prompt.
     *
     * When omitted, `DEFAULT_METADATA_EXTRACTORS` is used (browser URL extraction
     * + IDE file extraction). Pass an empty array to disable all extraction.
     *
     * To add custom extractors alongside the defaults:
     * ```ts
     * import { DEFAULT_METADATA_EXTRACTORS } from './metadata-extractors';
     * { metadataExtractors: [...DEFAULT_METADATA_EXTRACTORS, myExtractor] }
     * ```
     */
    metadataExtractors?: import('./metadata-extractors').MaterialMetadataExtractor[];

    /**
     * Blacklist rules for filtering out materials.
     * Materials matching any rule are silently ignored — they are never
     * created, persisted, or emitted as events.
     */
    materialBlacklist?: {
        /** Exact application names to block (case-insensitive). */
        apps?: string[];
        /** Substrings to match against the window/material title (case-insensitive). */
        titleIncludes?: string[];
        /** Bundle identifiers to block (case-insensitive, e.g. "com.apple.dock"). */
        bundleIds?: string[];
    };
}

// ─── Material Manager Events ─────────────────────────────────────────────

export interface MaterialManagerEvents {
    /** A new significant frame was captured for a window. Second arg: pHash (for remote storage). */
    'material-frame': (frame: MaterialFrame, hash?: string) => void;
    /** A new material was created (new tab/title detected) */
    'material-created': (material: Material) => void;
    /** A material was classified with a content type (materialType, materialTypeConfidence) */
    'material-type-classified': (material: Material) => void;
    /** A material's window gained focus */
    'material-focused': (windowId: number, material: Material) => void;
    /** A material's window lost focus */
    'material-unfocused': (windowId: number, material: Material) => void;
    /** A window tracker was created */
    'tracker-created': (windowId: number, title: string | null) => void;
    /** A window tracker was removed */
    'tracker-removed': (windowId: number) => void;
    /** Lifecycle status */
    status: (status: 'started' | 'stopped') => void;
    /** Error */
    error: (error: Error) => void;
    /** Storage: material save (for remote mode; parent Memory persists) */
    'storage:save-material': (material: Material) => void;
    /** Storage: material type update (for remote mode) */
    'storage:update-material-type': (materialId: string, materialType: string, materialTypeConfidence: number) => void;
}
