import Foundation
import CoreGraphics

// MARK: - DisplayManager

/// Enumerates displays and polls (every 2 s, on the main run loop) for
/// connect / disconnect / mode / arrangement changes.
final class DisplayManager {
    private var changeCallback: ((DisplayChangeEvent) -> Void)?
    private let lock = NSLock()
    private var cachedDisplays: [DisplayInfo] = []
    private var lastKnownDisplayIds: [CGDirectDisplayID] = []
    /// Track last known dimensions per display to detect configuration changes (e.g. orientation)
    private var lastKnownDisplayDimensions: [CGDirectDisplayID: (width: Int, height: Int)] = [:]
    /// Track last known bounds per display to detect arrangement/position changes
    private var lastKnownDisplayBounds: [CGDirectDisplayID: CGRect] = [:]
    private var pollingTimer: CFRunLoopTimer?

    init() {
        // Initialize cached display list
        _ = getDisplays()

        // Initialize last known display IDs and dimensions for change detection
        var displayCount: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &displayCount)
        if displayCount > 0 {
            lastKnownDisplayIds = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
            CGGetActiveDisplayList(displayCount, &lastKnownDisplayIds, &displayCount)

            // Record initial dimensions and bounds for each display
            for displayId in lastKnownDisplayIds {
                lastKnownDisplayDimensions[displayId] = getDisplayPixelDimensions(displayId)
                lastKnownDisplayBounds[displayId] = CGDisplayBounds(displayId)
            }
        }

        log("Initialized with \(cachedDisplays.count) displays")
        startDisplayPolling()
    }

    deinit {
        if let pollingTimer { CFRunLoopTimerInvalidate(pollingTimer) }
    }

    // MARK: - Public API

    func getDisplays() -> [DisplayInfo] {
        lock.lock()
        defer { lock.unlock() }

        var displays: [DisplayInfo] = []

        var displayCount: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &displayCount)
        guard displayCount > 0 else { return displays }

        var displayIds = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
        CGGetActiveDisplayList(displayCount, &displayIds, &displayCount)

        let mainDisplayId = CGMainDisplayID()

        for cgDisplayId in displayIds {
            var info = DisplayInfo(
                id: DisplayInfo.makeId(cgDisplayId),
                displayId: cgDisplayId,
                width: 0, height: 0,
                isMain: cgDisplayId == mainDisplayId,
                isBuiltIn: CGDisplayIsBuiltin(cgDisplayId) != 0,
                scaleFactor: 1.0,
                refreshRate: 60.0
            )

            // Get physical pixel dimensions and refresh rate from display mode
            if let mode = CGDisplayCopyDisplayMode(cgDisplayId) {
                info.width = UInt32(mode.pixelWidth)
                info.height = UInt32(mode.pixelHeight)
                info.refreshRate = mode.refreshRate > 0 ? mode.refreshRate : 60.0
            } else {
                info.width = UInt32(CGDisplayPixelsWide(cgDisplayId))
                info.height = UInt32(CGDisplayPixelsHigh(cgDisplayId))
            }

            // Backing scale factor = pixels per point of the current mode.
            // (Derived from CoreGraphics rather than NSScreen, which is
            // main-thread-only AppKit API; this runs on the command queue.)
            info.scaleFactor = Self.scaleFactor(cgDisplayId)

            displays.append(info)
        }

        cachedDisplays = displays
        return displays
    }

    func setDisplayChangeCallback(_ callback: ((DisplayChangeEvent) -> Void)?) {
        lock.lock()
        defer { lock.unlock() }
        changeCallback = callback
    }

    func startMonitoring(_ callback: @escaping (DisplayChangeEvent) -> Void) {
        setDisplayChangeCallback(callback)
    }

    /// Whether Screen Recording (TCC) access is granted. Never prompts.
    static func hasPermission() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    /// Pixels per point for the display's current mode (1.0 if unknown).
    static func scaleFactor(_ displayId: CGDirectDisplayID) -> Double {
        guard let mode = CGDisplayCopyDisplayMode(displayId), mode.width > 0, mode.pixelWidth > 0 else {
            return 1.0
        }
        return Double(mode.pixelWidth) / Double(mode.width)
    }

    // MARK: - Display Change Detection

    func detectDisplayChanges() {
        var displayCount: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &displayCount)

        var currentDisplayIds = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
        if displayCount > 0 {
            CGGetActiveDisplayList(displayCount, &currentDisplayIds, &displayCount)
        }

        let lastIds: [CGDirectDisplayID]
        let lastDimensions: [CGDirectDisplayID: (width: Int, height: Int)]
        let lastBounds: [CGDirectDisplayID: CGRect]
        lock.lock()
        lastIds = lastKnownDisplayIds
        lastDimensions = lastKnownDisplayDimensions
        lastBounds = lastKnownDisplayBounds
        lock.unlock()

        var changed = false

        // Find added displays
        for currentId in currentDisplayIds {
            if !lastIds.contains(currentId) {
                log("Detected NEW display: \(currentId)")
                handleDisplayChange(currentId, flags: .addFlag)
                changed = true
            }
        }

        // Find removed displays
        for lastId in lastIds {
            if !currentDisplayIds.contains(lastId) {
                log("Detected REMOVED display: \(lastId)")
                handleDisplayChange(lastId, flags: .removeFlag)
                changed = true
            }
        }

        // Detect configuration changes on existing displays:
        // - Resolution / orientation changes (pixel dimensions differ)
        // - Arrangement / position changes (display bounds differ)
        for currentId in currentDisplayIds {
            // Only check displays that already existed (not newly added ones)
            guard lastIds.contains(currentId) else { continue }

            let currentDims = getDisplayPixelDimensions(currentId)
            let currentBoundsRect = CGDisplayBounds(currentId)

            let dimsChanged: Bool = {
                guard let lastDims = lastDimensions[currentId] else { return false }
                return currentDims.width != lastDims.width || currentDims.height != lastDims.height
            }()

            let boundsChanged: Bool = {
                guard let lastRect = lastBounds[currentId] else { return false }
                return !currentBoundsRect.equalTo(lastRect)
            }()

            if dimsChanged {
                log("Detected RECONFIGURED display: \(currentId) (\(lastDimensions[currentId]?.width ?? 0)x\(lastDimensions[currentId]?.height ?? 0) -> \(currentDims.width)x\(currentDims.height))")
                handleDisplayChange(currentId, flags: .setModeFlag)
                changed = true
            } else if boundsChanged {
                log("Detected REARRANGED display: \(currentId) (bounds changed)")
                handleDisplayChange(currentId, flags: .desktopShapeChangedFlag)
                changed = true
            }
        }

        // Update last known displays, dimensions, and bounds
        lock.lock()
        lastKnownDisplayIds = currentDisplayIds
        lastKnownDisplayDimensions.removeAll()
        lastKnownDisplayBounds.removeAll()
        for displayId in currentDisplayIds {
            lastKnownDisplayDimensions[displayId] = getDisplayPixelDimensions(displayId)
            lastKnownDisplayBounds[displayId] = CGDisplayBounds(displayId)
        }
        lock.unlock()

        if changed {
            log("Display configuration changed: \(displayCount) displays (was \(lastIds.count))")
        }
    }

    // MARK: - Private

    private func startDisplayPolling() {
        guard pollingTimer == nil else { return }

        var context = CFRunLoopTimerContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil, release: nil, copyDescription: nil
        )

        // passUnretained is safe: the timer is invalidated in deinit.
        if let timer = CFRunLoopTimerCreate(
            kCFAllocatorDefault,
            CFAbsoluteTimeGetCurrent() + 0.5,  // First fire in 0.5s
            2.0,                                 // Then every 2s
            0, 0,
            { _, info in
                guard let info else { return }
                let mgr = Unmanaged<DisplayManager>.fromOpaque(info).takeUnretainedValue()
                // Run as a main-queue block (like commands): handling a change can pump the run loop
                // in awaitCallback, which from a bare timer callback would drain other main-queue
                // blocks (commands, shutdown) re-entrantly.
                DispatchQueue.main.async { [weak mgr] in
                    mgr?.detectDisplayChanges()
                }
            },
            &context
        ) {
            CFRunLoopAddTimer(CFRunLoopGetMain(), timer, .commonModes)
            pollingTimer = timer
        } else {
            log("ERROR: Failed to create display polling timer")
        }
    }

    private func handleDisplayChange(_ display: CGDirectDisplayID, flags: CGDisplayChangeSummaryFlags) {
        // Ignore begin configuration events
        if flags.contains(.beginConfigurationFlag) { return }

        // Build event
        var event = DisplayChangeEvent(
            type: .reconfigured,
            displayId: DisplayInfo.makeId(display)
        )

        if flags.contains(.addFlag) || flags.contains(.enabledFlag) {
            event = DisplayChangeEvent(type: .added, displayId: event.displayId)
        } else if flags.contains(.removeFlag) || flags.contains(.disabledFlag) {
            event = DisplayChangeEvent(type: .removed, displayId: event.displayId)
        } else if flags.contains(.setModeFlag) || flags.contains(.desktopShapeChangedFlag) {
            event = DisplayChangeEvent(type: .reconfigured, displayId: event.displayId)
        }

        // Get updated display info for non-removal events
        if event.type != .removed {
            var info = DisplayInfo(
                id: event.displayId,
                displayId: display,
                width: 0, height: 0,
                isMain: display == CGMainDisplayID(),
                isBuiltIn: CGDisplayIsBuiltin(display) != 0,
                scaleFactor: 1.0,
                refreshRate: 60.0
            )

            if let mode = CGDisplayCopyDisplayMode(display) {
                info.width = UInt32(mode.pixelWidth)
                info.height = UInt32(mode.pixelHeight)
                let rate = mode.refreshRate
                if rate > 0 { info.refreshRate = rate }
            } else {
                info.width = UInt32(CGDisplayPixelsWide(display))
                info.height = UInt32(CGDisplayPixelsHigh(display))
            }

            event.info = info
        }

        // Log user-friendly messages
        switch event.type {
        case .added:
            if let info = event.info, info.width > 0 {
                NSLog("📺 DISPLAY CONNECTED: %@ (%ux%u)", event.displayId, info.width, info.height)
            } else {
                NSLog("📺 DISPLAY CONNECTED: %@ (initializing...)", event.displayId)
            }
        case .removed:
            NSLog("📺 DISPLAY DISCONNECTED: %@", event.displayId)
        case .reconfigured:
            if let info = event.info {
                NSLog("📺 Display reconfigured: %@ (%ux%u)", event.displayId, info.width, info.height)
            }
        }

        // Refresh cache
        _ = getDisplays()

        // Invoke callback outside lock
        lock.lock()
        let callback = changeCallback
        lock.unlock()

        guard let callback else {
            log("No callback registered, but display state updated")
            return
        }

        log("Invoking display change callback for \(event.displayId)")
        callback(event)
    }

    /// Get the pixel dimensions (width, height) for a display from its current mode.
    private func getDisplayPixelDimensions(_ displayId: CGDirectDisplayID) -> (width: Int, height: Int) {
        if let mode = CGDisplayCopyDisplayMode(displayId) {
            return (mode.pixelWidth, mode.pixelHeight)
        }
        return (CGDisplayPixelsWide(displayId), CGDisplayPixelsHigh(displayId))
    }

    private func log(_ msg: String) {
        fputs("[DisplayManager] \(msg)\n", stderr)
        fflush(stderr)
    }
}
