import AppKit
import Foundation

/// What the monitor needs from a pasteboard. `SystemPasteboard` wraps `NSPasteboard.general`;
/// tests use a fake so they never touch the user's real clipboard.
protocol PasteboardReading: AnyObject {
    /// Cheap; does not read contents and does not trigger the macOS paste-privacy alert.
    var changeCount: Int { get }
    /// Type identifiers currently on the pasteboard (no contents are read).
    var typeIdentifiers: [String] { get }
    /// Highest-priority type from `types` that is present.
    func availableType(from types: [String]) -> String?
    /// Read the content of `type`. Only called when content is wanted and not concealed.
    func readContent(ofType type: String) -> (content: String?, paths: [String]?)
    /// Paste-privacy setting for this app (macOS 15.4+), as a problem to report, if any.
    var accessProblem: ClipboardMonitor.Problem? { get }
}

final class SystemPasteboard: PasteboardReading {
    private let pasteboard: NSPasteboard

    init(_ pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard
    }

    var changeCount: Int { pasteboard.changeCount }

    var typeIdentifiers: [String] { (pasteboard.types ?? []).map(\.rawValue) }

    func availableType(from types: [String]) -> String? {
        pasteboard.availableType(from: types.map { NSPasteboard.PasteboardType($0) })?.rawValue
    }

    func readContent(ofType raw: String) -> (content: String?, paths: [String]?) {
        let type = NSPasteboard.PasteboardType(raw)
        switch raw {
        case ClipboardClassifier.fileURLType:
            if let urls = pasteboard.readObjects(forClasses: [NSURL.self],
                                                 options: [.urlReadingFileURLsOnly: true]) as? [URL] {
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

    var accessProblem: ClipboardMonitor.Problem? {
        if #available(macOS 15.4, *) {
            return ClipboardMonitor.Problem(accessBehavior: pasteboard.accessBehavior.rawValue)
        }
        return nil
    }
}

extension ClipboardMonitor.Problem {
    /// Map `NSPasteboard.AccessBehavior` raw values (0 default, 1 ask, 2 always allow,
    /// 3 always deny) to a problem. Pure; unit-tested.
    init?(accessBehavior raw: Int) {
        switch raw {
        case 1: self = .accessPrompts
        case 3: self = .accessDenied
        default: return nil
        }
    }
}
