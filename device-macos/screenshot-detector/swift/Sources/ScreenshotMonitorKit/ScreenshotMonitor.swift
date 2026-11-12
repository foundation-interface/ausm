/// Monitors macOS screenshot activity and reproduces the captured image.
///
/// How macOS (Mojave and later, verified on macOS 26) takes a hotkey screenshot:
///   1. The hotkey spawns `/usr/sbin/screencapture` with flags that encode the mode
///      (`-z keyboard.screen|selection|interactive[.clipboard]`).
///   2. For interactive modes it hands the UI to the persistent `screencaptureui` agent
///      (overlay, Cmd+Shift+5 toolbar, floating thumbnail) and **exits at an arbitrary
///      point** — sometimes before the user has selected anything.
///   3. The user drags a region (mouse up = capture), presses Space + click for a window,
///      Esc to cancel, or in the Cmd+Shift+5 panel clicks Capture / presses Return.
///   4. The file lands on disk only after the floating thumbnail goes away (4–10 s later);
///      clipboard captures update the pasteboard immediately.
///
/// Therefore a session is opened when a `screencapture` process appears (its argv tells us the
/// mode) and is closed by the *user's* gesture, not by process exit:
///   - `screen` mode (Cmd+Shift+3 / non-interactive CLI): capture when the process exits.
///   - `selection` mode (Cmd+Shift+4): capture the tracked rect on mouse-up; Space toggles
///     window mode where a click captures the window under the cursor.
///   - `interactive` mode (Cmd+Shift+5): capture on Return or a click on the toolbar's
///     Capture button, using the tracked rect if the user dragged one.
///   - Esc (or a session timeout) cancels.
/// Images are captured with ScreenCaptureKit excluding the Screenshot UI and any host windows.
///
/// Threading: all state lives on a private serial queue. Every callback (`onEvent`,
/// `onSessionStarted`, `onSelectionChanged`, `onCapture`, `onSessionEnded`, `onError`) is invoked
/// on that queue — hop to the main thread yourself for UI work, and never block it waiting on
/// the main thread. Assign callbacks before `start()`. `start()`/`stop()` may be called from any
/// thread, including from inside a callback.
///
/// Permissions: Accessibility (or Input Monitoring) for the event tap that follows the user's
/// selection gestures, Screen Recording for the capture itself. Missing permissions are reported
/// through `onError` and as `{"type":"error"}` wire events; the monitor keeps running and retries
/// the event tap every few seconds so a grant takes effect without a restart.
import AppKit
import CoreGraphics
import Darwin
import Foundation

public final class ScreenshotMonitor: @unchecked Sendable {
    public enum Mode: String, Sendable {
        case screen, selection, window, interactive, unknown
    }

    public enum Destination: String, Sendable {
        case file, clipboard, unknown
    }

    /// Who started a session: the system screenshot hotkeys (Cmd+Shift+3/4/5), another program
    /// running the `screencapture` CLI (e.g. `screencapture -x`), or unknown (argv unreadable).
    public enum Origin: String {
        case hotkey, cli, unknown
    }

    /// Permission / health problems reported through `onError` and `{"type":"error","code":…}`.
    public enum Problem: String, Sendable {
        /// The CGEventTap could not be created: grant Accessibility (or Input Monitoring).
        /// Interactive (Cmd+Shift+4/5) sessions cannot be followed until it is granted.
        case accessibilityDenied = "accessibility_denied"
        /// Screen Recording is not granted: captures will fail.
        case screenRecordingDenied = "screen_recording_denied"
        /// The event tap was disabled by the system and could not be re-enabled
        /// (usually Accessibility was revoked while running).
        case eventTapDisabled = "event_tap_disabled"
    }

    public struct Options {
        /// How often to scan the process table for `screencapture` (seconds).
        public var pollInterval: TimeInterval = 0.03
        /// Delay between the user's capture gesture and our own capture, so the selection overlay
        /// has been torn down (seconds).
        public var captureDelay: TimeInterval = 0.08
        /// Abandon an interactive session that never completes (seconds).
        public var sessionTimeout: TimeInterval = 180
        /// Write the captured image to a temp file (mode 0600) and report `imagePath` in events.
        /// The consumer owns the file and should delete it after reading.
        public var writeTempFile = true
        /// Encoding used for the temp file.
        public var tempFileFormat: ScreenCapture.ImageFormat = .jpeg(quality: 0.85)
        /// On `start()`, delete `writeTemp` files older than this many seconds that no consumer
        /// cleaned up (only when `writeTempFile` is on). 0 disables the sweep.
        public var staleTempFileAge: TimeInterval = 3600
        /// Extra apps to leave out of captured images (e.g. the host app's own overlay windows).
        public var excludedBundleIdentifiers: Set<String> = []
        /// Leave the calling process's own windows out of captured images.
        public var excludeOwnProcess = true
        /// Only follow `screencapture` processes launched by the system screenshot hotkeys; other
        /// programs running the CLI (and processes whose argv cannot be read) are ignored.
        /// Off by default: every session reports its `origin` either way.
        public var hotkeyOnly = false
        /// Print diagnostics to stderr. Never includes image contents.
        public var debugLogging = false
        /// Tests turn this off so they never trigger a TCC prompt for the event tap.
        var installsEventTap = true
        /// Directory for temp images and the stale sweep (nil = the user's temp directory).
        var tempDirectory: URL? = nil
        /// System hooks; tests replace them with fakes.
        var environment = Environment()

        public init() {}
    }

    /// Everything the monitor asks of the system: the process table, display geometry, window
    /// lookups and the capture itself. Production uses the real implementations; tests inject
    /// fakes so no process scan, window list or ScreenCaptureKit call is made.
    struct Environment {
        var scan: () -> ScreenshotProcessScan = { ScreenshotProcessScan.scan() }
        var arguments: (pid_t) -> [String]? = { ScreenshotProcessScan.arguments(of: $0) }
        var displayContaining: (CGPoint) -> CGDirectDisplayID = { ScreenCapture.display(containing: $0) }
        var backingScale: (CGDirectDisplayID) -> CGFloat = { ScreenCapture.backingScale(of: $0) }
        var mouseLocation: () -> CGPoint = { ScreenCapture.mouseLocation() }
        var hasScreenRecordingPermission: () -> Bool = { ScreenCapture.hasScreenRecordingPermission() }
        var windowAt: (CGPoint, ScreenCapture.Exclusions) -> CGWindowID? = { ScreenCapture.windowID(at: $0, excluding: $1) }
        var windowBounds: (CGWindowID) -> CGRect? = { ScreenCapture.windowBounds($0) }
        var toolbarBounds: () -> CGRect? = { ScreenCapture.screenshotToolbarBounds() }
        /// The Cmd+Shift+5 panel's remembered capture style.
        var panelStyle: () -> String? = { UserDefaults(suiteName: "com.apple.screencapture")?.string(forKey: "style") }
        var captureDisplay: (CGDirectDisplayID, CGRect?, ScreenCapture.Exclusions, @escaping (CGImage?, String?) -> Void) -> Void = {
            ScreenCapture.captureDisplay($0, cropTo: $1, excluding: $2, completion: $3)
        }
        var captureWindow: (CGWindowID, @escaping (CGImage?, String?) -> Void) -> Void = {
            ScreenCapture.captureWindow($0, completion: $1)
        }
    }

    /// A completed capture.
    public struct Capture: @unchecked Sendable {
        public let image: CGImage
        /// Captured region in global CG points, nil for a whole display or a window.
        public let rect: CGRect?
        public let displayID: CGDirectDisplayID
        /// Pixels per point of the captured display (2 on Retina).
        public let scale: CGFloat
        public let mode: Mode
        public let destination: Destination
        /// Who started the session (hotkey vs another program's CLI invocation).
        public var origin: Origin = .unknown
        /// Path of the temp file when `Options.writeTempFile` is on.
        public let tempFilePath: String?
        public let timestamp: Date
    }

    // MARK: Callbacks (invoked on the monitor's internal serial queue; assign before start())

    /// Raw wire events, same JSON-able dictionaries the ScreenshotHelper prints.
    public var onEvent: (([String: Any]) -> Void)?
    public var onSessionStarted: ((Mode, Destination) -> Void)?
    public var onSelectionChanged: ((CGRect) -> Void)?
    public var onCapture: ((Capture) -> Void)?
    /// `cancelled` is true when the user pressed Esc / the session timed out / was superseded /
    /// the monitor was stopped / no image could be produced.
    public var onSessionEnded: ((_ cancelled: Bool) -> Void)?
    /// Permission / health problems (see `Problem`). Each problem is reported once until it clears.
    public var onError: ((Problem, String) -> Void)?

    // MARK: State (confined to `queue`)

    private struct Session {
        let id: Int
        let pid: pid_t
        var invocation: ScreencaptureInvocation
        let startedAt: Date
        var windowMode = false          // Space pressed during selection mode
        var sawMouseDown = false        // a press began inside this session
        var captureInFlight = false
        var displayID: CGDirectDisplayID?

        var effectiveMode: Mode { windowMode ? .window : invocation.mode }
    }

    private let options: Options
    private var env: Environment { options.environment }
    private let queue = DispatchQueue(label: "ausm.screenshot-monitor", qos: .userInitiated)
    private let queueKey = DispatchSpecificKey<Void>()
    private var pollTimer: DispatchSourceTimer?
    private var timeoutTimer: DispatchSourceTimer?
    private var knownScan = ScreenshotProcessScan()
    private var session: Session?
    private var sessionCounter = 0
    private let rectTracker = RectHeuristicTracker()
    private var eventTap: EventTap?
    private var reportedProblems: Set<Problem> = []
    private var lastHealthCheck = Date.distantPast
    private static let healthCheckInterval: TimeInterval = 5

    public init(options: Options = Options()) {
        self.options = options
        queue.setSpecific(key: queueKey, value: ())
    }

    deinit {
        stop()
    }

    public var isRunning: Bool { onQueue { pollTimer != nil } }

    /// True while the event tap that follows interactive selections is installed and enabled.
    public var eventTapActive: Bool { onQueue { eventTap?.isEnabled ?? false } }

    public func start() {
        onQueue { startOnQueue() }
    }

    /// Stops polling and removes the event tap. An open session ends with `cancelled: true`.
    public func stop() {
        onQueue { stopOnQueue() }
    }

    /// Tests: run `body` synchronously on the monitor's queue (e.g. to drive `poll()`).
    func performOnQueue(_ body: () -> Void) {
        onQueue(body)
    }

    /// Run `body` on the queue, synchronously; re-entrant when already on it.
    private func onQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil { return body() }
        return queue.sync(execute: body)
    }

    private func startOnQueue() {
        guard pollTimer == nil else { return }

        rectTracker.onRectChanged = { [weak self] rect in
            self?.handleRectChanged(rect)
        }

        if options.writeTempFile, options.staleTempFileAge > 0 {
            let removed = ScreenCapture.removeStaleTempFiles(olderThan: options.staleTempFileAge, directory: options.tempDirectory)
            if removed > 0 { log("removed \(removed) stale temp image(s)") }
        }

        // Baseline: screenshot processes that already exist are not new sessions.
        knownScan = env.scan()
        reportedProblems = []

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + options.pollInterval, repeating: options.pollInterval, leeway: .milliseconds(5))
        timer.setEventHandler { [weak self] in self?.poll() }
        pollTimer = timer
        timer.resume()

        installEventTap()
        emit(["type": "ready"])
        guard pollTimer != nil else { return } // stopped from inside the `ready` callback
        lastHealthCheck = Date()
        if eventTap == nil, options.installsEventTap {
            report(.accessibilityDenied, "Failed to create event tap — grant Accessibility (System Settings → Privacy & Security → Accessibility). Interactive screenshots will not be tracked until then.")
        }
        if !env.hasScreenRecordingPermission() {
            report(.screenRecordingDenied, ScreenCapture.screenRecordingDeniedMessage)
        }
    }

    private func stopOnQueue() {
        guard pollTimer != nil else { return }
        if session != nil { endSession(cancelled: true) }
        pollTimer?.cancel()
        pollTimer = nil
        timeoutTimer?.cancel()
        timeoutTimer = nil
        eventTap?.stop()
        eventTap = nil
        session = nil
        knownScan = ScreenshotProcessScan()
        rectTracker.reset()
    }

    private func installEventTap() {
        guard options.installsEventTap else { return }
        let tap = EventTap()
        tap.onMouse = { [weak self] type, location in
            self?.queue.async { self?.handleMouse(type: type, location: location) }
        }
        tap.onKeyDown = { [weak self] keyCode, isRepeat in
            self?.queue.async { self?.handleKeyDown(keyCode: keyCode, isRepeat: isRepeat) }
        }
        eventTap = tap.start() ? tap : nil
    }

    /// Every few seconds: recover the event tap (permission granted later, or the system disabled
    /// it) and report when it cannot be recovered.
    private func checkHealth() {
        let now = Date()
        guard now.timeIntervalSince(lastHealthCheck) >= Self.healthCheckInterval else { return }
        lastHealthCheck = now

        if let tap = eventTap {
            if !tap.isEnabled {
                tap.reenable()
                if !tap.isEnabled {
                    report(.eventTapDisabled, "Event tap was disabled by the system and could not be re-enabled (Accessibility revoked?). Interactive screenshots are not being tracked.")
                    // Drop it so the next check tries a fresh tap (works once permission is back).
                    tap.stop()
                    eventTap = nil
                }
            } else {
                clear(.eventTapDisabled)
            }
        } else if options.installsEventTap {
            installEventTap()
            if eventTap != nil {
                log("event tap installed")
                clear(.accessibilityDenied)
                clear(.eventTapDisabled)
            }
        }

        if env.hasScreenRecordingPermission() { clear(.screenRecordingDenied) }
    }

    // MARK: - Process polling

    func poll() {
        checkHealth()

        let scan = env.scan()
        let previous = knownScan
        knownScan = scan

        for pid in scan.screencaptureui.subtracting(previous.screencaptureui).sorted() {
            emit(["type": "screencaptureui_started", "pid": Int(pid)])
        }
        for pid in previous.screencaptureui.subtracting(scan.screencaptureui).sorted() {
            emit(["type": "screencaptureui_ended", "pid": Int(pid)])
        }

        let appeared = scan.screencapture.subtracting(previous.screencapture)
        let exited = previous.screencapture.subtracting(scan.screencapture)

        for pid in appeared.sorted() {
            let args = env.arguments(pid) ?? []
            let invocation = ScreencaptureInvocation(arguments: args)
            log("screencapture pid \(pid) argv=\(args) → mode=\(invocation.mode) dest=\(invocation.destination) interactive=\(invocation.interactive) origin=\(invocation.origin)")
            if options.hotkeyOnly && invocation.origin != .hotkey {
                log("ignoring non-hotkey screencapture pid \(pid)")
                continue
            }
            if session != nil {
                // A new hotkey while a session is open supersedes it.
                endSession(cancelled: true)
            }
            beginSession(pid: pid, invocation: invocation)
        }

        if let current = session, exited.contains(current.pid), !current.invocation.interactive, !current.captureInFlight {
            // Non-interactive: the capture is complete the moment the process exits.
            // (Cmd+Shift+3 writes one file per display; we reproduce the display under the cursor.)
            if let windowID = current.invocation.windowID {
                captureWindow(windowID)
            } else {
                let rect = current.invocation.explicitRect
                let point = rect.map { CGPoint(x: $0.midX, y: $0.midY) } ?? env.mouseLocation()
                captureDisplay(env.displayContaining(point), rect: rect)
            }
        }
    }

    private func beginSession(pid: pid_t, invocation: ScreencaptureInvocation) {
        sessionCounter += 1
        session = Session(id: sessionCounter, pid: pid, invocation: invocation, startedAt: Date())
        rectTracker.reset()
        emit([
            "type": "screencapture_started",
            "pid": Int(pid),
            "mode": invocation.mode.rawValue,
            "destination": invocation.destination.rawValue,
            "origin": invocation.origin.rawValue,
        ])
        onSessionStarted?(invocation.mode, invocation.destination)

        timeoutTimer?.cancel()
        let sessionID = sessionCounter
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + options.sessionTimeout)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.session?.id == sessionID else { return }
            self.log("session timed out")
            self.endSession(cancelled: true)
        }
        timeoutTimer = timer
        timer.resume()
    }

    private func endSession(cancelled: Bool, capture: Capture? = nil) {
        guard let current = session else { return }
        session = nil
        timeoutTimer?.cancel()
        timeoutTimer = nil
        rectTracker.reset()

        emit(ScreenshotWire.ended(
            pid: current.pid,
            mode: capture?.mode ?? current.effectiveMode,
            destination: current.invocation.destination,
            origin: current.invocation.origin,
            cancelled: cancelled,
            capture: capture,
            mimeType: options.tempFileFormat.mimeType
        ))
        if let capture = capture { onCapture?(capture) }
        onSessionEnded?(cancelled)
    }

    // MARK: - Input handling

    func handleMouse(type: CGEventType, location: CGPoint) {
        guard var current = session, current.invocation.interactive, !current.captureInFlight else { return }

        switch type {
        case .leftMouseDown:
            if current.displayID == nil {
                current.displayID = env.displayContaining(location)
            }
            current.sawMouseDown = true
            session = current
            rectTracker.handleMouseDown(at: location)

        case .leftMouseDragged:
            rectTracker.handleMouseDragged(to: location)

        case .leftMouseUp:
            // A release whose press began before the session (e.g. the button was held while
            // the hotkey fired) is not a selection gesture.
            guard current.sawMouseDown else { return }
            let travelled = rectTracker.handleMouseUp(at: location)
            let rect = rectTracker.getCurrentRect()

            switch current.invocation.mode {
            case .selection, .window:
                if current.windowMode || current.invocation.mode == .window {
                    if travelled < 4, let windowID = env.windowAt(location, exclusions()) {
                        captureWindow(windowID)
                    } else {
                        // Click over no window, or a drag in window mode: the system UI closes
                        // without capturing, so the session ends here (otherwise a later click
                        // would be captured as a phantom screenshot).
                        log("window-mode release without a window → cancel")
                        endSession(cancelled: true)
                    }
                } else if let rect = rect, rect.width >= 2, rect.height >= 2, travelled >= 2 {
                    captureDisplay(env.displayContaining(CGPoint(x: rect.midX, y: rect.midY)), rect: rect)
                } else {
                    // Click without drag (or a sub-2pt drag): the selection UI closes without a
                    // capture. Ending here keeps the next drag from becoming a phantom capture.
                    log("selection release without a region → cancel")
                    endSession(cancelled: true)
                }
            case .interactive:
                // A click (not a drag) on the right end of the Cmd+Shift+5 toolbar is the Capture button.
                if travelled < 4, let toolbar = env.toolbarBounds(), toolbar.contains(location),
                   location.x >= toolbar.maxX - 130 {
                    capturePanelSelection()
                }
            default:
                break
            }

        default:
            break
        }
    }

    func handleKeyDown(keyCode: Int64, isRepeat: Bool) {
        guard var current = session, current.invocation.interactive, !current.captureInFlight else { return }
        switch keyCode {
        case 53: // Esc
            log("Esc → cancel")
            endSession(cancelled: true)
        case 49: // Space toggles window mode during region selection
            // Holding Space while dragging moves the selection instead, and key auto-repeat must
            // not flip the mode back and forth.
            if current.invocation.mode == .selection, !isRepeat, !rectTracker.isDragging {
                current.windowMode.toggle()
                session = current
                rectTracker.reset()
            }
        case 36, 76: // Return / Enter capture in the Cmd+Shift+5 panel
            if current.invocation.mode == .interactive, !isRepeat {
                capturePanelSelection()
            }
        default:
            break
        }
    }

    /// Called synchronously by `rectTracker`, which only runs on `queue`.
    private func handleRectChanged(_ rect: CGRect) {
        guard let current = session else { return }
        let displayID = current.displayID ?? env.displayContaining(CGPoint(x: rect.midX, y: rect.midY))
        emit([
            "type": "selection_rect_changed",
            "rect": ScreenshotWire.rect(rect),
            "displayId": String(displayID),
        ])
        onSelectionChanged?(rect)
    }

    // MARK: - Capture

    private func exclusions() -> ScreenCapture.Exclusions {
        var ex = ScreenCapture.Exclusions()
        ex.bundleIdentifiers.formUnion(options.excludedBundleIdentifiers)
        if options.excludeOwnProcess { ex.pids.insert(getpid()) }
        ex.pids.formUnion(knownScan.screencapture)
        return ex
    }

    /// Cmd+Shift+5 panel: the panel remembers its capture style in the screencapture defaults.
    private func capturePanelSelection() {
        let style = env.panelStyle() ?? "selection"
        let location = env.mouseLocation()
        if style == "window", let windowID = env.windowAt(location, exclusions()) {
            captureWindow(windowID)
            return
        }
        if style == "selection", let rect = rectTracker.getCurrentRect(), rect.width >= 2, rect.height >= 2 {
            captureDisplay(env.displayContaining(CGPoint(x: rect.midX, y: rect.midY)), rect: rect)
            return
        }
        captureDisplay(env.displayContaining(location), rect: nil)
    }

    private func captureDisplay(_ displayID: CGDirectDisplayID, rect: CGRect?) {
        guard var current = session else { return }
        current.captureInFlight = true
        session = current
        let sessionID = current.id
        let delay = current.invocation.interactive ? options.captureDelay : 0.03
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, self.session?.id == sessionID else { return }
            self.env.captureDisplay(displayID, rect, self.exclusions()) { image, error in
                self.queue.async { self.finishCapture(sessionID: sessionID, image: image, rect: rect, displayID: displayID, error: error) }
            }
        }
    }

    private func captureWindow(_ windowID: CGWindowID) {
        guard var current = session else { return }
        current.captureInFlight = true
        session = current
        let sessionID = current.id
        queue.asyncAfter(deadline: .now() + options.captureDelay) { [weak self] in
            guard let self = self, self.session?.id == sessionID else { return }
            // Resolve the display from the window itself (the cursor may be elsewhere for `-l`).
            let center = self.env.windowBounds(windowID).map { CGPoint(x: $0.midX, y: $0.midY) }
            let displayID = self.env.displayContaining(center ?? self.env.mouseLocation())
            self.env.captureWindow(windowID) { image, error in
                self.queue.async { self.finishCapture(sessionID: sessionID, image: image, rect: nil, displayID: displayID, error: error) }
            }
        }
    }

    private func finishCapture(sessionID: Int, image: CGImage?, rect: CGRect?, displayID: CGDirectDisplayID, error: String?) {
        guard let current = session, current.id == sessionID else { return }
        if let error = error { log("capture warning: \(error)") }
        guard let image = image else {
            let reason = error ?? "capture returned no image"
            emit(["type": "screenshot_capture_failed", "reason": reason, "displayId": String(displayID)])
            if !env.hasScreenRecordingPermission() {
                report(.screenRecordingDenied, ScreenCapture.screenRecordingDeniedMessage)
            }
            endSession(cancelled: true)
            return
        }
        var path: String? = nil
        if options.writeTempFile {
            path = ScreenCapture.writeTemp(image, as: options.tempFileFormat, directory: options.tempDirectory)
            if path == nil { log("failed to write temp image") }
        }
        let capture = Capture(
            image: image,
            rect: rect,
            displayID: displayID,
            scale: env.backingScale(displayID),
            mode: current.effectiveMode,
            destination: current.invocation.destination,
            origin: current.invocation.origin,
            tempFilePath: path,
            timestamp: Date()
        )
        endSession(cancelled: false, capture: capture)
    }

    // MARK: - Output

    private func emit(_ obj: [String: Any]) {
        var payload = obj
        payload["timestamp"] = Int(Date().timeIntervalSince1970 * 1000)
        onEvent?(payload)
    }

    private func report(_ problem: Problem, _ message: String) {
        guard !reportedProblems.contains(problem) else { return }
        reportedProblems.insert(problem)
        // Permission problems are always printed: they explain why nothing is being detected.
        fputs("[ScreenshotMonitor] \(message)\n", stderr)
        emit(["type": "error", "code": problem.rawValue, "message": message])
        onError?(problem, message)
    }

    private func clear(_ problem: Problem) {
        reportedProblems.remove(problem)
    }

    private func log(_ message: String) {
        guard options.debugLogging else { return }
        fputs("[ScreenshotMonitor] \(message)\n", stderr)
    }
}

// MARK: - Wire payloads

/// Builders for the JSON-able dictionaries shared by `onEvent` and the helper's stdout.
enum ScreenshotWire {
    static func rect(_ r: CGRect) -> [String: Any] {
        return ["x": Double(r.origin.x), "y": Double(r.origin.y), "width": Double(r.width), "height": Double(r.height)]
    }

    static func ended(
        pid: pid_t,
        mode: ScreenshotMonitor.Mode,
        destination: ScreenshotMonitor.Destination,
        origin: ScreenshotMonitor.Origin = .unknown,
        cancelled: Bool,
        capture: ScreenshotMonitor.Capture?,
        mimeType: String
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "type": "screencapture_ended",
            "pid": Int(pid),
            "mode": mode.rawValue,
            "destination": destination.rawValue,
            "origin": origin.rawValue,
            "cancelled": cancelled,
        ]
        if let capture = capture {
            payload["imageWidth"] = capture.image.width
            payload["imageHeight"] = capture.image.height
            payload["displayId"] = String(capture.displayID)
            payload["scale"] = Double(capture.scale)
            if let path = capture.tempFilePath {
                payload["imagePath"] = path
                payload["imageMimeType"] = mimeType
            }
            if let rect = capture.rect {
                payload["rect"] = Self.rect(rect)
            }
        }
        return payload
    }
}

// MARK: - Event tap

/// Listen-only CGEventTap for the mouse buttons/drags and key downs the monitor needs.
/// Runs its own thread + run loop so a busy host main thread cannot starve it. Callbacks are
/// invoked on that thread.
final class EventTap {
    var onMouse: ((CGEventType, CGPoint) -> Void)?
    /// (keyCode, isAutoRepeat)
    var onKeyDown: ((Int64, Bool) -> Void)?

    private let lock = NSLock()
    private var port: CFMachPort?
    private var runLoop: CFRunLoop?

    /// Returns false when the tap cannot be created (Accessibility / Input Monitoring missing).
    func start() -> Bool {
        let mask: CGEventMask =
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.leftMouseDragged.rawValue) |
            (1 << CGEventType.leftMouseUp.rawValue) |
            (1 << CGEventType.keyDown.rawValue)

        // Unretained is safe: the tap thread below holds a strong reference to `self` until its
        // run loop exits, and no callback can fire after that.
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
            let tap = Unmanaged<EventTap>.fromOpaque(refcon).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                tap.reenable()
                return Unmanaged.passUnretained(event)
            }
            if type == .keyDown {
                tap.onKeyDown?(event.getIntegerValueField(.keyboardEventKeycode),
                               event.getIntegerValueField(.keyboardEventAutorepeat) != 0)
            } else {
                tap.onMouse?(type, event.location)
            }
            return Unmanaged.passUnretained(event)
        }

        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: refcon
        ) else {
            return false
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else {
            CFMachPortInvalidate(port)
            return false
        }
        lock.lock()
        self.port = port
        lock.unlock()

        let ready = DispatchSemaphore(value: 0)
        let thread = Thread { [self] in
            let rl = CFRunLoopGetCurrent()
            CFRunLoopAddSource(rl, source, .commonModes)
            self.lock.lock()
            self.runLoop = rl
            self.lock.unlock()
            CGEvent.tapEnable(tap: port, enable: true)
            ready.signal()
            // Returns after stop(): CFRunLoopStop, or the invalidated port leaves no sources.
            CFRunLoopRun()
            CFRunLoopRemoveSource(rl, source, .commonModes)
        }
        thread.name = "ausm.screenshot-monitor.tap"
        thread.start()
        ready.wait()
        return true
    }

    var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let port = port else { return false }
        return CGEvent.tapIsEnabled(tap: port)
    }

    func stop() {
        lock.lock()
        let port = self.port
        let rl = runLoop
        self.port = nil
        runLoop = nil
        lock.unlock()
        if let port = port {
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
        }
        if let rl = rl { CFRunLoopStop(rl) }
    }

    func reenable() {
        lock.lock()
        let port = self.port
        lock.unlock()
        if let port = port { CGEvent.tapEnable(tap: port, enable: true) }
    }
}
