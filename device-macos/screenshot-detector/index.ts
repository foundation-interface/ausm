/**
 * @ausm/device-macos-screenshot-detector
 *
 * Monitors macOS screenshot activity (Cmd+Shift+3/4/5 and the screencapture CLI),
 * follows the selection rect during interactive captures, and reproduces the
 * captured image. Reports ScreenshotEvent from @ausm/core. See README.md.
 */

export {
    ScreenshotDetectorService,
    createScreenshotDetector,
} from './screenshot-detector';

export type { ScreenshotDetectorConfig, ScreenshotDetectorEvents } from './screenshot-detector';
