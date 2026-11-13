/// TextInputMonitor — monitors focus changes across applications and detects when the user
/// enters / leaves / types in editable text elements (text fields, text areas, combo boxes).
/// Password fields (AXSecureTextField) are never tracked.
///
/// Uses AXObserver for:
///   1. kAXFocusedUIElementChangedNotification — focus into/out of editable elements
///   2. kAXValueChangedNotification — typing within the tracked element
/// and NSWorkspace app activation/termination so the observer follows the frontmost app.
/// Session rules live in `TextEditTracker` (pure, unit-tested).

import AppKit
import ApplicationServices
import Foundation

/// Reports TEXT_EDITING_STARTED / UPDATED / FINISHED for the focused text input of the
/// frontmost app.
///
/// Threading: every callback (`onEvent`, `onError`) is invoked on the monitor's private serial
/// queue. Hop to the main actor yourself for UI work, and never block that queue waiting on the
/// main thread. Assign callbacks before `start()`. `start()` (asynchronous: setup happens on the
/// queue, `.ready` is the first event) and `stop()` (synchronous; emits a final FINISHED for an
/// edit in progress before returning) are idempotent and safe from any thread, including from
/// inside a callback. AX notifications need the **main run loop** to be running (NSApplication,
/// or `RunLoop.main.run()` in a command-line tool).
///
/// Permissions: Accessibility. When it is missing `onError(.accessibilityDenied, …)` is called
/// and no events arrive; the monitor re-checks every `permissionCheckInterval` and attaches by
/// itself once it is granted (`.permissionChanged` is delivered on every change).
///
/// Privacy: password fields produce no events, no value reads and no value observer. Typed text
/// only ever leaves the monitor inside `TextInputEvent.text`. The host process's own text fields
/// are not observed.
public final class TextInputMonitor: @unchecked Sendable {
    public struct Options: Sendable {
        /// Delay before FINISHED when focus leaves a text input, to filter intermediate focus
        /// notifications (seconds).
        public var finishDebounce: TimeInterval = 0.2
        /// AX messaging timeout (seconds). This is set on the system-wide element, which macOS
        /// applies to **every AX call in the process**. Nil leaves the process setting alone.
        public var axMessagingTimeout: Float? = 0.5
        /// How often Accessibility is re-checked (seconds).
        public var permissionCheckInterval: TimeInterval = 2
        /// Cap on `TextInputEvent.text` in characters; longer values are cut and flagged with
        /// `textTruncated`. 0 or less disables the cap. Default 100 000.
        public var maxTextLength = 100_000

        public init() {}

        /// Parse `--max-text-length N` (TextInputHelper's command line).
        public static func fromArguments(_ args: [String]) -> Options {
            var o = Options()
            if let i = args.firstIndex(of: "--max-text-length"), i + 1 < args.count,
               let n = Int(args[i + 1]), n > 0 {
                o.maxTextLength = n
            }
            return o
        }
    }

    /// Problems reported through `onError`, each once until it clears.
    public enum Problem: String, Sendable {
        case accessibilityDenied = "accessibility_denied"
    }

    /// Called on the monitor's private queue.
    public var onEvent: ((TextInputMonitorEvent) -> Void)?
    /// Called on the monitor's private queue.
    public var onError: ((Problem, String) -> Void)?

    public let options: Options

    private let queue = DispatchQueue(label: "ausm.text-input-monitor")
    private let queueKey = DispatchSpecificKey<Void>()
    /// A just-launched app often rejects AXObserverAddNotification until its AX server is up.
    private let maxAttachAttempts = 6
    private let attachRetryDelay: DispatchTimeInterval = .milliseconds(500)

    private var running = false
    private var focusObserver: AXObserver?
    private var valueObserver: AXObserver?
    private var monitoredPID: pid_t = 0
    private var pendingAttach: DispatchWorkItem?
    private var pendingFinish: DispatchWorkItem?
    private var tracker = TextEditTracker<AXUIElement>()
    private let selfPID = ProcessInfo.processInfo.processIdentifier

    private var workspaceObservers: [NSObjectProtocol] = []
    private var permissionTimer: DispatchSourceTimer?
    private var accessibilityTrusted = false
    private var reportedDenied = false

    /// AX callback refcon: a retained box with a weak reference, so a notification in flight
    /// when the monitor is released is dropped instead of touching freed memory. Released on the
    /// main queue after any in-progress callback (which runs on the main run loop) returned.
    private final class CallbackBox {
        weak var target: TextInputMonitor?
    }

    private let box = CallbackBox()
    private lazy var refcon: UnsafeMutableRawPointer = Unmanaged.passRetained(box).toOpaque()

    public init(options: Options = Options()) {
        self.options = options
        queue.setSpecific(key: queueKey, value: ())
        box.target = self
    }

    deinit {
        stop()
        let unmanaged = Unmanaged<CallbackBox>.fromOpaque(refcon)
        DispatchQueue.main.async { unmanaged.release() }
    }

    public var isRunning: Bool { onQueue { running } }

    public func start() {
        if DispatchQueue.getSpecific(key: queueKey) != nil {
            startOnQueue()
        } else {
            queue.async { [self] in startOnQueue() }
        }
    }

    /// Synchronous: emits a final FINISHED for an in-progress edit, then tears down.
    public func stop() {
        onQueue { stopOnQueue() }
    }

    // MARK: - Lifecycle

    private func startOnQueue() {
        guard !running else { return }
        running = true
        reportedDenied = false
        if let timeout = options.axMessagingTimeout {
            AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), timeout)
        }
        registerWorkspaceNotifications()

        accessibilityTrusted = AXIsProcessTrusted()
        deliver(.ready(accessibilityTrusted: accessibilityTrusted))
        reportPermission()
        guard running else { return } // stopped from inside a callback

        attachToFrontmostApp()

        // Accessibility can be granted or revoked while we run.
        let t = DispatchSource.makeTimerSource(queue: queue)
        let interval = max(options.permissionCheckInterval, 0.1)
        t.schedule(deadline: .now() + interval, repeating: interval)
        t.setEventHandler { [weak self] in self?.checkPermission() }
        permissionTimer = t
        t.resume()
    }

    private func stopOnQueue() {
        guard running else { return }
        permissionTimer?.cancel()
        permissionTimer = nil
        perform(tracker.endSession())
        running = false
        tearDownObservers()
        unregisterWorkspaceNotifications()
    }

    private func checkPermission() {
        guard running else { return }
        let trusted = AXIsProcessTrusted()
        guard trusted != accessibilityTrusted else { return }
        accessibilityTrusted = trusted
        deliver(.permissionChanged(accessibilityTrusted: trusted))
        reportPermission()
        guard running else { return }
        if trusted {
            attachToFrontmostApp()
        } else {
            perform(tracker.endSession())
            tearDownObservers()
        }
    }

    private func reportPermission() {
        if accessibilityTrusted {
            reportedDenied = false
        } else if !reportedDenied {
            reportedDenied = true
            onError?(.accessibilityDenied, "Accessibility permission not granted; no events until it is. Grant it in System Settings > Privacy & Security > Accessibility.")
        }
    }

    private func attachToFrontmostApp() {
        guard let frontmost = NSWorkspace.shared.frontmostApplication else { return }
        let pid = frontmost.processIdentifier
        guard pid != selfPID else { return }
        tearDownObservers()
        setupObserver(for: pid, attempt: 1)
    }

    // MARK: - NSWorkspace app activation

    private func registerWorkspaceNotifications() {
        let nc = NSWorkspace.shared.notificationCenter

        workspaceObservers.append(nc.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: nil
        ) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication else { return }
            let pid = app.processIdentifier
            self?.queue.async { self?.handleAppActivated(pid: pid) }
        })

        workspaceObservers.append(nc.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification,
            object: nil, queue: nil
        ) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication else { return }
            let pid = app.processIdentifier
            self?.queue.async { self?.handleAppTerminated(pid: pid) }
        })
    }

    private func unregisterWorkspaceNotifications() {
        let nc = NSWorkspace.shared.notificationCenter
        for obs in workspaceObservers {
            nc.removeObserver(obs)
        }
        workspaceObservers.removeAll()
    }

    private func handleAppActivated(pid: pid_t) {
        guard running, pid != selfPID else { return }
        // Already attached (or attaching) to this app.
        if pid == monitoredPID, focusObserver != nil || pendingAttach != nil { return }
        perform(tracker.endSession())
        guard running else { return }
        tearDownObservers()
        setupObserver(for: pid, attempt: 1)
    }

    private func handleAppTerminated(pid: pid_t) {
        guard running, pid == monitoredPID else { return }
        perform(tracker.endSession())
        tearDownObservers()
    }

    // MARK: - AXObserver setup

    private func makeObserver(pid: pid_t) -> AXObserver? {
        var obs: AXObserver?
        let result = AXObserverCreate(pid, { (_, element, notification, refcon) in
            guard let refcon,
                  let monitor = Unmanaged<CallbackBox>.fromOpaque(refcon).takeUnretainedValue().target
            else { return }
            let el = element
            let notif = notification as String
            monitor.queue.async {
                monitor.handleNotification(notif, element: el)
            }
        }, &obs)
        return result == .success ? obs : nil
    }

    private func setupObserver(for pid: pid_t, attempt: Int) {
        guard running, accessibilityTrusted, pid != selfPID, pid > 0 else { return }
        guard let focusObs = makeObserver(pid: pid) else { return }

        monitoredPID = pid
        let appElement = AXUIElementCreateApplication(pid)
        let addResult = AXObserverAddNotification(
            focusObs, appElement,
            kAXFocusedUIElementChangedNotification as CFString,
            refcon
        )

        guard addResult == .success || addResult == .notificationAlreadyRegistered else {
            // App still launching (.cannotComplete) — retry a few times.
            guard attempt < maxAttachAttempts, addResult != .notImplemented else {
                monitoredPID = 0
                return
            }
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.monitoredPID == pid, self.focusObserver == nil else { return }
                self.pendingAttach = nil
                self.setupObserver(for: pid, attempt: attempt + 1)
            }
            pendingAttach = work
            queue.asyncAfter(deadline: .now() + attachRetryDelay, execute: work)
            return
        }

        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(focusObs), .commonModes)
        focusObserver = focusObs
        inspectCurrentFocus(pid: pid)
    }

    private func tearDownObservers() {
        pendingAttach?.cancel()
        pendingAttach = nil
        cancelPendingFinish()
        removeValueObserver()

        if let obs = focusObserver {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .commonModes)
        }
        focusObserver = nil
        tracker.reset()
        monitoredPID = 0
    }

    // MARK: - Value change observer (per-element)

    private func addValueObserver(for element: AXUIElement, pid: pid_t) {
        removeValueObserver()
        guard let valObs = makeObserver(pid: pid) else { return }

        let addResult = AXObserverAddNotification(
            valObs, element,
            kAXValueChangedNotification as CFString,
            refcon
        )

        if addResult == .success || addResult == .notificationAlreadyRegistered {
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(valObs), .commonModes)
            valueObserver = valObs
        }
    }

    private func removeValueObserver() {
        if let obs = valueObserver {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .commonModes)
        }
        valueObserver = nil
    }

    // MARK: - Notification handling

    private func handleNotification(_ notification: String, element: AXUIElement) {
        guard running else { return }
        switch notification {
        case kAXFocusedUIElementChangedNotification:
            handleFocusChanged(element)
        case kAXValueChangedNotification:
            // Defensive: never read the value of a secure field even if a notification slips through.
            let secure = TextInputPolicy.isSecure(role: nil, subrole: getStringAttribute(element, kAXSubroleAttribute))
            perform(tracker.valueChanged(element, isSecure: secure, readText: readValue))
        default:
            break
        }
    }

    private func handleFocusChanged(_ element: AXUIElement) {
        perform(tracker.focusChanged(to: resolveEditableElement(element), readText: readValue))
    }

    /// Read the current focused element on first attach to a new app.
    private func inspectCurrentFocus(pid: pid_t) {
        guard let element = getElementAttribute(
            AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute) else { return }
        handleFocusChanged(element)
    }

    /// The element itself or the nearest editable ancestor; nil for password fields.
    private func resolveEditableElement(_ element: AXUIElement) -> AXUIElement? {
        TextInputPolicy.resolveEditable(
            from: element,
            role: { self.getStringAttribute($0, kAXRoleAttribute) },
            subrole: { self.getStringAttribute($0, kAXSubroleAttribute) },
            parent: { self.getElementAttribute($0, kAXParentAttribute) }
        )
    }

    private func readValue(_ element: AXUIElement) -> String? {
        getStringAttribute(element, kAXValueAttribute)
    }

    // MARK: - Effects

    private func perform(_ effects: [TextEditTracker<AXUIElement>.Effect]) {
        for effect in effects {
            switch effect {
            case .started(let el, let text):
                deliver(.textInput(buildEvent(status: .started, element: el, text: text)))
            case .updated(let el, let text):
                deliver(.textInput(buildEvent(status: .updated, element: el, text: text)))
            case .finished(let el, let text):
                deliver(.textInput(buildEvent(status: .finished, element: el, text: text)))
            case .observeValue(let el):
                if running { addValueObserver(for: el, pid: monitoredPID) }
            case .stopObservingValue:
                removeValueObserver()
            case .scheduleFinish:
                if running { schedulePendingFinish() }
            case .cancelFinish:
                cancelPendingFinish()
            }
        }
    }

    private func schedulePendingFinish() {
        cancelPendingFinish()
        let pid = monitoredPID
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.running else { return }
            self.pendingFinish = nil
            // Re-query the *actual* focused element now that the dust has settled.
            let effects = self.tracker.finishDebounceElapsed(currentFocus: {
                guard pid != 0,
                      let current = self.getElementAttribute(
                          AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute)
                else { return nil }
                return self.resolveEditableElement(current)
            })
            self.perform(effects)
        }
        pendingFinish = work
        queue.asyncAfter(deadline: .now() + max(options.finishDebounce, 0), execute: work)
    }

    private func cancelPendingFinish() {
        pendingFinish?.cancel()
        pendingFinish = nil
    }

    // MARK: - Event building

    private func buildEvent(status: TextInputStatus, element: AXUIElement, text: String?) -> TextInputEvent {
        var pid: pid_t = 0
        let app = AXUIElementGetPid(element, &pid) == .success && pid > 0
            ? NSRunningApplication(processIdentifier: pid) : nil
        let appName = app?.localizedName

        let (cappedText, truncated) = TextInputPolicy.truncate(text, maxLength: options.maxTextLength)
        return TextInputEvent(
            status: status,
            text: cappedText,
            sourceElement: TextInputEvent.SourceElement(
                type: getStringAttribute(element, kAXRoleAttribute),
                application: appName,
                applicationID: app?.bundleIdentifier,
                applicationLocalizedName: appName,
                screenBounds: getFrame(element).map { TextInputEvent.RectJSON($0) },
                content: nil
            ),
            caretScreenPosition: getCaretPosition(element).map { TextInputEvent.PointJSON($0) },
            timestamp: Date().timeIntervalSince1970 * 1000,
            textTruncated: truncated ? true : nil
        )
    }

    // MARK: - AX attribute helpers (CFTypeID-checked; no force casts)

    private func getStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success else {
            return nil
        }
        return ref as? String
    }

    private func getElementAttribute(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success,
              let ref, CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(ref, to: AXUIElement.self)
    }

    private func asAXValue(_ ref: CFTypeRef?) -> AXValue? {
        guard let ref, CFGetTypeID(ref) == AXValueGetTypeID() else { return nil }
        return unsafeDowncast(ref, to: AXValue.self)
    }

    private func getFrame(_ element: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let posValue = asAXValue(posRef), AXValueGetValue(posValue, .cgPoint, &position),
              let sizeValue = asAXValue(sizeRef), AXValueGetValue(sizeValue, .cgSize, &size)
        else { return nil }
        return CGRect(origin: position, size: size)
    }

    /// Approximate caret position (top-left of the selection bounds, global screen points).
    private func getCaretPosition(_ element: AXUIElement) -> CGPoint? {
        var rangeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, kAXSelectedTextRangeAttribute as CFString, &rangeRef
        ) == .success, let rangeRef else { return nil }

        var boundsRef: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
            element,
            kAXBoundsForRangeParameterizedAttribute as CFString,
            rangeRef,
            &boundsRef
        ) == .success, let boundsValue = asAXValue(boundsRef) else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(boundsValue, .cgRect, &rect) else { return nil }
        return rect.origin
    }

    // MARK: - Output

    private func deliver(_ event: TextInputMonitorEvent) {
        onEvent?(event)
    }

    /// Run `body` on the queue, synchronously; re-entrant when already on it.
    private func onQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil { return body() }
        return queue.sync(execute: body)
    }
}
