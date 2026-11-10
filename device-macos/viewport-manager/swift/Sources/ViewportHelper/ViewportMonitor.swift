/// Core viewport monitor — orchestrates CGWindowList polling, NSWorkspace
/// notifications, and AXObserver focus changes into a serialised event stream
/// written as JSON lines to stdout.
///
///   - A timer on a serial DispatchQueue scans CGWindowList, diffs against the
///     previous snapshot (WindowDiff), and emits open/close/title/bounds events.
///   - WorkspaceObserver delivers app activate/deactivate/terminate and Space changes.
///   - AccessibilityObserver delivers kAXFocusedUIElementChangedNotification for the
///     frontmost app, giving immediate focus/unfocus detection.
///   - All state is owned by `queue`; nothing else touches it.
///
/// Coordinates are global CoreGraphics points (origin at the top-left of the main display,
/// y grows downward; secondary displays may have negative origins).

import AppKit
import CoreGraphics
import Foundation

final class ViewportMonitor {
    /// Polling interval: 16 ms ≈ 60 Hz for smooth bounds tracking. Each tick costs one
    /// CGWindowListCopyWindowInfo call plus AX lookups for windows not yet cached.
    private let tickInterval: TimeInterval = 0.016
    /// Upper bound for any single AX round-trip so a hung app cannot stall the monitor.
    private let axMessagingTimeout: Float = 0.25
    private let queue = DispatchQueue(label: "com.ausm.viewport-monitor")

    private var timer: DispatchSourceTimer?
    private var permissionTimer: DispatchSourceTimer?
    private var workspace: WorkspaceObserver?
    private var accessibility: AccessibilityObserver?

    // ── State (accessed only on `queue`) ──────────────────────────────────

    private var previousWindows: [String: WindowSnapshot] = [:]
    private var focusedWindowId: CGWindowID = 0
    private var hasFocusedWindow = false

    private var activeAppPID: pid_t = 0
    private var hasActiveApp = false
    private var activeAppState: ActiveAppState = .pendingDiff

    private var lastAccessibilityTrusted = false
    private var lastScreenRecordingGranted = false

    private let blockedBundleIds: Set<String> = [
        "com.apple.controlcenter",
        "com.apple.SystemUIServer",
        "com.apple.notificationcenterui",
        "com.apple.Spotlight",
        "com.apple.screencaptureui",
        "com.apple.dock",
    ]

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [] // compact single-line JSON
        return e
    }()

    // ── Lifecycle ─────────────────────────────────────────────────────────

    func start() {
        queue.async { [self] in
            // Bound every AX call made by this process (global setting on the system-wide element).
            AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), axMessagingTimeout)

            let ws = WorkspaceObserver(queue: queue)
            ws.delegate = self
            ws.register()
            workspace = ws

            let ax = AccessibilityObserver(queue: queue)
            ax.delegate = self
            accessibility = ax

            lastAccessibilityTrusted = AXIsProcessTrusted()
            lastScreenRecordingGranted = CGPreflightScreenCaptureAccess()
            if !lastAccessibilityTrusted {
                log("Accessibility permission not granted: AX focus tracking and documentPath are disabled")
            }
            if !lastScreenRecordingGranted {
                log("Screen Recording permission not granted: other apps' window titles are hidden, so most windows are not reported")
            }

            emitLine(ReadyEvent(accessibilityTrusted: lastAccessibilityTrusted,
                                screenRecordingGranted: lastScreenRecordingGranted))

            if let frontmost = NSWorkspace.shared.frontmostApplication {
                activeAppPID = frontmost.processIdentifier
                hasActiveApp = true
                activeAppState = .pendingDiff
                ax.monitor(pid: frontmost.processIdentifier)
            }

            let t = DispatchSource.makeTimerSource(queue: queue)
            t.schedule(deadline: .now(), repeating: tickInterval, leeway: .milliseconds(50))
            t.setEventHandler { [weak self] in self?.tick() }
            timer = t
            t.resume()

            // Permission can be granted or revoked while we run.
            let p = DispatchSource.makeTimerSource(queue: queue)
            p.schedule(deadline: .now() + 2, repeating: 2)
            p.setEventHandler { [weak self] in self?.checkPermissions() }
            permissionTimer = p
            p.resume()
        }
    }

    /// Synchronous so callers can exit right after it returns.
    func stop() {
        queue.sync { [self] in
            timer?.cancel()
            timer = nil
            permissionTimer?.cancel()
            permissionTimer = nil
            workspace?.terminate()
            workspace = nil
            accessibility?.terminate()
            accessibility = nil
        }
    }

    private func checkPermissions() {
        let ax = AXIsProcessTrusted()
        let sr = CGPreflightScreenCaptureAccess()
        guard ax != lastAccessibilityTrusted || sr != lastScreenRecordingGranted else { return }
        let axNewlyGranted = ax && !lastAccessibilityTrusted
        lastAccessibilityTrusted = ax
        lastScreenRecordingGranted = sr
        emitLine(PermissionEvent(accessibilityTrusted: ax, screenRecordingGranted: sr))
        if axNewlyGranted, hasActiveApp {
            // Attach the AX observer we could not create while untrusted.
            accessibility?.monitor(pid: activeAppPID)
        }
    }

    // ── Tick (main event loop) ────────────────────────────────────────────

    private func tick() {
        var events = [WindowEvent]()

        // 1. Scan current windows
        let currentWindows = scanWindows()

        // 2. Diff (open / close / title / bounds)
        events.append(contentsOf: WindowDiff.diff(old: previousWindows, new: currentWindows))

        // 3. Auto-unfocus a closed focused window (unfocused is emitted before its close)
        if hasFocusedWindow,
           let closeIdx = events.firstIndex(where: { $0.type == "window-closed" && $0.windowId == focusedWindowId })
        {
            var unfocused = events[closeIdx]
            unfocused.type = "window-unfocused"
            events.insert(unfocused, at: closeIdx)
            focusedWindowId = 0
            hasFocusedWindow = false
        }

        // 4. Poll-based focus detection (fallback when AX is unavailable or silent)
        events.append(contentsOf: pollFrontmostApp(currentWindows: currentWindows))

        // 5. Progress app-activation state machine
        events.append(contentsOf: progressAppActivation(currentWindows: currentWindows))

        // 6. Update snapshot
        previousWindows = currentWindows

        // 7. Emit
        for e in events { emitLine(e) }

        // 8. Post-tick side effects
        postTick()
    }

    // ── CGWindowList Scanning ─────────────────────────────────────────────

    private func scanWindows() -> [String: WindowSnapshot] {
        let options: CGWindowListOption = [.excludeDesktopElements, .optionOnScreenOnly]
        guard let infoList = CGWindowListCopyWindowInfo(options, kCGNullWindowID)
            as? [[String: Any]] else { return [:] }

        let appsByPid: [pid_t: NSRunningApplication] = NSWorkspace.shared.runningApplications
            .reduce(into: [:]) { $0[$1.processIdentifier] = $1 }

        let displays = activeDisplays()
        let mainDisplay = CGMainDisplayID()

        // Collect windowIds per PID for batch AXDocument lookup
        var pidWindows: [pid_t: [(CGWindowID, String, CGRect)]] = [:]

        var result = [String: WindowSnapshot]()
        for (zIndex, info) in infoList.enumerated() {
            guard
                let windowId = info[kCGWindowNumber as String] as? CGWindowID,
                let ownerPID = info[kCGWindowOwnerPID as String] as? pid_t,
                let app = appsByPid[ownerPID],
                let bundleId = app.bundleIdentifier,
                !blockedBundleIds.contains(bundleId),
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

        for (key, docPath) in queryAXDocuments(pidWindows: pidWindows) {
            if let snap = result[key] {
                result[key] = snap.with(documentPath: docPath)
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

    /// Cache of AXDocument lookups keyed by "windowId_pid_title". A nil value records a
    /// completed lookup that found no document, so windows without one (browsers, chat apps)
    /// are not re-queried over AX on every tick. Title is part of the key so tab /
    /// document switches cause a re-query.
    private var axDocumentCache: [String: String?] = [:]

    /// Query kAXDocumentAttribute for windows, batched by PID.
    /// Returns a map of "windowId_pid" → document path.
    private func queryAXDocuments(
        pidWindows: [pid_t: [(CGWindowID, String, CGRect)]]
    ) -> [String: String] {
        guard lastAccessibilityTrusted else { return [:] }

        var results: [String: String] = [:]

        for (pid, windows) in pidWindows {
            var uncached: [(CGWindowID, String, CGRect)] = []
            for (wid, title, rect) in windows {
                if let cached = axDocumentCache["\(wid)_\(pid)_\(title)"] {
                    if let path = cached { results["\(wid)_\(pid)"] = path }
                } else {
                    uncached.append((wid, title, rect))
                }
            }
            if uncached.isEmpty { continue }

            // Record a miss for every uncached window up front; matches below overwrite it.
            for (wid, title, _) in uncached {
                axDocumentCache["\(wid)_\(pid)_\(title)"] = .some(nil)
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
                    axDocumentCache["\(wid)_\(pid)_\(cgTitle)"] = .some(docString)
                    break
                }
            }
        }

        // Prune stale cache entries — keep only entries matching current windows
        let activeCacheKeys = Set(pidWindows.flatMap { pid, windows in
            windows.map { "\($0.0)_\(pid)_\($0.1)" }
        })
        axDocumentCache = axDocumentCache.filter { activeCacheKeys.contains($0.key) }

        return results
    }

    // ── Focus ─────────────────────────────────────────────────────────────

    /// Compute focus/unfocus events for a new focused window and update focus state.
    private func diffFocus(
        focusedWindow: WindowSnapshot?,
        currentWindows: [String: WindowSnapshot],
        prevWindows: [String: WindowSnapshot]
    ) -> [WindowEvent] {
        let newId = focusedWindow?.windowId ?? 0
        let hasNew = focusedWindow != nil
        let oldId = focusedWindowId
        let hadOld = hasFocusedWindow

        var shouldUnfocus = false
        var shouldFocus = false

        switch (hadOld, hasNew) {
        case (false, true):
            shouldFocus = true
        case (true, true):
            if oldId != newId { shouldUnfocus = true; shouldFocus = true }
            else { return [] }
        case (true, false):
            shouldUnfocus = true
        case (false, false):
            return []
        }

        var signals = [WindowEvent]()

        if shouldUnfocus {
            // Prefer current snapshot, fall back to previous
            let unfocusedWin = currentWindows.values.first(where: { $0.windowId == oldId })
                ?? prevWindows.values.first(where: { $0.windowId == oldId })
            if let w = unfocusedWin {
                signals.append(w.toEvent(type: "window-unfocused"))
            }
        }

        if shouldFocus, let w = focusedWindow {
            signals.append(w.toEvent(type: "window-focused"))
            focusedWindowId = w.windowId
            hasFocusedWindow = true
        } else if !shouldFocus, shouldUnfocus {
            focusedWindowId = 0
            hasFocusedWindow = false
        }

        return signals
    }

    /// Detect frontmost-app changes and window switches within the frontmost app.
    private func pollFrontmostApp(currentWindows: [String: WindowSnapshot]) -> [WindowEvent] {
        guard let frontmost = NSWorkspace.shared.frontmostApplication,
              frontmost.bundleIdentifier != nil else { return [] }

        let pid = frontmost.processIdentifier

        if hasActiveApp, activeAppPID == pid {
            // Same app: a different window is frontmost, or (after the focused window
            // closed) another window of the app should receive focus.
            if let front = frontmostWindow(of: pid, in: currentWindows),
               !hasFocusedWindow || front.windowId != focusedWindowId
            {
                return diffFocus(
                    focusedWindow: front,
                    currentWindows: currentWindows,
                    prevWindows: previousWindows
                )
            }
            return []
        }

        // App changed
        activeAppPID = pid
        hasActiveApp = true
        activeAppState = .pendingDiff
        return []
    }

    // ── App Activation ────────────────────────────────────────────────────

    private func progressAppActivation(
        currentWindows: [String: WindowSnapshot]
    ) -> [WindowEvent] {
        guard hasActiveApp, activeAppState == .pendingDiff else { return [] }

        // Wait until the newly active app has a tracked window (it may still be launching).
        guard let frontmost = frontmostWindow(of: activeAppPID, in: currentWindows) else {
            return []
        }

        activeAppState = .pendingSubscribe
        return diffFocus(
            focusedWindow: frontmost,
            currentWindows: currentWindows,
            prevWindows: previousWindows
        )
    }

    /// Side effects after a tick — set up AXObserver when ready.
    private func postTick() {
        guard hasActiveApp, activeAppState == .pendingSubscribe else { return }
        activeAppState = .subscribed
        accessibility?.monitor(pid: activeAppPID)
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /// Find the frontmost (lowest z-index) window owned by `pid`.
    private func frontmostWindow(
        of pid: pid_t, in windows: [String: WindowSnapshot]
    ) -> WindowSnapshot? {
        windows.values
            .filter { $0.ownerPID == pid }
            .min(by: { $0.zIndex < $1.zIndex })
    }

    /// Match an AX focus event to a CGWindowList window.
    private func findWindow(
        matching ax: AccessibilityWindowInfo,
        in windows: [String: WindowSnapshot]
    ) -> WindowSnapshot? {
        let matches = windows.values.filter {
            $0.ownerPID == ax.appPID && WindowDiff.approximatelyEqual($0.bounds, ax.windowRect)
        }
        if matches.count <= 1 { return matches.first }

        let titled = matches.filter { WindowDiff.titlesMatch(cgTitle: $0.title, axTitle: ax.windowTitle) }
        return titled.first ?? matches.first
    }

    // ── Output ────────────────────────────────────────────────────────────

    private func emitLine<T: Encodable>(_ value: T) {
        guard let data = try? encoder.encode(value),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line) // stdout, line-buffered
    }

    /// Diagnostics go to stderr and never include window titles or document paths.
    private func log(_ message: String) {
        FileHandle.standardError.write(Data("[viewport-helper] \(message)\n".utf8))
    }
}

// MARK: - WorkspaceObserverDelegate

extension ViewportMonitor: WorkspaceObserverDelegate {
    // WorkspaceObserver delivers these on `queue`, serialised with tick().

    func workspaceDidActivateApp(pid: pid_t, bundleId: String, name: String) {
        activeAppPID = pid
        hasActiveApp = true
        activeAppState = .pendingDiff

        // Subscribe to AX for the new app immediately so focus changes
        // are detected without waiting for the next tick (postTick).
        accessibility?.monitor(pid: pid)

        // Try to progress immediately; if the app has no tracked window yet (still
        // launching) stay in .pendingDiff so the next tick completes activation.
        for e in progressAppActivation(currentWindows: previousWindows) { emitLine(e) }
        if activeAppState == .pendingSubscribe {
            activeAppState = .subscribed
        }
    }

    func workspaceDidDeactivateApp(pid: pid_t) {
        if hasActiveApp, activeAppPID == pid {
            hasActiveApp = false
        }
    }

    func workspaceDidTerminateApp(pid: pid_t) {
        accessibility?.stopMonitoring(pid: pid)
        if hasActiveApp, activeAppPID == pid {
            hasActiveApp = false
        }
    }

    func workspaceDidChangeActiveSpace() {
        emitLine(SpaceChangeEvent(
            type: "space-changed",
            timestamp: Date().timeIntervalSince1970 * 1000
        ))
    }
}

// MARK: - AccessibilityObserverDelegate

extension ViewportMonitor: AccessibilityObserverDelegate {
    /// Called on the monitor's serial queue (AccessibilityObserver dispatches to it).
    func accessibilityDidChangeFocus(_ windowInfo: AccessibilityWindowInfo) {
        // Resolve focused window: try previous snapshot first to avoid a full scan.
        var currentWindowsForDiff = previousWindows
        var focused = findWindow(matching: windowInfo, in: previousWindows)
        if focused == nil {
            let currentWindows = scanWindows()
            currentWindowsForDiff = currentWindows
            focused = findWindow(matching: windowInfo, in: currentWindows)
        }
        guard let focused else { return }

        let events = diffFocus(
            focusedWindow: focused,
            currentWindows: currentWindowsForDiff,
            prevWindows: previousWindows
        )
        for e in events { emitLine(e) }
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
