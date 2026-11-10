/**
 * @ausm/device-macos-clipboard-monitor
 *
 * Monitors macOS clipboard activity. When clipboard content changes (copy/cut),
 * reports CopyPasteEvent from @ausm/core.
 */

export {
    ClipboardMonitorService,
    createClipboardMonitor,
} from './clipboard-monitor';

export type { ClipboardMonitorConfig, ClipboardMonitorEvents } from './clipboard-monitor';
