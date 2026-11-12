import Foundation

/// Pure clipboard logic (no pasteboard access): content-type priority, concealed-marker
/// detection, UTF-8-safe truncation, event construction and helper argument parsing.
/// Unit-tested in Tests/ClipboardMonitorKitTests.
public enum ClipboardClassifier {
    /// UTIs in priority order: FILE > URL > IMAGE > HTML > RTF > TEXT.
    public static let fileURLType = "public.file-url"
    public static let urlType = "public.url"
    public static let pngType = "public.png"
    public static let tiffType = "public.tiff"
    public static let htmlType = "public.html"
    public static let rtfType = "public.rtf"
    public static let stringType = "public.utf8-plain-text"

    /// The pasteboard types the monitor looks for, highest priority first.
    public static let typeOrder = [fileURLType, urlType, pngType, tiffType, htmlType, rtfType, stringType]

    /// Content type for one of the `typeOrder` UTIs. Anything else maps to `.text`.
    public static func contentType(for pasteboardType: String) -> ClipboardContentType {
        switch pasteboardType {
        case fileURLType: return .file
        case urlType: return .url
        case pngType, tiffType: return .image
        case htmlType: return .html
        case rtfType: return .rtf
        default: return .text
        }
    }

    /// String form used on the wire (`"FILE"`, `"URL"`, …).
    public static func contentType(forPasteboardType type: String) -> String {
        contentType(for: type).rawValue
    }

    /// Highest-priority type from `typeOrder` present in `types`, or nil. Same rule as
    /// `NSPasteboard.availableType(from: typeOrder)`.
    public static func preferredType(in types: [String]) -> String? {
        let present = Set(types)
        return typeOrder.first(where: present.contains)
    }

    /// Markers that password managers and similar apps put on the pasteboard
    /// (http://nspasteboard.org). Their content is never read or emitted.
    public static let concealedMarkers: Set<String> = [
        "org.nspasteboard.ConcealedType",
        "org.nspasteboard.TransientType",
        "com.agilebits.onepassword",
        "de.petermaurer.TransientPasteboardType",
    ]

    /// True when any of `types` is a concealed/transient marker (built-in or `additional`).
    public static func isConcealed(types: [String], additional: Set<String> = []) -> Bool {
        types.contains { concealedMarkers.contains($0) || additional.contains($0) }
    }

    /// Truncate to at most `maxBytes` of UTF-8 without splitting a character.
    /// Returns the (possibly shortened) string and whether it was shortened.
    public static func truncate(_ s: String, maxBytes: Int) -> (String, Bool) {
        guard maxBytes >= 0, s.utf8.count > maxBytes else { return (s, false) }
        var idx = s.utf8.index(s.utf8.startIndex, offsetBy: maxBytes)
        while idx > s.startIndex, idx.samePosition(in: s) == nil {
            idx = s.utf8.index(before: idx)
        }
        return (String(s[..<idx]), true)
    }

    /// Paths of file URLs only (a file-url pasteboard can also carry web URLs).
    public static func filePaths(from urls: [URL]) -> [String] {
        urls.filter { $0.isFileURL }.map { $0.path }.filter { !$0.isEmpty }
    }

    public typealias Options = ClipboardMonitor.Options

    /// Build the typed event for one pasteboard change. `content` / `contentPaths` are what the
    /// pasteboard returned (nil when not read). Concealed pasteboards and `includeContent ==
    /// false` never carry content, whatever was passed in.
    public static func makeEvent(
        changeCount: Int,
        timestampMs: Int64,
        contentType: ClipboardContentType?,
        concealed: Bool,
        content: String?,
        contentPaths: [String]?,
        options: Options
    ) -> ClipboardEvent {
        var text: String?
        var truncated = false
        var paths: [String]?
        if !concealed, options.includeContent {
            if let c = content {
                (text, truncated) = truncate(c, maxBytes: options.maxContentBytes)
            }
            if let p = contentPaths, !p.isEmpty { paths = p }
        }
        return ClipboardEvent(
            changeCount: changeCount,
            timestampMs: timestampMs,
            contentType: contentType,
            concealed: concealed,
            content: text,
            contentPaths: paths,
            contentTruncated: truncated
        )
    }

    /// Build the `clipboard_changed` wire event (the JSON object `ClipboardHelper` prints).
    public static func changedEvent(
        changeCount: Int,
        timestampMs: Int64,
        contentType: String?,
        concealed: Bool,
        content: String?,
        contentPaths: [String]?,
        options: Options
    ) -> [String: Any] {
        makeEvent(
            changeCount: changeCount,
            timestampMs: timestampMs,
            contentType: contentType.map { ClipboardContentType(rawValue: $0) ?? .text },
            concealed: concealed,
            content: content,
            contentPaths: contentPaths,
            options: options
        ).wireObject
    }

    /// Parse `--no-content` and `--max-content-bytes N` (ClipboardHelper's command line).
    public static func options(fromArguments args: [String]) -> Options {
        var o = Options()
        if args.contains("--no-content") { o.includeContent = false }
        if let i = args.firstIndex(of: "--max-content-bytes"), i + 1 < args.count,
           let n = Int(args[i + 1]), n > 0 {
            o.maxContentBytes = n
        }
        return o
    }
}
