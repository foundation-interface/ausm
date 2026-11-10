/// AXObserver wrapper for focus-change detection.
/// Monitors kAXFocusedUIElementChangedNotification for the frontmost app and
/// extracts the focused window's bounds/title/PID for matching against
/// the CGWindowList snapshot.
///
/// Threading: all methods are called on the monitor's serial queue. The observer's run-loop
/// source is attached to the main run loop (which main.swift runs); callbacks hop back to
/// the queue before touching any state.

import AppKit
import ApplicationServices
import Foundation

protocol AccessibilityObserverDelegate: AnyObject {
    func accessibilityDidChangeFocus(_ windowInfo: AccessibilityWindowInfo)
}

final class AccessibilityObserver {
    weak var delegate: AccessibilityObserverDelegate?

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
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        }
        observer = nil
        monitoredPID = 0
    }

    // MARK: - Private

    private func attach(pid: pid_t, attempt: Int) {
        guard AXIsProcessTrusted() else { return }

        var obs: AXObserver?
        let result = AXObserverCreate(pid, { (_, element, _, refcon) in
            guard let refcon else { return }
            let monitor = Unmanaged<AccessibilityObserver>.fromOpaque(refcon).takeUnretainedValue()
            let el = element  // retained by the closure
            monitor.queue.async {
                monitor.handleFocusChange(el)
            }
        }, &obs)

        guard result == .success, let newObserver = obs else { return }

        let appElement = AXUIElementCreateApplication(pid)
        // `self` lives for the whole process (owned by ViewportMonitor), so an unretained refcon is safe.
        let addResult = AXObserverAddNotification(
            newObserver, appElement,
            kAXFocusedUIElementChangedNotification as CFString,
            Unmanaged.passUnretained(self).toOpaque()
        )

        if addResult == .success || addResult == .notificationAlreadyRegistered {
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(newObserver), .defaultMode)
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
