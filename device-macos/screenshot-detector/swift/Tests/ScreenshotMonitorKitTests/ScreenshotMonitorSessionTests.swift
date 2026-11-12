import CoreGraphics
import Foundation
import XCTest
@testable import ScreenshotMonitorKit

/// Fake system for `ScreenshotMonitor`: a scripted process table, two displays (the secondary
/// one left of and above the main display, as in a typical multi-monitor desk), windows and a
/// capture backend that records requests. Nothing here scans real processes, reads the window
/// list or calls ScreenCaptureKit.
final class FakeScreenshotSystem {
    struct Display { let id: CGDirectDisplayID; let bounds: CGRect; let scale: CGFloat }

    private let lock = NSLock()
    private var _scan = ScreenshotProcessScan()
    var argv: [pid_t: [String]] = [:]
    var displays: [Display] = [
        Display(id: 1, bounds: CGRect(x: 0, y: 0, width: 1512, height: 982), scale: 2),
        Display(id: 2, bounds: CGRect(x: -1920, y: -300, width: 1920, height: 1080), scale: 1),
    ]
    var mouse = CGPoint(x: 100, y: 100)
    var permission = true
    var windows: [(id: CGWindowID, bounds: CGRect)] = []
    var toolbar: CGRect?
    var style: String?
    /// When false, capture completions are parked in `pending` until the test releases them.
    var autoComplete = true
    var captureError: String?
    var returnsImage = true
    private(set) var displayRequests: [(CGDirectDisplayID, CGRect?)] = []
    private(set) var windowRequests: [CGWindowID] = []
    private var pending: [() -> Void] = []

    var scan: ScreenshotProcessScan {
        get { lock.lock(); defer { lock.unlock() }; return _scan }
        set { lock.lock(); _scan = newValue; lock.unlock() }
    }

    func setProcesses(screencapture: Set<pid_t> = [], ui: Set<pid_t> = []) {
        scan = ScreenshotProcessScan(screencapture: screencapture, screencaptureui: ui)
    }

    var requestCount: Int { lock.lock(); defer { lock.unlock() }; return displayRequests.count + windowRequests.count }

    func releasePending() {
        lock.lock(); let p = pending; pending = []; lock.unlock()
        p.forEach { $0() }
    }

    static func image(width: Int, height: Int) -> CGImage {
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)!
        ctx.setFillColor(CGColor(red: 0, green: 0.5, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()!
    }

    private func display(at p: CGPoint) -> Display {
        displays.first { $0.bounds.contains(p) } ?? displays[0]
    }

    private func complete(_ completion: @escaping (CGImage?, String?) -> Void, width: Int, height: Int) {
        let img = returnsImage ? Self.image(width: max(width, 1), height: max(height, 1)) : nil
        let err = captureError
        let run = { completion(img, err) }
        lock.lock()
        if autoComplete { lock.unlock(); run() } else { pending.append(run); lock.unlock() }
    }

    var environment: ScreenshotMonitor.Environment {
        var env = ScreenshotMonitor.Environment()
        env.scan = { [unowned self] in self.scan }
        env.arguments = { [unowned self] pid in self.lock.lock(); defer { self.lock.unlock() }; return self.argv[pid] }
        env.displayContaining = { [unowned self] p in self.display(at: p).id }
        env.backingScale = { [unowned self] id in self.displays.first { $0.id == id }?.scale ?? 1 }
        env.mouseLocation = { [unowned self] in self.mouse }
        env.hasScreenRecordingPermission = { [unowned self] in self.permission }
        env.windowAt = { [unowned self] p, ex in
            self.windows.first { $0.bounds.contains(p) && !ex.pids.contains(-1) }?.id
        }
        env.windowBounds = { [unowned self] id in self.windows.first { $0.id == id }?.bounds }
        env.toolbarBounds = { [unowned self] in self.toolbar }
        env.panelStyle = { [unowned self] in self.style }
        env.captureDisplay = { [unowned self] id, rect, _, completion in
            self.lock.lock(); self.displayRequests.append((id, rect)); self.lock.unlock()
            let d = self.displays.first { $0.id == id } ?? self.displays[0]
            let size = rect?.size ?? d.bounds.size
            self.complete(completion, width: Int(size.width * d.scale), height: Int(size.height * d.scale))
        }
        env.captureWindow = { [unowned self] id, completion in
            self.lock.lock(); self.windowRequests.append(id); self.lock.unlock()
            let b = self.windows.first { $0.id == id }?.bounds ?? CGRect(x: 0, y: 0, width: 10, height: 10)
            self.complete(completion, width: Int(b.width), height: Int(b.height))
        }
        return env
    }
}

final class ScreenshotMonitorSessionTests: XCTestCase {
    private var sys: FakeScreenshotSystem!
    private var monitor: ScreenshotMonitor!
    private let lock = NSLock()
    private var events: [[String: Any]] = []
    private var captures: [ScreenshotMonitor.Capture] = []
    private var ended: [Bool] = []
    private var started: [(ScreenshotMonitor.Mode, ScreenshotMonitor.Destination)] = []
    private var selections: [CGRect] = []
    private var problems: [ScreenshotMonitor.Problem] = []

    override func setUp() {
        sys = FakeScreenshotSystem()
        events = []; captures = []; ended = []; started = []; selections = []; problems = []
    }

    override func tearDown() {
        monitor?.stop()
        monitor = nil
    }

    private func start(configure: (inout ScreenshotMonitor.Options) -> Void = { _ in }) {
        var o = ScreenshotMonitor.Options()
        o.installsEventTap = false
        o.writeTempFile = false
        o.pollInterval = 3600          // tests drive poll() themselves
        o.captureDelay = 0
        o.environment = sys.environment
        configure(&o)
        let m = ScreenshotMonitor(options: o)
        m.onEvent = { [unowned self] e in self.lock.lock(); self.events.append(e); self.lock.unlock() }
        m.onCapture = { [unowned self] c in self.lock.lock(); self.captures.append(c); self.lock.unlock() }
        m.onSessionEnded = { [unowned self] c in self.lock.lock(); self.ended.append(c); self.lock.unlock() }
        m.onSessionStarted = { [unowned self] mo, d in self.lock.lock(); self.started.append((mo, d)); self.lock.unlock() }
        m.onSelectionChanged = { [unowned self] r in self.lock.lock(); self.selections.append(r); self.lock.unlock() }
        m.onError = { [unowned self] p, _ in self.lock.lock(); self.problems.append(p); self.lock.unlock() }
        monitor = m
        m.start()
    }

    private func poll() { monitor.performOnQueue { monitor.poll() } }
    private func mouse(_ t: CGEventType, _ x: CGFloat, _ y: CGFloat) {
        monitor.performOnQueue { monitor.handleMouse(type: t, location: CGPoint(x: x, y: y)) }
    }
    private func key(_ code: Int64, repeat isRepeat: Bool = false) {
        monitor.performOnQueue { monitor.handleKeyDown(keyCode: code, isRepeat: isRepeat) }
    }
    private func drag(_ a: CGPoint, _ b: CGPoint) {
        mouse(.leftMouseDown, a.x, a.y)
        mouse(.leftMouseDragged, (a.x + b.x) / 2, (a.y + b.y) / 2)
        mouse(.leftMouseDragged, b.x, b.y)
        mouse(.leftMouseUp, b.x, b.y)
    }

    private func snapshot() -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return events }
    private func types() -> [String] { snapshot().compactMap { $0["type"] as? String } }
    private func last(_ type: String) -> [String: Any]? { snapshot().last { $0["type"] as? String == type } }

    private func waitUntil(_ what: String, timeout: TimeInterval = 2, _ cond: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !cond() && Date() < deadline { usleep(2000) }
        XCTAssertTrue(cond(), "timed out waiting for \(what)")
    }
    private func waitForEnded() { waitUntil("screencapture_ended") { types().contains("screencapture_ended") } }

    private func begin(pid: pid_t, _ args: [String]) {
        sys.argv[pid] = args
        sys.setProcesses(screencapture: [pid])
        poll()
    }

    // MARK: - Lifecycle

    func testReadyThenIdempotentStartAndRestart() {
        start()
        XCTAssertTrue(monitor.isRunning)
        monitor.start()
        XCTAssertEqual(types(), ["ready"])
        XCTAssertNotNil(snapshot().first?["timestamp"] as? Int)
        XCTAssertFalse(monitor.eventTapActive, "no tap is installed in tests")
        monitor.stop()
        monitor.stop()
        XCTAssertFalse(monitor.isRunning)
        monitor.start()
        XCTAssertEqual(types(), ["ready", "ready"])
    }

    func testProcessesAlreadyRunningAtStartAreNotSessions() {
        sys.argv[10] = ["-pd", "-z", "keyboard.screen"]
        sys.setProcesses(screencapture: [10], ui: [20])
        start()
        poll()
        sys.setProcesses()
        poll()
        // The pre-existing screencapture exiting is not a capture; the UI agent ending is reported.
        XCTAssertEqual(types(), ["ready", "screencaptureui_ended"])
        XCTAssertEqual(sys.requestCount, 0)
    }

    func testScreencaptureUIStartAndEndAreReported() {
        start()
        sys.setProcesses(ui: [7, 8])
        poll()
        sys.setProcesses(ui: [8])
        poll()
        let ui = snapshot().filter { ($0["type"] as? String)?.hasPrefix("screencaptureui") == true }
        XCTAssertEqual(ui.map { $0["type"] as? String }, ["screencaptureui_started", "screencaptureui_started", "screencaptureui_ended"])
        XCTAssertEqual(ui.map { $0["pid"] as? Int }, [7, 8, 7], "pids are reported in sorted order")
    }

    // MARK: - Cmd+Shift+3 / non-interactive

    func testFullScreenCaptureOnProcessExitUsesDisplayUnderCursor() throws {
        sys.mouse = CGPoint(x: -100, y: 50)   // on the secondary display (negative origin)
        start()
        begin(pid: 42, ["-pd", "-z", "keyboard.screen"])
        let s = try XCTUnwrap(last("screencapture_started"))
        XCTAssertEqual(s["mode"] as? String, "screen")
        XCTAssertEqual(s["destination"] as? String, "file")
        XCTAssertEqual(s["pid"] as? Int, 42)
        XCTAssertEqual(sys.requestCount, 0, "nothing is captured while screencapture runs")

        sys.setProcesses()
        poll()
        waitForEnded()
        let e = try XCTUnwrap(last("screencapture_ended"))
        XCTAssertEqual(e["cancelled"] as? Bool, false)
        XCTAssertEqual(e["displayId"] as? String, "2")
        XCTAssertEqual(e["scale"] as? Double, 1)
        XCTAssertEqual(e["imageWidth"] as? Int, 1920)
        XCTAssertNil(e["rect"])
        XCTAssertNil(e["imagePath"], "writeTempFile is off")
        XCTAssertEqual(captures.count, 1)
        XCTAssertEqual(ended, [false])
        XCTAssertEqual(started.first?.0, .screen)
        XCTAssertEqual(sys.displayRequests.first?.1, nil)
    }

    func testExplicitRectPicksDisplayFromRectNotCursor() throws {
        sys.mouse = CGPoint(x: 500, y: 500)   // main display
        start()
        begin(pid: 5, ["-R", "-1800,-200,400,300", "/tmp/r.png"])
        sys.setProcesses()
        poll()
        waitForEnded()
        XCTAssertEqual(sys.displayRequests.first?.0, 2)
        XCTAssertEqual(sys.displayRequests.first?.1, CGRect(x: -1800, y: -200, width: 400, height: 300))
        let e = try XCTUnwrap(last("screencapture_ended"))
        let rect = try XCTUnwrap(e["rect"] as? [String: Any])
        XCTAssertEqual(rect["x"] as? Double, -1800)
        XCTAssertEqual(e["mode"] as? String, "selection")
    }

    func testExplicitWindowCapturesWindowOnItsDisplay() throws {
        sys.windows = [(id: 77, bounds: CGRect(x: -1500, y: 0, width: 800, height: 600))]
        start()
        begin(pid: 6, ["-l", "77", "/tmp/w.png"])
        sys.setProcesses()
        poll()
        waitForEnded()
        XCTAssertEqual(sys.windowRequests, [77])
        let e = try XCTUnwrap(last("screencapture_ended"))
        XCTAssertEqual(e["displayId"] as? String, "2")
        XCTAssertEqual(e["mode"] as? String, "window")
    }

    func testClipboardDestinationIsCarriedThrough() throws {
        start()
        begin(pid: 9, ["-pdc", "-z", "keyboard.screen.clipboard"])
        sys.setProcesses()
        poll()
        waitForEnded()
        XCTAssertEqual(last("screencapture_ended")?["destination"] as? String, "clipboard")
    }

    func testUnreadableArgvStillOpensAScreenSession() {
        start()
        sys.setProcesses(screencapture: [99])   // no argv (process already gone / not ours)
        poll()
        XCTAssertEqual(last("screencapture_started")?["mode"] as? String, "screen")
    }

    // MARK: - Cmd+Shift+4

    func testSelectionDragCapturesTrackedRectAfterProcessAlreadyExited() throws {
        start()
        begin(pid: 11, ["-pdin", "-z", "keyboard.selection"])
        sys.setProcesses()       // screencapture exits before the user selects (macOS 26)
        poll()
        XCTAssertFalse(types().contains("screencapture_ended"))

        drag(CGPoint(x: 300, y: 200), CGPoint(x: 100, y: 50))
        waitForEnded()
        let changes = snapshot().filter { $0["type"] as? String == "selection_rect_changed" }
        XCTAssertGreaterThanOrEqual(changes.count, 2)
        XCTAssertEqual(changes.last?["displayId"] as? String, "1")
        XCTAssertEqual(selections.last, CGRect(x: 100, y: 50, width: 200, height: 150))
        XCTAssertEqual(sys.displayRequests.first?.1, CGRect(x: 100, y: 50, width: 200, height: 150))
        let e = try XCTUnwrap(last("screencapture_ended"))
        XCTAssertEqual(e["mode"] as? String, "selection")
        XCTAssertEqual(e["imageWidth"] as? Int, 400, "Retina display: 2 px per point")
        XCTAssertEqual(e["scale"] as? Double, 2)
    }

    func testSelectionOnNegativeOriginDisplay() throws {
        start()
        begin(pid: 12, ["-pdin", "-z", "keyboard.selection"])
        drag(CGPoint(x: -1000, y: -250), CGPoint(x: -900, y: -100))
        waitForEnded()
        XCTAssertEqual(sys.displayRequests.first?.0, 2)
        XCTAssertEqual(sys.displayRequests.first?.1, CGRect(x: -1000, y: -250, width: 100, height: 150))
        XCTAssertEqual(last("selection_rect_changed")?["displayId"] as? String, "2")
    }

    func testPlainClickCancelsAndLaterDragIsNotAPhantomCapture() {
        // Regression: a click without drag left the session open until Esc / the 180 s timeout,
        // so the next ordinary drag anywhere was captured as a phantom screenshot.
        start()
        begin(pid: 13, ["-pdin", "-z", "keyboard.selection"])
        mouse(.leftMouseDown, 10, 10)
        mouse(.leftMouseUp, 10, 10)
        XCTAssertEqual(sys.requestCount, 0)
        XCTAssertEqual(last("screencapture_ended")?["cancelled"] as? Bool, true)
        XCTAssertEqual(ended, [true])
        XCTAssertTrue(captures.isEmpty)
        // Later input (an ordinary drag, Esc) is not part of any session.
        drag(CGPoint(x: 0, y: 0), CGPoint(x: 50, y: 50))
        key(53)
        XCTAssertEqual(sys.requestCount, 0)
        XCTAssertEqual(types().filter { $0 == "screencapture_ended" }.count, 1)
    }

    func testEscBeforeAnyClickCancels() {
        start()
        begin(pid: 113, ["-pdin", "-z", "keyboard.selection"])
        key(53)
        XCTAssertEqual(ended, [true])
    }

    func testTinyDragCancelsWithoutCapture() {
        start()
        begin(pid: 14, ["-pdin", "-z", "keyboard.selection"])
        drag(CGPoint(x: 10, y: 10), CGPoint(x: 11, y: 11))
        XCTAssertEqual(sys.requestCount, 0)
        XCTAssertEqual(ended, [true])
        drag(CGPoint(x: 100, y: 100), CGPoint(x: 300, y: 300))
        XCTAssertEqual(sys.requestCount, 0, "no phantom capture after the cancelled session")
    }

    func testReleaseOfAPressThatBeganBeforeTheSessionIsIgnored() {
        start()
        begin(pid: 114, ["-pdin", "-z", "keyboard.selection"])
        mouse(.leftMouseUp, 40, 40)    // button was already down when the hotkey fired
        XCTAssertFalse(types().contains("screencapture_ended"))
        drag(CGPoint(x: 0, y: 0), CGPoint(x: 80, y: 60))
        waitForEnded()
        XCTAssertEqual(sys.displayRequests.first?.1, CGRect(x: 0, y: 0, width: 80, height: 60))
    }

    func testInteractiveSessionSurvivesProcessExitThenClickCancels() {
        // macOS 26: screencapture exits before the user selects, so process exit must not end
        // an interactive session; the gesture does.
        start()
        begin(pid: 115, ["-pdin", "-z", "keyboard.selection"])
        sys.setProcesses()
        poll()
        XCTAssertFalse(types().contains("screencapture_ended"))
        mouse(.leftMouseDown, 5, 5)
        mouse(.leftMouseUp, 5, 5)
        XCTAssertEqual(ended, [true])
        XCTAssertEqual(sys.requestCount, 0)
    }

    func testSpaceTogglesWindowModeAndClickCapturesWindow() throws {
        sys.windows = [(id: 501, bounds: CGRect(x: 0, y: 0, width: 640, height: 480))]
        start()
        begin(pid: 15, ["-pdin", "-z", "keyboard.selection"])
        key(49)
        key(49, repeat: true)          // auto-repeat must not flip back
        mouse(.leftMouseDown, 100, 100)
        mouse(.leftMouseUp, 101, 100)
        waitForEnded()
        XCTAssertEqual(sys.windowRequests, [501])
        let e = try XCTUnwrap(last("screencapture_ended"))
        XCTAssertEqual(e["mode"] as? String, "window")
        XCTAssertNil(e["rect"])
    }

    func testSpaceTwiceReturnsToRegionMode() {
        sys.windows = [(id: 502, bounds: CGRect(x: 0, y: 0, width: 640, height: 480))]
        start()
        begin(pid: 16, ["-pdin", "-z", "keyboard.selection"])
        key(49); key(49)
        mouse(.leftMouseDown, 100, 100)
        mouse(.leftMouseUp, 100, 100)
        XCTAssertEqual(sys.requestCount, 0, "a click in region mode is not a window capture")
        XCTAssertEqual(ended, [true])
    }

    func testSpaceWhileDraggingDoesNotToggle() {
        start()
        begin(pid: 17, ["-pdin", "-z", "keyboard.selection"])
        mouse(.leftMouseDown, 0, 0)
        mouse(.leftMouseDragged, 50, 50)
        key(49)                        // held Space moves the selection instead
        mouse(.leftMouseDragged, 100, 100)
        mouse(.leftMouseUp, 100, 100)
        waitForEnded()
        XCTAssertEqual(sys.displayRequests.count, 1)
        XCTAssertTrue(sys.windowRequests.isEmpty)
    }

    func testWindowClickOverNoWindowCancelsWithoutLaterPhantom() {
        start()
        begin(pid: 18, ["-pdin", "-z", "keyboard.selection"])
        key(49)
        mouse(.leftMouseDown, 100, 100)
        mouse(.leftMouseUp, 100, 100)
        XCTAssertEqual(sys.requestCount, 0)
        XCTAssertEqual(last("screencapture_ended")?["cancelled"] as? Bool, true)
        sys.windows = [(id: 700, bounds: CGRect(x: 0, y: 0, width: 300, height: 300))]
        mouse(.leftMouseDown, 50, 50)
        mouse(.leftMouseUp, 50, 50)
        XCTAssertEqual(sys.requestCount, 0, "a later click on a window is not a phantom capture")
    }

    func testDragInWindowModeCancels() {
        sys.windows = [(id: 701, bounds: CGRect(x: 0, y: 0, width: 300, height: 300))]
        start()
        begin(pid: 118, ["-iw"])
        drag(CGPoint(x: 10, y: 10), CGPoint(x: 200, y: 200))
        XCTAssertEqual(sys.requestCount, 0)
        XCTAssertEqual(ended, [true])
    }

    // MARK: - Session origin

    func testOriginIsReportedOnStartedEndedAndCapture() throws {
        start()
        begin(pid: 120, ["-pd", "-z", "keyboard.screen"])
        sys.setProcesses()
        poll()
        waitForEnded()
        XCTAssertEqual(last("screencapture_started")?["origin"] as? String, "hotkey")
        XCTAssertEqual(last("screencapture_ended")?["origin"] as? String, "hotkey")
        XCTAssertEqual(captures.first?.origin, .hotkey)
    }

    func testThirdPartyCLIInvocationIsFlaggedAsCLI() throws {
        start()
        begin(pid: 121, ["-x", "/tmp/shot.png"])   // another app running `screencapture -x`
        XCTAssertEqual(last("screencapture_started")?["origin"] as? String, "cli")
        sys.setProcesses()
        poll()
        waitForEnded()
        XCTAssertEqual(last("screencapture_ended")?["origin"] as? String, "cli")
        XCTAssertEqual(captures.first?.origin, .cli)
    }

    func testHotkeyOnlyIgnoresCLIAndUnreadableInvocations() throws {
        start { $0.hotkeyOnly = true }
        begin(pid: 122, ["-x", "/tmp/shot.png"])
        sys.setProcesses()
        poll()
        begin(pid: 123, [])                         // argv unreadable
        sys.setProcesses()
        poll()
        XCTAssertFalse(types().contains("screencapture_started"))
        XCTAssertEqual(sys.requestCount, 0)
        begin(pid: 124, ["-pdin", "-z", "keyboard.selection"])
        XCTAssertEqual(last("screencapture_started")?["origin"] as? String, "hotkey")
    }

    func testCLIInvocationDoesNotSupersedeHotkeySessionWhenHotkeyOnly() {
        start { $0.hotkeyOnly = true }
        begin(pid: 125, ["-pdin", "-z", "keyboard.selection"])
        sys.argv[126] = ["-x", "/tmp/a.png"]
        sys.setProcesses(screencapture: [126])
        poll()
        XCTAssertFalse(types().contains("screencapture_ended"), "the hotkey session stays open")
        drag(CGPoint(x: 0, y: 0), CGPoint(x: 40, y: 40))
        waitForEnded()
        XCTAssertEqual(sys.displayRequests.count, 1)
    }

    func testInteractiveWindowOnlyInvocationCapturesClickedWindow() {
        // Regression: `screencapture -iw` was parsed as region selection, so clicking a window
        // never captured and the session hung until the timeout.
        sys.windows = [(id: 600, bounds: CGRect(x: 0, y: 0, width: 300, height: 300))]
        start()
        begin(pid: 19, ["-iw", "/tmp/w.png"])
        mouse(.leftMouseDown, 50, 50)
        mouse(.leftMouseUp, 50, 50)
        waitForEnded()
        XCTAssertEqual(sys.windowRequests, [600])
    }

    // MARK: - Cmd+Shift+5

    func testPanelReturnCapturesTrackedSelection() throws {
        sys.style = "selection"
        start()
        begin(pid: 20, ["-pdiU", "-z", "keyboard.interactive"])
        drag(CGPoint(x: 10, y: 10), CGPoint(x: 210, y: 110))
        XCTAssertEqual(sys.requestCount, 0, "Cmd+Shift+5 waits for Return / Capture")
        key(36, repeat: true)          // auto-repeat Return is ignored
        XCTAssertEqual(sys.requestCount, 0)
        key(36)
        waitForEnded()
        XCTAssertEqual(sys.displayRequests.first?.1, CGRect(x: 10, y: 10, width: 200, height: 100))
        XCTAssertEqual(last("screencapture_ended")?["mode"] as? String, "interactive")
    }

    func testPanelEnterWithoutSelectionCapturesDisplayUnderCursor() {
        sys.mouse = CGPoint(x: -10, y: 10)
        start()
        begin(pid: 21, ["-pdiU", "-z", "keyboard.interactive"])
        key(76)
        waitForEnded()
        XCTAssertEqual(sys.displayRequests.first?.0, 2)
        XCTAssertNil(sys.displayRequests.first?.1 ?? nil)
    }

    func testPanelWindowStyleCapturesWindowUnderCursor() {
        sys.style = "window"
        sys.mouse = CGPoint(x: 20, y: 20)
        sys.windows = [(id: 700, bounds: CGRect(x: 0, y: 0, width: 100, height: 100))]
        start()
        begin(pid: 22, ["-pdiU", "-z", "keyboard.interactive"])
        key(36)
        waitForEnded()
        XCTAssertEqual(sys.windowRequests, [700])
    }

    func testToolbarCaptureButtonClick() {
        sys.toolbar = CGRect(x: 400, y: 800, width: 600, height: 60)
        start()
        begin(pid: 23, ["-pdiU", "-z", "keyboard.interactive"])
        mouse(.leftMouseDown, 500, 820)  // left part of the toolbar: an option, not Capture
        mouse(.leftMouseUp, 500, 820)
        XCTAssertEqual(sys.requestCount, 0)
        mouse(.leftMouseDown, 950, 820)  // right end: Capture
        mouse(.leftMouseUp, 950, 820)
        waitForEnded()
        XCTAssertEqual(sys.requestCount, 1)
    }

    func testSpaceDoesNotToggleWindowModeInPanel() {
        start()
        begin(pid: 24, ["-pdiU", "-z", "keyboard.interactive"])
        key(49)
        key(36)
        waitForEnded()
        XCTAssertEqual(last("screencapture_ended")?["mode"] as? String, "interactive")
    }

    // MARK: - Concurrency / ordering

    func testNewHotkeySupersedesOpenSession() {
        start()
        begin(pid: 30, ["-pdin", "-z", "keyboard.selection"])
        sys.argv[31] = ["-pd", "-z", "keyboard.screen"]
        sys.setProcesses(screencapture: [30, 31])
        poll()
        XCTAssertEqual(types(), ["ready", "screencapture_started", "screencapture_ended", "screencapture_started"])
        let endedEvent = snapshot()[2]
        XCTAssertEqual(endedEvent["pid"] as? Int, 30)
        XCTAssertEqual(endedEvent["cancelled"] as? Bool, true)
        XCTAssertEqual(last("screencapture_started")?["pid"] as? Int, 31)
    }

    func testTwoHotkeysInOnePollKeepOnlyTheLast() {
        start()
        sys.argv[40] = ["-pd", "-z", "keyboard.screen"]
        sys.argv[41] = ["-pdin", "-z", "keyboard.selection"]
        sys.setProcesses(screencapture: [41, 40])
        poll()
        XCTAssertEqual(types().filter { $0 == "screencapture_started" }.count, 2)
        XCTAssertEqual(last("screencapture_started")?["pid"] as? Int, 41)
        XCTAssertEqual(ended, [true])
    }

    func testStopWhileCaptureInFlightEndsCancelledAndDropsLateResult() {
        sys.autoComplete = false
        start()
        begin(pid: 50, ["-pd", "-z", "keyboard.screen"])
        sys.setProcesses()
        poll()
        waitUntil("capture request") { sys.requestCount == 1 }
        monitor.stop()
        XCTAssertEqual(ended, [true])
        sys.releasePending()
        usleep(50_000)
        monitor.performOnQueue {}
        XCTAssertEqual(types().filter { $0 == "screencapture_ended" }.count, 1)
        XCTAssertTrue(captures.isEmpty)
    }

    func testInputIgnoredWhileCaptureInFlight() {
        sys.autoComplete = false
        start()
        begin(pid: 51, ["-pdin", "-z", "keyboard.selection"])
        drag(CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 100))
        waitUntil("capture request") { sys.requestCount == 1 }
        key(53)                        // Esc during the capture does not cancel it
        drag(CGPoint(x: 0, y: 0), CGPoint(x: 300, y: 300))
        XCTAssertEqual(sys.requestCount, 1)
        XCTAssertFalse(types().contains("screencapture_ended"))
        sys.releasePending()
        waitForEnded()
        XCTAssertEqual(ended, [false])
    }

    func testSupersededSessionDropsItsLateCapture() {
        sys.autoComplete = false
        start()
        begin(pid: 52, ["-pdin", "-z", "keyboard.selection"])
        drag(CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 100))
        waitUntil("capture request") { sys.requestCount == 1 }
        sys.argv[53] = ["-pdiU", "-z", "keyboard.interactive"]
        sys.setProcesses(screencapture: [52, 53])
        poll()
        sys.releasePending()
        usleep(50_000)
        monitor.performOnQueue {}
        XCTAssertTrue(captures.isEmpty, "the first session's image must not be attributed to the second")
        XCTAssertEqual(ended, [true])
    }

    func testSessionTimeoutCancels() {
        start { $0.sessionTimeout = 0.05 }
        begin(pid: 60, ["-pdin", "-z", "keyboard.selection"])
        waitForEnded()
        XCTAssertEqual(last("screencapture_ended")?["cancelled"] as? Bool, true)
    }

    func testMouseAndKeysOutsideASessionAreIgnored() {
        start()
        drag(CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 100))
        key(53); key(36); key(49)
        XCTAssertEqual(types(), ["ready"])
    }

    func testNonInteractiveSessionIgnoresGestures() {
        start()
        begin(pid: 61, ["-pd", "-z", "keyboard.screen"])
        drag(CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 100))
        key(53)
        XCTAssertEqual(types(), ["ready", "screencapture_started"])
    }

    // MARK: - Failures and permissions

    func testCaptureFailureReportsReasonAndCancels() throws {
        sys.returnsImage = false
        sys.captureError = "SCScreenshotManager: boom"
        start()
        begin(pid: 70, ["-pd", "-z", "keyboard.screen"])
        sys.setProcesses()
        poll()
        waitForEnded()
        let f = try XCTUnwrap(last("screenshot_capture_failed"))
        XCTAssertEqual(f["reason"] as? String, "SCScreenshotManager: boom")
        XCTAssertNotNil(f["displayId"] as? String)
        XCTAssertEqual(last("screencapture_ended")?["cancelled"] as? Bool, true)
        XCTAssertTrue(problems.isEmpty, "permission is granted: no screen_recording_denied")
    }

    func testMissingScreenRecordingIsReportedOnceAtStartAndNotAgainOnFailure() {
        sys.permission = false
        sys.returnsImage = false
        start()
        XCTAssertEqual(problems, [.screenRecordingDenied])
        let err = last("error")
        XCTAssertEqual(err?["code"] as? String, "screen_recording_denied")
        begin(pid: 71, ["-pd", "-z", "keyboard.screen"])
        sys.setProcesses()
        poll()
        waitForEnded()
        XCTAssertEqual(problems, [.screenRecordingDenied], "each problem is reported once until it clears")
        XCTAssertEqual(last("screenshot_capture_failed")?["reason"] as? String, "capture returned no image")
    }

    func testWarningWithImageStillSucceeds() {
        sys.captureError = "SCShareableContent: fell back to legacy capture"
        start()
        begin(pid: 72, ["-pd", "-z", "keyboard.screen"])
        sys.setProcesses()
        poll()
        waitForEnded()
        XCTAssertEqual(ended, [false])
        XCTAssertFalse(types().contains("screenshot_capture_failed"))
    }

    // MARK: - Temp files

    func testTempFileWrittenPrivatelyAndStaleOnesSweptAtStart() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ausm-mon-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let stale = try XCTUnwrap(ScreenCapture.writeTemp(FakeScreenshotSystem.image(width: 2, height: 2), as: .png, directory: dir))
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-7200)], ofItemAtPath: stale)

        start {
            $0.writeTempFile = true
            $0.tempDirectory = dir
            $0.tempFileFormat = .png
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale))
        begin(pid: 80, ["-pd", "-z", "keyboard.screen"])
        sys.setProcesses()
        poll()
        waitForEnded()
        let e = try XCTUnwrap(last("screencapture_ended"))
        let path = try XCTUnwrap(e["imagePath"] as? String)
        XCTAssertTrue(path.hasPrefix(dir.path))
        XCTAssertEqual(e["imageMimeType"] as? String, "image/png")
        let attrs = try FileManager.default.attributesOfItem(atPath: path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual(captures.first?.tempFilePath, path)
    }

    func testUnwritableTempDirectoryStillReportsTheCapture() throws {
        start {
            $0.writeTempFile = true
            $0.staleTempFileAge = 0
            $0.tempDirectory = URL(fileURLWithPath: "/nonexistent-\(UUID().uuidString)")
        }
        begin(pid: 81, ["-pd", "-z", "keyboard.screen"])
        sys.setProcesses()
        poll()
        waitForEnded()
        let e = try XCTUnwrap(last("screencapture_ended"))
        XCTAssertEqual(e["cancelled"] as? Bool, false)
        XCTAssertNil(e["imagePath"])
        XCTAssertNotNil(e["imageWidth"])
    }

    func testEveryEventIsValidJSON() {
        sys.toolbar = nil
        start()
        begin(pid: 90, ["-pdin", "-z", "keyboard.selection"])
        drag(CGPoint(x: 0, y: 0), CGPoint(x: 64, y: 64))
        waitForEnded()
        for e in snapshot() {
            XCTAssertTrue(JSONSerialization.isValidJSONObject(e), "\(e["type"] ?? "?") is not JSON-able")
            XCTAssertNotNil(e["timestamp"] as? Int)
        }
    }
}
