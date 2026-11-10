/// TextInputHelper — standalone macOS process that monitors text input events
/// (focus into/out of editable fields and value changes) via the Accessibility API,
/// streaming them as JSON lines to stdout.
///
/// Protocol:
///   stdout -> one JSON object per line: a `ready` handshake (`accessibilityTrusted`), then
///             text-input events (`status` = TEXT_EDITING_STARTED|UPDATED|FINISHED) and
///             `permission` lines when Accessibility is granted/revoked
///   stderr -> diagnostics only (never typed text)
///
/// Password fields (AXSecureTextField) are never reported.
/// Exits on SIGTERM/SIGINT, stdin EOF (when stdin is a pipe), or when the parent process dies.

import ApplicationServices
import Foundation

// Line-buffer stdout so each JSON line is flushed immediately
setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)

let monitor = TextInputMonitor()
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

let parentWatch = ParentProcessWatch { shutdown() }

// Run the main run loop — required for AXObserver callbacks and
// NSWorkspace notifications to fire.
RunLoop.main.run()
