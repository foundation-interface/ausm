/**
 * @ausm/core - Activity Understanding and Scaffolding Medium
 *
 * A system-level API for monitoring and responding to user activity events.
 * 
 * @example
 * ```typescript
 * import { TextSelectionEvent } from '@ausm/core';
 * import { ausmRuntime } from '@ausm/core/runtime';
 * 
 * ausmRuntime.initialize();
 * ausmRuntime.onTextSelectionEvent((event: TextSelectionEvent) => {
 *   console.log('Selected:', event.selectedText);
 * });
 * ```
 */

// Core types and factories
export { createAUSMEvent, createAUSMUIElement, type AUSMEvent, type AUSMEventKind, type AUSMUIElement, type EventDataOf } from './AUSM';

// Events (interfaces + factory functions)
export { createScreenshotEvent, ScreenshotStatus, ScreenshotType, type ScreenshotEvent, type ScreenshotEventData, type ScreenshotImageData } from './events/ScreenShotEvent';
export { createWindowStateEvent, WindowState, type WindowStateEvent, type WindowStateEventData } from './events/WindowStateEvent';
export { createTextInputEvent, EditableTextElementType, TextInputStatus, type TextInputEvent, type TextInputEventData } from './events/TextInputEvent';
export { createTextSelectionEvent, TextElementType, SelectionMethod, SelectionStage, DetectionSource, type TextSelectionEvent, type TextSelectionEventData } from './events/TextSelectionEvent';
export { createMaterialEvent, MaterialEventType, type MaterialEvent, type MaterialEventData } from './events/MaterialEvent';
export { createCursorPlusPlusEvent, MouseAction, type CursorPlusPlusEvent, type CursorPlusPlusEventData, type InteractionScreenshot } from './events/CursorPlusPlusEvent';
export { createCopyPasteEvent, CopyPasteAction, CopyPasteContentType, type CopyPasteEvent, type CopyPasteEventData } from './events/CopyPasteEvent';
export { createSpaceChangeEvent, type SpaceChangeEvent, type SpaceChangeEventData } from './events/SpaceChangeEvent';
export { createTaskEvent, TaskStatus, type TaskEvent, type TaskEventData, type TaskLevel } from './events/TaskEvent';

// Detectors
export {
    DetectorManager,
    createDetectorEvent,
    type DetectorEntry,
    type DetectorEvent,
    type DetectorEventData,
    type DetectorsConfig,
} from './detectors';

// Types
export type { Point, Rect, AUSMEventData, AUSMUIElementData, EventCallback, AUSMApplication, ImageData } from './types';
