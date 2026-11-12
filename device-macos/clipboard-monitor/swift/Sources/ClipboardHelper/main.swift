/// ClipboardHelper — standalone macOS process that monitors clipboard changes and writes them
/// as JSON lines to stdout. Thin wrapper over ClipboardMonitorKit (all logic lives there).
///
/// Usage: ClipboardHelper [--no-content] [--max-content-bytes N]
///   --no-content           report only contentType/changeCount; never read pasteboard contents
///   --max-content-bytes N  cap `content` at N bytes of UTF-8 (default 1 MiB); longer content
///                          is cut and flagged with "contentTruncated": true
///
/// Protocol:
///   stdout → one JSON object per line (line-buffered):
///     - {"type":"ready"} on startup
///     - {"type":"clipboard_changed","changeCount":N,"timestamp":ms,
///        "contentType"?:"TEXT|HTML|RTF|IMAGE|FILE|URL","content"?:"...","contentPaths"?:[...],
///        "contentTruncated"?:true,"concealed"?:true}
///   stderr → diagnostic / error messages (never clipboard contents)
///   The process runs until SIGTERM/SIGINT, or until its parent process exits.
///
/// Privacy: pasteboards marked concealed/transient by password managers (nspasteboard.org) are
/// reported with "concealed": true and no content. Image data is never read.
///
/// Poll interval: 200 ms. No permissions required.

import ClipboardMonitorKit
import Darwin
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ line: String?) {
    guard let line else { return }
    print(line)
}

let monitor = ClipboardMonitor(options: ClipboardClassifier.options(fromArguments: CommandLine.arguments))
monitor.onEvent = { event in emit(event.wireLine) }
monitor.onError = { problem, message in
    fputs("[ClipboardHelper] \(problem.rawValue): \(message)\n", stderr)
}

emit(ClipboardWire.line(ClipboardWire.readyObject))
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
