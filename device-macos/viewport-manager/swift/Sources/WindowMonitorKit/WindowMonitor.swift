/// Window monitor: orchestrates CGWindowList polling, NSWorkspace notifications and AXObserver
/// focus changes into one serialised stream of `WindowMonitorEvent`s.
///
///   - A timer on a private serial queue scans CGWindowList, diffs against the previous
///     snapshot (`WindowDiff`) and runs the focus state machine (`FocusTracker`).
///   - `WorkspaceObserver` delivers app activate/deactivate/terminate and Space changes.
///   - `AccessibilityObserver` delivers kAXFocusedUIElementChangedNotification for the
///     frontmost app, giving immediate focus/unfocus detection.
///   - All state is owned by the queue; nothing else touches it.
///
/// Coordinates are global CoreGraphics points (origin at the top-left of the main display,
/// y grows downward; secondary displays may have negative origins).

import AppKit
import CoreGraphics
import Foundation

/// Reports window appear / vanish / focus / unfocus / title / bounds changes and Mission Control
/// Space changes.
///
/// Threading: every callback (`onEvent`, `onError`) is invoked on the monitor's private serial
/// queue. Hop to the main actor yourself for UI work, and never block that queue waiting on the
/// main thread. Assign callbacks before `start()`. `start()` (asynchronous: setup happens on the
/// queue, `.ready` is the first event) and `stop()` (synchronous: no callback runs after it
/// returns, unless called from inside a callback) are idempotent and safe from any thread,
/// including from inside a callback. AX focus notifications need the **main run loop** to be
/// running (NSApplication, or `RunLoop.main.run()` in a command-line tool); without it focus is
/// still detected by polling.
///
/// Permissions: Screen Recording (without it macOS hides other apps' window titles and those
/// windows are skipped) and Accessibility (instant focus tracking and `documentPath`). Missing
/// permissions are reported through `onError` at start and whenever one is revoked; grants and
/// revocations also arrive as `.permissionsChanged`. Nothing needs a restart.
public final class WindowMonitor: @unchecked Sendable {
    public struct Options: Sendable {
        /// CGWindowList polling interval (seconds). Default 16 ms (about 60 Hz) for smooth bounds
        /// tracking; each tick costs one CGWindowListCopyWindowInfo call plus AX lookups for
        /// windows not yet cached.
        public var pollInterval: TimeInterval = 0.016
        /// How often permissions are re-checked (seconds).
        public var permissionCheckInterval: TimeInterval = 2
        /// AX messaging timeout (seconds) so a hung app cannot stall the monitor. This is set on
        /// the system-wide element, which macOS applies to **every AX call in the process**.
        /// Nil leaves the process setting alone.
        public var axMessagingTimeout: Float? = 0.25
        /// Apps whose windows are never reported (system UI by default).
        public var blockedBundleIdentifiers: Set<String> = WindowMonitor.defaultBlockedBundleIdentifiers
        /// Leave the host process's own windows out.
        public var excludeOwnProcess = false
        /// Look up each window's AXDocument (needs Accessibility).
        public var resolveDocumentPaths = true

        public init() {}
    }

    public static let defaultBlockedBundleIdentifiers: Set<String> = [
        "com.apple.controlcenter",
        "com.apple.SystemUIServer",
        "com.apple.notificationcenterui",
        "com.apple.Spotlight",
        "com.apple.screencaptureui",
        "com.apple.dock",
    ]

    /// Permission problems reported through `onError`, each once until it clears.
    public enum Problem: String, Sendable {
        /// AX focus tracking and `documentPath` are disabled (focus falls back to polling).
        case accessibilityDenied = "accessibility_denied"
        /// Other apps' window titles are hidden, so most windows are not reported.
        case screenRecordingDenied = "screen_recording_denied"
    }

    /// Called on the monitor's private queue.
    public var onEvent: ((WindowMonitorEvent) -> Void)?
    /// Called on the monitor's private queue.
    public var onError: ((Problem, String) -> Void)?

    public let options: Options

    private let queue = DispatchQueue(label: "ausm.window-monitor")
    private let queueKey = DispatchSpecificKey<Void>()
    private var running = false
    private var timer: DispatchSourceTimer?
    private var permissionTimer: DispatchSourceTimer?
    private var workspace: WorkspaceObserver?
    private var accessibility: AccessibilityObserver?

    // ── State (accessed only on `queue`) ──────────────────────────────────
    private var previousWindows: [String: WindowSnapshot] = [:]
    private var focus = FocusTracker()
    private var documentCache = DocumentPathCache()
    private var permissionState = WindowPermissions(accessibilityTrusted: false, screenRecordingGranted: false)
    private var reportedProblems: Set<Problem> = []
    private let selfPID = ProcessInfo.processInfo.processIdentifier

    public init(options: Options = Options()) {
        self.options = options
        queue.setSpecific(key: queueKey, value: ())
    }

    deinit {
        stop()
    }

    public var isRunning: Bool { onQueue { running } }

    /// Last permission state seen by the monitor.
    public var permissions: WindowPermissions { onQueue { permissionState } }

    public func start() {
        if DispatchQueue.getSpecific(key: queueKey) != nil {
            startOnQueue()
        } else {
            queue.async { [self] in startOnQueue() }
        }
    }

    public func stop() {
        onQueue { stopOnQueue() }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    private func startOnQueue() {
        guard !running else { return }
        running = true
        previousWindows = [:]
        documentCache = DocumentPathCache()
        reportedProblems = []

        if let timeout = options.axMessagingTimeout {
            AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), timeout)
        }

        let ws = WorkspaceObserver(queue: queue)
        ws.delegate = self
        ws.register()
        workspace = ws

        let ax = AccessibilityObserver(queue: queue)
        ax.delegate = self
        accessibility = ax

        permissionState = Self.currentPermissions()
        deliver(.ready(permissionState))
        reportProblems()
        guard running else { return } // stopped from inside a callback

        let frontmost = NSWorkspace.shared.frontmostApplication
        focus.begin(frontmostPID: frontmost?.processIdentifier)
        if let pid = frontmost?.processIdentifier { ax.monitor(pid: pid) }

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: max(options.pollInterval, 0.005), leeway: .milliseconds(50))
        t.setEventHandler { [weak self] in self?.tick() }
        timer = t
        t.resume()

        // Permission can be granted or revoked while we run.
        let p = DispatchSource.makeTimerSource(queue: queue)
        let interval = max(options.permissionCheckInterval, 0.1)
        p.schedule(deadline: .now() + interval, repeating: interval)
        p.setEventHandler { [weak self] in self?.checkPermissions() }
        permissionTimer = p
        p.resume()
    }

    private func stopOnQueue() {
        guard running else { return }
        running = false
        timer?.cancel()
        timer = nil
        permissionTimer?.cancel()
        permissionTimer = nil
        workspace?.terminate()
        workspace = nil
        accessibility?.terminate()
        accessibility = nil
    }

    static func currentPermissions() -> WindowPermissions {
        WindowPermissions(accessibilityTrusted: AXIsProcessTrusted(),
                          screenRecordingGranted: CGPreflightScreenCaptureAccess())
    }

    private func checkPermissions() {
        guard running else { return }
        let now = Self.currentPermissions()
        guard now != permissionState else { return }
        let axNewlyGranted = now.accessibilityTrusted && !permissionState.accessibilityTrusted
        permissionState = now
        deliver(.permissionsChanged(now))
        reportProblems()
        if axNewlyGranted, focus.hasActiveApp {
            // Attach the AX observer we could not create while untrusted.
            accessibility?.monitor(pid: focus.activeAppPID)
        }
    }

    private func reportProblems() {
        let current = Self.problems(for: permissionState)
        reportedProblems.formIntersection(current) // cleared problems may be reported again
        for problem in [Problem.accessibilityDenied, .screenRecordingDenied]
        where current.contains(problem) && !reportedProblems.contains(problem) {
            reportedProblems.insert(problem)
            onError?(problem, Self.message(for: problem))
        }
    }

    static func problems(for p: WindowPermissions) -> Set<Problem> {
        var s = Set<Problem>()
        if !p.accessibilityTrusted { s.insert(.accessibilityDenied) }
        if !p.screenRecordingGranted { s.insert(.screenRecordingDenied) }
        return s
    }

    static func message(for problem: Problem) -> String {
        switch problem {
        case .accessibilityDenied:
            return "Accessibility permission not granted: AX focus tracking and documentPath are disabled"
        case .screenRecordingDenied:
            return "Screen Recording permission not granted: other apps' window titles are hidden, so most windows are not reported"
        }
    }

    // ── Tick ──────────────────────────────────────────────────────────────

    private func tick() {
        guard running else { return }
        let current = scanWindows()
        let frontmost = NSWorkspace.shared.frontmostApplication
        let frontPID = frontmost?.bundleIdentifier != nil ? frontmost?.processIdentifier : nil
        let result = focus.tick(previous: previousWindows, current: current, frontmostPID: frontPID)
        previousWindows = current
        for e in result.events {
            guard running else { return }
            deliver(.window(e))
        }
        if let pid = result.subscribePID { accessibility?.monitor(pid: pid) }
    }

    // ── CGWindowList Scanning ─────────────────────────────────────────────

    private func scanWindows() -> [String: WindowSnapshot] {
        let listOptions: CGWindowListOption = [.excludeDesktopElements, .optionOnScreenOnly]
        guard let infoList = CGWindowListCopyWindowInfo(listOptions, kCGNullWindowID)
            as? [[String: Any]] else { return [:] }

        let appsByPid: [pid_t: NSRunningApplication] = NSWorkspace.shared.runningApplications
            .reduce(into: [:]) { $0[$1.processIdentifier] = $1 }

        let displays = activeDisplays()
        let mainDisplay = CGMainDisplayID()

        // Collect windows per PID for batch AXDocument lookup
        var pidWindows: [pid_t: [(CGWindowID, String, CGRect)]] = [:]

        var result = [String: WindowSnapshot]()
        for (zIndex, info) in infoList.enumerated() {
            guard
                let windowId = info[kCGWindowNumber as String] as? CGWindowID,
                let ownerPID = info[kCGWindowOwnerPID as String] as? pid_t,
                !(options.excludeOwnProcess && ownerPID == selfPID),
                let app = appsByPid[ownerPID],
                let bundleId = app.bundleIdentifier,
                !options.blockedBundleIdentifiers.contains(bundleId),
                let layerNum = info[kCGWindowLayer as String] as? Int, layerNum == 0,
                let onScreen = info[kCGWindowIsOnscreen as String] as? Int, onScreen == 1,
                let boundsDict = info[kCGWindowBounds as String] as? NSDictionary
            else { continue }

            var rect = CGRect.zero
            guard CGRectMakeWithDictionaryRepresentation(boundsDict as CFDictionary, &rect) else { continue }

            let title = info[kCGWindowName as String] as? String ?? ""
            guard WindowDiff.shouldTrack(title: title, bounds: rect) else { continue }

            let ownerName = info[kCGWindowOwnerName as String] as? String ?? ""
            let displayId = WindowDiff.primaryDisplay(for: rect, displays: displays, fallback: mainDisplay)

            pidWindows[ownerPID, default: []].append((windowId, title, rect))

            let snap = WindowSnapshot(
                windowId: windowId, title: title, ownerName: ownerName,
                bundleId: bundleId, ownerPID: ownerPID,
                bounds: rect, layer: layerNum, zIndex: zIndex,
                displayId: displayId,
                documentPath: nil
            )
            result[snap.key] = snap
        }

        if options.resolveDocumentPaths {
            for (key, docPath) in queryAXDocuments(pidWindows: pidWindows) {
                if let snap = result[key] {
                    result[key] = snap.with(documentPath: docPath)
                }
            }
        }

        return result
    }

    /// Current display list (re-read every tick so hot-plug / arrangement changes apply immediately).
    private func activeDisplays() -> [(id: CGDirectDisplayID, bounds: CGRect)] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { ($0, CGDisplayBounds($0)) }
    }

    // ── AXDocument Lookup ─────────────────────────────────────────────────

    /// Query kAXDocumentAttribute for windows, batched by PID.
    /// Returns a map of "windowId_pid" → document path.
    private func queryAXDocuments(
        pidWindows: [pid_t: [(CGWindowID, String, CGRect)]]
    ) -> [String: String] {
        guard permissionState.accessibilityTrusted else { return [:] }

        var results: [String: String] = [:]

        for (pid, windows) in pidWindows {
            var uncached: [(CGWindowID, String, CGRect)] = []
            for (wid, title, rect) in windows {
                let key = DocumentPathCache.Key(windowId: wid, pid: pid, title: title)
                if let cached = documentCache.lookup(key) {
                    if let path = cached { results["\(wid)_\(pid)"] = path }
                } else {
                    uncached.append((wid, title, rect))
                }
            }
            if uncached.isEmpty { continue }

            // Record a miss for every uncached window up front; matches below overwrite it.
            for (wid, title, _) in uncached {
                documentCache.record(.init(windowId: wid, pid: pid, title: title), path: nil)
            }

            let appElement = AXUIElementCreateApplication(pid)
            var axWindowsRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(
                appElement, kAXWindowsAttribute as CFString, &axWindowsRef
            ) == .success, let axWindows = axWindowsRef as? [AXUIElement] else {
                continue
            }

            for axWindow in axWindows {
                var docRef: CFTypeRef?
                guard AXUIElementCopyAttributeValue(
                    axWindow, kAXDocumentAttribute as CFString, &docRef
                ) == .success, let docString = docRef as? String else {
                    continue
                }

                var titleRef: CFTypeRef?
                _ = AXUIElementCopyAttributeValue(axWindow, kAXTitleAttribute as CFString, &titleRef)
                let axTitle = titleRef as? String ?? ""
                let axRect = CGRect(origin: axPoint(axWindow, kAXPositionAttribute) ?? .zero,
                                    size: axSize(axWindow, kAXSizeAttribute) ?? .zero)

                for (wid, cgTitle, cgRect) in uncached
                where WindowDiff.titlesMatch(cgTitle: cgTitle, axTitle: axTitle)
                    && WindowDiff.approximatelyEqual(cgRect, axRect)
                {
                    results["\(wid)_\(pid)"] = docString
                    documentCache.record(.init(windowId: wid, pid: pid, title: cgTitle), path: docString)
                    break
                }
            }
        }

        // Prune stale cache entries — keep only entries matching current windows
        documentCache.prune(keeping: Set(pidWindows.flatMap { pid, windows in
            windows.map { DocumentPathCache.Key(windowId: $0.0, pid: pid, title: $0.1) }
        }))

        return results
    }

    // ── Output ────────────────────────────────────────────────────────────

    private func deliver(_ event: WindowMonitorEvent) {
        onEvent?(event)
    }

    /// Run `body` on the queue, synchronously; re-entrant when already on it.
    private func onQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil { return body() }
        return queue.sync(execute: body)
    }
}

// MARK: - WorkspaceObserverDelegate

extension WindowMonitor: WorkspaceObserverDelegate {
    // WorkspaceObserver delivers these on `queue`, serialised with tick().

    func workspaceDidActivateApp(pid: pid_t, bundleId: String, name: String) {
        guard running else { return }
        // Subscribe to AX for the new app immediately so focus changes
        // are detected without waiting for the next tick.
        accessibility?.monitor(pid: pid)
        for e in focus.appActivated(pid: pid, windows: previousWindows) {
            guard running else { return }
            deliver(.window(e))
        }
    }

    func workspaceDidDeactivateApp(pid: pid_t) {
        focus.appDeactivated(pid: pid)
    }

    func workspaceDidTerminateApp(pid: pid_t) {
        accessibility?.stopMonitoring(pid: pid)
        focus.appTerminated(pid: pid)
    }

    func workspaceDidChangeActiveSpace() {
        guard running else { return }
        deliver(.spaceChanged(Date()))
    }
}

// MARK: - AccessibilityObserverDelegate

extension WindowMonitor: AccessibilityObserverDelegate {
    /// Called on the monitor's serial queue (AccessibilityObserver dispatches to it).
    func accessibilityDidChangeFocus(_ windowInfo: AccessibilityWindowInfo) {
        guard running else { return }
        let events = focus.axFocusChanged(windowInfo, previous: previousWindows, rescan: { scanWindows() })
        for e in events {
            guard running else { return }
            deliver(.window(e))
        }
    }
}

// MARK: - AX value helpers (CFTypeID-checked; no force casts)

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success,
          let ref, CFGetTypeID(ref) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(unsafeDowncast(ref, to: AXValue.self), .cgPoint, &point) ? point : nil
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success,
          let ref, CFGetTypeID(ref) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(unsafeDowncast(ref, to: AXValue.self), .cgSize, &size) ? size : nil
}

/// Returns the attribute as an AXUIElement if it is one.
func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success,
          let ref, CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
    return unsafeDowncast(ref, to: AXUIElement.self)
}
