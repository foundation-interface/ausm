import ApplicationServices
import XCTest
@testable import TextInputMonitorKit

final class TextInputPolicyTests: XCTestCase {
    func testEditableRolesAreTracked() {
        XCTAssertTrue(TextInputPolicy.isTrackable(role: "AXTextField", subrole: nil))
        XCTAssertTrue(TextInputPolicy.isTrackable(role: "AXTextArea", subrole: nil))
        XCTAssertTrue(TextInputPolicy.isTrackable(role: "AXComboBox", subrole: nil))
        XCTAssertTrue(TextInputPolicy.isTrackable(role: "AXTextField", subrole: "AXSearchField"))
    }

    func testPasswordFieldsAreNeverTracked() {
        XCTAssertEqual(TextInputPolicy.secureSubrole, "AXSecureTextField")
        XCTAssertFalse(TextInputPolicy.isTrackable(role: "AXTextField", subrole: "AXSecureTextField"))
        XCTAssertFalse(TextInputPolicy.isTrackable(role: "AXTextArea", subrole: "AXSecureTextField"))
        XCTAssertTrue(TextInputPolicy.isSecure(role: nil, subrole: "AXSecureTextField"))
    }

    func testNonEditableRolesAreNotTracked() {
        XCTAssertFalse(TextInputPolicy.isTrackable(role: "AXButton", subrole: nil))
        XCTAssertFalse(TextInputPolicy.isTrackable(role: "AXStaticText", subrole: nil))
        XCTAssertFalse(TextInputPolicy.isTrackable(role: nil, subrole: nil))
    }
}

final class WireFormatTests: XCTestCase {
    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("\n"), "must be a single line")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testTextInputEventShapeMatchesTextInputEventLike() throws {
        let evt = TextInputEvent(
            status: .updated,
            text: "hello\nworld \u{1F600}",
            sourceElement: .init(type: "AXTextArea", application: "Notes", applicationID: "com.apple.Notes",
                                 applicationLocalizedName: "Notes",
                                 screenBounds: .init(CGRect(x: 1, y: 2, width: 3, height: 4)), content: nil),
            caretScreenPosition: .init(CGPoint(x: 5, y: 6)),
            timestamp: 1_700_000_000_000
        )
        let obj = try json(evt)
        XCTAssertEqual(Set(obj.keys), ["status", "text", "sourceElement", "caretScreenPosition", "timestamp"])
        XCTAssertEqual(obj["status"] as? String, "TEXT_EDITING_UPDATED")
        XCTAssertEqual(obj["text"] as? String, "hello\nworld \u{1F600}", "newlines are escaped, not line breaks")
        let src = try XCTUnwrap(obj["sourceElement"] as? [String: Any])
        XCTAssertEqual(src["applicationID"] as? String, "com.apple.Notes")
        XCTAssertNil(src["content"], "content is never populated")
        XCTAssertEqual(src["screenBounds"] as? [String: Double], ["x": 1, "y": 2, "width": 3, "height": 4])
        XCTAssertEqual(obj["caretScreenPosition"] as? [String: Double], ["x": 5, "y": 6])
    }

    func testNilTextIsOmitted() throws {
        let evt = TextInputEvent(status: .started, text: nil, sourceElement: nil,
                                 caretScreenPosition: nil, timestamp: 0)
        let obj = try json(evt)
        XCTAssertNil(obj["text"])
        XCTAssertEqual(obj["status"] as? String, "TEXT_EDITING_STARTED")
    }

    func testStatusLinesHaveNoStatusField() throws {
        // Readers treat lines without `status` as non-text-input messages.
        let ready = try json(ReadyEvent(accessibilityTrusted: false))
        XCTAssertEqual(ready["type"] as? String, "ready")
        XCTAssertEqual(ready["accessibilityTrusted"] as? Bool, false)
        XCTAssertNil(ready["status"])

        let perm = try json(PermissionEvent(accessibilityTrusted: true))
        XCTAssertEqual(perm["type"] as? String, "permission")
        XCTAssertNil(perm["status"])
    }
}
