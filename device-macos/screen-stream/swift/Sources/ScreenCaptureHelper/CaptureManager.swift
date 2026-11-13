import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import AppKit

// MARK: - Stream Output Handler

/// Receives ScreenCaptureKit callbacks on the per-display sample queue.
final class StreamOutputHandler: NSObject, SCStreamOutput, SCStreamDelegate {
    let frameHandler: (CVPixelBuffer, CMTime) -> Void
    let errorHandler: (Error) -> Void

    init(frameHandler: @escaping (CVPixelBuffer, CMTime) -> Void,
         errorHandler: @escaping (Error) -> Void) {
        self.frameHandler = frameHandler
        self.errorHandler = errorHandler
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        // Skip idle/blank/suspended frames: only `.complete` frames carry new pixels.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let rawStatus = attachments.first?[.status] as? Int,
           let status = SCFrameStatus(rawValue: rawStatus),
           status != .complete {
            return
        }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        frameHandler(pixelBuffer, CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        errorHandler(error)
    }
}

// MARK: - Display Stream Container

/// One running SCStream. Created and mutated on the main queue only.
final class DisplayStream {
    let displayId: String
    let stream: SCStream
    let output: StreamOutputHandler
    let queue: DispatchQueue
    let videoWriter: VideoWriter?
    let geometry: StreamGeometry

    init(displayId: String, stream: SCStream, output: StreamOutputHandler,
         queue: DispatchQueue, videoWriter: VideoWriter?, geometry: StreamGeometry) {
        self.displayId = displayId
        self.stream = stream
        self.output = output
        self.queue = queue
        self.videoWriter = videoWriter
        self.geometry = geometry
    }
}

/// Capture geometry of a running display stream (for proportional window capture).
struct StreamGeometry {
    /// Logical display dimensions (points)
    let logicalWidth: Int
    let logicalHeight: Int
    /// Capture resolution (pixels) — after scaling to targetHeight
    let captureWidth: Int
    let captureHeight: Int
}

/// Why `startCapture` failed.
struct CaptureFailure: Error {
    let code: HelperErrorCode
    let message: String
}

// MARK: - CaptureManager

/// Owns the ScreenCaptureKit streams, the shared memory writer and the
/// latest-frame cache.
///
/// Threading: all mutating entry points (configure, start/stop, display
/// changes) run on the main queue. Frame callbacks run on per-display serial
/// queues and only touch lock-protected state (`capturing`, `latestFrames`,
/// `MultiDisplayShmManager`) plus objects captured at stream creation.
/// Read-only commands (captureWindow, captureLatestFrame, getDisplays) may run
/// on any queue and use `geometryLock` / `latestFramesLock`.
final class CaptureManager {
    private var _capturing = false
    private let capturingLock = NSLock()
    private var capturing: Bool {
        get { capturingLock.lock(); defer { capturingLock.unlock() }; return _capturing }
        set { capturingLock.lock(); _capturing = newValue; capturingLock.unlock() }
    }

    // Configuration (main queue only)
    private var fps: UInt32 = 30
    private var targetHeight: UInt32 = 720
    private var recordingEnabled = false
    private var outputDirectory = ""
    private var sharedMemoryName = ""
    private var frameCount: UInt32 = 0

    // Per-display configuration overrides (main queue only)
    private var displayFps: [String: UInt32] = [:]
    private var displayTargetHeight: [String: UInt32] = [:]

    private let displayManager = DisplayManager()
    private let frameBuffer = FrameBuffer()
    private let multiDisplayShm = MultiDisplayShmManager()
    private var streams: [String: DisplayStream] = [:]   // main queue only

    /// Non-zero while a start/stop/restart is pumping the run loop; display
    /// change events that arrive meanwhile are deferred instead of re-entering.
    private var transitionDepth = 0

    // Snapshot readable from any queue (captureWindow).
    private let geometryLock = NSLock()
    private var geometrySnapshot: [String: StreamGeometry] = [:]
    private var targetHeightSnapshot: UInt32 = 720

    private var displayChangeCallback: ((String, String) -> Void)?
    private var errorCallback: ((HelperErrorCode, String, String?) -> Void)?

    /// Latest captured BGRA frame per display, for on-demand JPEG encoding via
    /// captureLatestFrame(). FrameData.data is only valid during the capture
    /// callback, so the bytes are copied.
    struct LatestFrame {
        let timestamp: UInt64
        let frameNumber: UInt64
        let width: UInt32
        let height: UInt32
        let bytesPerRow: Int
        let data: Data
    }
    private var latestFrames: [String: LatestFrame] = [:]
    private let latestFramesLock = NSLock()

    init() {
        displayManager.startMonitoring { [weak self] event in
            self?.handleDisplayChange(event)
        }
    }

    // MARK: - Public API

    func configure(_ update: CaptureConfigUpdate) {
        if let v = update.fps { fps = v }
        if let v = update.targetHeight { targetHeight = v }
        if let v = update.enableRecording { recordingEnabled = v }
        if let v = update.outputDirectory { outputDirectory = v }
        if let v = update.sharedMemoryName { sharedMemoryName = v }
        if let v = update.frameCount { frameCount = v }
        publishTargetHeight()
        if !update.rejected.isEmpty {
            NSLog("[Helper] Ignored invalid config keys: %@", update.rejected.joined(separator: ", "))
        }
        NSLog("[Helper] Configured: fps=%u, targetHeight=%u, recording=%d, frameCount=%u",
              fps, targetHeight, recordingEnabled ? 1 : 0, frameCount)
    }

    /// Start capturing the given displays (all if empty). Returns nil on
    /// success (at least one display streaming), or the reason it failed.
    func startCapture(displayIds: [String]) -> CaptureFailure? {
        guard !capturing else {
            NSLog("[Helper] Already capturing")
            return nil
        }

        transitionDepth += 1
        defer { transitionDepth -= 1 }

        let displays = displayManager.getDisplays()
        guard !displays.isEmpty else {
            return CaptureFailure(code: .noDisplays, message: "No active displays found")
        }

        capturing = true

        // Initialize multi-display shared memory if configured
        if !sharedMemoryName.isEmpty && frameCount > 0 {
            if !multiDisplayShm.initialize(baseName: sharedMemoryName, framesPerDisplay: frameCount) {
                capturing = false
                return CaptureFailure(code: .shmFailed,
                                      message: "Failed to create shared memory '\(sharedMemoryName)'")
            }
        }

        let scDisplays: [SCDisplay]
        switch fetchShareableDisplays(timeout: 10.0) {
        case .success(let list):
            scDisplays = list
        case .failure(let failure):
            capturing = false
            multiDisplayShm.shutdown()
            return failure
        }

        var scDisplayMap: [CGDirectDisplayID: SCDisplay] = [:]
        for scDisplay in scDisplays {
            scDisplayMap[scDisplay.displayID] = scDisplay
        }

        let filter: Set<String>? = displayIds.isEmpty ? nil : Set(displayIds)
        var lastError: CaptureFailure?
        for display in displays {
            if let filter, !filter.contains(display.id) { continue }
            guard let scDisplay = scDisplayMap[display.displayId] else {
                NSLog("[Helper] SCDisplay not found for %@", display.id)
                continue
            }
            if let failure = startDisplayCapture(display.id, scDisplay: scDisplay) {
                lastError = failure
            }
        }

        guard !streams.isEmpty else {
            capturing = false
            multiDisplayShm.shutdown()
            return lastError ?? CaptureFailure(code: .noDisplays, message: "None of the requested displays could be captured")
        }

        NSLog("[Helper] Capture started for %d displays", streams.count)
        return nil
    }

    func stopCapture() {
        guard capturing else { return }
        capturing = false

        transitionDepth += 1
        defer { transitionDepth -= 1 }

        for displayStream in streams.values {
            stopDisplayStream(displayStream)
        }
        streams.removeAll()
        updateGeometrySnapshot()

        multiDisplayShm.shutdown()

        // Clear cached latest frames so post-stop captureLatestFrame()
        // doesn't serve stale data.
        latestFramesLock.lock()
        latestFrames.removeAll()
        latestFramesLock.unlock()

        NSLog("[Helper] Capture stopped")
    }

    var isCapturing: Bool { capturing }

    func getDisplays() -> [[String: Any]] {
        displayManager.getDisplays().map { display in
            // CGDisplayBounds returns logical-point coordinates (origin + size)
            // in the global coordinate space.
            let bounds = CGDisplayBounds(display.displayId)
            return [
                "id": display.id,
                "name": display.id,
                "displayId": display.displayId,  // Numeric CGDirectDisplayID
                "width": display.width,           // Native pixel width
                "height": display.height,         // Native pixel height
                "isMain": display.isMain,
                "isBuiltIn": display.isBuiltIn,
                "scaleFactor": display.scaleFactor,
                "refreshRate": display.refreshRate,
                "originX": Double(bounds.origin.x),
                "originY": Double(bounds.origin.y),
                "logicalWidth": Double(bounds.size.width),
                "logicalHeight": Double(bounds.size.height),
            ] as [String: Any]
        }
    }

    /// Encode the most recent BGRA frame for the given display as JPEG.
    func captureLatestFrame(displayId: String, jpegQuality: Double = 0.8) -> [String: Any] {
        latestFramesLock.lock()
        let snapshot = latestFrames[displayId]
        latestFramesLock.unlock()

        guard let frame = snapshot else {
            return ["success": false, "error": "No frame available for \(displayId) yet"]
        }

        let width = Int(frame.width)
        let height = Int(frame.height)
        // CFData-backed provider: the image owns (or shares) the bytes, so no
        // pointer escapes a withUnsafeBytes scope.
        guard let provider = CGDataProvider(data: frame.data as CFData),
              let image = CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: frame.bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue |
                                                   CGImageAlphaInfo.premultipliedFirst.rawValue),
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
              ) else {
            return ["success": false, "error": "Failed to construct CGImage for \(displayId)"]
        }

        guard let jpegData = Self.encodeJPEG(image, quality: jpegQuality) else {
            return ["success": false, "error": "JPEG encoding failed for \(displayId)"]
        }

        return [
            "success": true,
            "displayId": displayId,
            "width": width,
            "height": height,
            "jpegSize": jpegData.count,
            "data": jpegData.base64EncodedString(),
            "timestamp": Double(frame.timestamp),
            "frameNumber": Double(frame.frameNumber),
        ]
    }

    /// Update global settings while stopped. Returns false while capturing.
    func updateConfiguration(_ update: CaptureConfigUpdate) -> Bool {
        guard !capturing else {
            NSLog("[Helper] Cannot update config while capturing - stop first")
            return false
        }
        if let v = update.fps { fps = v }
        if let v = update.targetHeight { targetHeight = v }
        if let v = update.enableRecording { recordingEnabled = v }
        if let v = update.outputDirectory { outputDirectory = v }
        publishTargetHeight()
        return true
    }

    func setDisplayChangeCallback(_ callback: @escaping (String, String) -> Void) {
        displayChangeCallback = callback
    }

    /// Called (on the main queue) when a running stream fails, e.g. because
    /// Screen Recording permission was revoked: (code, message, displayId).
    func setErrorCallback(_ callback: @escaping (HelperErrorCode, String, String?) -> Void) {
        errorCallback = callback
    }

    // MARK: - Per-Display Configuration

    func getDisplayFps(_ displayId: String) -> UInt32 {
        displayFps[displayId] ?? fps
    }

    func getDisplayTargetHeight(_ displayId: String) -> UInt32 {
        displayTargetHeight[displayId] ?? targetHeight
    }

    func configureDisplay(_ displayId: String, fps: UInt32?, targetHeight: UInt32?) {
        if let fps {
            displayFps[displayId] = fps
            NSLog("[Helper] Display %@: FPS set to %u", displayId, fps)
        }
        if let targetHeight {
            displayTargetHeight[displayId] = targetHeight
            NSLog("[Helper] Display %@: targetHeight set to %u", displayId, targetHeight)
        }
    }

    func getDisplayConfigs() -> [String: [String: UInt32]] {
        var configs: [String: [String: UInt32]] = [:]
        for display in displayManager.getDisplays() {
            configs[display.id] = [
                "fps": getDisplayFps(display.id),
                "targetHeight": getDisplayTargetHeight(display.id),
            ]
        }
        return configs
    }

    func restartDisplayCapture(_ displayId: String) -> Bool {
        guard capturing, let existing = streams[displayId] else { return false }

        transitionDepth += 1
        defer { transitionDepth -= 1 }

        streams.removeValue(forKey: displayId)
        stopDisplayStream(existing)
        multiDisplayShm.removeDisplay(displayId)
        updateGeometrySnapshot()

        guard case .success(let list) = fetchShareableDisplays(timeout: 5.0),
              let scDisplay = list.first(where: { DisplayInfo.makeId($0.displayID) == displayId }) else {
            NSLog("[Helper] Could not find SCDisplay for %@", displayId)
            return false
        }

        return startDisplayCapture(displayId, scDisplay: scDisplay) == nil
    }

    // MARK: - Window Capture (One-Shot)

    /// Capture a single window by its CGWindowID using CGWindowListCreateImage.
    /// Returns JPEG-encoded image data, width, and height.
    /// This reads directly from the window's backing store, so it works even
    /// when the window is behind other windows.
    ///
    /// The image is scaled to be proportional to the display stream: if the
    /// display is captured at captureHeight/logicalHeight ratio, the window
    /// uses that same ratio, keeping window pixels at the same density as
    /// display-stream frames.
    ///
    /// Safe to call from any queue.
    func captureWindow(windowId: CGWindowID, displayId: String? = nil, jpegQuality: Double = 0.85) -> [String: Any] {
        // .nominalResolution gives a 1x (logical-pixel) image.
        // CGWindowListCreateImage is deprecated in macOS 14 in favour of
        // SCScreenshotManager, but remains functional and synchronous.
        guard let cgImage = CGWindowListCreateImage(
            .null,
            .optionIncludingWindow,
            windowId,
            [.boundsIgnoreFraming, .nominalResolution]
        ) else {
            return ["success": false, "error": "CGWindowListCreateImage returned nil for window \(windowId)"]
        }

        let srcWidth = cgImage.width
        let srcHeight = cgImage.height
        guard srcWidth > 0, srcHeight > 0 else {
            return ["success": false, "error": "Window \(windowId) has an empty image"]
        }

        let (geometry, fallbackHeight) = geometryFor(displayId)
        var finalWidth = srcWidth
        var finalHeight = srcHeight
        if let g = geometry, g.logicalHeight > 0, g.captureHeight > 0 {
            let scale = Double(g.captureHeight) / Double(g.logicalHeight)
            finalWidth = max(1, Int(Double(srcWidth) * scale))
            finalHeight = max(1, Int(Double(srcHeight) * scale))
        } else if fallbackHeight > 0 && srcHeight > Int(fallbackHeight) {
            // No display info — cap at targetHeight
            let scale = Double(fallbackHeight) / Double(srcHeight)
            finalWidth = max(1, Int(Double(srcWidth) * scale))
            finalHeight = Int(fallbackHeight)
        }

        var scaledImage = cgImage
        if finalWidth != srcWidth || finalHeight != srcHeight {
            guard let ctx = CGContext(
                data: nil,
                width: finalWidth,
                height: finalHeight,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
            ) else {
                return ["success": false, "error": "Failed to create scaling context for window \(windowId)"]
            }
            ctx.interpolationQuality = .high
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: finalWidth, height: finalHeight))
            guard let drawn = ctx.makeImage() else {
                return ["success": false, "error": "Failed to draw scaled image for window \(windowId)"]
            }
            scaledImage = drawn
        }

        guard let jpegData = Self.encodeJPEG(scaledImage, quality: jpegQuality) else {
            return ["success": false, "error": "JPEG encoding failed for window \(windowId)"]
        }

        return [
            "success": true,
            "windowId": Int(windowId),
            "width": finalWidth,
            "height": finalHeight,
            "jpegSize": jpegData.count,
            "data": jpegData.base64EncodedString(),
        ]
    }

    // MARK: - Private: Helpers

    private static func encodeJPEG(_ image: CGImage, quality: Double) -> Data? {
        let rep = NSBitmapImageRep(cgImage: image)
        return rep.representation(using: .jpeg, properties: [.compressionFactor: NSNumber(value: quality)])
    }

    /// Geometry for `displayId` (or the first running stream) plus the
    /// global targetHeight, from the thread-safe snapshot.
    private func geometryFor(_ displayId: String?) -> (StreamGeometry?, UInt32) {
        geometryLock.lock(); defer { geometryLock.unlock() }
        if let id = displayId, let g = geometrySnapshot[id] {
            return (g, targetHeightSnapshot)
        }
        let first = geometrySnapshot.keys.sorted().first.flatMap { geometrySnapshot[$0] }
        return (first, targetHeightSnapshot)
    }

    private func updateGeometrySnapshot() {
        var snapshot: [String: StreamGeometry] = [:]
        for (id, s) in streams { snapshot[id] = s.geometry }
        geometryLock.lock()
        geometrySnapshot = snapshot
        geometryLock.unlock()
    }

    private func publishTargetHeight() {
        geometryLock.lock()
        targetHeightSnapshot = targetHeight
        geometryLock.unlock()
    }

    /// Wait for a ScreenCaptureKit completion handler, up to `timeout` seconds.
    ///
    /// Mutating commands run inside a main-queue block (CommandServer uses
    /// DispatchQueue.main.sync), and the main queue runs one block at a time, so a
    /// completion that hops back to main can't run until the command returns:
    /// every wait would time out. SCK calls back on its own queue, so the result
    /// is handed over through a lock and a semaphore instead. The run loop is
    /// still pumped so run-loop sources (timers, display callbacks) keep firing.
    static func awaitCallback<T>(timeout: TimeInterval,
                                 _ start: (@escaping (T) -> Void) -> Void) -> T? {
        let lock = NSLock()
        var result: T?
        let done = DispatchSemaphore(value: 0)
        start { value in
            lock.lock()
            if result == nil { result = value }
            lock.unlock()
            done.signal()
        }
        let deadline = Date(timeIntervalSinceNow: timeout)
        while done.wait(timeout: .now()) == .timedOut {
            if Date() >= deadline { return nil }
            CFRunLoopRunInMode(.defaultMode, 0.05, true)
        }
        lock.lock()
        defer { lock.unlock() }
        return result
    }

    /// Fetch shareable displays without depending on the main queue being free.
    private func fetchShareableDisplays(timeout: TimeInterval) -> Result<[SCDisplay], CaptureFailure> {
        let reply = Self.awaitCallback(timeout: timeout) { (done: @escaping (([SCDisplay]?, Error?)) -> Void) in
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
                done((content?.displays, error))
            }
        }
        let complete = reply != nil
        let displays = reply?.0
        let fetchError = reply?.1

        if let displays, !displays.isEmpty {
            return .success(displays)
        }
        if !DisplayManager.hasPermission() || Self.isPermissionError(fetchError) {
            return .failure(CaptureFailure(
                code: .permissionDenied,
                message: "Screen Recording permission is not granted. Enable it for the host app in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the app."))
        }
        if !complete {
            return .failure(CaptureFailure(code: .streamFailed, message: "Timed out waiting for ScreenCaptureKit shareable content"))
        }
        return .failure(CaptureFailure(code: .noDisplays,
                                       message: "No shareable displays: \(fetchError?.localizedDescription ?? "none reported")"))
    }

    private static func isPermissionError(_ error: Error?) -> Bool {
        guard let error = error as NSError? else { return false }
        return error.domain == SCStreamErrorDomain && error.code == SCStreamError.userDeclined.rawValue
    }

    // MARK: - Private: Display Change Handling

    private func handleDisplayChange(_ event: DisplayChangeEvent) {
        // A start/stop is pumping the run loop; re-entering would mutate
        // `streams` underneath it. Retry shortly.
        if transitionDepth > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.handleDisplayChange(event)
            }
            return
        }

        let typeStr: String
        switch event.type {
        case .added: typeStr = "added"
        case .removed: typeStr = "removed"
        case .reconfigured: typeStr = "reconfigured"
        }

        NSLog("[Helper] Display change: %@ %@", typeStr, event.displayId)

        if capturing {
            switch event.type {
            case .added:
                handleDisplayAdded(event.displayId)
            case .removed:
                handleDisplayRemoved(event.displayId)
            case .reconfigured:
                handleDisplayReconfigured(event.displayId)
            }
        }

        displayChangeCallback?(event.displayId, typeStr)
    }

    private func handleDisplayAdded(_ displayId: String, retryCount: Int = 0) {
        // Same guard as handleDisplayChange: retries and the reconfigure re-add arrive via asyncAfter
        // and must not start a second stream for this display while another transition is pumping.
        if transitionDepth > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, self.capturing else { return }
                self.handleDisplayAdded(displayId, retryCount: retryCount)
            }
            return
        }
        guard streams[displayId] == nil else { return }

        let retry = { [weak self] in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                guard let self, self.capturing else { return }
                self.handleDisplayAdded(displayId, retryCount: retryCount + 1)
            }
        }

        // Check the display is actually online and active
        if displayId.hasPrefix("display-"), let cgDisplayId = UInt32(displayId.dropFirst(8)), cgDisplayId > 0,
           CGDisplayIsOnline(cgDisplayId) == 0 || CGDisplayIsActive(cgDisplayId) == 0 {
            if retryCount < 5 { retry() } else {
                NSLog("[Helper] Display %@ still not online after retries, giving up", displayId)
            }
            return
        }

        transitionDepth += 1
        defer { transitionDepth -= 1 }

        if case .success(let list) = fetchShareableDisplays(timeout: 5.0),
           let scDisplay = list.first(where: { DisplayInfo.makeId($0.displayID) == displayId }) {
            if let failure = startDisplayCapture(displayId, scDisplay: scDisplay) {
                errorCallback?(failure.code, failure.message, displayId)
            }
        } else if retryCount < 5 {
            retry()
        } else {
            NSLog("[Helper] Could not find SCDisplay for %@ after retries", displayId)
        }
    }

    private func handleDisplayRemoved(_ displayId: String) {
        if let displayStream = streams.removeValue(forKey: displayId) {
            transitionDepth += 1
            stopDisplayStream(displayStream)
            transitionDepth -= 1
            updateGeometrySnapshot()
        }

        if !sharedMemoryName.isEmpty {
            multiDisplayShm.removeDisplay(displayId, destroyShm: true)
        }

        latestFramesLock.lock()
        latestFrames.removeValue(forKey: displayId)
        latestFramesLock.unlock()
    }

    private func handleDisplayReconfigured(_ displayId: String) {
        handleDisplayRemoved(displayId)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, self.capturing else { return }
            self.handleDisplayAdded(displayId, retryCount: 0)
        }
    }

    // MARK: - Private: Capture Stream Management

    /// Start one display stream. Returns nil on success. Main queue only.
    private func startDisplayCapture(_ displayId: String, scDisplay: SCDisplay) -> CaptureFailure? {
        let displayFps = getDisplayFps(displayId)
        let displayTargetHeight = getDisplayTargetHeight(displayId)

        // Physical pixel dimensions (Retina-aware)
        let cgDisplayId = scDisplay.displayID
        var physicalPixelWidth = 0
        var physicalPixelHeight = 0
        if let mode = CGDisplayCopyDisplayMode(cgDisplayId) {
            physicalPixelWidth = mode.pixelWidth
            physicalPixelHeight = mode.pixelHeight
        }
        if physicalPixelWidth == 0 || physicalPixelHeight == 0 {
            physicalPixelWidth = CGDisplayPixelsWide(cgDisplayId)
            physicalPixelHeight = CGDisplayPixelsHigh(cgDisplayId)
        }

        let (width, height) = ShmMath.captureSize(pixelWidth: physicalPixelWidth,
                                                  pixelHeight: physicalPixelHeight,
                                                  targetHeight: displayTargetHeight)
        NSLog("[Helper] Display %@: logical=%dx%d, pixels=%dx%d, capture=%dx%d",
              displayId, scDisplay.width, scDisplay.height,
              physicalPixelWidth, physicalPixelHeight, width, height)

        let geometry = StreamGeometry(logicalWidth: Int(scDisplay.width), logicalHeight: Int(scDisplay.height),
                                      captureWidth: width, captureHeight: height)

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, displayFps)))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.queueDepth = 5

        let filter = SCContentFilter(display: scDisplay, excludingWindows: [])

        // Video writer (optional), owned by this stream only.
        var videoWriter: VideoWriter?
        if recordingEnabled && !outputDirectory.isEmpty {
            let writer = VideoWriter()
            let outputPath = VideoWriter.segmentPath(directory: outputDirectory, displayId: displayId)
            if writer.initialize(outputPath: outputPath, width: UInt32(width), height: UInt32(height),
                                 fps: displayFps, codec: .h264, bitrate: 8_000_000) {
                videoWriter = writer
            }
        }

        let captureDisplayId = scDisplay.displayID
        let output = StreamOutputHandler(
            frameHandler: { [weak self, weak videoWriter] pixelBuffer, presentationTime in
                guard let self, self.capturing else { return }
                self.frameBuffer.processFrame(pixelBuffer, presentationTime: presentationTime,
                                              displayId: captureDisplayId) { frame in
                    self.handleFrame(frame, videoWriter: videoWriter)
                }
            },
            errorHandler: { [weak self] error in
                NSLog("[Helper] Stream error for display %u: %@", captureDisplayId, error.localizedDescription)
                let permissionLost = !DisplayManager.hasPermission() || CaptureManager.isPermissionError(error)
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.capturing else { return }
                    NSLog("[Helper] Auto-removing failed display: %@", displayId)
                    self.handleDisplayRemoved(displayId)
                    self.errorCallback?(permissionLost ? .permissionDenied : .streamFailed,
                                        permissionLost
                                            ? "Screen Recording permission was revoked"
                                            : "Capture stream stopped: \(error.localizedDescription)",
                                        displayId)
                    self.displayChangeCallback?(displayId, "removed")
                }
            })

        let queue = DispatchQueue(label: "com.ausm.helper.capture.\(displayId)")
        let stream = SCStream(filter: filter, configuration: config, delegate: output)

        do {
            try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
        } catch {
            videoWriter?.finalize()
            return CaptureFailure(code: .streamFailed,
                                  message: "Failed to add stream output for \(displayId): \(error.localizedDescription)")
        }

        // Register in shared memory before frames arrive. Pass the SCDisplay
        // logical dimensions (points) so consumers can map frame pixels to
        // screen coordinates.
        if !sharedMemoryName.isEmpty {
            let added = multiDisplayShm.addDisplay(
                displayId, width: UInt32(width), height: UInt32(height),
                logicalWidth: UInt32(max(0, scDisplay.width)),
                logicalHeight: UInt32(max(0, scDisplay.height)))
            if !added {
                NSLog("[Helper] Shared memory unavailable for %@; continuing without SHM output", displayId)
            }
        }

        let displayStream = DisplayStream(displayId: displayId, stream: stream, output: output,
                                          queue: queue, videoWriter: videoWriter, geometry: geometry)

        // Start capture and wait for completion (pumping the run loop).
        let startReply = Self.awaitCallback(timeout: 5.0) { (done: @escaping (Error?) -> Void) in
            stream.startCapture { error in done(error) }
        }
        let startComplete = startReply != nil
        let startError: Error? = startReply ?? nil

        if !startComplete || startError != nil {
            let permissionLost = !DisplayManager.hasPermission() || Self.isPermissionError(startError)
            let reason = startError?.localizedDescription ?? "timeout"
            NSLog("[Helper] Stream failed to start for %@: %@", displayId, reason)
            stopDisplayStream(displayStream)
            if !sharedMemoryName.isEmpty {
                multiDisplayShm.removeDisplay(displayId, destroyShm: true)
            }
            return CaptureFailure(code: permissionLost ? .permissionDenied : .streamFailed,
                                  message: permissionLost
                                    ? "Screen Recording permission is not granted"
                                    : "Failed to start capture for \(displayId): \(reason)")
        }

        // A "stop" may have been processed while the run loop was pumped.
        guard capturing else {
            stopDisplayStream(displayStream)
            if !sharedMemoryName.isEmpty {
                multiDisplayShm.removeDisplay(displayId, destroyShm: true)
            }
            return CaptureFailure(code: .streamFailed, message: "Capture was stopped while \(displayId) was starting")
        }

        streams[displayId] = displayStream
        updateGeometrySnapshot()
        NSLog("[Helper] Started capture for %@ (%dx%d @ %u fps)", displayId, width, height, displayFps)
        return nil
    }

    /// Stop an SCStream, drain its sample queue and finalize its video file.
    private func stopDisplayStream(_ displayStream: DisplayStream) {
        let stopComplete = Self.awaitCallback(timeout: 3.0) { (done: @escaping (Bool) -> Void) in
            displayStream.stream.stopCapture { error in
                if let error {
                    NSLog("[Helper] Error stopping stream for %@: %@", displayStream.displayId, error.localizedDescription)
                }
                done(true)
            }
        } != nil
        if !stopComplete {
            NSLog("[Helper] Timeout waiting for stream stop: %@", displayStream.displayId)
        }

        // Drain the sample queue so no callback is mid-flight, then finalize.
        displayStream.queue.sync { }
        displayStream.videoWriter?.finalize()
        NSLog("[Helper] Stopped stream for %@", displayStream.displayId)
    }

    // MARK: - Private: Frame Handling (per-display capture queue)

    private func handleFrame(_ frame: FrameData, videoWriter: VideoWriter?) {
        let displayIdStr = DisplayInfo.makeId(frame.displayId)

        _ = multiDisplayShm.writeFrame(displayId: displayIdStr, timestamp: frame.timestamp,
                                       data: frame.data, width: frame.width, height: frame.height,
                                       bytesPerRow: frame.bytesPerRow)

        cacheLatestFrame(displayIdStr, frame: frame)

        if let videoWriter, videoWriter.isActive {
            writeFrameToVideo(videoWriter, frame: frame)
        }
    }

    private func cacheLatestFrame(_ displayId: String, frame: FrameData) {
        let snapshot = LatestFrame(
            timestamp: frame.timestamp,
            frameNumber: frame.frameNumber,
            width: frame.width,
            height: frame.height,
            bytesPerRow: frame.bytesPerRow,
            data: Data(bytes: frame.data, count: frame.dataSize)
        )
        latestFramesLock.lock()
        latestFrames[displayId] = snapshot
        latestFramesLock.unlock()
    }

    private func writeFrameToVideo(_ videoWriter: VideoWriter, frame: FrameData) {
        let time = CMTime(value: Int64(clamping: frame.timestamp), timescale: 1_000_000)
        _ = videoWriter.appendFrame(bgra: frame.data, width: Int(frame.width), height: Int(frame.height),
                                    bytesPerRow: frame.bytesPerRow, timestamp: time)
    }
}
