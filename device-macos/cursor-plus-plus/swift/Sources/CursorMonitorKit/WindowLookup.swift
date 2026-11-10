import AppKit
import CoreGraphics
import Foundation

/// Find the frontmost on-screen normal-level window whose bounds contain the given point.
/// Windows owned by `excludingPIDs` (e.g. the host's own overlay) are skipped.
public func windowAtPoint(_ point: CGPoint, excludingPIDs: Set<pid_t> = []) -> WindowInfo? {
    guard let infoList = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else {
        return nil
    }

    for info in infoList {
        guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else {
            continue
        }
        guard let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else {
            continue
        }
        guard bounds.contains(point) else { continue }

        let pid = info[kCGWindowOwnerPID as String] as? pid_t ?? 0
        if excludingPIDs.contains(pid) { continue }

        let windowId = info[kCGWindowNumber as String] as? CGWindowID ?? 0
        let title = info[kCGWindowName as String] as? String ?? ""
        let ownerName = info[kCGWindowOwnerName as String] as? String ?? ""
        let bundleId = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""

        return WindowInfo(
            windowId: windowId,
            title: title,
            ownerName: ownerName,
            bundleId: bundleId,
            pid: pid,
            bounds: bounds
        )
    }
    return nil
}
