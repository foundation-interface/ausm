import CoreGraphics
import Foundation

/// Infers the selection rectangle of an interactive screenshot from raw mouse events.
/// Coordinates are global CG points (origin top-left of the main display, y grows down).
/// Supports creating a new rect, moving it, and resizing by edge/corner handles — the same
/// gestures the macOS selection overlay offers.
///
/// Not thread-safe: `ScreenshotMonitor` drives it from its serial queue only.
final class RectHeuristicTracker {
    enum DragMode {
        case creating(anchor: CGPoint)
        case moving(originRect: CGRect, anchor: CGPoint)
        case resizing(handle: ResizeHandle, originRect: CGRect)

        var isCreating: Bool {
            if case .creating = self { return true }
            return false
        }
    }

    /// Named in CG orientation: `top` is the minY edge, `bottom` is the maxY edge.
    enum ResizeHandle {
        case left, right, top, bottom
        case topLeft, topRight, bottomLeft, bottomRight
    }

    private var currentRect: CGRect?
    private var dragMode: DragMode?
    private var dragStart: CGPoint?
    private var dragDistance: CGFloat = 0
    private let handleSlop: CGFloat = 12

    var onRectChanged: ((CGRect) -> Void)?

    /// True between a mouse-down and the matching mouse-up.
    var isDragging: Bool { dragMode != nil }

    func handleMouseDown(at point: CGPoint) {
        dragStart = point
        dragDistance = 0
        if let r = currentRect, r.width > 0, r.height > 0 {
            if let handle = classifyHandle(down: point, rect: r) {
                dragMode = .resizing(handle: handle, originRect: r)
            } else if r.contains(point) {
                dragMode = .moving(originRect: r, anchor: point)
            } else {
                dragMode = .creating(anchor: point)
            }
        } else {
            dragMode = .creating(anchor: point)
        }
    }

    func handleMouseDragged(to point: CGPoint) {
        guard let mode = dragMode else { return }
        if let s = dragStart { dragDistance = max(dragDistance, hypot(point.x - s.x, point.y - s.y)) }
        emitIfChanged(rect(for: mode, at: point), creating: mode.isCreating)
    }

    /// Returns the distance the mouse travelled during this press (0 for a plain click).
    @discardableResult
    func handleMouseUp(at point: CGPoint) -> CGFloat {
        if let mode = dragMode {
            emitIfChanged(rect(for: mode, at: point), creating: mode.isCreating)
        }
        if let s = dragStart { dragDistance = max(dragDistance, hypot(point.x - s.x, point.y - s.y)) }
        dragMode = nil
        dragStart = nil
        return dragDistance
    }

    func reset() {
        currentRect = nil
        dragMode = nil
        dragStart = nil
        dragDistance = 0
    }

    func getCurrentRect() -> CGRect? {
        return currentRect
    }

    private func rect(for mode: DragMode, at point: CGPoint) -> CGRect {
        switch mode {
        case .creating(let anchor):
            return normalizedRect(from: anchor, to: point)
        case .moving(let originRect, let anchor):
            return originRect.offsetBy(dx: point.x - anchor.x, dy: point.y - anchor.y)
        case .resizing(let handle, let originRect):
            return applyResize(handle: handle, origin: originRect, currentPoint: point)
        }
    }

    private func emitIfChanged(_ newRect: CGRect, creating: Bool) {
        let rounded = CGRect(
            x: round(newRect.origin.x),
            y: round(newRect.origin.y),
            width: round(newRect.size.width),
            height: round(newRect.size.height)
        )
        // A plain click (or a purely horizontal/vertical stroke) while creating must not replace
        // the existing selection with an empty rect: clicking the Cmd+Shift+5 toolbar's Capture
        // button would otherwise wipe the selection right before it is captured.
        if creating, rounded.width <= 0 || rounded.height <= 0 { return }
        if let existing = currentRect, existing == rounded { return }
        currentRect = rounded
        onRectChanged?(rounded)
    }

    private func normalizedRect(from a: CGPoint, to b: CGPoint) -> CGRect {
        let x1 = min(a.x, b.x), x2 = max(a.x, b.x)
        let y1 = min(a.y, b.y), y2 = max(a.y, b.y)
        return CGRect(x: x1, y: y1, width: x2 - x1, height: y2 - y1)
    }

    private func classifyHandle(down p: CGPoint, rect r: CGRect) -> ResizeHandle? {
        let slop = handleSlop
        func near(_ a: CGPoint, _ b: CGPoint) -> Bool {
            abs(a.x - b.x) <= slop && abs(a.y - b.y) <= slop
        }
        if near(p, CGPoint(x: r.minX, y: r.minY)) { return .topLeft }
        if near(p, CGPoint(x: r.maxX, y: r.minY)) { return .topRight }
        if near(p, CGPoint(x: r.minX, y: r.maxY)) { return .bottomLeft }
        if near(p, CGPoint(x: r.maxX, y: r.maxY)) { return .bottomRight }
        let withinY = p.y >= r.minY - slop && p.y <= r.maxY + slop
        let withinX = p.x >= r.minX - slop && p.x <= r.maxX + slop
        if abs(p.x - r.minX) <= slop && withinY { return .left }
        if abs(p.x - r.maxX) <= slop && withinY { return .right }
        if abs(p.y - r.minY) <= slop && withinX { return .top }
        if abs(p.y - r.maxY) <= slop && withinX { return .bottom }
        return nil
    }

    private func applyResize(handle: ResizeHandle, origin: CGRect, currentPoint p: CGPoint) -> CGRect {
        var minX = origin.minX, maxX = origin.maxX
        var minY = origin.minY, maxY = origin.maxY
        switch handle {
        case .left:        minX = p.x
        case .right:       maxX = p.x
        case .top:         minY = p.y
        case .bottom:      maxY = p.y
        case .topLeft:     minX = p.x; minY = p.y
        case .topRight:    maxX = p.x; minY = p.y
        case .bottomLeft:  minX = p.x; maxY = p.y
        case .bottomRight: maxX = p.x; maxY = p.y
        }
        // Allow dragging a handle past the opposite edge (the overlay flips the rect).
        return CGRect(x: min(minX, maxX), y: min(minY, maxY), width: abs(maxX - minX), height: abs(maxY - minY))
    }
}
