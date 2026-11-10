import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - Output Event (JSON-encoded, written to stdout)

/// Matches the Node-side TextInputEventLike shape so no mapping is needed.
struct TextInputEvent: Codable {
    let status: String
    let text: String?
    let sourceElement: SourceElement?
    let caretScreenPosition: PointJSON?
    let timestamp: Double

    struct SourceElement: Codable {
        let type: String?
        let application: String?
        let applicationID: String?
        let applicationLocalizedName: String?
        let screenBounds: RectJSON?
        let content: String?
    }

    struct RectJSON: Codable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double

        init(_ r: CGRect) {
            self.x = r.origin.x
            self.y = r.origin.y
            self.width = r.size.width
            self.height = r.size.height
        }
    }

    struct PointJSON: Codable {
        let x: Double
        let y: Double

        init(_ p: CGPoint) {
            self.x = p.x
            self.y = p.y
        }
    }
}

// MARK: - Tracking policy (pure; unit-tested)

enum TextInputPolicy {
    /// AX roles we consider to be editable text inputs.
    static let editableRoles: Set<String> = [
        kAXTextFieldRole as String,
        kAXTextAreaRole as String,
        kAXComboBoxRole as String,
    ]

    /// Password fields. Native NSSecureTextField and web `<input type=password>` (WebKit and
    /// Chromium) both report this subrole.
    static let secureSubrole = kAXSecureTextFieldSubrole as String

    static func isSecure(role: String?, subrole: String?) -> Bool {
        subrole == secureSubrole
    }

    /// Whether an element is an editable text input we may report on. Password fields are
    /// never tracked: no events, no value reads, no value-change observer (so not even the
    /// typing cadence or length leaks).
    static func isTrackable(role: String?, subrole: String?) -> Bool {
        guard let role, editableRoles.contains(role) else { return false }
        return !isSecure(role: role, subrole: subrole)
    }
}

// MARK: - Handshake / permission status

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
