import CoreGraphics
import XCTest
@testable import ViewportHelper

private func snap(_ id: CGWindowID, pid: pid_t = 100, title: String = "Doc",
                  bounds: CGRect = CGRect(x: 0, y: 0, width: 800, height: 600),
                  z: Int = 0, display: CGDirectDisplayID = 1, doc: String? = nil) -> WindowSnapshot {
    WindowSnapshot(windowId: id, title: title, ownerName: "App", bundleId: "com.example.app",
                   ownerPID: pid, bounds: bounds, layer: 0, zIndex: z, displayId: display, documentPath: doc)
}

private func map(_ snaps: [WindowSnapshot]) -> [String: WindowSnapshot] {
    Dictionary(uniqueKeysWithValues: snaps.map { ($0.key, $0) })
}

final class WindowDiffTests: XCTestCase {
    func testOpenAndClose() {
        let a = snap(1), b = snap(2, z: 1)
        let events = WindowDiff.diff(old: map([a]), new: map([b]))
        XCTAssertEqual(events.map(\.type), ["window-closed", "window-opened"], "closes are emitted before opens")
        XCTAssertEqual(events[0].windowId, 1)
        XCTAssertEqual(events[1].windowId, 2)
    }

    func testNoChangesProducesNoEvents() {
        let s = map([snap(1), snap(2, z: 1)])
        XCTAssertTrue(WindowDiff.diff(old: s, new: s).isEmpty)
    }

    func testTitleChangeCarriesOldTitle() {
        let events = WindowDiff.diff(old: map([snap(1, title: "A")]), new: map([snap(1, title: "B")]))
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].type, "title-changed")
        XCTAssertEqual(events[0].title, "B")
        XCTAssertEqual(events[0].oldTitle, "A")
    }

    func testSingleBoundsChangeCarriesOldBounds() {
        let old = snap(1, bounds: CGRect(x: 0, y: 0, width: 800, height: 600))
        let new = snap(1, bounds: CGRect(x: 10, y: 20, width: 800, height: 600))
        let events = WindowDiff.diff(old: map([old]), new: map([new]))
        XCTAssertEqual(events.map(\.type), ["bounds-changed"])
        XCTAssertEqual(events[0].oldBounds?.x, 0)
        XCTAssertEqual(events[0].bounds.x, 10)
    }

    func testMultiWindowBoundsFlurryIsDropped() {
        let old = map([snap(1), snap(2, z: 1)])
        let moved = CGRect(x: 50, y: 0, width: 800, height: 600)
        let new = map([snap(1, title: "Renamed", bounds: moved), snap(2, bounds: moved, z: 1)])
        let events = WindowDiff.diff(old: old, new: new)
        XCTAssertEqual(events.map(\.type), ["title-changed"], "bounds noise dropped, other changes kept")
    }

    func testSameWindowIdDifferentPidIsDistinct() {
        let events = WindowDiff.diff(old: map([snap(7, pid: 1)]), new: map([snap(7, pid: 2)]))
        XCTAssertEqual(events.map(\.type), ["window-closed", "window-opened"])
    }
}

final class DisplayAssignmentTests: XCTestCase {
    let displays: [(id: CGDirectDisplayID, bounds: CGRect)] = [
        (1, CGRect(x: 0, y: 0, width: 1440, height: 900)),
        (2, CGRect(x: 1440, y: -200, width: 2560, height: 1440)),  // external, offset vertically
    ]

    func testLargestOverlapWins() {
        // Mostly on display 2 even though its origin is on display 1.
        let rect = CGRect(x: 1400, y: 0, width: 1000, height: 600)
        XCTAssertEqual(WindowDiff.primaryDisplay(for: rect, displays: displays, fallback: 1), 2)
        let rect2 = CGRect(x: 0, y: 0, width: 1400, height: 800)
        XCTAssertEqual(WindowDiff.primaryDisplay(for: rect2, displays: displays, fallback: 2), 1)
    }

    func testOffscreenFallsBackToNearest() {
        let rect = CGRect(x: 5000, y: 0, width: 100, height: 100)
        XCTAssertEqual(WindowDiff.primaryDisplay(for: rect, displays: displays, fallback: 1), 2)
        XCTAssertEqual(WindowDiff.primaryDisplay(for: rect, displays: [], fallback: 9), 9)
    }
}

final class MatchingTests: XCTestCase {
    func testApproximateBounds() {
        XCTAssertTrue(WindowDiff.approximatelyEqual(CGRect(x: 0, y: 0, width: 100, height: 100),
                                                    CGRect(x: 1, y: 0.5, width: 101, height: 100)))
        XCTAssertFalse(WindowDiff.approximatelyEqual(CGRect(x: 0, y: 0, width: 100, height: 100),
                                                     CGRect(x: 5, y: 0, width: 100, height: 100)))
    }

    func testTitles() {
        XCTAssertTrue(WindowDiff.titlesMatch(cgTitle: "Doc", axTitle: "Doc"))
        XCTAssertTrue(WindowDiff.titlesMatch(cgTitle: "Doc", axTitle: "Doc — Edited"))
        XCTAssertFalse(WindowDiff.titlesMatch(cgTitle: "", axTitle: "Anything"), "empty title must not prefix-match")
        XCTAssertTrue(WindowDiff.titlesMatch(cgTitle: "", axTitle: nil))
    }

    func testShouldTrack() {
        let big = CGRect(x: 0, y: 100, width: 800, height: 600)
        XCTAssertTrue(WindowDiff.shouldTrack(title: "Doc", bounds: big))
        XCTAssertFalse(WindowDiff.shouldTrack(title: "", bounds: big))
        XCTAssertFalse(WindowDiff.shouldTrack(title: "Doc", bounds: CGRect(x: 0, y: 0, width: 50, height: 600)))
    }
}

final class WireFormatTests: XCTestCase {
    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("\n"), "must be a single line")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testWindowEventShape() throws {
        var evt = snap(42, pid: 7, title: "T", bounds: CGRect(x: 1, y: 2, width: 300, height: 400),
                       display: 5, doc: "file:///tmp/a.txt").toEvent(type: "window-focused")
        var obj = try json(evt)
        XCTAssertEqual(Set(obj.keys), ["type", "windowId", "title", "ownerName", "bundleId", "pid",
                                       "bounds", "displayId", "documentPath"])
        XCTAssertEqual(obj["type"] as? String, "window-focused")
        XCTAssertEqual(obj["windowId"] as? Int, 42)
        XCTAssertEqual(obj["pid"] as? Int, 7)
        XCTAssertEqual(obj["displayId"] as? Int, 5)
        let bounds = try XCTUnwrap(obj["bounds"] as? [String: Double])
        XCTAssertEqual(bounds, ["x": 1, "y": 2, "width": 300, "height": 400])

        evt.documentPath = nil
        evt.oldTitle = "Old"
        obj = try json(evt)
        XCTAssertNil(obj["documentPath"], "nil optionals are omitted")
        XCTAssertEqual(obj["oldTitle"] as? String, "Old")
    }

    func testReadyAndPermissionShape() throws {
        let ready = try json(ReadyEvent(accessibilityTrusted: true, screenRecordingGranted: false))
        XCTAssertEqual(ready["type"] as? String, "ready")
        XCTAssertEqual(ready["accessibilityTrusted"] as? Bool, true)
        XCTAssertEqual(ready["screenRecordingGranted"] as? Bool, false)
        XCTAssertNotNil(ready["bounds"], "ready keeps window-event fields for older readers")

        let perm = try json(PermissionEvent(accessibilityTrusted: false, screenRecordingGranted: true))
        XCTAssertEqual(perm["type"] as? String, "permission")
        XCTAssertEqual(perm["accessibilityTrusted"] as? Bool, false)

        let space = try json(SpaceChangeEvent(type: "space-changed", timestamp: 1234.5))
        XCTAssertEqual(Set(space.keys), ["type", "timestamp"])
    }
}
