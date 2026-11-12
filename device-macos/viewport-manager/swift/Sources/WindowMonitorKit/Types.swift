import CoreGraphics
import Foundation

// MARK: - Public event types

/// Kind of window event. Raw values are the wire strings the Node wrapper parses.
public enum WindowEventType: String, Codable, Sendable, CaseIterable {
    /// A window became visible (appeared in the on-screen window list).
    case opened = "window-opened"
    /// A window was closed, hidden, minimised or moved to another Space.
    case closed = "window-closed"
    /// A window became the focused (frontmost) window.
    case focused = "window-focused"
    /// The previously focused window lost focus (always before the next `focused`, and before
    /// `closed` when the focused window goes away).
    case unfocused = "window-unfocused"
    /// A single window moved or resized. Ticks where several windows change bounds at once
    /// (Space swipes, Mission Control, display changes) are dropped as noise.
    case boundsChanged = "bounds-changed"
    /// A window's title changed (`oldTitle` holds the previous one).
    case titleChanged = "title-changed"
}

/// One window event. Also the exact JSON object ViewportHelper prints (nil fields omitted).
///
/// Coordinates are global CoreGraphics points: origin at the top-left of the main display,
/// y grows downward, secondary displays may have negative origins.
public struct WindowEvent: Codable, Sendable, Equatable {
    public var type: WindowEventType
    /// CGWindowID.
    public let windowId: UInt32
    /// Window title. Empty titles are never reported (macOS hides other apps' titles without
    /// Screen Recording, so those windows are skipped entirely).
    public let title: String
    public let ownerName: String
    public let bundleId: String
    public let pid: Int32
    public let bounds: Rect
    /// CGDirectDisplayID of the display with the largest overlap with the window.
    public let displayId: UInt32
    /// AXDocument of the window (a file URL string), when the app exposes one and
    /// Accessibility is granted.
    public var documentPath: String?
    /// For `titleChanged`.
    public var oldTitle: String?
    /// For `boundsChanged`.
    public var oldBounds: Rect?

    public struct Rect: Codable, Sendable, Equatable {
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

    public init(type: WindowEventType, windowId: UInt32, title: String, ownerName: String, bundleId: String,
                pid: Int32, bounds: Rect, displayId: UInt32, documentPath: String? = nil,
                oldTitle: String? = nil, oldBounds: Rect? = nil) {
        self.type = type
        self.windowId = windowId
        self.title = title
        self.ownerName = ownerName
        self.bundleId = bundleId
        self.pid = pid
        self.bounds = bounds
        self.displayId = displayId
        self.documentPath = documentPath
        self.oldTitle = oldTitle
        self.oldBounds = oldBounds
    }
}

/// TCC state relevant to the window monitor.
public struct WindowPermissions: Sendable, Equatable {
    /// Needed for instant AX focus tracking and `documentPath` (focus still works by polling).
    public let accessibilityTrusted: Bool
    /// Without it macOS hides other apps' window titles, and untitled windows are not reported.
    public let screenRecordingGranted: Bool

    public init(accessibilityTrusted: Bool, screenRecordingGranted: Bool) {
        self.accessibilityTrusted = accessibilityTrusted
        self.screenRecordingGranted = screenRecordingGranted
    }
}

/// Everything `WindowMonitor.onEvent` delivers.
public enum WindowMonitorEvent: Sendable, Equatable {
    /// First event after `start()`, with the current permissions.
    case ready(WindowPermissions)
    /// A window lifecycle / focus / title / bounds event.
    case window(WindowEvent)
    /// The active Space (virtual desktop, Mission Control) changed.
    case spaceChanged(Date)
    /// Accessibility or Screen Recording was granted or revoked while running.
    case permissionsChanged(WindowPermissions)

    /// The JSON line ViewportHelper prints for this event.
    public var wireLine: String? {
        switch self {
        case .ready(let p):
            return WindowWire.line(ReadyEvent(accessibilityTrusted: p.accessibilityTrusted,
                                              screenRecordingGranted: p.screenRecordingGranted))
        case .window(let e):
            return WindowWire.line(e)
        case .spaceChanged(let date):
            return WindowWire.line(SpaceChangeEvent(type: "space-changed",
                                                    timestamp: date.timeIntervalSince1970 * 1000))
        case .permissionsChanged(let p):
            return WindowWire.line(PermissionEvent(accessibilityTrusted: p.accessibilityTrusted,
                                                   screenRecordingGranted: p.screenRecordingGranted))
        }
    }
}

// MARK: - Wire-only shapes

enum WindowWire {
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [] // compact single-line JSON
        return e
    }()

    static func line<T: Encodable>(_ value: T) -> String? {
        guard let data = try? encoder.encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// `{"type":"space-changed","timestamp":ms}`
struct SpaceChangeEvent: Codable {
    let type: String  // always "space-changed"
    let timestamp: Double
}

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
struct WindowSnapshot: Equatable {
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

    func toEvent(type: WindowEventType) -> WindowEvent {
        WindowEvent(
            type: type,
            windowId: windowId,
            title: title,
            ownerName: ownerName,
            bundleId: bundleId,
            pid: Int32(ownerPID),
            bounds: .init(bounds),
            displayId: displayId,
            documentPath: documentPath
        )
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
enum ActiveAppState: Equatable {
    /// Waiting for the app's window to appear in CGWindowList
    case pendingDiff
    /// Window found, waiting to set up AXObserver
    case pendingSubscribe
    /// AXObserver is active for this app
    case subscribed
}
