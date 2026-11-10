import CoreGraphics
import XCTest
@testable import ScreenshotMonitorKit

final class RectHeuristicTrackerTests: XCTestCase {
    private var tracker: RectHeuristicTracker!
    private var emitted: [CGRect] = []

    override func setUp() {
        tracker = RectHeuristicTracker()
        emitted = []
        tracker.onRectChanged = { [unowned self] in self.emitted.append($0) }
    }

    private func drag(from a: CGPoint, to b: CGPoint) -> CGFloat {
        tracker.handleMouseDown(at: a)
        tracker.handleMouseDragged(to: CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2))
        tracker.handleMouseDragged(to: b)
        return tracker.handleMouseUp(at: b)
    }

    func testCreateNormalizesAnyDirection() {
        let travelled = drag(from: CGPoint(x: 300, y: 200), to: CGPoint(x: 100, y: 50))
        XCTAssertEqual(tracker.getCurrentRect(), CGRect(x: 100, y: 50, width: 200, height: 150))
        XCTAssertEqual(travelled, 250, accuracy: 0.001)
        XCTAssertEqual(emitted.last, tracker.getCurrentRect())
    }

    func testRoundsToWholePointsAndDeduplicates() {
        tracker.handleMouseDown(at: CGPoint(x: 0.4, y: 0.4))
        tracker.handleMouseDragged(to: CGPoint(x: 10.6, y: 10.6))
        tracker.handleMouseDragged(to: CGPoint(x: 10.7, y: 10.7)) // rounds to the same rect
        tracker.handleMouseUp(at: CGPoint(x: 10.7, y: 10.7))
        XCTAssertEqual(tracker.getCurrentRect(), CGRect(x: 0, y: 0, width: 10, height: 10))
        XCTAssertEqual(emitted.count, 1)
    }

    func testMoveInsideRect() {
        _ = drag(from: CGPoint(x: 100, y: 100), to: CGPoint(x: 200, y: 200))
        _ = drag(from: CGPoint(x: 150, y: 150), to: CGPoint(x: 170, y: 140))
        XCTAssertEqual(tracker.getCurrentRect(), CGRect(x: 120, y: 90, width: 100, height: 100))
    }

    func testResizeByCornerAndEdge() {
        _ = drag(from: CGPoint(x: 100, y: 100), to: CGPoint(x: 200, y: 200))
        _ = drag(from: CGPoint(x: 200, y: 200), to: CGPoint(x: 260, y: 230)) // bottom-right corner
        XCTAssertEqual(tracker.getCurrentRect(), CGRect(x: 100, y: 100, width: 160, height: 130))
        _ = drag(from: CGPoint(x: 100, y: 150), to: CGPoint(x: 80, y: 150)) // left edge
        XCTAssertEqual(tracker.getCurrentRect(), CGRect(x: 80, y: 100, width: 180, height: 130))
    }

    func testResizePastOppositeEdgeFlips() {
        _ = drag(from: CGPoint(x: 100, y: 100), to: CGPoint(x: 200, y: 200))
        _ = drag(from: CGPoint(x: 100, y: 150), to: CGPoint(x: 250, y: 150)) // left edge past right
        XCTAssertEqual(tracker.getCurrentRect(), CGRect(x: 200, y: 100, width: 50, height: 100))
    }

    func testClickOutsideDoesNotClobberSelection() {
        _ = drag(from: CGPoint(x: 100, y: 100), to: CGPoint(x: 200, y: 200))
        let before = tracker.getCurrentRect()
        let count = emitted.count
        tracker.handleMouseDown(at: CGPoint(x: 600, y: 600))   // e.g. the Cmd+Shift+5 Capture button
        let travelled = tracker.handleMouseUp(at: CGPoint(x: 600, y: 600))
        XCTAssertEqual(travelled, 0)
        XCTAssertEqual(tracker.getCurrentRect(), before)
        XCTAssertEqual(emitted.count, count)
    }

    func testZeroAreaStrokeIsIgnored() {
        _ = drag(from: CGPoint(x: 10, y: 10), to: CGPoint(x: 90, y: 10))
        XCTAssertNil(tracker.getCurrentRect())
        XCTAssertTrue(emitted.isEmpty)
    }

    func testIsDraggingAndReset() {
        XCTAssertFalse(tracker.isDragging)
        tracker.handleMouseDown(at: .zero)
        XCTAssertTrue(tracker.isDragging)
        tracker.handleMouseUp(at: .zero)
        XCTAssertFalse(tracker.isDragging)
        _ = drag(from: .zero, to: CGPoint(x: 5, y: 5))
        tracker.reset()
        XCTAssertNil(tracker.getCurrentRect())
    }
}

final class RectHeuristicTrackerEdgeTests: XCTestCase {
    private var tracker: RectHeuristicTracker!
    private var emitted: [CGRect] = []

    override func setUp() {
        tracker = RectHeuristicTracker()
        emitted = []
        tracker.onRectChanged = { [unowned self] in self.emitted.append($0) }
    }

    private func drag(_ a: CGPoint, _ b: CGPoint) {
        tracker.handleMouseDown(at: a)
        tracker.handleMouseDragged(to: b)
        tracker.handleMouseUp(at: b)
    }

    func testDragWithoutMouseDownIsIgnored() {
        tracker.handleMouseDragged(to: CGPoint(x: 50, y: 50))
        XCTAssertEqual(tracker.handleMouseUp(at: CGPoint(x: 60, y: 60)), 0)
        XCTAssertNil(tracker.getCurrentRect())
        XCTAssertTrue(emitted.isEmpty)
    }

    func testNegativeCoordinatesOnSecondaryDisplay() {
        drag(CGPoint(x: -100, y: -50), CGPoint(x: -400, y: -250))
        XCTAssertEqual(tracker.getCurrentRect(), CGRect(x: -400, y: -250, width: 300, height: 200))
        drag(CGPoint(x: -250, y: -150), CGPoint(x: -260, y: -170))   // move inside
        XCTAssertEqual(tracker.getCurrentRect(), CGRect(x: -410, y: -270, width: 300, height: 200))
    }

    func testRectSpanningTwoDisplays() {
        drag(CGPoint(x: -100, y: 10), CGPoint(x: 100, y: 110))
        XCTAssertEqual(tracker.getCurrentRect(), CGRect(x: -100, y: 10, width: 200, height: 100))
    }

    func testAllEightHandles() {
        let base = CGRect(x: 100, y: 100, width: 100, height: 100)
        let cases: [(CGPoint, CGPoint, CGRect)] = [
            (CGPoint(x: 100, y: 100), CGPoint(x: 90, y: 80), CGRect(x: 90, y: 80, width: 110, height: 120)),   // topLeft
            (CGPoint(x: 200, y: 100), CGPoint(x: 210, y: 80), CGRect(x: 100, y: 80, width: 110, height: 120)), // topRight
            (CGPoint(x: 100, y: 200), CGPoint(x: 90, y: 220), CGRect(x: 90, y: 100, width: 110, height: 120)), // bottomLeft
            (CGPoint(x: 200, y: 200), CGPoint(x: 210, y: 220), CGRect(x: 100, y: 100, width: 110, height: 120)), // bottomRight
            (CGPoint(x: 100, y: 150), CGPoint(x: 70, y: 999), CGRect(x: 70, y: 100, width: 130, height: 100)), // left
            (CGPoint(x: 200, y: 150), CGPoint(x: 230, y: 999), CGRect(x: 100, y: 100, width: 130, height: 100)), // right
            (CGPoint(x: 150, y: 100), CGPoint(x: 999, y: 60), CGRect(x: 100, y: 60, width: 100, height: 140)), // top
            (CGPoint(x: 150, y: 200), CGPoint(x: 999, y: 240), CGRect(x: 100, y: 100, width: 100, height: 140)), // bottom
        ]
        for (down, to, expected) in cases {
            tracker.reset()
            drag(base.origin, CGPoint(x: base.maxX, y: base.maxY))
            drag(down, to)
            XCTAssertEqual(tracker.getCurrentRect(), expected, "handle at \(down)")
        }
    }

    func testClickJustOutsideSlopStartsNewSelection() {
        drag(CGPoint(x: 100, y: 100), CGPoint(x: 200, y: 200))
        drag(CGPoint(x: 300, y: 300), CGPoint(x: 350, y: 340))
        XCTAssertEqual(tracker.getCurrentRect(), CGRect(x: 300, y: 300, width: 50, height: 40))
    }

    func testRepeatedMouseDownWithoutUpRestartsGesture() {
        tracker.handleMouseDown(at: CGPoint(x: 0, y: 0))
        tracker.handleMouseDragged(to: CGPoint(x: 500, y: 500))
        tracker.handleMouseDown(at: CGPoint(x: 1000, y: 1000))  // missed mouse-up
        tracker.handleMouseDragged(to: CGPoint(x: 1010, y: 1010))
        let travelled = tracker.handleMouseUp(at: CGPoint(x: 1010, y: 1010))
        XCTAssertEqual(travelled, hypot(10, 10), accuracy: 0.001, "travel is measured from the latest press")
    }

    func testResetDuringDragDropsGesture() {
        tracker.handleMouseDown(at: .zero)
        tracker.handleMouseDragged(to: CGPoint(x: 50, y: 50))
        tracker.reset()
        XCTAssertFalse(tracker.isDragging)
        tracker.handleMouseDragged(to: CGPoint(x: 80, y: 80))
        XCTAssertNil(tracker.getCurrentRect())
    }

    func testTravelIsMaxDistanceNotEndpointDistance() {
        tracker.handleMouseDown(at: .zero)
        tracker.handleMouseDragged(to: CGPoint(x: 30, y: 40))
        XCTAssertEqual(tracker.handleMouseUp(at: .zero), 50, accuracy: 0.001)
    }

    func testFractionalCoordinatesRoundToWholePoints() {
        drag(CGPoint(x: -10.4, y: 5.5), CGPoint(x: 20.6, y: 30.49))
        let r = tracker.getCurrentRect()!
        XCTAssertEqual(r.origin.x, r.origin.x.rounded())
        XCTAssertEqual(r.width, r.width.rounded())
    }
}
