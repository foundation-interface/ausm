/// TextInputMonitor — monitors focus changes across applications and detects
/// when the user enters/leaves/types in editable text elements (text fields,
/// text areas, combo boxes). Password fields (AXSecureTextField) are never tracked.
///
/// Uses AXObserver for:
///   1. kAXFocusedUIElementChangedNotification — detect focus into/out of editable elements
///   2. kAXValueChangedNotification — detect typing within an editable element
///
/// Also watches NSWorkspace for app activation/termination so the AXObserver
/// follows the frontmost application.
///
/// Threading: all state lives on `queue`. AXObserver run-loop sources are attached to the
/// main run loop (run by main.swift); callbacks hop to `queue` before touching state.
///
/// Privacy: typed text is only ever written to stdout as part of an event. It is never
/// logged to stderr.

import AppKit
import ApplicationServices
import Foundation

final class TextInputMonitor {
    private let queue = DispatchQueue(label: "com.ausm.text-input-monitor")

    /// Upper bound for any single AX round-trip so a hung app cannot stall the monitor.
    private let axMessagingTimeout: Float = 0.5
    /// A just-launched app often rejects AXObserverAddNotification until its AX server is up.
    private let maxAttachAttempts = 6
    private let attachRetryDelay: DispatchTimeInterval = .milliseconds(500)

    private var focusObserver: AXObserver?
    private var valueObserver: AXObserver?
    private var monitoredPID: pid_t = 0
    private var pendingAttach: DispatchWorkItem?
    private var focusedElement: AXUIElement?
    private var focusedElementIsEditable = false
    private var lastEmittedText: String?
    private let selfPID = ProcessInfo.processInfo.processIdentifier

    /// Pending FINISHED event work item. When focus leaves an editable element,
    /// we delay the FINISHED emission and then re-verify the actual focused
    /// element before emitting. This prevents spurious STARTED→FINISHED pairs
    /// caused by intermediate focus notifications.
    private var pendingFinish: DispatchWorkItem?
    private let finishDebounceMs: Int = 200

    private var workspaceObservers: [NSObjectProtocol] = []
    private var permissionTimer: DispatchSourceTimer?
    private var accessibilityTrusted = false

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = []
        return e
    }()

    // MARK: - Lifecycle

    func start() {
        queue.async { [self] in
            AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), axMessagingTimeout)
            registerWorkspaceNotifications()

            accessibilityTrusted = AXIsProcessTrusted()
            emitLine(ReadyEvent(accessibilityTrusted: accessibilityTrusted))
            if !accessibilityTrusted {
                log("Accessibility permission not granted; no events until it is. Grant it in System Settings > Privacy & Security > Accessibility.")
            }

            attachToFrontmostApp()

            // Accessibility can be granted or revoked while we run.
            let t = DispatchSource.makeTimerSource(queue: queue)
            t.schedule(deadline: .now() + 2, repeating: 2)
            t.setEventHandler { [weak self] in self?.checkPermission() }
            permissionTimer = t
            t.resume()
        }
    }

    /// Synchronous: emits a final FINISHED for an in-progress edit, then tears down.
    func stop() {
        queue.sync { [self] in
            permissionTimer?.cancel()
            permissionTimer = nil
            cancelPendingFinish()
            if focusedElementIsEditable {
                emitFinished()
            }
            tearDownObservers()
            unregisterWorkspaceNotifications()
        }
    }

    private func checkPermission() {
        let trusted = AXIsProcessTrusted()
        guard trusted != accessibilityTrusted else { return }
        accessibilityTrusted = trusted
        emitLine(PermissionEvent(accessibilityTrusted: trusted))
        log(trusted ? "Accessibility permission granted" : "Accessibility permission revoked")
        if trusted {
            attachToFrontmostApp()
        } else {
            cancelPendingFinish()
            if focusedElementIsEditable { emitFinished() }
            tearDownObservers()
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
        guard pid != selfPID else { return }
        // Already attached (or attaching) to this app.
        if pid == monitoredPID, focusObserver != nil || pendingAttach != nil { return }

        cancelPendingFinish()
        if focusedElementIsEditable {
            emitFinished()
        }

        tearDownObservers()
        setupObserver(for: pid, attempt: 1)
    }

    private func handleAppTerminated(pid: pid_t) {
        guard pid == monitoredPID else { return }
        cancelPendingFinish()
        if focusedElementIsEditable {
            emitFinished()
        }
        tearDownObservers()
    }

    // MARK: - AXObserver setup

    private func makeObserver(pid: pid_t) -> AXObserver? {
        var obs: AXObserver?
        let result = AXObserverCreate(pid, { (_, element, notification, refcon) in
            guard let refcon else { return }
            let monitor = Unmanaged<TextInputMonitor>.fromOpaque(refcon).takeUnretainedValue()
            let el = element
            let notif = notification as String
            monitor.queue.async {
                monitor.handleNotification(notif, element: el)
            }
        }, &obs)
        return result == .success ? obs : nil
    }

    private func setupObserver(for pid: pid_t, attempt: Int) {
        guard accessibilityTrusted, pid != selfPID, pid > 0 else { return }
        guard let focusObs = makeObserver(pid: pid) else { return }

        monitoredPID = pid
        let appElement = AXUIElementCreateApplication(pid)
        // `self` lives for the whole process, so an unretained refcon is safe.
        let addResult = AXObserverAddNotification(
            focusObs, appElement,
            kAXFocusedUIElementChangedNotification as CFString,
            Unmanaged.passUnretained(self).toOpaque()
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

        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(focusObs), .defaultMode)
        focusObserver = focusObs
        inspectCurrentFocus(pid: pid)
    }

    private func tearDownObservers() {
        pendingAttach?.cancel()
        pendingAttach = nil
        removeValueObserver()

        if let obs = focusObserver {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        }
        focusObserver = nil
        focusedElement = nil
        focusedElementIsEditable = false
        lastEmittedText = nil
        monitoredPID = 0
    }

    // MARK: - Value change observer (per-element)

    private func addValueObserver(for element: AXUIElement, pid: pid_t) {
        removeValueObserver()
        guard let valObs = makeObserver(pid: pid) else { return }

        let addResult = AXObserverAddNotification(
            valObs, element,
            kAXValueChangedNotification as CFString,
            Unmanaged.passUnretained(self).toOpaque()
        )

        if addResult == .success || addResult == .notificationAlreadyRegistered {
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(valObs), .defaultMode)
            valueObserver = valObs
        }
    }

    private func removeValueObserver() {
        if let obs = valueObserver {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        }
        valueObserver = nil
    }

    // MARK: - Notification handling

    private func handleNotification(_ notification: String, element: AXUIElement) {
        switch notification {
        case kAXFocusedUIElementChangedNotification:
            handleFocusChanged(element)
        case kAXValueChangedNotification:
            handleValueChanged(element)
        default:
            break
        }
    }

    private func handleFocusChanged(_ element: AXUIElement) {
        // Resolve the editable element: either `element` itself or an
        // ancestor with an editable role (handles focus landing on a child
        // element inside a text field). Password fields resolve to nil.
        guard let target = resolveEditableElement(element) else {
            // Focus moved to a non-editable (or secure) element. Schedule FINISHED after
            // a short debounce so that rapid intermediate focus changes
            // (child/container bounce) don't produce spurious events.
            if focusedElementIsEditable {
                schedulePendingFinish()
            }
            return
        }

        // Cancel any pending FINISHED — we're (still) in an editable element.
        cancelPendingFinish()

        // If we were already tracking this same editable element, ignore
        // the duplicate notification (common during click-to-focus).
        if focusedElementIsEditable, let prev = focusedElement, CFEqual(prev, target) {
            return
        }

        // Switching from one editable element to another
        if focusedElementIsEditable {
            emitFinished()
        }

        focusedElement = target
        focusedElementIsEditable = true
        addValueObserver(for: target, pid: monitoredPID)
        emitStarted(element: target)
    }

    /// Walk up the AX hierarchy (up to 8 levels) looking for an element whose role is
    /// editable. Returns nil if none is found or the nearest one is a password field.
    private func resolveEditableElement(_ element: AXUIElement) -> AXUIElement? {
        var current: AXUIElement = element
        for _ in 0..<8 {
            let role = getStringAttribute(current, kAXRoleAttribute)
            if let role, TextInputPolicy.editableRoles.contains(role) {
                let subrole = getStringAttribute(current, kAXSubroleAttribute)
                return TextInputPolicy.isTrackable(role: role, subrole: subrole) ? current : nil
            }
            guard let parent = getElementAttribute(current, kAXParentAttribute) else { break }
            current = parent
        }
        return nil
    }

    // MARK: - FINISHED debounce

    private func schedulePendingFinish() {
        cancelPendingFinish()
        let pid = monitoredPID
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingFinish = nil
            guard self.focusedElementIsEditable else { return }

            // Re-query the *actual* focused element now that the dust has
            // settled. If it's still editable (user is still in the text
            // field), suppress the FINISHED and keep tracking.
            if pid != 0,
               let currentElement = self.getElementAttribute(
                   AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute),
               let resolved = self.resolveEditableElement(currentElement)
            {
                // Only re-create the value observer if the element reference actually
                // changed, to avoid dropping value-change notifications.
                if let prev = self.focusedElement, CFEqual(prev, resolved) {
                    return
                }
                self.focusedElement = resolved
                self.addValueObserver(for: resolved, pid: pid)
                return
            }

            self.emitFinished()
            self.focusedElement = nil
            self.focusedElementIsEditable = false
            self.removeValueObserver()
            self.lastEmittedText = nil
        }
        pendingFinish = work
        queue.asyncAfter(
            deadline: .now() + .milliseconds(finishDebounceMs),
            execute: work
        )
    }

    private func cancelPendingFinish() {
        pendingFinish?.cancel()
        pendingFinish = nil
    }

    private func handleValueChanged(_ element: AXUIElement) {
        guard focusedElementIsEditable else { return }
        // Defensive: never read the value of a secure field even if a notification slips through.
        if TextInputPolicy.isSecure(role: nil, subrole: getStringAttribute(element, kAXSubroleAttribute)) {
            return
        }
        emitUpdated(element: element)
    }

    /// Read the current focused element on first attach to a new app.
    private func inspectCurrentFocus(pid: pid_t) {
        guard let element = getElementAttribute(
            AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute) else { return }
        handleFocusChanged(element)
    }

    // MARK: - Event emission

    private func emitStarted(element: AXUIElement) {
        let text = getStringAttribute(element, kAXValueAttribute)
        lastEmittedText = text
        emitLine(buildEvent(status: "TEXT_EDITING_STARTED", element: element, text: text))
    }

    private func emitUpdated(element: AXUIElement) {
        let text = getStringAttribute(element, kAXValueAttribute)
        guard text != lastEmittedText else { return }
        lastEmittedText = text
        emitLine(buildEvent(status: "TEXT_EDITING_UPDATED", element: element, text: text))
    }

    private func emitFinished() {
        guard let element = focusedElement else { return }
        let text = lastEmittedText
        lastEmittedText = nil
        emitLine(buildEvent(status: "TEXT_EDITING_FINISHED", element: element, text: text))
    }

    private func buildEvent(
        status: String, element: AXUIElement, text: String?
    ) -> TextInputEvent {
        var pid: pid_t = 0
        let app = AXUIElementGetPid(element, &pid) == .success && pid > 0
            ? NSRunningApplication(processIdentifier: pid) : nil
        let appName = app?.localizedName

        return TextInputEvent(
            status: status,
            text: text,
            sourceElement: TextInputEvent.SourceElement(
                type: getStringAttribute(element, kAXRoleAttribute),
                application: appName,
                applicationID: app?.bundleIdentifier,
                applicationLocalizedName: appName,
                screenBounds: getFrame(element).map { TextInputEvent.RectJSON($0) },
                content: nil
            ),
            caretScreenPosition: getCaretPosition(element).map { TextInputEvent.PointJSON($0) },
            timestamp: Date().timeIntervalSince1970 * 1000
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

    private func emitLine<T: Encodable>(_ value: T) {
        guard let data = try? encoder.encode(value),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line)
    }

    /// Diagnostics to stderr. Never pass typed text or element values here.
    private func log(_ message: String) {
        FileHandle.standardError.write(Data("[text-input-helper] \(message)\n".utf8))
    }
}
