import CoreGraphics
import XCTest
@testable import CursorMonitorKit

/// Fake accessibility tree: no AX API is called.
final class FakeAXNode: AXNodeLike {
    let role: String?
    let subrole: String?
    let attributeNames: [String]
    let frame: CGRect?
    var parentNode: FakeAXNode?  // strong: test trees are built inline and must outlive the call
    private(set) var childNodes: [FakeAXNode] = []

    init(_ role: String?, subrole: String? = nil, attrs: [String] = [], frame: CGRect? = nil, children: [FakeAXNode] = []) {
        self.role = role
        self.subrole = subrole
        self.attributeNames = attrs
        self.frame = frame
        for c in children { c.parentNode = self }
        self.childNodes = children
    }
    var parent: FakeAXNode? { parentNode }
    var children: [FakeAXNode] { childNodes }
}

final class AccessibilityEditabilityTests: XCTestCase {
    private let p = CGPoint(x: 50, y: 50)

    func testEditableRoles() {
        for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"] {
            XCTAssertTrue(axIsEditableNode(FakeAXNode(role), at: nil), role)
        }
        for role in ["AXButton", "AXStaticText", "AXImage", nil] as [String?] {
            _ = FakeAXNode("AXWindow", children: [FakeAXNode(role)])
            XCTAssertFalse(axIsEditableNode(FakeAXNode(role), at: nil), String(describing: role))
        }
    }

    func testSecureTextFieldIsNotEditable() {
        XCTAssertFalse(axIsEditableNode(FakeAXNode("AXTextField", subrole: "AXSecureTextField"), at: nil))
        XCTAssertFalse(axIsEditableNode(FakeAXNode("AXSecureTextField"), at: nil))
    }

    func testChildOfSecureFieldIsNotEditable() {
        let inner = FakeAXNode("AXStaticText")
        _ = FakeAXNode("AXWindow", children: [FakeAXNode("AXTextField", subrole: "AXSecureTextField", children: [inner])])
        XCTAssertFalse(axIsEditableNode(inner, at: p))
    }

    func testSecureSiblingDoesNotMakePlaceholderEditable() {
        let placeholder = FakeAXNode("AXStaticText", frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        _ = FakeAXNode("AXWindow", children: [FakeAXNode("AXGroup", children: [
            FakeAXNode("AXTextField", subrole: "AXSecureTextField", frame: CGRect(x: 0, y: 0, width: 200, height: 100)),
            placeholder,
        ])])
        XCTAssertFalse(axIsEditableNode(placeholder, at: p))
    }

    func testDescendantOfEditableAncestorRole() {
        let leaf = FakeAXNode("AXStaticText")
        _ = FakeAXNode("AXWebArea", children: [FakeAXNode("AXTextArea", children: [FakeAXNode("AXGroup", children: [leaf])])])
        XCTAssertTrue(axIsEditableNode(leaf, at: nil))
    }

    func testChromiumEditableAncestorAttribute() {
        let leaf = FakeAXNode("AXStaticText")
        _ = FakeAXNode("AXGroup", attrs: ["AXEditableAncestor"], children: [leaf])
        XCTAssertTrue(axIsEditableNode(leaf, at: nil))
        XCTAssertTrue(axIsEditableNode(FakeAXNode("AXStaticText", attrs: ["AXEditableAncestor"]), at: nil))
    }

    func testWalkStopsAtWindowAndWebArea() {
        let leaf = FakeAXNode("AXStaticText")
        _ = FakeAXNode("AXTextArea", children: [FakeAXNode("AXWebArea", children: [leaf])])
        XCTAssertFalse(axIsEditableNode(leaf, at: nil), "editability does not leak across a web area")
        let leaf2 = FakeAXNode("AXStaticText")
        _ = FakeAXNode("AXTextArea", children: [FakeAXNode("AXWindow", children: [leaf2])])
        XCTAssertFalse(axIsEditableNode(leaf2, at: nil))
    }

    func testPlaceholderSiblingOverTextViewIsEditable() {
        // A placeholder label drawn on top of an (empty) text view, as a sibling, not a child.
        let placeholder = FakeAXNode("AXStaticText", frame: CGRect(x: 10, y: 40, width: 120, height: 20))
        _ = FakeAXNode("AXWindow", children: [FakeAXNode("AXScrollArea", children: [
            FakeAXNode("AXTextArea", frame: CGRect(x: 0, y: 0, width: 400, height: 300)),
            placeholder,
        ])])
        XCTAssertTrue(axIsEditableNode(placeholder, at: p))
        XCTAssertFalse(axIsEditableNode(placeholder, at: nil), "sibling check needs the point")
        XCTAssertFalse(axIsEditableNode(placeholder, at: CGPoint(x: 500, y: 500)), "point outside the text view")
    }

    func testPlaceholderNestedOneLevelNextToTextView() {
        let label = FakeAXNode("AXStaticText")
        _ = FakeAXNode("AXWindow", children: [FakeAXNode("AXGroup", children: [
            FakeAXNode("AXGroup", children: [label]),
            FakeAXNode("AXTextField", frame: CGRect(x: -2000, y: -100, width: 300, height: 30)),
        ])])
        XCTAssertTrue(axIsEditableNode(label, at: CGPoint(x: -1900, y: -90)), "negative-origin display")
    }

    func testSiblingsAreNotSearchedAcrossTheWindow() {
        let label = FakeAXNode("AXStaticText")
        _ = FakeAXNode("AXWindow", children: [label, FakeAXNode("AXTextField", frame: CGRect(x: 0, y: 0, width: 999, height: 999))])
        XCTAssertFalse(axIsEditableNode(label, at: p), "a window-level text field elsewhere does not count")
    }

    func testNonEditableSiblingContainingPointDoesNotCount() {
        let label = FakeAXNode("AXStaticText")
        _ = FakeAXNode("AXWindow", children: [FakeAXNode("AXGroup", children: [
            label, FakeAXNode("AXButton", frame: CGRect(x: 0, y: 0, width: 100, height: 100)),
            FakeAXNode("AXTextField", frame: nil),
        ])])
        XCTAssertFalse(axIsEditableNode(label, at: p))
    }

    func testDeepTreeTerminates() {
        var node = FakeAXNode("AXGroup")
        let leaf = node
        for _ in 0..<100 { node = FakeAXNode("AXGroup", children: [node]) }
        XCTAssertFalse(axIsEditableNode(leaf, at: p))
    }
}
