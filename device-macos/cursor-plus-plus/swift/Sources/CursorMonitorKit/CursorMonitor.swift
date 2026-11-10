import AppKit
import CoreGraphics
import Foundation

/// Monitors mouse events via a listen-only CGEventTap and reports them through `onEvent`.
/// Interaction events (clicks, scrolls, holds) are enriched with the window and the
/// accessibility element under the cursor.
///
/// Threading: the tap is attached to the **main run loop**, so `onEvent` is always invoked on
/// the main thread and AX enrichment runs there (each AX call is bounded by a 250 ms timeout).
/// Call `start()`/`stop()` on the main thread and release the monitor there. The main run loop
/// must be running (NSApplication, or `RunLoop.main.run()` in a command-line tool).
///
/// Permissions: Accessibility. `start()` returns false when the tap cannot be created. If the
/// system later disables the tap and it cannot be re-enabled (e.g. Accessibility revoked), an
/// event with `type == "error"`, `code == "event_tap_disabled"` is delivered once.
public final class CursorMonitor {
    public struct Options {
        /// Minimum interval between MOVE events, and separately between DRAG events (seconds).
        /// 0 reports every move / drag.
        public var moveThrottle: TimeInterval = 0.05
        /// Press duration that counts as a hold (ms).
        public var holdThresholdMs: Double = 400
        /// Max cursor travel during a hold (points).
        public var holdMoveTolerance: Double = 5
        /// Skip windows owned by the host process when resolving the window under the cursor.
        public var ignoreOwnWindows = true
        /// Run AX/window enrichment for interactions (clicks, scrolls, holds).
        public var enrichInteractions = true
        /// Restrict enrichment to these actions (nil = every interaction). Hosts that only care
        /// about e.g. DOUBLE_CLICK avoid an AX round-trip on every scroll tick.
        public var enrichedActions: Set<String>? = nil

        public init() {}
    }

    /// Called on the main thread for every event. `context` carries the live AXUIElement for
    /// enriched events (nil for MOVE/DRAG and non-enriched actions).
    public var onEvent: ((CursorEvent, CursorContext?) -> Void)?

    private let options: Options
    private(set) var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var healthTimer: DispatchSourceTimer?
    private var tapDisabledReported = false

    // Hold detection state
    private var hold: HoldTracker
    private var holdTimer: DispatchWorkItem?

    // Move / drag throttling
    private var moveThrottle: EventThrottle
    private var dragThrottle: EventThrottle

    /// Monotonic seconds used for throttling and hold timing (injectable for tests). Wall-clock
    /// time (CFAbsoluteTime) jumps when the system clock is changed, which used to stall the
    /// throttles or report bogus hold durations.
    var clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }

    public init(options: Options = Options()) {
        self.options = options
        self.hold = HoldTracker(thresholdMs: options.holdThresholdMs, tolerance: options.holdMoveTolerance)
        self.moveThrottle = EventThrottle(interval: options.moveThrottle)
        self.dragThrottle = EventThrottle(interval: options.moveThrottle)
    }

    deinit {
        stop()
    }

    public var isRunning: Bool { tap != nil }

    /// Returns false when the event tap could not be created (missing Accessibility permission).
    @discardableResult
    public func start() -> Bool {
        if tap != nil { return true }
        var eventMask: CGEventMask = 0
        eventMask |= (1 << CGEventType.mouseMoved.rawValue)
        eventMask |= (1 << CGEventType.leftMouseDown.rawValue)
        eventMask |= (1 << CGEventType.leftMouseUp.rawValue)
        eventMask |= (1 << CGEventType.rightMouseDown.rawValue)
        eventMask |= (1 << CGEventType.rightMouseUp.rawValue)
        eventMask |= (1 << CGEventType.otherMouseDown.rawValue)
        eventMask |= (1 << CGEventType.otherMouseUp.rawValue)
        eventMask |= (1 << CGEventType.scrollWheel.rawValue)
        eventMask |= (1 << CGEventType.leftMouseDragged.rawValue)
        eventMask |= (1 << CGEventType.rightMouseDragged.rawValue)

        // Unretained: stop() (also run from deinit) removes the source from the main run loop
        // before `self` goes away, and callbacks only run on that run loop.
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()

        guard let newTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: eventMask,
            callback: cursorEventCallback,
            userInfo: selfPtr
        ) else {
            return false
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0) else {
            CFMachPortInvalidate(newTap)
            return false
        }

        self.tap = newTap
        self.runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: newTap, enable: true)
        tapDisabledReported = false
        startHealthTimer()

        emit(CursorEvent(type: "ready"), nil)
        return true
    }

    public func stop() {
        healthTimer?.cancel()
        healthTimer = nil
        holdTimer?.cancel()
        holdTimer = nil
        hold.reset()
        if let t = tap {
            CGEvent.tapEnable(tap: t, enable: false)
            CFMachPortInvalidate(t)
        }
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        tap = nil
        runLoopSource = nil
    }

    func reEnableTap() {
        if let t = tap {
            CGEvent.tapEnable(tap: t, enable: true)
        }
    }

    /// The system disables a tap that times out or when Accessibility is revoked; the callback
    /// re-enables it, but a revoked tap never calls back — so poll.
    private func startHealthTimer() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 5, repeating: 5, leeway: .seconds(1))
        timer.setEventHandler { [weak self] in
            guard let self = self, let t = self.tap else { return }
            if CGEvent.tapIsEnabled(tap: t) {
                self.tapDisabledReported = false
                return
            }
            CGEvent.tapEnable(tap: t, enable: true)
            if !CGEvent.tapIsEnabled(tap: t), !self.tapDisabledReported {
                self.tapDisabledReported = true
                var event = CursorEvent(type: "error")
                event.code = "event_tap_disabled"
                event.message = "Event tap was disabled and could not be re-enabled (Accessibility revoked?). No cursor events are being delivered."
                self.emit(event, nil)
            }
        }
        healthTimer = timer
        timer.resume()
    }

    // MARK: - Event Handling

    func handleEvent(_ type: CGEventType, _ cgEvent: CGEvent) {
        let point = cgEvent.location
        let now = clock()

        switch type {
        case .mouseMoved:
            handleMove(point, now: now)

        case .leftMouseDown:
            hold.mouseDown(at: point, time: now)
            scheduleHoldCheck()
            let clickCount = Int(cgEvent.getIntegerValueField(.mouseEventClickState))
            if clickCount >= 2 {
                emitInteraction(action: "DOUBLE_CLICK", point: point, button: 0, clickCount: clickCount)
            } else {
                emitInteraction(action: "CLICK", point: point, button: 0, clickCount: clickCount)
            }

        case .leftMouseUp:
            holdTimer?.cancel()
            holdTimer = nil
            if let elapsed = hold.mouseUp(at: point, time: now) {
                emitInteraction(action: "HOLD_END", point: point, button: 0, holdDurationMs: elapsed)
            }

        case .rightMouseDown:
            emitInteraction(action: "RIGHT_CLICK", point: point, button: 2,
                            clickCount: Int(cgEvent.getIntegerValueField(.mouseEventClickState)))

        case .otherMouseDown:
            emitInteraction(action: "CLICK", point: point, button: 1,
                            clickCount: Int(cgEvent.getIntegerValueField(.mouseEventClickState)))

        case .scrollWheel:
            let dy = cgEvent.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)
            let dx = cgEvent.getDoubleValueField(.scrollWheelEventPointDeltaAxis2)
            emitScroll(point: point, deltaX: dx, deltaY: dy)

        case .leftMouseDragged, .rightMouseDragged:
            let button = (type == .leftMouseDragged) ? 0 : 2
            if type == .leftMouseDragged, let elapsed = hold.update(at: point, time: now) {
                emitInteraction(action: "HOLD_START", point: hold.downPoint, button: 0, holdDurationMs: elapsed)
            }
            if dragThrottle.shouldEmit(at: now) {
                emitDrag(point: point, button: button)
            }

        default:
            break
        }
    }

    /// A perfectly still press produces no drag events, so a timer fires HOLD_START.
    private func scheduleHoldCheck() {
        holdTimer?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self = self, self.hold.isPressed else { return }
            if let elapsed = self.hold.update(at: nil, time: self.clock()) {
                self.emitInteraction(action: "HOLD_START", point: self.hold.downPoint, button: 0, holdDurationMs: elapsed)
            }
        }
        holdTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + options.holdThresholdMs / 1000, execute: item)
    }

    // MARK: - Emit Helpers

    private func handleMove(_ point: CGPoint, now: TimeInterval) {
        guard moveThrottle.shouldEmit(at: now) else { return }

        var event = CursorEvent(type: "cursor-event")
        event.action = "MOVE"
        event.x = Double(point.x)
        event.y = Double(point.y)
        emit(event, nil)
    }

    private func emitInteraction(action: String, point: CGPoint, button: Int,
                                 clickCount: Int = 1, holdDurationMs: Double? = nil) {
        var event = CursorEvent(type: "cursor-event")
        event.action = action
        event.x = Double(point.x)
        event.y = Double(point.y)
        event.button = button
        event.clickCount = clickCount
        event.holdDurationMs = holdDurationMs

        let context = enrichWithContext(&event, at: point, action: action)
        emit(event, context)
    }

    private func emitScroll(point: CGPoint, deltaX: Double, deltaY: Double) {
        var event = CursorEvent(type: "cursor-event")
        event.action = "SCROLL"
        event.x = Double(point.x)
        event.y = Double(point.y)
        event.scrollDeltaX = deltaX
        event.scrollDeltaY = deltaY

        let context = enrichWithContext(&event, at: point, action: "SCROLL")
        emit(event, context)
    }

    private func emitDrag(point: CGPoint, button: Int) {
        var event = CursorEvent(type: "cursor-event")
        event.action = "DRAG"
        event.x = Double(point.x)
        event.y = Double(point.y)
        event.button = button
        emit(event, nil)
    }

    private func enrichWithContext(_ event: inout CursorEvent, at point: CGPoint, action: String) -> CursorContext? {
        guard options.enrichInteractions else { return nil }
        if let allowed = options.enrichedActions, !allowed.contains(action) { return nil }
        let excluded: Set<pid_t> = options.ignoreOwnWindows ? [getpid()] : []
        let win = windowAtPoint(point, excludingPIDs: excluded)
        if let win = win {
            event.windowId = win.windowId
            event.windowTitle = win.title
            event.ownerName = win.ownerName
            event.bundleId = win.bundleId.isEmpty ? nil : win.bundleId
            event.windowX = Double(win.bounds.origin.x)
            event.windowY = Double(win.bounds.origin.y)
            event.windowWidth = Double(win.bounds.size.width)
            event.windowHeight = Double(win.bounds.size.height)
        }

        let ax = axElementAtPoint(point)
        event.uiElementRole = ax.role
        event.uiElementSubrole = ax.subrole
        event.uiElementLabel = ax.label
        event.uiElementDescription = ax.description
        event.uiElementValue = ax.value
        event.uiElementIsEditableText = ax.isEditableText

        // Desktop-level elements (e.g. Finder's desktop) have no CGWindow at layer 0; still
        // report which app owns the element so consumers can route on it.
        if event.bundleId == nil, let element = ax.element {
            var pid: pid_t = 0
            if AXUIElementGetPid(element, &pid) == .success, let app = NSRunningApplication(processIdentifier: pid) {
                event.bundleId = app.bundleIdentifier
                event.ownerName = app.localizedName
            }
        }
        return CursorContext(element: ax.element, window: win)
    }

    private func emit(_ event: CursorEvent, _ context: CursorContext?) {
        onEvent?(event, context)
    }
}

// MARK: - C Callback

private func cursorEventCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo = userInfo else { return Unmanaged.passUnretained(event) }
    let monitor = Unmanaged<CursorMonitor>.fromOpaque(userInfo).takeUnretainedValue()

    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        monitor.reEnableTap()
        return Unmanaged.passUnretained(event)
    }

    monitor.handleEvent(type, event)
    return Unmanaged.passUnretained(event)
}
