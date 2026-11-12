import XCTest
@testable import TextInputMonitorKit

/// Fake AX element: identity plus a value. Only synthetic strings are used.
private struct El: Equatable {
    let id: Int
}

private typealias Tracker = TextEditTracker<El>
private typealias Effect = Tracker.Effect

final class TextEditTrackerTests: XCTestCase {
    private var values: [Int: String] = [:]
    private var reads: [Int] = []

    override func setUp() {
        values = [1: "one", 2: "two", 3: "three"]
        reads = []
    }

    private func read(_ e: El) -> String? {
        reads.append(e.id)
        return values[e.id]
    }

    func testFocusIntoEditableStarts() {
        var t = Tracker()
        let fx = t.focusChanged(to: El(id: 1), readText: read)
        XCTAssertEqual(fx, [.observeValue(El(id: 1)), .started(El(id: 1), text: "one")])
        XCTAssertTrue(t.isEditing)
        XCTAssertEqual(t.lastText, "one")
    }

    func testFocusIntoNonEditableWhenIdleDoesNothing() {
        var t = Tracker()
        XCTAssertEqual(t.focusChanged(to: nil, readText: read), [])
        XCTAssertFalse(t.finishPending)
        XCTAssertTrue(reads.isEmpty)
    }

    func testDuplicateFocusIsIgnored() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        reads = []
        XCTAssertEqual(t.focusChanged(to: El(id: 1), readText: read), [])
        XCTAssertTrue(reads.isEmpty, "no value read for a duplicate")
    }

    func testSwitchBetweenEditablesFinishesThenStarts() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        let fx = t.focusChanged(to: El(id: 2), readText: read)
        XCTAssertEqual(fx, [.finished(El(id: 1), text: "one"), .observeValue(El(id: 2)), .started(El(id: 2), text: "two")])
        XCTAssertEqual(t.focused, El(id: 2))
    }

    func testFinishCarriesLastReportedTextNotCurrentValue() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        _ = t.valueChanged(El(id: 1), isSecure: false, readText: read)
        values[1] = "one more" // changed but never reported
        XCTAssertEqual(t.endSession(), [.finished(El(id: 1), text: "one")])
    }

    func testLeavingSchedulesFinishInsteadOfFinishing() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        XCTAssertEqual(t.focusChanged(to: nil, readText: read), [.scheduleFinish])
        XCTAssertTrue(t.finishPending)
        XCTAssertTrue(t.isEditing, "still editing until the debounce confirms")
    }

    func testRepeatedLeavesRescheduleTheDebounce() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        XCTAssertEqual(t.focusChanged(to: nil, readText: read), [.scheduleFinish])
        XCTAssertEqual(t.focusChanged(to: nil, readText: read), [.scheduleFinish])
    }

    func testBounceBackToSameElementCancelsFinish() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        _ = t.focusChanged(to: nil, readText: read)
        XCTAssertEqual(t.focusChanged(to: El(id: 1), readText: read), [.cancelFinish])
        XCTAssertFalse(t.finishPending)
        XCTAssertTrue(t.isEditing)
    }

    func testBounceToOtherEditableCancelsAndSwitches() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        _ = t.focusChanged(to: nil, readText: read)
        XCTAssertEqual(t.focusChanged(to: El(id: 2), readText: read),
                       [.cancelFinish, .finished(El(id: 1), text: "one"), .observeValue(El(id: 2)),
                        .started(El(id: 2), text: "two")])
    }

    func testDebounceConfirmsFinish() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        _ = t.focusChanged(to: nil, readText: read)
        XCTAssertEqual(t.finishDebounceElapsed(currentFocus: { nil }),
                       [.finished(El(id: 1), text: "one"), .stopObservingValue])
        XCTAssertFalse(t.isEditing)
        XCTAssertNil(t.focused)
        XCTAssertNil(t.lastText)
    }

    func testDebounceFindsSameElementStillFocused() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        _ = t.focusChanged(to: nil, readText: read)
        XCTAssertEqual(t.finishDebounceElapsed(currentFocus: { El(id: 1) }), [])
        XCTAssertTrue(t.isEditing)
        XCTAssertFalse(t.finishPending)
    }

    func testDebounceFindsDifferentEditableSilentlyRetargets() {
        // Same behaviour as before the refactor: the value observer moves, no STARTED.
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        _ = t.focusChanged(to: nil, readText: read)
        XCTAssertEqual(t.finishDebounceElapsed(currentFocus: { El(id: 3) }), [.observeValue(El(id: 3))])
        XCTAssertEqual(t.focused, El(id: 3))
        XCTAssertEqual(t.lastText, "one", "last reported text kept")
    }

    func testDebounceAfterCancelIsNoOp() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        _ = t.focusChanged(to: nil, readText: read)
        _ = t.focusChanged(to: El(id: 1), readText: read) // cancels
        var queried = false
        XCTAssertEqual(t.finishDebounceElapsed(currentFocus: { queried = true; return nil }), [])
        XCTAssertFalse(queried, "focus is not re-queried for a cancelled debounce")
        XCTAssertTrue(t.isEditing)
    }

    func testDebounceAfterEndSessionIsNoOp() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        _ = t.focusChanged(to: nil, readText: read)
        XCTAssertEqual(t.endSession(), [.cancelFinish, .finished(El(id: 1), text: "one")])
        XCTAssertEqual(t.finishDebounceElapsed(currentFocus: { nil }), [])
    }

    func testValueChangeEmitsOnlyRealChanges() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        XCTAssertEqual(t.valueChanged(El(id: 1), isSecure: false, readText: read), [], "same as STARTED value")
        values[1] = "one!"
        XCTAssertEqual(t.valueChanged(El(id: 1), isSecure: false, readText: read), [.updated(El(id: 1), text: "one!")])
        XCTAssertEqual(t.valueChanged(El(id: 1), isSecure: false, readText: read), [])
        values[1] = nil
        XCTAssertEqual(t.valueChanged(El(id: 1), isSecure: false, readText: read), [.updated(El(id: 1), text: nil)],
                       "value becoming unreadable is a change")
        values[1] = ""
        XCTAssertEqual(t.valueChanged(El(id: 1), isSecure: false, readText: read), [.updated(El(id: 1), text: "")],
                       "empty differs from nil")
    }

    func testValueChangeWhenIdleIsIgnoredWithoutReading() {
        var t = Tracker()
        XCTAssertEqual(t.valueChanged(El(id: 1), isSecure: false, readText: read), [])
        XCTAssertTrue(reads.isEmpty)
    }

    func testSecureValueChangeIsNeverRead() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        reads = []
        values[1] = "changed"
        XCTAssertEqual(t.valueChanged(El(id: 1), isSecure: true, readText: read), [])
        XCTAssertTrue(reads.isEmpty)
    }

    func testValueChangeDuringPendingFinishStillReports() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        _ = t.focusChanged(to: nil, readText: read)
        values[1] = "late"
        XCTAssertEqual(t.valueChanged(El(id: 1), isSecure: false, readText: read), [.updated(El(id: 1), text: "late")])
        XCTAssertEqual(t.finishDebounceElapsed(currentFocus: { nil }),
                       [.finished(El(id: 1), text: "late"), .stopObservingValue])
    }

    func testEndSessionWhenIdle() {
        var t = Tracker()
        XCTAssertEqual(t.endSession(), [])
    }

    func testEndSessionThenRestart() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        XCTAssertEqual(t.endSession(), [.finished(El(id: 1), text: "one")])
        XCTAssertEqual(t.endSession(), [], "only one FINISHED")
        XCTAssertEqual(t.focusChanged(to: El(id: 1), readText: read),
                       [.observeValue(El(id: 1)), .started(El(id: 1), text: "one")], "same element starts again")
    }

    func testResetIsSilent() {
        var t = Tracker()
        _ = t.focusChanged(to: El(id: 1), readText: read)
        _ = t.focusChanged(to: nil, readText: read)
        t.reset()
        XCTAssertFalse(t.isEditing)
        XCTAssertFalse(t.finishPending)
        XCTAssertEqual(t.endSession(), [])
    }

    func testStartedWithUnreadableValue() {
        var t = Tracker()
        XCTAssertEqual(t.focusChanged(to: El(id: 9), readText: read),
                       [.observeValue(El(id: 9)), .started(El(id: 9), text: nil)])
        XCTAssertEqual(t.valueChanged(El(id: 9), isSecure: false, readText: read), [])
    }

    func testEveryStartedIsBalancedByOneFinished() {
        // Random walk over focus / value / debounce / end events; STARTED and FINISHED must
        // strictly alternate.
        var rng = SplitMix64(seed: 0xA05)
        for _ in 0..<200 {
            var t = Tracker()
            var open = false
            for _ in 0..<40 {
                let fx: [Effect]
                switch Int.random(in: 0..<6, using: &rng) {
                case 0, 1: fx = t.focusChanged(to: El(id: Int.random(in: 1...3, using: &rng)), readText: read)
                case 2: fx = t.focusChanged(to: nil, readText: read)
                case 3: values[1] = String(Int.random(in: 0...3, using: &rng)); fx = t.valueChanged(El(id: 1), isSecure: false, readText: read)
                case 4: let stay = Bool.random(using: &rng); fx = t.finishDebounceElapsed(currentFocus: { stay ? El(id: 2) : nil })
                default: fx = t.endSession()
                }
                for e in fx {
                    switch e {
                    case .started: XCTAssertFalse(open); open = true
                    case .finished: XCTAssertTrue(open); open = false
                    case .updated: XCTAssertTrue(open)
                    default: break
                    }
                }
                XCTAssertEqual(open, t.isEditing)
            }
        }
    }
}

/// Deterministic generator so the random walk is reproducible.
private struct SplitMix64: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// Fake AX tree for `TextInputPolicy.resolveEditable`.
private final class Node {
    let role: String?
    let subrole: String?
    let parent: Node?
    init(_ role: String?, _ subrole: String? = nil, parent: Node? = nil) {
        self.role = role
        self.subrole = subrole
        self.parent = parent
    }
}

final class ResolveEditableTests: XCTestCase {
    private func resolve(_ n: Node, depth: Int = TextInputPolicy.maxAncestorDepth) -> Node? {
        TextInputPolicy.resolveEditable(from: n, maxDepth: depth, role: { $0.role }, subrole: { $0.subrole },
                                        parent: { $0.parent })
    }

    func testElementItself() {
        let f = Node("AXTextField")
        XCTAssertTrue(resolve(f) === f)
    }

    func testChildInsideTextArea() {
        let area = Node("AXTextArea", parent: Node("AXScrollArea", parent: Node("AXWindow")))
        let child = Node("AXStaticText", parent: Node("AXGroup", parent: area))
        XCTAssertTrue(resolve(child) === area)
    }

    func testPasswordFieldResolvesToNil() {
        let pw = Node("AXTextField", "AXSecureTextField")
        XCTAssertNil(resolve(pw))
        XCTAssertNil(resolve(Node("AXStaticText", parent: pw)), "child of a password field")
    }

    func testPasswordFieldInsideEditableAncestorStillNil() {
        // The nearest editable wins; an outer editable is never used for a password child.
        let outer = Node("AXTextArea")
        let pw = Node("AXTextField", "AXSecureTextField", parent: outer)
        XCTAssertNil(resolve(pw))
    }

    func testNoEditableAncestor() {
        XCTAssertNil(resolve(Node("AXButton", parent: Node("AXWindow", parent: Node("AXApplication")))))
        XCTAssertNil(resolve(Node(nil)))
    }

    func testDepthLimit() {
        var n = Node("AXTextField")
        let field = n
        for _ in 0..<7 { n = Node("AXGroup", parent: n) }
        XCTAssertTrue(resolve(n) === field, "8 levels including the start")
        n = Node("AXGroup", parent: n)
        XCTAssertNil(resolve(n), "9th level is too far")
        XCTAssertNil(resolve(field, depth: 0))
        XCTAssertTrue(resolve(field, depth: 1) === field)
    }

    func testSearchFieldAndComboBox() {
        XCTAssertNotNil(resolve(Node("AXTextField", "AXSearchField")))
        XCTAssertNotNil(resolve(Node("AXComboBox")))
        XCTAssertNil(resolve(Node("AXStaticText", "AXSecureTextField")), "secure subrole on a non-editable role is just non-editable")
    }

    func testRolesAreCaseSensitive() {
        XCTAssertNil(resolve(Node("axtextfield")))
        XCTAssertFalse(TextInputPolicy.isTrackable(role: "AXTextFieldX", subrole: nil))
    }
}

final class TextInputWireTests: XCTestCase {
    private func parse(_ line: String?) throws -> [String: Any] {
        let line = try XCTUnwrap(line)
        XCTAssertFalse(line.contains("\n"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
    }

    func testMonitorEventLines() throws {
        XCTAssertEqual(try parse(TextInputMonitorEvent.ready(accessibilityTrusted: true).wireLine) as NSDictionary,
                       ["type": "ready", "accessibilityTrusted": true] as NSDictionary)
        XCTAssertEqual(try parse(TextInputMonitorEvent.permissionChanged(accessibilityTrusted: false).wireLine) as NSDictionary,
                       ["type": "permission", "accessibilityTrusted": false] as NSDictionary)
        let e = TextInputEvent(status: .finished, text: "t", sourceElement: nil, caretScreenPosition: nil, timestamp: 5)
        let obj = try parse(TextInputMonitorEvent.textInput(e).wireLine)
        XCTAssertEqual(obj["status"] as? String, "TEXT_EDITING_FINISHED")
        XCTAssertNil(obj["type"], "text-input lines have no type field")
        XCTAssertEqual(Set(obj.keys), ["status", "text", "timestamp"])
    }

    func testStatusRawValues() {
        XCTAssertEqual(TextInputStatus.allCases.map(\.rawValue),
                       ["TEXT_EDITING_STARTED", "TEXT_EDITING_UPDATED", "TEXT_EDITING_FINISHED"])
    }

    func testRoundTripAndAccessors() throws {
        let e = TextInputEvent(
            status: .updated, text: "q\"uote\\",
            sourceElement: .init(type: "AXTextField", application: "A", applicationID: "com.example.a",
                                 applicationLocalizedName: "A", screenBounds: .init(CGRect(x: -10, y: 5, width: 1, height: 2)),
                                 content: nil),
            caretScreenPosition: .init(CGPoint(x: 1.5, y: 2.5)), timestamp: 2_000)
        let data = try XCTUnwrap(TextInputMonitorEvent.textInput(e).wireLine?.data(using: .utf8))
        XCTAssertEqual(try JSONDecoder().decode(TextInputEvent.self, from: data), e)
        XCTAssertEqual(e.sourceElement?.screenBounds?.cgRect, CGRect(x: -10, y: 5, width: 1, height: 2))
        XCTAssertEqual(e.caretScreenPosition?.cgPoint, CGPoint(x: 1.5, y: 2.5))
        XCTAssertEqual(e.date.timeIntervalSince1970, 2, accuracy: 1e-9)
    }

    func testOptionsDefaults() {
        let o = TextInputMonitor.Options()
        XCTAssertEqual(o.finishDebounce, 0.2)
        XCTAssertEqual(o.axMessagingTimeout, 0.5)
        XCTAssertEqual(o.permissionCheckInterval, 2)
        XCTAssertEqual(TextInputMonitor.Problem.accessibilityDenied.rawValue, "accessibility_denied")
    }
}
