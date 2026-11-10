import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Screen capture primitives used by `ScreenshotMonitor` to reproduce what the system
/// screenshot just captured. On macOS 14+ this uses ScreenCaptureKit so the Screenshot
/// overlay / toolbar / floating thumbnail (and any host-app windows) can be excluded from
/// the image; older systems fall back to `CGDisplayCreateImage` + crop.
///
/// All functions are safe to call from any thread. Capture completions are delivered on an
/// arbitrary background queue.
public enum ScreenCapture {
    /// Error string reported when Screen Recording permission is missing.
    public static let screenRecordingDeniedMessage =
        "Screen Recording permission not granted (System Settings → Privacy & Security → Screen Recording)"

    /// Whether this process (or the app responsible for it) may capture screen contents.
    /// Never prompts.
    public static func hasScreenRecordingPermission() -> Bool {
        return CGPreflightScreenCaptureAccess()
    }

    public struct Exclusions: Sendable {
        public var bundleIdentifiers: Set<String> = ["com.apple.screencaptureui"]
        public var pids: Set<pid_t> = []
        public init() {}
    }

    /// Display containing `point` (global CG coordinates), falling back to the main display.
    public static func display(containing point: CGPoint) -> CGDirectDisplayID {
        var id: CGDirectDisplayID = 0
        var count: UInt32 = 0
        if CGGetDisplaysWithPoint(point, 1, &id, &count) == .success, count > 0 {
            return id
        }
        return CGMainDisplayID()
    }

    /// Backing scale factor of a display (pixels per point). `CGDisplayPixelsWide` reports points
    /// in HiDPI modes, so the display mode's pixel size is the reliable source.
    public static func backingScale(of displayID: CGDirectDisplayID) -> CGFloat {
        if let mode = CGDisplayCopyDisplayMode(displayID), mode.width > 0 {
            return CGFloat(mode.pixelWidth) / CGFloat(mode.width)
        }
        return 1
    }

    /// Current mouse location in global CG coordinates (thread-safe, no AppKit needed).
    public static func mouseLocation() -> CGPoint {
        return CGEvent(source: nil)?.location ?? .zero
    }

    /// Capture `displayID`, optionally cropped to `rect` (global CG points).
    public static func captureDisplay(
        _ displayID: CGDirectDisplayID,
        cropTo rect: CGRect?,
        excluding exclusions: Exclusions,
        completion: @escaping (CGImage?, String?) -> Void
    ) {
        let bounds = CGDisplayBounds(displayID)
        // Clip to the display; a rect that misses it entirely captures the whole display.
        let crop: CGRect? = rect.flatMap { r -> CGRect? in
            guard r.width >= 1, r.height >= 1 else { return nil }
            let clipped = r.intersection(bounds)
            return clipped.width >= 1 && clipped.height >= 1 ? clipped : nil
        }

        if #available(macOS 14.0, *) {
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
                guard let content = content, let display = content.displays.first(where: { $0.displayID == displayID }) else {
                    // Permission missing or display vanished (hot-unplug): fall back to legacy capture.
                    fallbackDisplay(displayID, crop: crop, error: error.map { "SCShareableContent: \($0.localizedDescription)" }, completion: completion)
                    return
                }
                let excludedApps = content.applications.filter {
                    exclusions.bundleIdentifiers.contains($0.bundleIdentifier) || exclusions.pids.contains($0.processID)
                }
                let filter = SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: [])
                let config = SCStreamConfiguration()
                let scale = backingScale(of: displayID)
                let target = crop ?? bounds
                // sourceRect is in display-local points.
                config.sourceRect = CGRect(
                    x: target.origin.x - bounds.origin.x,
                    y: target.origin.y - bounds.origin.y,
                    width: target.width,
                    height: target.height
                )
                config.width = max(Int((target.width * scale).rounded()), 1)
                config.height = max(Int((target.height * scale).rounded()), 1)
                config.scalesToFit = false
                config.showsCursor = false
                config.captureResolution = .best
                config.pixelFormat = kCVPixelFormatType_32BGRA
                SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
                    if let image = image {
                        completion(image, nil)
                    } else {
                        fallbackDisplay(displayID, crop: crop, error: error.map { "SCScreenshotManager: \($0.localizedDescription)" }, completion: completion)
                    }
                }
            }
        } else {
            fallbackDisplay(displayID, crop: crop, error: nil, completion: completion)
        }
    }

    /// Without Screen Recording permission the legacy CG APIs do not fail — they return the
    /// desktop wallpaper with every window missing. Never report such an image as a capture.
    private static func fallbackDisplay(
        _ displayID: CGDirectDisplayID, crop: CGRect?, error: String?,
        completion: @escaping (CGImage?, String?) -> Void
    ) {
        guard hasScreenRecordingPermission() else {
            completion(nil, screenRecordingDeniedMessage)
            return
        }
        completion(legacyCaptureDisplay(displayID, cropTo: crop), error)
    }

    private static func fallbackWindow(
        _ windowID: CGWindowID, error: String?,
        completion: @escaping (CGImage?, String?) -> Void
    ) {
        guard hasScreenRecordingPermission() else {
            completion(nil, screenRecordingDeniedMessage)
            return
        }
        completion(legacyCaptureWindow(windowID), error)
    }

    /// Capture a single window (including its shadow, like Cmd+Shift+4 + Space does).
    public static func captureWindow(_ windowID: CGWindowID, completion: @escaping (CGImage?, String?) -> Void) {
        if #available(macOS 14.0, *) {
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
                guard let content = content, let window = content.windows.first(where: { $0.windowID == windowID }) else {
                    fallbackWindow(windowID, error: error.map { "SCShareableContent: \($0.localizedDescription)" }, completion: completion)
                    return
                }
                let filter = SCContentFilter(desktopIndependentWindow: window)
                let config = SCStreamConfiguration()
                let frame = window.frame
                let scale = backingScale(of: display(containing: CGPoint(x: frame.midX, y: frame.midY)))
                config.width = max(Int((frame.width * scale).rounded()), 1)
                config.height = max(Int((frame.height * scale).rounded()), 1)
                config.showsCursor = false
                config.captureResolution = .best
                config.ignoreShadowsSingleWindow = false
                config.pixelFormat = kCVPixelFormatType_32BGRA
                SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
                    if let image = image { completion(image, nil) }
                    else { fallbackWindow(windowID, error: error.map { "SCScreenshotManager: \($0.localizedDescription)" }, completion: completion) }
                }
            }
        } else {
            fallbackWindow(windowID, error: nil, completion: completion)
        }
    }

    /// Topmost normal (layer 0) window under `point`, skipping the screenshot UI and excluded apps.
    static func windowID(at point: CGPoint, excluding exclusions: Exclusions) -> CGWindowID? {
        guard let infoList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        for info in infoList {
            guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
            guard let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
                  bounds.contains(point) else { continue }
            let pid = info[kCGWindowOwnerPID as String] as? pid_t ?? 0
            if exclusions.pids.contains(pid) { continue }
            let owner = info[kCGWindowOwnerName as String] as? String ?? ""
            if owner == "Screenshot" || owner == "screencapture" { continue }
            if let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier,
               exclusions.bundleIdentifiers.contains(bundle) { continue }
            return info[kCGWindowNumber as String] as? CGWindowID
        }
        return nil
    }

    /// Bounds (global CG points) of an on-screen window, nil if it is gone.
    static func windowBounds(_ windowID: CGWindowID) -> CGRect? {
        guard let infoList = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]],
              let info = infoList.first,
              let boundsDict = info[kCGWindowBounds as String] as? [String: Any] else { return nil }
        return CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
    }

    /// Bounds (global CG points) of the window owned by the Screenshot agent that looks like the
    /// Cmd+Shift+5 toolbar: a wide, short window at a very high level.
    static func screenshotToolbarBounds() -> CGRect? {
        guard let infoList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        for info in infoList {
            let owner = info[kCGWindowOwnerName as String] as? String ?? ""
            guard owner == "Screenshot" || owner == "screencaptureui" else { continue }
            guard let layer = info[kCGWindowLayer as String] as? Int, layer >= 1000 else { continue }
            guard let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
            if bounds.width >= 300, bounds.height <= 120 { return bounds }
        }
        return nil
    }

    // MARK: - Legacy fallbacks

    private static func legacyCaptureDisplay(_ displayID: CGDirectDisplayID, cropTo rect: CGRect?) -> CGImage? {
        guard let full = CGDisplayCreateImage(displayID) else { return nil }
        guard let rect = rect else { return full }
        let bounds = CGDisplayBounds(displayID)
        let scaleX = CGFloat(full.width) / bounds.width
        let scaleY = CGFloat(full.height) / bounds.height
        var pixelRect = CGRect(
            x: max(0, floor((rect.origin.x - bounds.origin.x) * scaleX)),
            y: max(0, floor((rect.origin.y - bounds.origin.y) * scaleY)),
            width: ceil(rect.width * scaleX),
            height: ceil(rect.height * scaleY)
        )
        pixelRect.size.width = min(pixelRect.width, CGFloat(full.width) - pixelRect.origin.x)
        pixelRect.size.height = min(pixelRect.height, CGFloat(full.height) - pixelRect.origin.y)
        guard pixelRect.width > 0, pixelRect.height > 0 else { return full }
        return full.cropping(to: pixelRect) ?? full
    }

    private static func legacyCaptureWindow(_ windowID: CGWindowID) -> CGImage? {
        return CGWindowListCreateImage(.null, .optionIncludingWindow, windowID, [.bestResolution])
    }

    // MARK: - Encoding

    public enum ImageFormat: Sendable, Equatable {
        case jpeg(quality: CGFloat)
        case png

        public var mimeType: String {
            switch self {
            case .jpeg: return "image/jpeg"
            case .png: return "image/png"
            }
        }
        public var fileExtension: String {
            switch self {
            case .jpeg: return "jpg"
            case .png: return "png"
            }
        }
    }

    /// Encode with ImageIO (thread-safe, no AppKit). Returns nil if encoding fails.
    public static func encode(_ image: CGImage, as format: ImageFormat) -> Data? {
        let data = NSMutableData()
        let type: CFString
        var properties: [CFString: Any] = [:]
        switch format {
        case .jpeg(let quality):
            type = UTType.jpeg.identifier as CFString
            properties[kCGImageDestinationLossyCompressionQuality] = min(max(quality, 0), 1)
        case .png:
            type = UTType.png.identifier as CFString
        }
        guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, type, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }

    /// Prefix of every temp file written by `writeTemp`.
    public static let tempFilePrefix = "ausm-screenshot-"

    /// Write to a new file in the user's temporary directory (mode 0600, unique name) and return
    /// its path. The caller owns the file and should delete it once consumed; files that are
    /// never consumed are swept by `removeStaleTempFiles(olderThan:)`.
    public static func writeTemp(_ image: CGImage, as format: ImageFormat, directory: URL? = nil) -> String? {
        guard let data = encode(image, as: format) else { return nil }
        let dir = directory ?? FileManager.default.temporaryDirectory
        let name = "\(tempFilePrefix)\(getpid())-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8)).\(format.fileExtension)"
        let path = dir.appendingPathComponent(name).path
        // O_EXCL: never follow or overwrite an existing path; 0600: screenshots are private.
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return nil }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            try handle.write(contentsOf: data)
            try handle.close()
            return path
        } catch {
            try? handle.close()
            unlink(path)
            return nil
        }
    }

    /// Delete `writeTemp` files older than `age` seconds (left behind when no consumer deleted
    /// them). Returns the number of files removed.
    @discardableResult
    public static func removeStaleTempFiles(olderThan age: TimeInterval, directory: URL? = nil) -> Int {
        let dir = directory ?? FileManager.default.temporaryDirectory
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return 0 }
        let cutoff = Date().addingTimeInterval(-age)
        var removed = 0
        for name in names where name.hasPrefix(tempFilePrefix) {
            let path = dir.appendingPathComponent(name).path
            guard let attrs = try? fm.attributesOfItem(atPath: path),
                  attrs[.type] as? FileAttributeType == .typeRegular,
                  let modified = attrs[.modificationDate] as? Date, modified < cutoff else { continue }
            if (try? fm.removeItem(atPath: path)) != nil { removed += 1 }
        }
        return removed
    }
}
