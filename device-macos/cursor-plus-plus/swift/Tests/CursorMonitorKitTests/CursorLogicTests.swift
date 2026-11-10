import CoreGraphics
import Foundation
import XCTest
@testable import CursorMonitorKit

final class EventThrottleTests: XCTestCase {
    func testThrottleInterval() {
        var t = EventThrottle(interval: 0.05)
        XCTAssertTrue(t.shouldEmit(at: 10.000))   // first event always passes
        XCTAssertFalse(t.shouldEmit(at: 10.020))
        XCTAssertFalse(t.shouldEmit(at: 10.049))
        XCTAssertTrue(t.shouldEmit(at: 10.050))
        XCTAssertFalse(t.shouldEmit(at: 10.060))  // measured from the last emitted event
        XCTAssertTrue(t.shouldEmit(at: 10.200))
    }

    func testZeroIntervalPassesEverything() {
        var t = EventThrottle(interval: 0)
        for i in 0..<10 { XCTAssertTrue(t.shouldEmit(at: 1 + Double(i) * 0.0001)) }
    }
}

final class HoldTrackerTests: XCTestCase {
    private func tracker() -> HoldTracker { HoldTracker(thresholdMs: 400, tolerance: 5) }

    func testStillPressFiresStartFromTimerThenEnd() throws {
        var h = tracker()
        h.mouseDown(at: CGPoint(x: 100, y: 100), time: 0)
        XCTAssertNil(h.update(at: nil, time: 0.2))                      // too early
        let started = try XCTUnwrap(h.update(at: nil, time: 0.45))
        XCTAssertEqual(started, 450, accuracy: 0.001)
        XCTAssertNil(h.update(at: nil, time: 0.5))                      // only once
        let ended = try XCTUnwrap(h.mouseUp(at: CGPoint(x: 101, y: 100), time: 1.0))
        XCTAssertEqual(ended, 1000, accuracy: 0.001)
        XCTAssertFalse(h.isPressed)
    }

    func testHoldEndFiresEvenWhenStartWasEmitted() {
        // Regression: HOLD_END used to be suppressed whenever HOLD_START had fired.
        var h = tracker()
        h.mouseDown(at: .zero, time: 0)
        XCTAssertNotNil(h.update(at: CGPoint(x: 1, y: 1), time: 0.5))
        XCTAssertNotNil(h.mouseUp(at: CGPoint(x: 1, y: 1), time: 0.8))
    }

    func testDragBeyondToleranceIsNotAHold() {
        // Regression: a long text-selection drag used to report HOLD_END.
        var h = tracker()
        h.mouseDown(at: .zero, time: 0)
        XCTAssertNil(h.update(at: CGPoint(x: 50, y: 0), time: 0.1))
        XCTAssertNil(h.update(at: CGPoint(x: 0, y: 0), time: 0.5))      // came back, still not a hold
        XCTAssertNil(h.update(at: nil, time: 0.6))
        XCTAssertNil(h.mouseUp(at: .zero, time: 1.2))
    }

    func testMovementAfterHoldStartedStillEndsHold() {
        var h = tracker()
        h.mouseDown(at: .zero, time: 0)
        XCTAssertNotNil(h.update(at: nil, time: 0.5))
        XCTAssertNil(h.update(at: CGPoint(x: 300, y: 0), time: 0.6))     // e.g. drag after long-press
        XCTAssertNotNil(h.mouseUp(at: CGPoint(x: 300, y: 0), time: 0.9))
    }

    func testQuickClickIsNotAHold() {
        var h = tracker()
        h.mouseDown(at: .zero, time: 0)
        XCTAssertNil(h.mouseUp(at: .zero, time: 0.1))
    }

    func testHoldWithoutTimerTickStillEnds() {
        // Timer never ran (busy main thread): release after the threshold still reports HOLD_END.
        var h = tracker()
        h.mouseDown(at: .zero, time: 0)
        let ended = h.mouseUp(at: CGPoint(x: 2, y: 2), time: 0.6)
        XCTAssertEqual(ended ?? 0, 600, accuracy: 0.001)
    }

    func testUpdateWithoutPressIsIgnored() {
        var h = tracker()
        XCTAssertNil(h.update(at: nil, time: 5))
        XCTAssertNil(h.mouseUp(at: .zero, time: 5))
    }
}

final class CursorEventEncodingTests: XCTestCase {
    private func json(_ event: CursorEvent) throws -> [String: Any] {
        let data = try JSONEncoder().encode(event)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testReadyIsMinimal() throws {
        let obj = try json(CursorEvent(type: "ready"))
        XCTAssertEqual(obj.count, 1)
        XCTAssertEqual(obj["type"] as? String, "ready")
    }

    func testInteractionShapeOmitsNils() throws {
        var e = CursorEvent(type: "cursor-event")
        e.action = "DOUBLE_CLICK"
        e.x = 10.5
        e.y = 20
        e.button = 0
        e.clickCount = 2
        e.windowId = 42
        e.bundleId = "com.apple.finder"
        e.uiElementRole = "AXTextField"
        e.uiElementIsEditableText = true
        let obj = try json(e)
        XCTAssertEqual(obj["type"] as? String, "cursor-event")
        XCTAssertEqual(obj["action"] as? String, "DOUBLE_CLICK")
        XCTAssertEqual(obj["x"] as? Double, 10.5)
        XCTAssertEqual(obj["clickCount"] as? Int, 2)
        XCTAssertEqual(obj["windowId"] as? Int, 42)
        XCTAssertEqual(obj["bundleId"] as? String, "com.apple.finder")
        XCTAssertEqual(obj["uiElementIsEditableText"] as? Bool, true)
        XCTAssertNil(obj["uiElementValue"])
        XCTAssertNil(obj["scrollDeltaX"])
        XCTAssertNil(obj["code"])
        XCTAssertEqual(Set(obj.keys), ["type", "action", "x", "y", "button", "clickCount", "windowId",
                                       "bundleId", "uiElementRole", "uiElementIsEditableText"])
    }

    func testErrorShape() throws {
        var e = CursorEvent(type: "error")
        e.code = "event_tap_disabled"
        e.message = "m"
        let obj = try json(e)
        XCTAssertEqual(Set(obj.keys), ["type", "code", "message"])
    }

    func testRoundTrip() throws {
        var e = CursorEvent(type: "cursor-event")
        e.action = "SCROLL"
        e.scrollDeltaY = -3
        let decoded = try JSONDecoder().decode(CursorEvent.self, from: JSONEncoder().encode(e))
        XCTAssertEqual(decoded.action, "SCROLL")
        XCTAssertEqual(decoded.scrollDeltaY, -3)
    }
}
