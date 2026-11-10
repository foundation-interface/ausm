import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - Public event types

/// Phase of an edit in one text input. Raw values are the wire strings (`TextInputStatusLike`
/// on the Node side).
public enum TextInputStatus: String, Codable, Sendable, CaseIterable {
    /// Focus entered an editable text element. `text` is its value at that moment.
    case started = "TEXT_EDITING_STARTED"
    /// The value changed (only emitted when it differs from the last reported value).
    case updated = "TEXT_EDITING_UPDATED"
    /// Focus left the element (after a 200 ms debounce), the app changed, or the monitor
    /// stopped. `text` is the last reported value.
    case finished = "TEXT_EDITING_FINISHED"
}

/// One text-input event. Also the exact JSON object TextInputHelper prints (nil fields omitted);
/// matches the Node-side `TextInputEventLike` so no mapping is needed.
public struct TextInputEvent: Codable, Sendable, Equatable {
    public let status: TextInputStatus
    /// The element's full value (AXValue). Never read from password fields.
    public let text: String?
    public let sourceElement: SourceElement?
    /// Approximate caret position: top-left of the selection bounds, global screen points.
    public let caretScreenPosition: PointJSON?
    /// Milliseconds since 1970.
    public let timestamp: Double

    public struct SourceElement: Codable, Sendable, Equatable {
        /// AX role (`AXTextField`, `AXTextArea`, `AXComboBox`).
        public let type: String?
        public let application: String?
        /// Bundle identifier of the owning app.
        public let applicationID: String?
        public let applicationLocalizedName: String?
        /// Element frame in global screen points (top-left origin).
        public let screenBounds: RectJSON?
        /// Always nil (kept for wire compatibility).
        public let content: String?

        public init(type: String?, application: String?, applicationID: String?,
                    applicationLocalizedName: String?, screenBounds: RectJSON?, content: String?) {
            self.type = type
            self.application = application
            self.applicationID = applicationID
            self.applicationLocalizedName = applicationLocalizedName
            self.screenBounds = screenBounds
            self.content = content
        }
    }

    public struct RectJSON: Codable, Sendable, Equatable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double

        public init(_ r: CGRect) {
            self.x = r.origin.x
            self.y = r.origin.y
            self.width = r.size.width
            self.height = r.size.height
        }

        public var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    }

    public struct PointJSON: Codable, Sendable, Equatable {
        public let x: Double
        public let y: Double

        public init(_ p: CGPoint) {
            self.x = p.x
            self.y = p.y
        }

        public var cgPoint: CGPoint { CGPoint(x: x, y: y) }
    }

    public init(status: TextInputStatus, text: String?, sourceElement: SourceElement?,
                caretScreenPosition: PointJSON?, timestamp: Double) {
        self.status = status
        self.text = text
        self.sourceElement = sourceElement
        self.caretScreenPosition = caretScreenPosition
        self.timestamp = timestamp
    }

    public var date: Date { Date(timeIntervalSince1970: timestamp / 1000) }
}

/// Everything `TextInputMonitor.onEvent` delivers.
public enum TextInputMonitorEvent: Sendable, Equatable {
    /// First event after `start()`.
    case ready(accessibilityTrusted: Bool)
    case textInput(TextInputEvent)
    /// Accessibility was granted or revoked while running.
    case permissionChanged(accessibilityTrusted: Bool)

    /// The JSON line TextInputHelper prints for this event.
    public var wireLine: String? {
        switch self {
        case .ready(let trusted): return TextInputWire.line(ReadyEvent(accessibilityTrusted: trusted))
        case .textInput(let e): return TextInputWire.line(e)
        case .permissionChanged(let trusted): return TextInputWire.line(PermissionEvent(accessibilityTrusted: trusted))
        }
    }
}

// MARK: - Tracking policy (pure; unit-tested)

public enum TextInputPolicy {
    /// AX roles we consider to be editable text inputs.
    public static let editableRoles: Set<String> = [
        kAXTextFieldRole as String,
        kAXTextAreaRole as String,
        kAXComboBoxRole as String,
    ]

    /// Password fields. Native NSSecureTextField and web `<input type=password>` (WebKit and
    /// Chromium) both report this subrole.
    public static let secureSubrole = kAXSecureTextFieldSubrole as String

    public static func isSecure(role: String?, subrole: String?) -> Bool {
        subrole == secureSubrole
    }

    /// Whether an element is an editable text input we may report on. Password fields are
    /// never tracked: no events, no value reads, no value-change observer (so not even the
    /// typing cadence or length leaks).
    public static func isTrackable(role: String?, subrole: String?) -> Bool {
        guard let role, editableRoles.contains(role) else { return false }
        return !isSecure(role: role, subrole: subrole)
    }

    /// How far up the AX hierarchy focus may have landed inside a text input.
    public static let maxAncestorDepth = 8

    /// Walk from `start` up through `parent` (at most `maxDepth` elements, `start` included)
    /// to the nearest element with an editable role. Returns nil when there is none, or when
    /// the nearest one is a password field (an editable ancestor further up is not used).
    public static func resolveEditable<Element>(
        from start: Element,
        maxDepth: Int = maxAncestorDepth,
        role: (Element) -> String?,
        subrole: (Element) -> String?,
        parent: (Element) -> Element?
    ) -> Element? {
        var current = start
        for _ in 0..<max(maxDepth, 0) {
            if let r = role(current), editableRoles.contains(r) {
                return isTrackable(role: r, subrole: subrole(current)) ? current : nil
            }
            guard let next = parent(current) else { break }
            current = next
        }
        return nil
    }
}

// MARK: - Wire-only shapes

enum TextInputWire {
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = []
        return e
    }()

    static func line<T: Encodable>(_ value: T) -> String? {
        guard let data = try? encoder.encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// First line on stdout.
struct ReadyEvent: Codable {
    var type = "ready"
    let accessibilityTrusted: Bool
}

/// Emitted when Accessibility permission is granted or revoked while running.
/// Has no `status`, so readers that only handle text-input events ignore it.
struct PermissionEvent: Codable {
    var type = "permission"
    let accessibilityTrusted: Bool
}
