import Foundation

/// Pure helpers for ClipboardHelper (no pasteboard access), unit-tested.
enum ClipboardClassifier {
    /// UTIs in priority order: FILE > URL > IMAGE > HTML > RTF > TEXT.
    static let fileURLType = "public.file-url"
    static let urlType = "public.url"
    static let pngType = "public.png"
    static let tiffType = "public.tiff"
    static let htmlType = "public.html"
    static let rtfType = "public.rtf"
    static let stringType = "public.utf8-plain-text"

    static let typeOrder = [fileURLType, urlType, pngType, tiffType, htmlType, rtfType, stringType]

    static func contentType(forPasteboardType type: String) -> String {
        switch type {
        case fileURLType: return "FILE"
        case urlType: return "URL"
        case pngType, tiffType: return "IMAGE"
        case htmlType: return "HTML"
        case rtfType: return "RTF"
        default: return "TEXT"
        }
    }

    /// Markers that password managers and similar apps put on the pasteboard
    /// (http://nspasteboard.org). Their content is never read or emitted.
    static let concealedMarkers: Set<String> = [
        "org.nspasteboard.ConcealedType",
        "org.nspasteboard.TransientType",
        "com.agilebits.onepassword",
        "de.petermaurer.TransientPasteboardType",
    ]

    static func isConcealed(types: [String]) -> Bool {
        return types.contains(where: concealedMarkers.contains)
    }

    /// Truncate to at most `maxBytes` of UTF-8 without splitting a character.
    /// Returns the (possibly shortened) string and whether it was shortened.
    static func truncate(_ s: String, maxBytes: Int) -> (String, Bool) {
        guard maxBytes >= 0, s.utf8.count > maxBytes else { return (s, false) }
        var idx = s.utf8.index(s.utf8.startIndex, offsetBy: maxBytes)
        while idx > s.startIndex, idx.samePosition(in: s) == nil {
            idx = s.utf8.index(before: idx)
        }
        return (String(s[..<idx]), true)
    }

    /// Paths of file URLs only (a file-url pasteboard can also carry web URLs).
    static func filePaths(from urls: [URL]) -> [String] {
        return urls.filter { $0.isFileURL }.map { $0.path }.filter { !$0.isEmpty }
    }

    struct Options {
        var includeContent = true
        var maxContentBytes = 1_048_576
    }

    /// Build the `clipboard_changed` wire event. `content` / `contentPaths` are what the
    /// pasteboard returned (nil when not read).
    static func changedEvent(
        changeCount: Int,
        timestampMs: Int64,
        contentType: String?,
        concealed: Bool,
        content: String?,
        contentPaths: [String]?,
        options: Options
    ) -> [String: Any] {
        var obj: [String: Any] = [
            "type": "clipboard_changed",
            "changeCount": changeCount,
            "timestamp": timestampMs,
        ]
        if let ct = contentType { obj["contentType"] = ct }
        if concealed {
            obj["concealed"] = true
            return obj
        }
        guard options.includeContent else { return obj }
        if let c = content {
            let (text, truncated) = truncate(c, maxBytes: options.maxContentBytes)
            obj["content"] = text
            if truncated { obj["contentTruncated"] = true }
        }
        if let paths = contentPaths, !paths.isEmpty {
            obj["contentPaths"] = paths
        }
        return obj
    }

    /// Parse `--no-content` and `--max-content-bytes N`.
    static func options(fromArguments args: [String]) -> Options {
        var o = Options()
        if args.contains("--no-content") { o.includeContent = false }
        if let i = args.firstIndex(of: "--max-content-bytes"), i + 1 < args.count,
           let n = Int(args[i + 1]), n > 0 {
            o.maxContentBytes = n
        }
        return o
    }
}
