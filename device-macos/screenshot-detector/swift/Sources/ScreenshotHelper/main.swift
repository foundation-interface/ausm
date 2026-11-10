/// ScreenshotHelper — standalone macOS process that monitors screenshot activity
/// and streams JSON events to stdout. Thin wrapper over ScreenshotMonitorKit.
///
/// Usage: ScreenshotHelper [--debug]
///
/// Protocol:
///   stdout → one JSON object per line (line-buffered) for each screenshot event
///   stderr → diagnostics (permission warnings always; everything else only with --debug)
///   The process runs until SIGTERM/SIGINT, or until its parent process exits.
///
/// Events (type field; every event also carries `timestamp`, ms since epoch):
///   ready
///   screencapture_started    { pid, mode, destination }
///   selection_rect_changed   { rect, displayId }
///   screencapture_ended      { pid, mode, destination, cancelled,
///                              imagePath?, imageWidth?, imageHeight?, imageMimeType?, rect?,
///                              displayId?, scale? }
///   screencaptureui_started / screencaptureui_ended { pid }
///   screenshot_capture_failed { reason, displayId }
///   error                    { code: accessibility_denied | screen_recording_denied |
///                                    event_tap_disabled, message }
///
/// The temp file named by `imagePath` (mode 0600) belongs to the consumer, which should delete
/// it after reading; files older than an hour are swept when the helper starts.
///
/// Requires: Accessibility (event tap) + Screen Recording (capture) permissions.

import Darwin
import Foundation
import ScreenshotMonitorKit

setvbuf(stdout, nil, _IOLBF, 0)

var options = ScreenshotMonitor.Options()
options.writeTempFile = true
options.debugLogging = CommandLine.arguments.contains("--debug")

let monitor = ScreenshotMonitor(options: options)
monitor.onEvent = { event in
    guard JSONSerialization.isValidJSONObject(event),
          let data = try? JSONSerialization.data(withJSONObject: event),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}
monitor.start()

func shutdown() -> Never {
    monitor.stop()
    exit(0)
}

let sigSources: [DispatchSourceSignal] = [SIGTERM, SIGINT].map { sig in
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { shutdown() }
    source.resume()
    return source
}

// Exit with the parent (e.g. the Node process is SIGKILLed and never sends SIGTERM).
let parentPID = getppid()
let parentWatch: DispatchSourceProcess? = parentPID > 1 ? {
    let source = DispatchSource.makeProcessSource(identifier: parentPID, eventMask: .exit, queue: .main)
    source.setEventHandler { shutdown() }
    source.resume()
    return source
}() : nil
if parentPID > 1, getppid() != parentPID { shutdown() } // parent died before the watch was armed

RunLoop.main.run()
