/**
 * @ausm/device-macos-text-input
 *
 * Text input monitoring service — detects focus/typing/unfocused in editable
 * text elements via a Swift helper subprocess (macOS Accessibility API).
 * Falls back to a manual reportEvent() stub on non-macOS platforms or when the
 * helper binary is missing.
 */

export {
    TextInputMonitorService,
    createTextInputMonitor,
} from './text-input-monitor';

export type {
    TextInputEventLike,
    TextInputMonitorConfig,
    TextInputMonitorEvents,
    TextInputPermissionState,
    TextInputStatusLike,
    TextInputSourceElement,
    NativeTextInputEvent,
    Point,
    Rect,
} from './types';
