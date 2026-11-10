/**
 * @ausm/device-macos-cursor-plus-plus
 *
 * Cursor and mouse interaction tracking service — monitors position,
 * clicks, scrolls, holds, and drags via a Swift helper subprocess
 * (macOS CGEventTap + Accessibility API). Enriches each interaction
 * with material context and a small screenshot crop around the cursor.
 */

export {
    CursorPlusPlusService,
    createCursorPlusPlus,
} from './cursor-plus-plus';

export {
    CropReader,
    type CropReaderConfig,
    type CropResult,
} from './crop-reader';

export type {
    MouseActionLike,
    NativeCursorEvent,
    CursorEventLike,
    CursorPlusPlusConfig,
    CursorPlusPlusEvents,
    MaterialLookup,
    DisplayStreamCrop,
    InteractionScreenshotLike,
} from './types';
