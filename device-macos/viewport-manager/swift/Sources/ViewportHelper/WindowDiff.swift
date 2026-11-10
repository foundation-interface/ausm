/// Pure, side-effect-free window-state logic (unit-tested in Tests/ViewportHelperTests).

import CoreGraphics
import Foundation

enum WindowDiff {
    /// Diff two CGWindowList snapshots (keyed by `WindowSnapshot.key`) into
    /// window-closed / window-opened / title-changed / bounds-changed events.
    ///
    /// Order: all closes first, then per-window opens and changes. When more than one window
    /// changes bounds in the same tick (Mission Control / Space swipe animations, display
    /// reconfiguration) all bounds-changed events are dropped as noise.
    static func diff(old: [String: WindowSnapshot], new: [String: WindowSnapshot]) -> [WindowEvent] {
        var events = [WindowEvent]()
        var boundsChangedCount = 0

        for (key, oldWin) in old.sorted(by: { $0.value.zIndex < $1.value.zIndex }) where new[key] == nil {
            events.append(oldWin.toEvent(type: "window-closed"))
        }

        for (key, newWin) in new.sorted(by: { $0.value.zIndex < $1.value.zIndex }) {
            if let oldWin = old[key] {
                if oldWin.title != newWin.title {
                    var evt = newWin.toEvent(type: "title-changed")
                    evt.oldTitle = oldWin.title
                    events.append(evt)
                }
                if oldWin.bounds != newWin.bounds {
                    var evt = newWin.toEvent(type: "bounds-changed")
                    evt.oldBounds = .init(oldWin.bounds)
                    events.append(evt)
                    boundsChangedCount += 1
                }
            } else {
                events.append(newWin.toEvent(type: "window-opened"))
            }
        }

        if boundsChangedCount > 1 {
            events.removeAll { $0.type == "bounds-changed" }
        }
        return events
    }

    /// The display a window is "primarily on": the one with the largest intersection area.
    /// Falls back to the display nearest the window's centre when it intersects none
    /// (e.g. a window dragged mostly off-screen), and to `fallback` when there are no displays.
    static func primaryDisplay(
        for rect: CGRect,
        displays: [(id: CGDirectDisplayID, bounds: CGRect)],
        fallback: CGDirectDisplayID
    ) -> CGDirectDisplayID {
        var best: (id: CGDirectDisplayID, area: CGFloat)?
        for d in displays {
            let inter = rect.intersection(d.bounds)
            guard !inter.isNull, !inter.isEmpty else { continue }
            let area = inter.width * inter.height
            if best == nil || area > best!.area { best = (d.id, area) }
        }
        if let best { return best.id }

        let centre = CGPoint(x: rect.midX, y: rect.midY)
        func distance(_ r: CGRect) -> CGFloat {
            let dx = max(r.minX - centre.x, 0, centre.x - r.maxX)
            let dy = max(r.minY - centre.y, 0, centre.y - r.maxY)
            return dx * dx + dy * dy
        }
        return displays.min(by: { distance($0.bounds) < distance($1.bounds) })?.id ?? fallback
    }

    /// AX and CGWindowList report the same global top-left-origin coordinates, but either side
    /// may round fractional (scaled-mode) values differently.
    static func approximatelyEqual(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = 2) -> Bool {
        abs(a.origin.x - b.origin.x) < tolerance && abs(a.origin.y - b.origin.y) < tolerance
            && abs(a.width - b.width) < tolerance && abs(a.height - b.height) < tolerance
    }

    /// Title match used when correlating an AX window with a CGWindowList entry.
    static func titlesMatch(cgTitle: String, axTitle: String?) -> Bool {
        guard let axTitle else { return cgTitle.isEmpty }
        return cgTitle == axTitle || (!cgTitle.isEmpty && axTitle.hasPrefix(cgTitle))
    }

    /// Whether a CGWindowList entry should be tracked as a user-visible window.
    static func shouldTrack(title: String, bounds rect: CGRect) -> Bool {
        // Skip tiny / zero-area helper windows.
        guard rect.width > 100 && rect.height > 100 else { return false }
        // Skip unnamed windows (utility panels). NOTE: without Screen Recording permission
        // macOS hides other apps' window titles, so most windows are skipped.
        guard !title.isEmpty else { return false }
        // Menu-bar "Item-0" status items pinned to the top edge.
        if title == "Item-0" {
            let minDim = min(rect.width, rect.height)
            if minDim * minDim < 80 * 80 && rect.origin.y < minDim { return false }
        }
        return true
    }
}
