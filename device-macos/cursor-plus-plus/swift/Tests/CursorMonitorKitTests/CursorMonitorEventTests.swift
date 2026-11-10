import CoreGraphics
import Foundation
import XCTest
@testable import CursorMonitorKit

/// Drives `CursorMonitor.handleEvent` with synthetic CGEvents (created, never posted) and an
/// injected clock. Enrichment is off, so no window list / accessibility API is touched and no
/// event tap is installed.
final class CursorMonitorEventTests: XCTestCase {
    private var now: TimeInterval = 1000
    private var events: [CursorEvent] = []
    private var contexts: [CursorContext?] = []

    private func makeMonitor(throttle: TimeInterval = 0.05, holdMs: Double = 400,
                             tolerance: Double = 5) -> CursorMonitor {
        var options = CursorMonitor.Options()
        options.moveThrottle = throttle
        options.holdThresholdMs = holdMs
        options.holdMoveTolerance = tolerance
        options.enrichInteractions = false
        let m = CursorMonitor(options: options)
        m.clock = { [unowned self] in self.now }
        m.onEvent = { [unowned self] e, ctx in self.events.append(e); self.contexts.append(ctx) }
        addTeardownBlock { m.stop() }
        return m
    }

    override func setUp() {
        now = 1000
        events = []
        contexts = []
    }

    private func mouse(_ type: CGEventType, _ x: CGFloat, _ y: CGFloat, clicks: Int64? = nil,
                       button: CGMouseButton = .left) throws -> CGEvent {
        let e = try XCTUnwrap(CGEvent(mouseEventSource: nil, mouseType: type,
                                      mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button))
        if let clicks = clicks { e.setIntegerValueField(.mouseEventClickState, value: clicks) }
        return e
    }

    private func send(_ m: CursorMonitor, _ type: CGEventType, _ x: CGFloat, _ y: CGFloat,
                      clicks: Int64? = nil, button: CGMouseButton = .left) throws {
        m.handleEvent(type, try mouse(type, x, y, clicks: clicks, button: button))
    }

    private var actions: [String] { events.compactMap { $0.action } }

    func testNotRunningUntilStarted() {
        let m = makeMonitor()
        XCTAssertFalse(m.isRunning)
        m.stop()  // stop without start is a no-op
        m.stop()
        XCTAssertFalse(m.isRunning)
    }

    func testMoveIsThrottledByInjectedClock() throws {
        let m = makeMonitor(throttle: 0.05)
        try send(m, .mouseMoved, 1, 1)
        now += 0.01; try send(m, .mouseMoved, 2, 2)
        now += 0.05; try send(m, .mouseMoved, 3, 3)
        XCTAssertEqual(actions, ["MOVE", "MOVE"])
        XCTAssertEqual(events.last?.x, 3)
        XCTAssertNil(events.last?.button, "MOVE carries only coordinates")
        XCTAssertTrue(contexts.allSatisfy { $0 == nil })
    }

    func testMoveSurvivesClockGoingBackwards() throws {
        // Regression: with wall-clock time, setting the clock back suppressed MOVE until the
        // clock caught up with the last emitted timestamp.
        let m = makeMonitor(throttle: 0.05)
        try send(m, .mouseMoved, 1, 1)
        now -= 3600
        try send(m, .mouseMoved, 2, 2)
        now += 0.01
        try send(m, .mouseMoved, 3, 3)   // throttled relative to the new baseline
        now += 0.06
        try send(m, .mouseMoved, 4, 4)
        XCTAssertEqual(events.map { $0.x }, [1, 2, 4])
    }

    func testSingleAndDoubleClick() throws {
        let m = makeMonitor()
        try send(m, .leftMouseDown, 10, 20, clicks: 1)
        try send(m, .leftMouseUp, 10, 20, clicks: 1)
        now += 0.1
        try send(m, .leftMouseDown, 10, 20, clicks: 2)
        try send(m, .leftMouseUp, 10, 20, clicks: 2)
        now += 0.1
        try send(m, .leftMouseDown, 10, 20, clicks: 3)   // triple click is still a DOUBLE_CLICK action
        XCTAssertEqual(actions, ["CLICK", "DOUBLE_CLICK", "DOUBLE_CLICK"])
        XCTAssertEqual(events.map { $0.clickCount }, [1, 2, 3])
        XCTAssertEqual(events.map { $0.button }, [0, 0, 0])
        XCTAssertEqual(events[0].x, 10)
        XCTAssertEqual(events[0].y, 20)
    }

    func testRightAndMiddleButtons() throws {
        let m = makeMonitor()
        try send(m, .rightMouseDown, 5, 5, clicks: 1, button: .right)
        try send(m, .rightMouseUp, 5, 5, clicks: 1, button: .right)
        try send(m, .otherMouseDown, 6, 6, clicks: 1, button: .center)
        try send(m, .otherMouseUp, 6, 6, clicks: 1, button: .center)
        XCTAssertEqual(actions, ["RIGHT_CLICK", "CLICK"])
        XCTAssertEqual(events.map { $0.button }, [2, 1])
    }

    func testNegativeMultiDisplayCoordinatesPassThrough() throws {
        // A display left of / above the main display has negative global coordinates.
        let m = makeMonitor()
        try send(m, .leftMouseDown, -1440.5, -900, clicks: 1)
        XCTAssertEqual(events.first?.x, -1440.5)
        XCTAssertEqual(events.first?.y, -900)
    }

    func testScrollDeltas() throws {
        let m = makeMonitor()
        let e = try XCTUnwrap(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                      wheel1: 0, wheel2: 0, wheel3: 0))
        e.location = CGPoint(x: 50, y: 60)
        e.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: -7)
        e.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: 3)
        m.handleEvent(.scrollWheel, e)
        let s = try XCTUnwrap(events.first)
        XCTAssertEqual(s.action, "SCROLL")
        XCTAssertEqual(s.scrollDeltaY, -7)
        XCTAssertEqual(s.scrollDeltaX, 3)
        XCTAssertEqual(s.x, 50)
        XCTAssertNil(s.button)
    }

    func testDragThrottledSeparatelyFromMove() throws {
        let m = makeMonitor(throttle: 0.05)
        try send(m, .mouseMoved, 0, 0)                 // MOVE at t0
        try send(m, .leftMouseDown, 0, 0, clicks: 1)   // CLICK
        now += 0.001
        try send(m, .leftMouseDragged, 50, 0)          // first DRAG passes despite recent MOVE
        now += 0.01
        try send(m, .leftMouseDragged, 60, 0)          // throttled
        now += 0.05
        try send(m, .rightMouseDragged, 70, 0, button: .right)
        XCTAssertEqual(actions, ["MOVE", "CLICK", "DRAG", "DRAG"])
        XCTAssertEqual(events[2].button, 0)
        XCTAssertEqual(events[3].button, 2)
    }

    func testLongPressViaDragEventsEmitsHoldStartAtDownPointThenHoldEnd() throws {
        let m = makeMonitor(throttle: 0, holdMs: 400, tolerance: 5)
        try send(m, .leftMouseDown, 100, 100, clicks: 1)
        now += 0.2
        try send(m, .leftMouseDragged, 102, 101)       // within tolerance, too early
        now += 0.3
        try send(m, .leftMouseDragged, 103, 100)       // 500 ms: HOLD_START
        now += 0.5
        try send(m, .leftMouseUp, 103, 100, clicks: 1)
        XCTAssertEqual(actions, ["CLICK", "DRAG", "HOLD_START", "DRAG", "HOLD_END"])
        let start = try XCTUnwrap(events.first { $0.action == "HOLD_START" })
        XCTAssertEqual(start.x, 100, "HOLD_START is reported where the press began")
        XCTAssertEqual(start.holdDurationMs ?? 0, 500, accuracy: 0.001)
        let end = try XCTUnwrap(events.last)
        XCTAssertEqual(end.holdDurationMs ?? 0, 1000, accuracy: 0.001)
        XCTAssertEqual(end.x, 103)
    }

    func testSelectionDragIsNotAHold() throws {
        let m = makeMonitor(throttle: 0, holdMs: 400, tolerance: 5)
        try send(m, .leftMouseDown, 0, 0, clicks: 1)
        now += 0.1; try send(m, .leftMouseDragged, 40, 0)
        now += 1.0; try send(m, .leftMouseDragged, 41, 0)
        now += 0.1; try send(m, .leftMouseUp, 41, 0, clicks: 1)
        XCTAssertFalse(actions.contains("HOLD_START"))
        XCTAssertFalse(actions.contains("HOLD_END"))
    }

    func testRightDragNeverStartsAHold() throws {
        let m = makeMonitor(throttle: 0, holdMs: 100)
        try send(m, .rightMouseDown, 0, 0, clicks: 1, button: .right)
        now += 1
        try send(m, .rightMouseDragged, 1, 0, button: .right)
        try send(m, .rightMouseUp, 1, 0, clicks: 1, button: .right)
        XCTAssertEqual(actions, ["RIGHT_CLICK", "DRAG"])
    }

    func testMouseUpWithoutDownIsIgnored() throws {
        let m = makeMonitor()
        try send(m, .leftMouseUp, 0, 0, clicks: 1)
        XCTAssertTrue(events.isEmpty)
    }

    func testStillPressTimerFiresHoldStartUsingInjectedClock() throws {
        let m = makeMonitor(holdMs: 20)
        try send(m, .leftMouseDown, 7, 8, clicks: 1)
        now += 0.75
        let fired = expectation(description: "HOLD_START")
        m.onEvent = { [unowned self] e, _ in
            self.events.append(e)
            if e.action == "HOLD_START" { fired.fulfill() }
        }
        wait(for: [fired], timeout: 2)
        let start = try XCTUnwrap(events.last)
        XCTAssertEqual(start.holdDurationMs ?? 0, 750, accuracy: 0.001)
        XCTAssertEqual(start.x, 7)
        XCTAssertEqual(start.y, 8)
    }

    func testStopCancelsPendingHoldTimer() throws {
        let m = makeMonitor(holdMs: 20)
        try send(m, .leftMouseDown, 0, 0, clicks: 1)
        now += 1
        m.stop()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(actions, ["CLICK"])
        // A release after stop no longer reports HOLD_END (the press state was reset).
        try send(m, .leftMouseUp, 0, 0, clicks: 1)
        XCTAssertEqual(actions, ["CLICK"])
    }

    func testReleaseBeforeTimerSuppressesHoldStart() throws {
        let m = makeMonitor(holdMs: 20)
        try send(m, .leftMouseDown, 0, 0, clicks: 1)
        now += 0.005
        try send(m, .leftMouseUp, 0, 0, clicks: 1)
        now += 1
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(actions, ["CLICK"])
    }

    func testUnhandledEventTypesAreIgnored() throws {
        let m = makeMonitor()
        m.handleEvent(.keyDown, try mouse(.mouseMoved, 0, 0))
        m.handleEvent(.null, try mouse(.mouseMoved, 0, 0))
        XCTAssertTrue(events.isEmpty)
    }

    func testNoCallbackAssignedDoesNotCrash() throws {
        let m = makeMonitor()
        m.onEvent = nil
        try send(m, .leftMouseDown, 0, 0, clicks: 1)
        try send(m, .mouseMoved, 0, 0)
    }
}
