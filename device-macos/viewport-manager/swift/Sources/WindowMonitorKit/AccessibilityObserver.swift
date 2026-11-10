/// AXObserver wrapper for focus-change detection.
/// Monitors kAXFocusedUIElementChangedNotification for the frontmost app and
/// extracts the focused window's bounds/title/PID for matching against
/// the CGWindowList snapshot.
///
/// Threading: all methods are called on the monitor's serial queue. The observer's run-loop
/// source is attached to the main run loop (common modes); callbacks hop back to the queue
/// before touching any state.
///
/// Lifetime: the AX callback's refcon is a retained `CallbackBox` holding a weak reference, so a
/// notification already in flight when the observer is released is dropped instead of touching
/// freed memory. The box is released on the main queue, after any in-progress callback (which
/// runs on the main run loop) has returned.

import AppKit
import ApplicationServices
import Foundation

protocol AccessibilityObserverDelegate: AnyObject {
    func accessibilityDidChangeFocus(_ windowInfo: AccessibilityWindowInfo)
}

final class AccessibilityObserver {
    weak var delegate: AccessibilityObserverDelegate?

    private final class CallbackBox {
        weak var target: AccessibilityObserver?
    }

    private let box = CallbackBox()
    private lazy var refcon: UnsafeMutableRawPointer = Unmanaged.passRetained(box).toOpaque()

    private let queue: DispatchQueue
    private var observer: AXObserver?
    private var monitoredPID: pid_t = 0
    private var pendingRetry: DispatchWorkItem?
    private let selfPID = ProcessInfo.processInfo.processIdentifier

    /// A just-launched app often rejects AXObserverAddNotification until its AX server is up.
    private let maxAttachAttempts = 6
    private let retryDelay: DispatchTimeInterval = .milliseconds(500)

    init(queue: DispatchQueue) {
        self.queue = queue
        box.target = self
    }

    deinit {
        terminate()
        let unmanaged = Unmanaged<CallbackBox>.fromOpaque(refcon)
        DispatchQueue.main.async { unmanaged.release() }
    }

    /// Start monitoring focus changes for the given PID (replacing any previous app).
    func monitor(pid: pid_t) {
        guard pid != selfPID, pid > 0 else { return }
        if observer != nil, monitoredPID == pid { return }
        terminate()
        attach(pid: pid, attempt: 1)
    }

    /// Stop monitoring if `pid` is the monitored app (e.g. it terminated).
    func stopMonitoring(pid: pid_t) {
        if monitoredPID == pid { terminate() }
    }

    func terminate() {
        pendingRetry?.cancel()
        pendingRetry = nil
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        observer = nil
        monitoredPID = 0
    }

    // MARK: - Private

    private func attach(pid: pid_t, attempt: Int) {
        guard AXIsProcessTrusted() else { return }

        var obs: AXObserver?
        let result = AXObserverCreate(pid, { (_, element, _, refcon) in
            guard let refcon,
                  let monitor = Unmanaged<CallbackBox>.fromOpaque(refcon).takeUnretainedValue().target
            else { return }
            let el = element  // retained by the closure
            monitor.queue.async {
                monitor.handleFocusChange(el)
            }
        }, &obs)

        guard result == .success, let newObserver = obs else { return }

        let appElement = AXUIElementCreateApplication(pid)
        let addResult = AXObserverAddNotification(
            newObserver, appElement,
            kAXFocusedUIElementChangedNotification as CFString,
            refcon
        )

        if addResult == .success || addResult == .notificationAlreadyRegistered {
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(newObserver), .commonModes)
            observer = newObserver
            monitoredPID = pid
            return
        }

        // .cannotComplete / .notImplemented while the app is still launching: retry briefly.
        guard attempt < maxAttachAttempts, addResult != .notImplemented else { return }
        monitoredPID = pid
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.monitoredPID == pid, self.observer == nil else { return }
            self.pendingRetry = nil
            self.attach(pid: pid, attempt: attempt + 1)
        }
        pendingRetry = work
        queue.asyncAfter(deadline: .now() + retryDelay, execute: work)
    }

    private func handleFocusChange(_ element: AXUIElement) {
        let info = extractWindowInfo(from: element)
        guard info.appPID != 0, !info.windowRect.isEmpty else { return }
        delegate?.accessibilityDidChangeFocus(info)
    }

    /// Extract window info from an AX element.
    private func extractWindowInfo(from element: AXUIElement) -> AccessibilityWindowInfo {
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)

        guard let windowAX = findWindowElement(from: element) else {
            return AccessibilityWindowInfo(windowRect: .zero, appPID: pid, windowTitle: nil)
        }

        var titleRef: CFTypeRef?
        _ = AXUIElementCopyAttributeValue(windowAX, kAXTitleAttribute as CFString, &titleRef)

        return AccessibilityWindowInfo(
            windowRect: CGRect(origin: axPoint(windowAX, kAXPositionAttribute) ?? .zero,
                               size: axSize(windowAX, kAXSizeAttribute) ?? .zero),
            appPID: pid,
            windowTitle: titleRef as? String
        )
    }

    /// Walk up the AX hierarchy to find the window element.
    private func findWindowElement(from element: AXUIElement) -> AXUIElement? {
        if let window = axElement(element, kAXWindowAttribute) {
            return window
        }

        var current: AXUIElement = element
        for _ in 0 ..< 16 {
            var roleRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(current, kAXRoleAttribute as CFString, &roleRef) == .success,
                  let role = roleRef as? String else { break }

            if role == (kAXWindowRole as String) { return current }

            guard let parent = axElement(current, kAXParentAttribute) else { break }
            current = parent
        }
        return nil
    }
}
