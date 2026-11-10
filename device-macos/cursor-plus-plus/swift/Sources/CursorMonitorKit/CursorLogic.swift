import CoreGraphics
import Foundation

/// Rate limiter: lets an event through when at least `interval` seconds passed since the last
/// one it let through. `interval <= 0` lets everything through. A timestamp earlier than the
/// last emitted one (clock moved backwards) also passes and restarts the interval, so the
/// throttle can never get stuck suppressing events.
struct EventThrottle {
    var interval: TimeInterval
    private var last: TimeInterval?

    init(interval: TimeInterval) {
        self.interval = interval
    }

    mutating func shouldEmit(at now: TimeInterval) -> Bool {
        if interval > 0, let last = last, now >= last, now - last < interval { return false }
        last = now
        return true
    }
}

/// Press-and-hold detection for the left button.
///
/// A press is a hold once it has lasted `thresholdMs` while the cursor stayed within
/// `tolerance` points of where it went down. `HOLD_START` fires at that moment (from a timer or
/// the next drag event, whichever comes first); `HOLD_END` fires on release of a press that was
/// a hold. A press that wandered beyond the tolerance before the threshold is a drag, not a hold.
struct HoldTracker {
    var thresholdMs: Double
    var tolerance: Double

    private(set) var downTime: TimeInterval?
    private(set) var downPoint: CGPoint = .zero
    private(set) var holdStarted = false
    private var maxDistance: Double = 0

    init(thresholdMs: Double, tolerance: Double) {
        self.thresholdMs = thresholdMs
        self.tolerance = tolerance
    }

    var isPressed: Bool { downTime != nil }

    mutating func mouseDown(at point: CGPoint, time: TimeInterval) {
        downTime = time
        downPoint = point
        holdStarted = false
        maxDistance = 0
    }

    /// Feed a drag position (or nil for a timer tick). Returns the elapsed ms when HOLD_START
    /// should fire now; at most once per press.
    mutating func update(at point: CGPoint?, time: TimeInterval) -> Double? {
        guard let down = downTime, !holdStarted else { return nil }
        if let point = point { track(point) }
        guard maxDistance <= tolerance else { return nil }
        let elapsed = (time - down) * 1000
        guard elapsed >= thresholdMs else { return nil }
        holdStarted = true
        return elapsed
    }

    /// Returns the hold duration (ms) when HOLD_END should fire for this release.
    mutating func mouseUp(at point: CGPoint, time: TimeInterval) -> Double? {
        guard let down = downTime else { return nil }
        defer { reset() }
        track(point)
        let elapsed = (time - down) * 1000
        if holdStarted || (elapsed >= thresholdMs && maxDistance <= tolerance) {
            return elapsed
        }
        return nil
    }

    mutating func reset() {
        downTime = nil
        holdStarted = false
        maxDistance = 0
    }

    private mutating func track(_ point: CGPoint) {
        maxDistance = max(maxDistance, Double(hypot(point.x - downPoint.x, point.y - downPoint.y)))
    }
}
