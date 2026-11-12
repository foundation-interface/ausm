import CoreGraphics
import Foundation

/// Focus / app-activation state machine (pure; unit-tested). `WindowMonitor` feeds it window
/// snapshots, the frontmost app's pid and workspace / AX notifications, and emits what it returns.
struct FocusTracker {
    private(set) var focusedWindowId: CGWindowID = 0
    private(set) var hasFocusedWindow = false
    private(set) var activeAppPID: pid_t = 0
    private(set) var hasActiveApp = false
    private(set) var activeAppState: ActiveAppState = .pendingDiff

    struct TickResult: Equatable {
        var events: [WindowEvent]
        /// Attach the AX focus observer to this pid after emitting.
        var subscribePID: pid_t?
    }

    /// The app that is frontmost when monitoring starts.
    mutating func begin(frontmostPID pid: pid_t?) {
        self = FocusTracker()
        if let pid {
            activeAppPID = pid
            hasActiveApp = true
            activeAppState = .pendingDiff
        }
    }

    /// One polling tick. `frontmostPID` is nil when there is no frontmost app with a bundle id.
    mutating func tick(previous: [String: WindowSnapshot], current: [String: WindowSnapshot],
                       frontmostPID: pid_t?) -> TickResult {
        // 1. Diff (open / close / title / bounds)
        var events = WindowDiff.diff(old: previous, new: current)
        // 2. Auto-unfocus a closed focused window (unfocused is emitted right before its close)
        unfocusClosedWindow(in: &events)
        // 3. Poll-based focus detection (fallback when AX is unavailable or silent)
        events += pollFrontmost(pid: frontmostPID, current: current, previous: previous)
        // 4. Progress the app-activation state machine
        events += progressActivation(current: current, previous: previous)
        // 5. Subscribe AX once the new app's window has been focused
        var subscribe: pid_t?
        if hasActiveApp, activeAppState == .pendingSubscribe {
            activeAppState = .subscribed
            subscribe = activeAppPID
        }
        return TickResult(events: events, subscribePID: subscribe)
    }

    mutating func unfocusClosedWindow(in events: inout [WindowEvent]) {
        guard hasFocusedWindow,
              let closeIdx = events.firstIndex(where: { $0.type == .closed && $0.windowId == focusedWindowId })
        else { return }
        var unfocused = events[closeIdx]
        unfocused.type = .unfocused
        events.insert(unfocused, at: closeIdx)
        focusedWindowId = 0
        hasFocusedWindow = false
    }

    /// Focus/unfocus events for a newly focused window; updates focus state.
    mutating func diffFocus(focusedWindow: WindowSnapshot?, current: [String: WindowSnapshot],
                            previous: [String: WindowSnapshot]) -> [WindowEvent] {
        let newId = focusedWindow?.windowId ?? 0
        let hasNew = focusedWindow != nil
        let oldId = focusedWindowId

        var shouldUnfocus = false
        var shouldFocus = false
        switch (hasFocusedWindow, hasNew) {
        case (false, true):
            shouldFocus = true
        case (true, true):
            if oldId != newId { shouldUnfocus = true; shouldFocus = true } else { return [] }
        case (true, false):
            shouldUnfocus = true
        case (false, false):
            return []
        }

        var signals = [WindowEvent]()
        if shouldUnfocus {
            // Prefer the current snapshot, fall back to the previous one.
            let unfocusedWin = current.values.first(where: { $0.windowId == oldId })
                ?? previous.values.first(where: { $0.windowId == oldId })
            if let w = unfocusedWin { signals.append(w.toEvent(type: .unfocused)) }
        }
        if shouldFocus, let w = focusedWindow {
            signals.append(w.toEvent(type: .focused))
            focusedWindowId = w.windowId
            hasFocusedWindow = true
        } else if shouldUnfocus {
            focusedWindowId = 0
            hasFocusedWindow = false
        }
        return signals
    }

    /// Frontmost-app changes and window switches within the frontmost app.
    mutating func pollFrontmost(pid: pid_t?, current: [String: WindowSnapshot],
                                previous: [String: WindowSnapshot]) -> [WindowEvent] {
        guard let pid else { return [] }
        if hasActiveApp, activeAppPID == pid {
            // Same app: a different window is frontmost, or (after the focused window closed)
            // another window of the app should receive focus.
            if let front = WindowDiff.frontmostWindow(of: pid, in: current),
               !hasFocusedWindow || front.windowId != focusedWindowId {
                return diffFocus(focusedWindow: front, current: current, previous: previous)
            }
            return []
        }
        // App changed: wait for its window (progressActivation).
        activeAppPID = pid
        hasActiveApp = true
        activeAppState = .pendingDiff
        return []
    }

    mutating func progressActivation(current: [String: WindowSnapshot],
                                     previous: [String: WindowSnapshot]) -> [WindowEvent] {
        guard hasActiveApp, activeAppState == .pendingDiff else { return [] }
        // Wait until the newly active app has a tracked window (it may still be launching).
        guard let front = WindowDiff.frontmostWindow(of: activeAppPID, in: current) else { return [] }
        activeAppState = .pendingSubscribe
        return diffFocus(focusedWindow: front, current: current, previous: previous)
    }

    /// NSWorkspace didActivateApplication. The caller attaches the AX observer to `pid` right away.
    mutating func appActivated(pid: pid_t, windows: [String: WindowSnapshot]) -> [WindowEvent] {
        activeAppPID = pid
        hasActiveApp = true
        activeAppState = .pendingDiff
        // If the app has no tracked window yet (still launching) stay in .pendingDiff so the
        // next tick completes activation.
        let events = progressActivation(current: windows, previous: windows)
        if activeAppState == .pendingSubscribe { activeAppState = .subscribed }
        return events
    }

    mutating func appDeactivated(pid: pid_t) {
        if hasActiveApp, activeAppPID == pid { hasActiveApp = false }
    }

    mutating func appTerminated(pid: pid_t) {
        if hasActiveApp, activeAppPID == pid { hasActiveApp = false }
    }

    /// AX focus moved to the window described by `ax`. `lookup` returns the windows to search
    /// when the previous snapshot has no match (a fresh scan).
    mutating func axFocusChanged(_ ax: AccessibilityWindowInfo, previous: [String: WindowSnapshot],
                                 rescan: () -> [String: WindowSnapshot]) -> [WindowEvent] {
        var windows = previous
        var focused = WindowDiff.findWindow(matching: ax, in: previous)
        if focused == nil {
            windows = rescan()
            focused = WindowDiff.findWindow(matching: ax, in: windows)
        }
        guard let focused else { return [] }
        return diffFocus(focusedWindow: focused, current: windows, previous: previous)
    }
}

/// Cache of AXDocument lookups keyed by window id, pid and title (pure; unit-tested). A nil
/// value records a completed lookup that found no document, so windows without one (browsers,
/// chat apps) are not re-queried over AX on every tick. The title is part of the key so tab /
/// document switches cause a re-query.
struct DocumentPathCache {
    struct Key: Hashable {
        let windowId: CGWindowID
        let pid: pid_t
        let title: String
    }

    private(set) var entries: [Key: String?] = [:]

    /// `.some(nil)` = looked up, no document; `nil` = never looked up.
    func lookup(_ key: Key) -> String?? { entries[key] }

    mutating func record(_ key: Key, path: String?) { entries[key] = .some(path) }

    /// Drop entries for windows that are no longer on screen (or whose title changed).
    mutating func prune(keeping active: Set<Key>) {
        entries = entries.filter { active.contains($0.key) }
    }
}
