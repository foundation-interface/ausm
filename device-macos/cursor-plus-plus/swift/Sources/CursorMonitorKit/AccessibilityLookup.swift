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
    if info.subrole != (kAXSecureTextFieldSubrole as String) && info.role != "AXSecureTextField" {
        info.value = axStringAttribute(element, kAXValueAttribute, maxLength: 200)
    }
    info.isEditableText = axIsEditableText(element, role: info.role, at: point)
    return info
}

private let editableRoles: Set<String> = [
    kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, "AXSearchField",
]

/// Minimal read-only view of an accessibility node, so the editability heuristic can be
/// tested against a fake tree. `AXElementNode` is the real implementation.
protocol AXNodeLike {
    var role: String? { get }
    var subrole: String? { get }
    var attributeNames: [String] { get }
    var parent: Self? { get }
    var children: [Self] { get }
    /// Frame in global screen points, if the node reports position and size.
    var frame: CGRect? { get }
}

/// Secure (password) fields never count as editable text: their contents must not be
/// treated like ordinary typing targets.
private func isSecure<N: AXNodeLike>(_ node: N) -> Bool {
    node.role == "AXSecureTextField" || node.subrole == (kAXSecureTextFieldSubrole as String)
}

private func isEditableRole<N: AXNodeLike>(_ node: N) -> Bool {
    guard let role = node.role, editableRoles.contains(role) else { return false }
    return !isSecure(node)
}

/// Heuristic: does this element (or the editable region it belongs to) accept typed text?
///  - Native AppKit controls report a text role (secure fields excluded).
///  - WebKit exposes `contenteditable` roots as AXTextArea.
///  - Chromium exposes descendants of editable regions with an `AXEditableAncestor` attribute.
///  - A placeholder / static-text label drawn next to (not inside) a text view: when `point`
///    is given, an editable sibling of the element or of its parent whose frame contains the
///    point counts.
func axIsEditableNode<N: AXNodeLike>(_ element: N, at point: CGPoint?) -> Bool {
    if isSecure(element) { return false }
    if isEditableRole(element) { return true }
    var current = element
    for _ in 0..<12 {
        if current.attributeNames.contains("AXEditableAncestor") { return true }
        guard let parent = current.parent else { break }
        current = parent
        if isSecure(current) { return false }
        if isEditableRole(current) { return true }
        let role = current.role
        if role == kAXWindowRole || role == kAXApplicationRole || role == "AXWebArea" { break }
    }
    guard let point = point else { return false }
    var level: N? = element
    for _ in 0..<2 {
        guard let node = level, let parent = node.parent else { break }
        if parent.role == kAXWindowRole || parent.role == kAXApplicationRole { break }
        for sibling in parent.children.prefix(64) where isEditableRole(sibling) {
            if let frame = sibling.frame, frame.contains(point) { return true }
        }
        level = parent
    }
    return false
}

/// Live AXUIElement adapter for `axIsEditableNode`.
struct AXElementNode: AXNodeLike {
    let element: AXUIElement
    var role: String? { axStringAttribute(element, kAXRoleAttribute) }
    var subrole: String? { axStringAttribute(element, kAXSubroleAttribute) }
    var attributeNames: [String] {
        var names: CFArray?
        guard AXUIElementCopyAttributeNames(element, &names) == .success, let list = names as? [String] else { return [] }
        return list
    }
    var parent: AXElementNode? { axParent(of: element).map(AXElementNode.init) }
    var children: [AXElementNode] {
        var ref: AnyObject?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &ref) == .success,
              let list = ref as? [AnyObject] else { return [] }
        return list.compactMap { asAXElement($0) }.map(AXElementNode.init)
    }
    var frame: CGRect? {
        var posRef: AnyObject?
        var sizeRef: AnyObject?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let posVal = posRef, let sizeVal = sizeRef,
              CFGetTypeID(posVal) == AXValueGetTypeID(), CFGetTypeID(sizeVal) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(posVal as! AXValue, .cgPoint, &origin),
              AXValueGetValue(sizeVal as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }
}

/// Does `element` (at `point`, when known) accept typed text? See `axIsEditableNode`.
public func axIsEditableText(_ element: AXUIElement, role: String?, at point: CGPoint? = nil) -> Bool {
    _ = systemWideElement
    _ = role // re-read through the node; kept for source compatibility
    return axIsEditableNode(AXElementNode(element: element), at: point)
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
