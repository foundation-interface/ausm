import ApplicationServices
import CoreGraphics
import Foundation

/// Wire event — one JSON object per line on the helper's stdout. Nil fields are omitted.
public struct CursorEvent: Codable, Sendable {
    public let type: String          // "ready" | "cursor-event" | "error"
    public var action: String?       // MOVE, CLICK, DOUBLE_CLICK, RIGHT_CLICK, SCROLL, HOLD_START, HOLD_END, DRAG

    public var x: Double?
    public var y: Double?

    public var button: Int?          // 0 = left, 1 = middle, 2 = right
    public var clickCount: Int?

    public var scrollDeltaX: Double?
    public var scrollDeltaY: Double?

    public var holdDurationMs: Double?

    public var windowId: UInt32?
    public var windowTitle: String?
    public var ownerName: String?
    public var bundleId: String?

    public var windowX: Double?
    public var windowY: Double?
    public var windowWidth: Double?
    public var windowHeight: Double?

    public var uiElementRole: String?
    public var uiElementSubrole: String?
    public var uiElementLabel: String?
    public var uiElementDescription: String?
    public var uiElementValue: String?
    /// True when the element under the cursor accepts typed text (text field/area, combo box,
    /// search field, or a web content-editable region).
    public var uiElementIsEditableText: Bool?

    /// For `type == "error"`: machine-readable code (`event_tap_disabled`,
    /// `accessibility_denied`) and a human-readable message.
    public var code: String?
    public var message: String?

    public init(type: String) {
        self.type = type
    }
}

/// Lightweight snapshot of a window from CGWindowList.
public struct WindowInfo: Sendable {
    public let windowId: CGWindowID
    public let title: String
    public let ownerName: String
    public let bundleId: String
    public let pid: pid_t
    public let bounds: CGRect
}

/// In-process extras that cannot cross the JSON boundary: the live accessibility element under
/// the cursor (for hosts that want to act on it) and the resolved window.
public struct CursorContext {
    public let element: AXUIElement?
    public let window: WindowInfo?
}
