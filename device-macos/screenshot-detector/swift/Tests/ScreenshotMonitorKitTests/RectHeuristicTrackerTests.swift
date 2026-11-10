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
