import Foundation

/// Kind of content on the pasteboard, chosen by priority FILE > URL > IMAGE > HTML > RTF > TEXT.
/// Raw values are the wire strings (`CopyPasteContentType` on the Node side).
public enum ClipboardContentType: String, Sendable, CaseIterable, Codable {
    case text = "TEXT"
    case html = "HTML"
    case rtf = "RTF"
    case image = "IMAGE"
    case file = "FILE"
    case url = "URL"
}

/// One pasteboard change (a copy or cut in any app).
public struct ClipboardEvent: Sendable, Equatable {
    /// `NSPasteboard.changeCount` after the change.
    public let changeCount: Int
    /// Milliseconds since 1970 when the change was observed.
    public let timestampMs: Int64
    /// Nil when the pasteboard holds none of the recognised types.
    public let contentType: ClipboardContentType?
    /// The pasteboard carried a concealed/transient marker (password managers). Such events
    /// never carry `content` or `contentPaths`.
    public let concealed: Bool
    /// Text for TEXT/HTML/RTF/URL, newline-joined paths for FILE. Never set for IMAGE (image
    /// data is never read), for concealed pasteboards, or when `Options.includeContent` is off.
    public let content: String?
    /// File paths for FILE content (non-empty when present).
    public let contentPaths: [String]?
    /// `content` was cut at `Options.maxContentBytes` (on a character boundary).
    public let contentTruncated: Bool

    public init(changeCount: Int, timestampMs: Int64, contentType: ClipboardContentType?,
                concealed: Bool, content: String?, contentPaths: [String]?, contentTruncated: Bool) {
        self.changeCount = changeCount
        self.timestampMs = timestampMs
        self.contentType = contentType
        self.concealed = concealed
        self.content = content
        self.contentPaths = contentPaths
        self.contentTruncated = contentTruncated
    }

    public var timestamp: Date { Date(timeIntervalSince1970: TimeInterval(timestampMs) / 1000) }

    /// The `clipboard_changed` JSON object ClipboardHelper prints (absent fields omitted).
    public var wireObject: [String: Any] {
        var obj: [String: Any] = [
            "type": "clipboard_changed",
            "changeCount": changeCount,
            "timestamp": timestampMs,
        ]
        if let ct = contentType { obj["contentType"] = ct.rawValue }
        if concealed { obj["concealed"] = true }
        if let content { obj["content"] = content }
        if contentTruncated { obj["contentTruncated"] = true }
        if let contentPaths, !contentPaths.isEmpty { obj["contentPaths"] = contentPaths }
        return obj
    }

    /// `wireObject` as one line of compact JSON.
    public var wireLine: String? { ClipboardWire.line(wireObject) }
}

/// JSON-lines helpers shared by ClipboardHelper and the tests.
public enum ClipboardWire {
    /// `{"type":"ready"}`
    public static let readyObject: [String: Any] = ["type": "ready"]

    public static func line(_ obj: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj),
              let str = String(data: data, encoding: .utf8) else { return nil }
        return str
    }
}

/// Reports each problem once, until it clears (pure; unit-tested).
struct ProblemLatch<Problem: Hashable> {
    private(set) var current: Problem?

    /// Feed the latest observation; returns the problem to report, if it is new.
    mutating func update(_ observed: Problem?) -> Problem? {
        defer { current = observed }
        guard let observed, observed != current else { return nil }
        return observed
    }
}
