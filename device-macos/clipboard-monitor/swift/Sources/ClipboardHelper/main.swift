/// ClipboardHelper — standalone macOS process that monitors clipboard changes
/// by polling NSPasteboard.changeCount. When it changes, detects content type
/// (text, HTML, RTF, image, file, URL) and outputs JSON events to stdout.
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

import AppKit
import Darwin
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let options = ClipboardClassifier.options(fromArguments: CommandLine.arguments)
let pasteboard = NSPasteboard.general
var lastChangeCount = pasteboard.changeCount
let typeOrder = ClipboardClassifier.typeOrder.map { NSPasteboard.PasteboardType($0) }

/// Read the highest-priority content. Only called when content is wanted and not concealed.
func readContent(of type: NSPasteboard.PasteboardType) -> (content: String?, paths: [String]?) {
    switch type.rawValue {
    case ClipboardClassifier.fileURLType:
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
            let paths = ClipboardClassifier.filePaths(from: urls)
            return paths.isEmpty ? (nil, nil) : (paths.joined(separator: "\n"), paths)
        }
        if let url = pasteboard.string(forType: type).flatMap({ URL(string: $0) }), url.isFileURL {
            return (url.path, [url.path])
        }
        return (nil, nil)
    case ClipboardClassifier.pngType, ClipboardClassifier.tiffType:
        return (nil, nil) // never read image data (can be huge)
    case ClipboardClassifier.rtfType:
        if let str = pasteboard.string(forType: type) { return (str, nil) }
        if let data = pasteboard.data(forType: type) { return (String(data: data, encoding: .utf8), nil) }
        return (nil, nil)
    default:
        return (pasteboard.string(forType: type), nil)
    }
}

func emit(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj),
          let str = String(data: data, encoding: .utf8) else { return }
    print(str)
}

emit(["type": "ready"])

let sigSources: [DispatchSourceSignal] = [SIGTERM, SIGINT].map { sig in
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { exit(0) }
    source.resume()
    return source
}

// Exit with the parent (e.g. the Node process is SIGKILLed and never sends SIGTERM).
let parentPID = getppid()
let parentWatch: DispatchSourceProcess? = parentPID > 1 ? {
    let source = DispatchSource.makeProcessSource(identifier: parentPID, eventMask: .exit, queue: .main)
    source.setEventHandler { exit(0) }
    source.resume()
    return source
}() : nil
if parentPID > 1, getppid() != parentPID { exit(0) } // parent died before the watch was armed

let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: .milliseconds(200), leeway: .milliseconds(20))
timer.setEventHandler {
    let count = pasteboard.changeCount
    guard count != lastChangeCount else { return }
    lastChangeCount = count

    let types = (pasteboard.types ?? []).map { $0.rawValue }
    let concealed = ClipboardClassifier.isConcealed(types: types)
    let available = pasteboard.availableType(from: typeOrder)
    var content: String? = nil
    var paths: [String]? = nil
    if let available = available, options.includeContent, !concealed {
        (content, paths) = readContent(of: available)
    }
    emit(ClipboardClassifier.changedEvent(
        changeCount: count,
        timestampMs: Int64(Date().timeIntervalSince1970 * 1000),
        contentType: available.map { ClipboardClassifier.contentType(forPasteboardType: $0.rawValue) },
        concealed: concealed,
        content: content,
        contentPaths: paths,
        options: options
    ))
}
timer.resume()

RunLoop.main.run()
