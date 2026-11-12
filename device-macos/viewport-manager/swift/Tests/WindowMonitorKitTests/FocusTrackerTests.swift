import CoreGraphics
import XCTest
@testable import WindowMonitorKit

private func types(_ events: [WindowEvent]) -> [String] {
    events.map { "\($0.type.rawValue):\($0.windowId)" }
}

final class FocusTrackerTests: XCTestCase {
    // App A (pid 100) has windows 1 (front) and 2; app B (pid 200) has window 3.
    let w1 = snap(1, pid: 100, z: 0)
    let w2 = snap(2, pid: 100, z: 2)
    let w3 = snap(3, pid: 200, z: 1)

    func testFirstTickFocusesFrontmostWindowOfFrontmostApp() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        let r = t.tick(previous: [:], current: map([w1, w2, w3]), frontmostPID: 100)
        XCTAssertEqual(types(r.events), ["window-opened:1", "window-opened:3", "window-opened:2", "window-focused:1"])
        XCTAssertEqual(r.subscribePID, 100, "AX observer attached after the first focus")
        XCTAssertEqual(t.activeAppState, .subscribed)
        XCTAssertEqual(t.focusedWindowId, 1)
    }

    func testSteadyStateProducesNothing() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        let s = map([w1, w2, w3])
        _ = t.tick(previous: [:], current: s, frontmostPID: 100)
        for _ in 0..<3 {
            let r = t.tick(previous: s, current: s, frontmostPID: 100)
            XCTAssertTrue(r.events.isEmpty)
            XCTAssertNil(r.subscribePID, "subscribe only once")
        }
    }

    func testAppWithoutWindowsWaitsThenFocusesWhenWindowAppears() {
        var t = FocusTracker()
        t.begin(frontmostPID: 300) // launching app, no windows yet
        let s = map([w1])
        var r = t.tick(previous: [:], current: s, frontmostPID: 300)
        XCTAssertEqual(types(r.events), ["window-opened:1"])
        XCTAssertEqual(t.activeAppState, .pendingDiff)
        XCTAssertNil(r.subscribePID)
        let w9 = snap(9, pid: 300, z: 0)
        r = t.tick(previous: s, current: map([w9, snap(1, pid: 100, z: 1)]), frontmostPID: 300)
        XCTAssertEqual(types(r.events), ["window-opened:9", "window-focused:9"])
        XCTAssertEqual(r.subscribePID, 300)
    }

    func testPollDetectsAppSwitchOverTwoSteps() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        let s = map([w1, w2, w3])
        _ = t.tick(previous: [:], current: s, frontmostPID: 100)
        // B becomes frontmost; same window set.
        let r = t.tick(previous: s, current: s, frontmostPID: 200)
        XCTAssertEqual(types(r.events), ["window-unfocused:1", "window-focused:3"])
        XCTAssertEqual(r.subscribePID, 200)
        XCTAssertEqual(t.activeAppPID, 200)
    }

    func testWindowSwitchWithinSameApp() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        let s = map([w1, w2])
        _ = t.tick(previous: [:], current: s, frontmostPID: 100)
        // Window 2 raised above 1 (z-order swap, bounds equal so no bounds events).
        let swapped = map([snap(1, pid: 100, z: 1), snap(2, pid: 100, z: 0)])
        let r = t.tick(previous: s, current: swapped, frontmostPID: 100)
        XCTAssertEqual(types(r.events), ["window-unfocused:1", "window-focused:2"])
        XCTAssertNil(r.subscribePID)
    }

    func testClosingFocusedWindowUnfocusesBeforeCloseThenFocusesNext() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        let s = map([w1, w2])
        _ = t.tick(previous: [:], current: s, frontmostPID: 100)
        let r = t.tick(previous: s, current: map([w2]), frontmostPID: 100)
        XCTAssertEqual(types(r.events), ["window-unfocused:1", "window-closed:1", "window-focused:2"])
        XCTAssertEqual(t.focusedWindowId, 2)
    }

    func testClosingLastWindowLeavesNothingFocused() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        let s = map([w1])
        _ = t.tick(previous: [:], current: s, frontmostPID: 100)
        let r = t.tick(previous: s, current: [:], frontmostPID: 100)
        XCTAssertEqual(types(r.events), ["window-unfocused:1", "window-closed:1"])
        XCTAssertFalse(t.hasFocusedWindow)
        // App keeps running with no windows: nothing more.
        XCTAssertTrue(t.tick(previous: [:], current: [:], frontmostPID: 100).events.isEmpty)
    }

    func testClosingUnfocusedWindowDoesNotUnfocus() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        let s = map([w1, w2])
        _ = t.tick(previous: [:], current: s, frontmostPID: 100)
        let r = t.tick(previous: s, current: map([w1]), frontmostPID: 100)
        XCTAssertEqual(types(r.events), ["window-closed:2"])
        XCTAssertEqual(t.focusedWindowId, 1)
    }

    func testNoFrontmostAppKeepsState() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        let s = map([w1])
        _ = t.tick(previous: [:], current: s, frontmostPID: 100)
        let r = t.tick(previous: s, current: s, frontmostPID: nil)
        XCTAssertTrue(r.events.isEmpty)
        XCTAssertEqual(t.focusedWindowId, 1)
    }

    func testBeginWithoutFrontmostApp() {
        var t = FocusTracker()
        t.begin(frontmostPID: nil)
        XCTAssertFalse(t.hasActiveApp)
        let r = t.tick(previous: [:], current: map([w1]), frontmostPID: nil)
        XCTAssertEqual(types(r.events), ["window-opened:1"])
        XCTAssertNil(r.subscribePID)
    }

    func testBeginResetsPreviousState() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        _ = t.tick(previous: [:], current: map([w1]), frontmostPID: 100)
        t.begin(frontmostPID: 200)
        XCTAssertFalse(t.hasFocusedWindow)
        XCTAssertEqual(t.activeAppPID, 200)
        XCTAssertEqual(t.activeAppState, .pendingDiff)
    }

    func testWorkspaceActivationFocusesImmediatelyFromLastSnapshot() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        let s = map([w1, w3])
        _ = t.tick(previous: [:], current: s, frontmostPID: 100)
        let events = t.appActivated(pid: 200, windows: s)
        XCTAssertEqual(types(events), ["window-unfocused:1", "window-focused:3"])
        XCTAssertEqual(t.activeAppState, .subscribed, "caller already attached AX")
        // The following tick sees the same frontmost app and window: nothing new.
        XCTAssertTrue(t.tick(previous: s, current: s, frontmostPID: 200).events.isEmpty)
    }

    func testWorkspaceActivationOfLaunchingAppStaysPending() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        let s = map([w1])
        _ = t.tick(previous: [:], current: s, frontmostPID: 100)
        XCTAssertTrue(t.appActivated(pid: 400, windows: s).isEmpty)
        XCTAssertEqual(t.activeAppState, .pendingDiff)
        let w = snap(40, pid: 400, z: 0)
        let next = map([w, snap(1, pid: 100, z: 1)])
        let r = t.tick(previous: s, current: next, frontmostPID: 400)
        XCTAssertEqual(types(r.events), ["window-opened:40", "window-unfocused:1", "window-focused:40"])
        XCTAssertEqual(r.subscribePID, 400)
    }

    func testDeactivateAndTerminateOnlyAffectActiveApp() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        t.appDeactivated(pid: 999)
        XCTAssertTrue(t.hasActiveApp)
        t.appTerminated(pid: 999)
        XCTAssertTrue(t.hasActiveApp)
        t.appDeactivated(pid: 100)
        XCTAssertFalse(t.hasActiveApp)
        t.begin(frontmostPID: 100)
        t.appTerminated(pid: 100)
        XCTAssertFalse(t.hasActiveApp)
    }

    func testAfterDeactivationPollReactivatesSameApp() {
        var t = FocusTracker()
        t.begin(frontmostPID: 100)
        let s = map([w1])
        _ = t.tick(previous: [:], current: s, frontmostPID: 100)
        t.appDeactivated(pid: 100)
        // Frontmost is still 100 (e.g. deactivation raced with re-activation): treated as a new
        // activation; focus does not change so nothing is emitted, but AX is re-subscribed.
        let r = t.tick(previous: s, current: s, frontmostPID: 100)
        XCTAssertTrue(r.events.isEmpty)
        XCTAssertEqual(r.subscribePID, 100)
    }

    func testDiffFocusTable() {
        var t = FocusTracker()
        let s = map([w1, w2])
        XCTAssertTrue(t.diffFocus(focusedWindow: nil, current: s, previous: s).isEmpty, "none → none")
        XCTAssertEqual(types(t.diffFocus(focusedWindow: w1, current: s, previous: s)), ["window-focused:1"])
        XCTAssertTrue(t.diffFocus(focusedWindow: w1, current: s, previous: s).isEmpty, "same window")
        XCTAssertEqual(types(t.diffFocus(focusedWindow: w2, current: s, previous: s)),
                       ["window-unfocused:1", "window-focused:2"])
        XCTAssertEqual(types(t.diffFocus(focusedWindow: nil, current: s, previous: s)), ["window-unfocused:2"])
        XCTAssertFalse(t.hasFocusedWindow)
    }

    func testUnfocusUsesPreviousSnapshotWhenWindowIsGone() {
        var t = FocusTracker()
        _ = t.diffFocus(focusedWindow: w1, current: map([w1]), previous: [:])
        let events = t.diffFocus(focusedWindow: w2, current: map([w2]), previous: map([w1]))
        XCTAssertEqual(types(events), ["window-unfocused:1", "window-focused:2"])
    }

    func testUnfocusOmittedWhenWindowUnknownEverywhere() {
        var t = FocusTracker()
        _ = t.diffFocus(focusedWindow: w1, current: map([w1]), previous: [:])
        let events = t.diffFocus(focusedWindow: w2, current: map([w2]), previous: map([w2]))
        XCTAssertEqual(types(events), ["window-focused:2"])
    }

    func testAXFocusUsesPreviousSnapshotWithoutRescan() {
        var t = FocusTracker()
        let s = map([w1, w2])
        _ = t.diffFocus(focusedWindow: w1, current: s, previous: s)
        var rescans = 0
        let ax = AccessibilityWindowInfo(windowRect: w2.bounds, appPID: 100, windowTitle: "Doc")
        // w1 and w2 share bounds and title: tie broken by z-order → w1 (already focused).
        XCTAssertTrue(t.axFocusChanged(ax, previous: s, rescan: { rescans += 1; return [:] }).isEmpty)
        XCTAssertEqual(rescans, 0)
    }

    func testAXFocusRescansWhenNoMatch() {
        var t = FocusTracker()
        let s = map([w1])
        _ = t.diffFocus(focusedWindow: w1, current: s, previous: s)
        let newWin = snap(5, pid: 100, title: "New", bounds: CGRect(x: 300, y: 300, width: 400, height: 400), z: 0)
        let ax = AccessibilityWindowInfo(windowRect: newWin.bounds, appPID: 100, windowTitle: "New")
        var rescans = 0
        let events = t.axFocusChanged(ax, previous: s, rescan: { rescans += 1; return map([newWin, w1]) })
        XCTAssertEqual(rescans, 1)
        XCTAssertEqual(types(events), ["window-unfocused:1", "window-focused:5"])
    }

    func testAXFocusWithNoMatchAnywhereIsIgnored() {
        var t = FocusTracker()
        let ax = AccessibilityWindowInfo(windowRect: CGRect(x: 1, y: 1, width: 500, height: 500), appPID: 777, windowTitle: nil)
        XCTAssertTrue(t.axFocusChanged(ax, previous: map([w1]), rescan: { map([w1]) }).isEmpty)
        XCTAssertFalse(t.hasFocusedWindow)
    }
}

final class WindowMatchingTests: XCTestCase {
    func testFrontmostWindowOfPid() {
        let s = map([snap(1, pid: 1, z: 3), snap(2, pid: 1, z: 1), snap(3, pid: 2, z: 0)])
        XCTAssertEqual(WindowDiff.frontmostWindow(of: 1, in: s)?.windowId, 2)
        XCTAssertEqual(WindowDiff.frontmostWindow(of: 2, in: s)?.windowId, 3)
        XCTAssertNil(WindowDiff.frontmostWindow(of: 9, in: s))
        XCTAssertNil(WindowDiff.frontmostWindow(of: 1, in: [:]))
    }

    func testFindWindowByBoundsThenTitle() {
        let r = CGRect(x: 10, y: 10, width: 500, height: 400)
        let a = snap(1, pid: 1, title: "Alpha", bounds: r, z: 1)
        let b = snap(2, pid: 1, title: "Beta", bounds: r, z: 0)
        let c = snap(3, pid: 2, title: "Alpha", bounds: r, z: 2)
        let s = map([a, b, c])
        func find(_ pid: pid_t, _ rect: CGRect, _ title: String?) -> CGWindowID? {
            WindowDiff.findWindow(matching: .init(windowRect: rect, appPID: pid, windowTitle: title), in: s)?.windowId
        }
        XCTAssertEqual(find(1, r, "Alpha"), 1, "title disambiguates")
        XCTAssertEqual(find(1, r, "Alpha — Edited"), 1, "AX title may extend the CG title")
        XCTAssertEqual(find(1, r, "Gamma"), 2, "no title match: frontmost of the bounds matches")
        XCTAssertEqual(find(1, r.offsetBy(dx: 1.5, dy: -1.5), "Beta"), 2, "within rounding tolerance")
        XCTAssertNil(find(1, r.offsetBy(dx: 3, dy: 0), "Beta"), "outside tolerance")
        XCTAssertEqual(find(2, r, nil), 3, "single match ignores title")
        XCTAssertNil(find(3, r, "Alpha"), "other pid")
    }

    func testApproximatelyEqualBoundaries() {
        let a = CGRect(x: 0, y: 0, width: 100, height: 100)
        XCTAssertTrue(WindowDiff.approximatelyEqual(a, a))
        XCTAssertFalse(WindowDiff.approximatelyEqual(a, a.offsetBy(dx: 2, dy: 0)), "tolerance is exclusive")
        XCTAssertTrue(WindowDiff.approximatelyEqual(a, CGRect(x: -1.9, y: 1.9, width: 101.9, height: 98.1)))
        XCTAssertFalse(WindowDiff.approximatelyEqual(a, CGRect(x: 0, y: 0, width: 100, height: 103)))
        XCTAssertTrue(WindowDiff.approximatelyEqual(a, a.offsetBy(dx: 4, dy: 0), tolerance: 5))
    }

    func testTitlesMatchMore() {
        XCTAssertFalse(WindowDiff.titlesMatch(cgTitle: "Doc", axTitle: nil))
        XCTAssertFalse(WindowDiff.titlesMatch(cgTitle: "Doc", axTitle: "Do"))
        XCTAssertFalse(WindowDiff.titlesMatch(cgTitle: "Doc", axTitle: "A Doc"))
        XCTAssertTrue(WindowDiff.titlesMatch(cgTitle: "", axTitle: ""))
    }

    func testShouldTrackEdgeCases() {
        XCTAssertFalse(WindowDiff.shouldTrack(title: "T", bounds: CGRect(x: 0, y: 0, width: 100, height: 600)), "exactly 100 is too small")
        XCTAssertTrue(WindowDiff.shouldTrack(title: "T", bounds: CGRect(x: 0, y: 0, width: 101, height: 101)))
        XCTAssertFalse(WindowDiff.shouldTrack(title: "T", bounds: CGRect(x: 0, y: 0, width: 600, height: 100)))
        // "Item-0" status items: the size guard (> 100 pt) already drops anything the Item-0 rule
        // (< 80 pt) would, so a 101 pt Item-0 at the top edge is tracked.
        XCTAssertTrue(WindowDiff.shouldTrack(title: "Item-0", bounds: CGRect(x: 0, y: 0, width: 200, height: 101)))
        XCTAssertFalse(WindowDiff.shouldTrack(title: "Item-0", bounds: CGRect(x: 0, y: 0, width: 24, height: 24)))
        XCTAssertTrue(WindowDiff.shouldTrack(title: "Item-0", bounds: CGRect(x: 0, y: 500, width: 200, height: 200)))
        XCTAssertTrue(WindowDiff.shouldTrack(title: "Item-0", bounds: CGRect(x: 0, y: 0, width: 800, height: 600)),
                      "large Item-0 windows are real windows")
    }
}

final class WindowDiffMoreTests: XCTestCase {
    func testEmptyToEmpty() {
        XCTAssertTrue(WindowDiff.diff(old: [:], new: [:]).isEmpty)
    }

    func testOpensAreOrderedFrontToBack() {
        let events = WindowDiff.diff(old: [:], new: map([snap(1, z: 2), snap(2, z: 0), snap(3, z: 1)]))
        XCTAssertEqual(events.map(\.windowId), [2, 3, 1])
    }

    func testClosesComeFirstAndAreOrderedByOldZ() {
        let old = map([snap(1, z: 1), snap(2, z: 0), snap(3, z: 2)])
        let events = WindowDiff.diff(old: old, new: map([snap(4, z: 0)]))
        XCTAssertEqual(events.map(\.type), [.closed, .closed, .closed, .opened])
        XCTAssertEqual(events.map(\.windowId), [2, 1, 3, 4])
    }

    func testTitleAndBoundsChangeOnSameWindowGiveBothEvents() {
        let old = snap(1, title: "A", bounds: CGRect(x: 0, y: 0, width: 800, height: 600))
        let new = snap(1, title: "B", bounds: CGRect(x: 0, y: 0, width: 900, height: 600))
        let events = WindowDiff.diff(old: map([old]), new: map([new]))
        XCTAssertEqual(events.map(\.type), [.titleChanged, .boundsChanged])
        XCTAssertEqual(events[1].oldBounds?.width, 800)
        XCTAssertNil(events[0].oldBounds)
        XCTAssertNil(events[1].oldTitle)
    }

    func testOneBoundsChangeAmongStaticWindowsIsKept() {
        let old = map([snap(1), snap(2, z: 1), snap(3, z: 2)])
        let new = map([snap(1), snap(2, bounds: CGRect(x: 5, y: 5, width: 800, height: 600), z: 1), snap(3, z: 2)])
        XCTAssertEqual(WindowDiff.diff(old: old, new: new).map(\.windowId), [2])
    }

    func testZOrderOnlyChangeIsSilent() {
        let old = map([snap(1, z: 0), snap(2, z: 1)])
        let new = map([snap(1, z: 1), snap(2, z: 0)])
        XCTAssertTrue(WindowDiff.diff(old: old, new: new).isEmpty)
    }

    func testDocumentPathAndDisplayChangeAloneAreSilent() {
        XCTAssertTrue(WindowDiff.diff(old: map([snap(1, display: 1, doc: nil)]),
                                      new: map([snap(1, display: 2, doc: "file:///x")])).isEmpty)
    }

    func testEventsCarryNewSnapshotFields() {
        let old = snap(1, title: "A", display: 1)
        let new = snap(1, title: "B", display: 2, doc: "file:///x")
        let e = WindowDiff.diff(old: map([old]), new: map([new]))[0]
        XCTAssertEqual(e.displayId, 2)
        XCTAssertEqual(e.documentPath, "file:///x")
    }

    func testPrimaryDisplayTieAndTouchingEdges() {
        let displays: [(id: CGDirectDisplayID, bounds: CGRect)] = [
            (1, CGRect(x: 0, y: 0, width: 1000, height: 1000)),
            (2, CGRect(x: 1000, y: 0, width: 1000, height: 1000)),
        ]
        // Exactly split: first display wins the tie.
        XCTAssertEqual(WindowDiff.primaryDisplay(for: CGRect(x: 500, y: 0, width: 1000, height: 500), displays: displays, fallback: 9), 1)
        // Touching an edge (zero-area intersection) does not count.
        XCTAssertEqual(WindowDiff.primaryDisplay(for: CGRect(x: 1000, y: 0, width: 200, height: 200), displays: displays, fallback: 9), 2)
        // Above all displays: nearest by centre.
        XCTAssertEqual(WindowDiff.primaryDisplay(for: CGRect(x: 1500, y: -900, width: 200, height: 200), displays: displays, fallback: 9), 2)
        XCTAssertEqual(WindowDiff.primaryDisplay(for: CGRect(x: -900, y: 100, width: 200, height: 200), displays: displays, fallback: 9), 1)
    }
}

final class DocumentPathCacheTests: XCTestCase {
    func testLookupStates() {
        var c = DocumentPathCache()
        let k = DocumentPathCache.Key(windowId: 1, pid: 2, title: "T")
        XCTAssertNil(c.lookup(k), "never looked up")
        c.record(k, path: nil)
        XCTAssertEqual(c.lookup(k), .some(nil), "looked up, no document")
        c.record(k, path: "file:///a")
        XCTAssertEqual(c.lookup(k), .some("file:///a"))
    }

    func testTitleIsPartOfKey() {
        var c = DocumentPathCache()
        c.record(.init(windowId: 1, pid: 2, title: "A"), path: "file:///a")
        XCTAssertNil(c.lookup(.init(windowId: 1, pid: 2, title: "B")))
        XCTAssertNil(c.lookup(.init(windowId: 1, pid: 3, title: "A")))
    }

    func testPrune() {
        var c = DocumentPathCache()
        let keep = DocumentPathCache.Key(windowId: 1, pid: 1, title: "A")
        let drop = DocumentPathCache.Key(windowId: 2, pid: 1, title: "B")
        c.record(keep, path: nil)
        c.record(drop, path: "file:///b")
        c.prune(keeping: [keep])
        XCTAssertEqual(c.entries.count, 1)
        XCTAssertNotNil(c.lookup(keep))
        XCTAssertNil(c.lookup(drop))
        c.prune(keeping: [])
        XCTAssertTrue(c.entries.isEmpty)
    }
}

final class WindowMonitorEventWireTests: XCTestCase {
    private func parse(_ line: String?) throws -> [String: Any] {
        let line = try XCTUnwrap(line)
        XCTAssertFalse(line.contains("\n"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
    }

    func testReadyLine() throws {
        let obj = try parse(WindowMonitorEvent.ready(.init(accessibilityTrusted: true, screenRecordingGranted: false)).wireLine)
        XCTAssertEqual(obj["type"] as? String, "ready")
        XCTAssertEqual(obj["accessibilityTrusted"] as? Bool, true)
        XCTAssertEqual(obj["screenRecordingGranted"] as? Bool, false)
        XCTAssertEqual(Set(obj.keys), ["type", "windowId", "title", "ownerName", "bundleId", "pid", "bounds",
                                       "displayId", "accessibilityTrusted", "screenRecordingGranted"])
    }

    func testPermissionLine() throws {
        let obj = try parse(WindowMonitorEvent.permissionsChanged(.init(accessibilityTrusted: false, screenRecordingGranted: true)).wireLine)
        XCTAssertEqual(Set(obj.keys), ["type", "accessibilityTrusted", "screenRecordingGranted"])
        XCTAssertEqual(obj["type"] as? String, "permission")
    }

    func testSpaceLineIsMilliseconds() throws {
        let obj = try parse(WindowMonitorEvent.spaceChanged(Date(timeIntervalSince1970: 1_700_000_000.25)).wireLine)
        XCTAssertEqual(obj["type"] as? String, "space-changed")
        XCTAssertEqual(obj["timestamp"] as? Double ?? 0, 1_700_000_000_250, accuracy: 0.01)
    }

    func testWindowLineEveryType() throws {
        for type in WindowEventType.allCases {
            let obj = try parse(WindowMonitorEvent.window(snap(1).toEvent(type: type)).wireLine)
            XCTAssertEqual(obj["type"] as? String, type.rawValue)
        }
        XCTAssertEqual(Set(WindowEventType.allCases.map(\.rawValue)),
                       ["window-opened", "window-closed", "window-focused", "window-unfocused",
                        "bounds-changed", "title-changed"], "the set the Node wrapper accepts")
    }

    func testOldBoundsEncoding() throws {
        var e = snap(1).toEvent(type: .boundsChanged)
        e.oldBounds = .init(CGRect(x: 1, y: 2, width: 3, height: 4))
        let obj = try parse(WindowMonitorEvent.window(e).wireLine)
        XCTAssertEqual(obj["oldBounds"] as? [String: Double], ["x": 1, "y": 2, "width": 3, "height": 4])
        XCTAssertEqual(e.oldBounds?.cgRect, CGRect(x: 1, y: 2, width: 3, height: 4))
    }

    func testRoundTripDecode() throws {
        let e = snap(7, title: "T", doc: "file:///d").toEvent(type: .opened)
        let data = try XCTUnwrap(WindowMonitorEvent.window(e).wireLine?.data(using: .utf8))
        XCTAssertEqual(try JSONDecoder().decode(WindowEvent.self, from: data), e)
    }

    func testProblemsForPermissions() {
        XCTAssertEqual(WindowMonitor.problems(for: .init(accessibilityTrusted: true, screenRecordingGranted: true)), [])
        XCTAssertEqual(WindowMonitor.problems(for: .init(accessibilityTrusted: false, screenRecordingGranted: true)), [.accessibilityDenied])
        XCTAssertEqual(WindowMonitor.problems(for: .init(accessibilityTrusted: false, screenRecordingGranted: false)),
                       [.accessibilityDenied, .screenRecordingDenied])
        XCTAssertEqual(WindowMonitor.Problem.screenRecordingDenied.rawValue, "screen_recording_denied")
    }

    func testOptionsDefaults() {
        let o = WindowMonitor.Options()
        XCTAssertEqual(o.pollInterval, 0.016)
        XCTAssertEqual(o.axMessagingTimeout, 0.25)
        XCTAssertFalse(o.excludeOwnProcess)
        XCTAssertTrue(o.blockedBundleIdentifiers.contains("com.apple.dock"))
        XCTAssertEqual(o.blockedBundleIdentifiers.count, 6)
    }
}
