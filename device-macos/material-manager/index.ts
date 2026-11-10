/**
 * @ausm/device-macos-material-manager
 *
 * Window material tracking — captures, deduplicates, and curates per-window
 * screen frames.
 *
 * Architecture:
 *   WindowStateEvents (from viewport-manager)
 *     └─ MaterialManager (this module)
 *         ├─ WindowTracker per windowId
 *         │     └─ Material per distinct title (tab/view)
 *         │           └─ MaterialFrame[] (deduplicated frame history)
 *         └─ FrameReader (Python subprocess)
 *             └─ screen-stream shared memory → crop → pHash → JPEG
 */

// Main orchestrator
export {
    MaterialManager,
    createMaterialManager,
    type WindowStateEventLike,
} from './material-manager';

// Per-window tracker
export { WindowTracker } from './window-tracker';

// SQLite-backed frame storage
export { FrameStore, type FrameStoreConfig } from './frame-store';

// Python subprocess manager
export { FrameReader, type CropResult, type ImageAnalysisResult } from './frame-reader';

// Types
export type {
    Rect,
    Material,
    MaterialFrame,
    MaterialManagerConfig,
    MaterialManagerEvents,
    FrameReaderRequest,
    FrameReaderResponse,
} from './types';

// Metadata extractors (extensibility API)
export {
    DEFAULT_METADATA_EXTRACTORS,
    BrowserMetadataExtractor,
    IDEMetadataExtractor,
    runExtractors,
    type MaterialMetadataExtractor,
} from './metadata-extractors';
