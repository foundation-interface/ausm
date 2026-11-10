import ApplicationServices
import Foundation

/// Summary of the accessibility element at a point.
///
/// AX functions here are synchronous IPC to the target app. Each call is bounded by a 250 ms
/// messaging timeout (set process-wide on first use, which also applies to the host's own AX
/// calls that don't set a timeout). Safe to call from any thread.
public struct AXElementInfo {
    public var element: AXUIElement?
    public var role: String?
    public var subrole: String?
    public var label: String?
    public var description: String?
    public var value: String?
    public var isEditableText = false
}

private let systemWideElement: AXUIElement = {
    let el = AXUIElementCreateSystemWide()
    // Setting the timeout on the system-wide element makes it the default for every element
    // (including parents fetched while walking up the tree): unresponsive apps must not stall
    // the main thread / event tap.
    AXUIElementSetMessagingTimeout(el, 0.25)
    return el
}()

/// `ref` as an AXUIElement, or nil when the attribute holds some other CF type.
private func asAXElement(_ ref: AnyObject?) -> AXUIElement? {
    guard let ref = ref, CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
    return (ref as! AXUIElement) // checked above
}

private func axParent(of element: AXUIElement) -> AXUIElement? {
    var parentRef: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &parentRef) == .success else { return nil }
    return asAXElement(parentRef)
}

/// Query the accessibility element at the given screen coordinates (global CG points).
/// `value` is omitted for secure (password) text fields.
public func axElementAtPoint(_ point: CGPoint) -> AXElementInfo {
    var elementRef: AXUIElement?
    let err = AXUIElementCopyElementAtPosition(systemWideElement, Float(point.x), Float(point.y), &elementRef)
    guard err == .success, let element = elementRef else {
        return AXElementInfo()
    }
    AXUIElementSetMessagingTimeout(element, 0.25)

    var info = AXElementInfo()
    info.element = element
    info.role = axStringAttribute(element, kAXRoleAttribute)
    info.subrole = axStringAttribute(element, kAXSubroleAttribute)
    info.label = axStringAttribute(element, kAXTitleAttribute)
    info.description = axStringAttribute(element, kAXDescriptionAttribute)
    if info.subrole != (kAXSecureTextFieldSubrole as String) {
        info.value = axStringAttribute(element, kAXValueAttribute, maxLength: 200)
    }
    info.isEditableText = axIsEditableText(element, role: info.role)
    return info
}

private let editableRoles: Set<String> = [
    kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, "AXSearchField",
]

/// Heuristic: does this element (or the editable region it belongs to) accept typed text?
///  - Native AppKit controls report a text role.
///  - WebKit exposes `contenteditable` roots as AXTextArea.
///  - Chromium exposes descendants of editable regions with an `AXEditableAncestor` attribute.
public func axIsEditableText(_ element: AXUIElement, role: String?) -> Bool {
    _ = systemWideElement
    if let role = role, editableRoles.contains(role) { return true }
    var current = element
    for _ in 0..<12 {
        var names: CFArray?
        if AXUIElementCopyAttributeNames(current, &names) == .success, let names = names as? [String] {
            if names.contains("AXEditableAncestor") { return true }
        }
        guard let parent = axParent(of: current) else { break }
        current = parent
        let parentRole = axStringAttribute(current, kAXRoleAttribute)
        if let parentRole = parentRole, editableRoles.contains(parentRole) {
            return true
        }
        if parentRole == kAXWindowRole || parentRole == kAXApplicationRole || parentRole == "AXWebArea" {
            break
        }
    }
    return false
}

/// The focused element of the frontmost application, with the same editability heuristic.
public func axFocusedElementInfo(pid: pid_t) -> AXElementInfo {
    _ = systemWideElement
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.25)
    var focusedRef: AnyObject?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
          let element = asAXElement(focusedRef) else { return AXElementInfo() }
    var info = AXElementInfo()
    info.element = element
    info.role = axStringAttribute(element, kAXRoleAttribute)
    info.subrole = axStringAttribute(element, kAXSubroleAttribute)
    info.label = axStringAttribute(element, kAXTitleAttribute)
    info.description = axStringAttribute(element, kAXDescriptionAttribute)
    info.isEditableText = axIsEditableText(element, role: info.role)
    return info
}

/// The AXWindow that contains `element`, if any (nil for desktop-level elements such as
/// Finder's desktop icon view).
public func axWindow(of element: AXUIElement) -> AXUIElement? {
    _ = systemWideElement
    var ref: AnyObject?
    if AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &ref) == .success,
       let window = asAXElement(ref) {
        return window
    }
    var current = element
    for _ in 0..<30 {
        guard let parent = axParent(of: current) else { return nil }
        current = parent
        if axStringAttribute(current, kAXRoleAttribute) == kAXWindowRole { return current }
    }
    return nil
}

public func axStringAttribute(_ element: AXUIElement, _ attribute: String, maxLength: Int = 500) -> String? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard err == .success, let str = value as? String, !str.isEmpty else {
        return nil
    }
    if str.count > maxLength {
        return String(str.prefix(maxLength))
    }
    return str
}
