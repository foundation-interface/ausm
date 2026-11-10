/// CursorHelper — standalone macOS process that monitors mouse events
/// and streams them as JSON lines to stdout. Thin wrapper over CursorMonitorKit.
///
/// Usage: CursorHelper [--move-throttle-ms N]
///   --move-throttle-ms N   minimum ms between MOVE events (and between DRAG events); 0 = all.
///                          Default 50.
///
/// Protocol:
///   stdout → one JSON object per line (line-buffered); see `CursorEvent`:
///     {"type":"ready"}
///     {"type":"cursor-event","action":"CLICK",...}
///     {"type":"error","code":"accessibility_denied"|"event_tap_disabled","message":"..."}
///   stderr → diagnostic messages
///   The process runs until SIGTERM/SIGINT, or until its parent process exits.
///
/// Exit codes: 0 normal shutdown, 2 the event tap could not be created (grant Accessibility).
///
/// Requires: Accessibility permission (event tap + AXUIElement queries).

import CursorMonitorKit
import Darwin
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let encoder = JSONEncoder()

func write(_ event: CursorEvent) {
    guard let data = try? encoder.encode(event),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

var options = CursorMonitor.Options()
if let idx = CommandLine.arguments.firstIndex(of: "--move-throttle-ms"),
   idx + 1 < CommandLine.arguments.count,
   let ms = Double(CommandLine.arguments[idx + 1]), ms.isFinite, ms >= 0 {
    options.moveThrottle = ms / 1000
}

let monitor = CursorMonitor(options: options)
monitor.onEvent = { event, _ in write(event) }
if !monitor.start() {
    let message = "Failed to create CGEventTap — grant Accessibility (System Settings → Privacy & Security → Accessibility) to the app that launched this helper."
    fputs("[CursorHelper] \(message)\n", stderr)
    var event = CursorEvent(type: "error")
    event.code = "accessibility_denied"
    event.message = message
    write(event)
    exit(2)
}

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
