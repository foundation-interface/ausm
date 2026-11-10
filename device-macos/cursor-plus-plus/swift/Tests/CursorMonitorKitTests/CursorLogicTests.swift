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

final class EventThrottleEdgeTests: XCTestCase {
    func testBackwardsClockPassesAndRestartsInterval() {
        // Regression: a timestamp before the last emitted one (clock set back) used to be
        // suppressed until time caught up again.
        var t = EventThrottle(interval: 0.05)
        XCTAssertTrue(t.shouldEmit(at: 100))
        XCTAssertTrue(t.shouldEmit(at: 50))
        XCTAssertFalse(t.shouldEmit(at: 50.01))
        XCTAssertTrue(t.shouldEmit(at: 50.06))
    }

    func testNegativeIntervalPassesEverything() {
        var t = EventThrottle(interval: -1)
        XCTAssertTrue(t.shouldEmit(at: 1))
        XCTAssertTrue(t.shouldEmit(at: 1))
    }

    func testDuplicateTimestampIsThrottled() {
        var t = EventThrottle(interval: 0.05)
        XCTAssertTrue(t.shouldEmit(at: 3))
        XCTAssertFalse(t.shouldEmit(at: 3))
    }

    func testIntervalChangeTakesEffect() {
        var t = EventThrottle(interval: 1)
        XCTAssertTrue(t.shouldEmit(at: 0))
        XCTAssertFalse(t.shouldEmit(at: 0.5))
        t.interval = 0
        XCTAssertTrue(t.shouldEmit(at: 0.5))
    }
}

final class HoldTrackerEdgeTests: XCTestCase {
    func testToleranceBoundaryIsInclusive() {
        var h = HoldTracker(thresholdMs: 400, tolerance: 5)
        h.mouseDown(at: .zero, time: 0)
        XCTAssertNotNil(h.update(at: CGPoint(x: 3, y: 4), time: 0.4))   // distance exactly 5
    }

    func testJustBeyondToleranceIsNotAHold() {
        var h = HoldTracker(thresholdMs: 400, tolerance: 5)
        h.mouseDown(at: .zero, time: 0)
        XCTAssertNil(h.update(at: CGPoint(x: 3, y: 4.01), time: 0.4))
        XCTAssertNil(h.mouseUp(at: .zero, time: 1))
    }

    func testThresholdBoundaryIsInclusive() {
        var h = HoldTracker(thresholdMs: 400, tolerance: 5)
        h.mouseDown(at: .zero, time: 10)
        XCTAssertEqual(h.update(at: nil, time: 10.4) ?? 0, 400, accuracy: 0.001)
    }

    func testNegativeCoordinatesOnSecondaryDisplay() {
        var h = HoldTracker(thresholdMs: 100, tolerance: 5)
        h.mouseDown(at: CGPoint(x: -1920, y: -200), time: 0)
        XCTAssertNotNil(h.update(at: CGPoint(x: -1918, y: -201), time: 0.2))
        XCTAssertEqual(h.downPoint, CGPoint(x: -1920, y: -200))
    }

    func testNewPressResetsPreviousState() {
        var h = HoldTracker(thresholdMs: 100, tolerance: 5)
        h.mouseDown(at: .zero, time: 0)
        XCTAssertNil(h.update(at: CGPoint(x: 100, y: 0), time: 0.05))   // wandered: drag
        // A second mouseDown without an up (missed event) starts a fresh press.
        h.mouseDown(at: CGPoint(x: 100, y: 0), time: 1)
        XCTAssertFalse(h.holdStarted)
        XCTAssertNotNil(h.update(at: nil, time: 1.2))
    }

    func testClockGoingBackwardsNeverStartsAHold() {
        var h = HoldTracker(thresholdMs: 100, tolerance: 5)
        h.mouseDown(at: .zero, time: 10)
        XCTAssertNil(h.update(at: nil, time: 5))
        XCTAssertNil(h.mouseUp(at: .zero, time: 5))
    }

    func testZeroThresholdHoldsImmediately() {
        var h = HoldTracker(thresholdMs: 0, tolerance: 0)
        h.mouseDown(at: .zero, time: 0)
        XCTAssertEqual(h.update(at: nil, time: 0), 0)
    }

    func testResetMidPressDropsHold() {
        var h = HoldTracker(thresholdMs: 100, tolerance: 5)
        h.mouseDown(at: .zero, time: 0)
        XCTAssertNotNil(h.update(at: nil, time: 0.2))
        h.reset()
        XCTAssertFalse(h.isPressed)
        XCTAssertNil(h.mouseUp(at: .zero, time: 0.5))
    }
}

final class CursorEventEncodingEdgeTests: XCTestCase {
    func testUnicodeEmojiAndRTLStringsRoundTrip() throws {
        var e = CursorEvent(type: "cursor-event")
        e.action = "CLICK"
        e.windowTitle = "שלום עולם — مرحبا 👩🏽‍💻 \u{202E}txet\u{202C}"
        e.uiElementLabel = "\"quoted\"\n\ttab\\slash\u{0000}nul"
        e.ownerName = "日本語アプリ"
        e.uiElementValue = ""
        let data = try JSONEncoder().encode(e)
        // One line on the wire: newlines inside strings must be escaped.
        XCTAssertFalse(data.contains(UInt8(ascii: "\n")))
        let decoded = try JSONDecoder().decode(CursorEvent.self, from: data)
        XCTAssertEqual(decoded.windowTitle, e.windowTitle)
        XCTAssertEqual(decoded.uiElementLabel, e.uiElementLabel)
        XCTAssertEqual(decoded.ownerName, e.ownerName)
        XCTAssertEqual(decoded.uiElementValue, "", "empty strings are kept, not dropped as nil")
    }

    func testExtremeNumericValues() throws {
        var e = CursorEvent(type: "cursor-event")
        e.windowId = UInt32.max
        e.x = -32768.25
        e.y = 1e6
        e.clickCount = Int.max
        e.holdDurationMs = 0
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(e)) as? [String: Any])
        XCTAssertEqual((obj["windowId"] as? NSNumber)?.uint32Value, UInt32.max)
        XCTAssertEqual(obj["x"] as? Double, -32768.25)
        XCTAssertEqual(obj["holdDurationMs"] as? Double, 0)
    }

    func testDecodingIgnoresUnknownFieldsAndRequiresType() throws {
        let json = #"{"type":"cursor-event","action":"MOVE","x":1,"y":2,"futureField":{"a":1}}"#
        let e = try JSONDecoder().decode(CursorEvent.self, from: Data(json.utf8))
        XCTAssertEqual(e.action, "MOVE")
        XCTAssertThrowsError(try JSONDecoder().decode(CursorEvent.self, from: Data(#"{"action":"MOVE"}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(CursorEvent.self, from: Data(#"{"type":"x","x":"1"}"#.utf8)))
    }

    func testNonFiniteValuesFailToEncodeRatherThanEmittingInvalidJSON() {
        var e = CursorEvent(type: "cursor-event")
        e.scrollDeltaY = .nan
        XCTAssertThrowsError(try JSONEncoder().encode(e))
    }
}
