/// ViewportHelper — standalone macOS process that monitors window lifecycle
/// events and streams them as JSON lines to stdout. Thin wrapper over WindowMonitorKit
/// (all logic lives there).
///
/// Protocol:
///   stdout → one JSON object per line: a `ready` handshake (with permission flags), then
///            window events, `space-changed`, and `permission` (on permission changes)
///   stderr → diagnostics (never window titles or document paths)
///
/// Exits on SIGTERM/SIGINT, stdin EOF (when stdin is a pipe), or when the parent process dies.

import Foundation
import WindowMonitorKit

// Line-buffer stdout so each JSON line is flushed immediately
setvbuf(stdout, nil, _IOLBF, 0)
// A closed stdout must not kill us with SIGPIPE mid-write; the parent watch handles exit.
signal(SIGPIPE, SIG_IGN)

let monitor = WindowMonitor()
monitor.onEvent = { event in
    if let line = event.wireLine { print(line) } // stdout, line-buffered
}
monitor.onError = { _, message in
    // Messages never include window titles or document paths.
    FileHandle.standardError.write(Data("[viewport-helper] \(message)\n".utf8))
}
monitor.start()

func shutdown() -> Never {
    monitor.stop()
    exit(0)
}

let sigSources: [DispatchSourceSignal] = [SIGTERM, SIGINT].map { sig in
    signal(sig, SIG_IGN) // ignore default handler
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { shutdown() }
    source.resume()
    return source
}

let parentWatch = ParentProcessWatch { shutdown() }

// Run the main run loop — this is what makes NSWorkspace notifications
// and AXObserver callbacks actually fire.
RunLoop.main.run()
