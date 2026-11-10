import CoreGraphics
import Foundation

// MARK: - Output Event (JSON-encoded, written to stdout)

struct WindowEvent: Codable {
    var type: String
    let windowId: UInt32
    let title: String
    let ownerName: String
    let bundleId: String
    let pid: Int32
    let bounds: Rect
    /// CGDirectDisplayID of the display this window is primarily on
    let displayId: UInt32
    /// File URL from the AXDocument attribute (nil for non-document windows)
    var documentPath: String?

    var oldTitle: String?
    var oldBounds: Rect?

    struct Rect: Codable {
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
}

// MARK: - Space Change Event (JSON-encoded, written to stdout)

struct SpaceChangeEvent: Codable {
    let type: String  // always "space-changed"
    let timestamp: Double
}

// MARK: - Handshake / permission status (JSON-encoded, written to stdout)

/// First line on stdout. Keeps the WindowEvent fields (zeroed) so older readers that
/// decode every line as a window event still parse it; they skip `type == "ready"`.
struct ReadyEvent: Codable {
    var type = "ready"
    var windowId: UInt32 = 0
    var title = ""
    var ownerName = ""
    var bundleId = ""
    var pid: Int32 = 0
    var bounds = WindowEvent.Rect(.zero)
    var displayId: UInt32 = 0
    let accessibilityTrusted: Bool
    let screenRecordingGranted: Bool
}

/// Emitted when Accessibility or Screen Recording permission changes while running.
struct PermissionEvent: Codable {
    var type = "permission"
    let accessibilityTrusted: Bool
    let screenRecordingGranted: Bool
}

// MARK: - Internal Window Snapshot

/// Snapshot of a single on-screen window at a point in time.
struct WindowSnapshot {
    let windowId: CGWindowID
    let title: String
    let ownerName: String
    let bundleId: String
    let ownerPID: pid_t
    let bounds: CGRect
    let layer: Int
    /// Front-to-back Z-order index from CGWindowList (0 = frontmost)
    let zIndex: Int
    /// CGDirectDisplayID of the display this window is primarily on
    let displayId: CGDirectDisplayID
    /// File URL from the AXDocument attribute (nil for non-document windows)
    let documentPath: String?

    /// Unique key: "windowId_ownerPID" (CGWindowID can theoretically be reused)
    var key: String { "\(windowId)_\(ownerPID)" }

    func with(documentPath: String?) -> WindowSnapshot {
        WindowSnapshot(windowId: windowId, title: title, ownerName: ownerName, bundleId: bundleId,
                       ownerPID: ownerPID, bounds: bounds, layer: layer, zIndex: zIndex,
                       displayId: displayId, documentPath: documentPath)
    }

    func toEvent(type: String) -> WindowEvent {
        var event = WindowEvent(
            type: type,
            windowId: windowId,
            title: title,
            ownerName: ownerName,
            bundleId: bundleId,
            pid: Int32(ownerPID),
            bounds: .init(bounds),
            displayId: displayId
        )
        event.documentPath = documentPath
        return event
    }
}

// MARK: - Accessibility Window Info

/// Info extracted from an AX focused element for window matching.
struct AccessibilityWindowInfo {
    let windowRect: CGRect
    let appPID: pid_t
    let windowTitle: String?
}

// MARK: - App Activation Tracking

/// App-activation state machine for the frontmost app.
enum ActiveAppState {
    /// Waiting for the app's window to appear in CGWindowList
    case pendingDiff
    /// Window found, waiting to set up AXObserver
    case pendingSubscribe
    /// AXObserver is active for this app
    case subscribed
}
