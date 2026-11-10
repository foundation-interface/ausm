import Foundation
import AVFoundation
import CoreMedia
import CoreVideo
import CoreGraphics
import Accelerate
import ImageIO
import UniformTypeIdentifiers

// MARK: - Per-device capture session

/// Threading: CaptureManager's public API, `sessions` and device notifications run on the
/// main thread (CommandServer hops there). Sample buffers arrive on each session's private
/// queue and only touch `sinks` / `latestFrames` (lock-protected) and the lock-protected SHM.
private final class DeviceSession {
    let deviceId: String
    let session: AVCaptureSession
    let output: AVCaptureVideoDataOutput
    let queue: DispatchQueue
    var captureWidth: UInt32 = 0
    var captureHeight: UInt32 = 0
    var observers: [NSObjectProtocol] = []
    var restartAttempts = 0

    init(deviceId: String) {
        self.deviceId = deviceId
        self.session = AVCaptureSession()
        self.output = AVCaptureVideoDataOutput()
        self.queue = DispatchQueue(label: "com.ausm.camera.\(deviceId)", qos: .userInitiated)
    }
}

// MARK: - CaptureManager

class CaptureManager: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private var _capturing = false
    private let capturingLock = NSLock()
    var isCapturing: Bool {
        capturingLock.lock(); defer { capturingLock.unlock() }; return _capturing
    }
    private func setCapturing(_ value: Bool) {
        capturingLock.lock(); _capturing = value; capturingLock.unlock()
    }

    private var fps: UInt32 = 10
    private var targetHeight: UInt32 = 720
    private var sharedMemoryName = "/ausm-camera-frames"
    private var frameCount: UInt32 = 5
    private var preferredDeviceId: String?

    private var deviceFps: [String: UInt32] = [:]
    private var deviceTargetHeight: [String: UInt32] = [:]

    private let multiDisplayShm = MultiDisplayShmManager()
    /// Main-thread only.
    private var sessions: [String: DeviceSession] = [:]

    /// Per-output routing info read from capture queues; guarded by `sinksLock`.
    private struct Sink { let deviceId: String; let width: Int; let height: Int }
    private var sinks: [ObjectIdentifier: Sink] = [:]
    private let sinksLock = NSLock()

    private var deviceChangeCallback: ((String, String) -> Void)?
    private var captureErrorCallback: ((String, String) -> Void)?
    private var observers: [NSObjectProtocol] = []

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
    private var frameNumbers: [String: UInt64] = [:]
    private var loggedFirstFrame = false  // guarded by latestFramesLock

    override init() {
        super.init()
        startDeviceMonitoring()
    }

    deinit {
        stopDeviceMonitoring()
    }

    /// Called with (deviceId, "added" | "removed").
    func setDeviceChangeCallback(_ callback: @escaping (String, String) -> Void) {
        deviceChangeCallback = callback
    }

    /// Called with (deviceId, message) when a running session fails or is interrupted.
    func setCaptureErrorCallback(_ callback: @escaping (String, String) -> Void) {
        captureErrorCallback = callback
    }

    // MARK: - Public API

    func configure(_ config: [String: Any]) {
        if let v = ConfigValue.clamped(config["fps"], to: ConfigValue.fpsRange) { fps = v }
        if let v = ConfigValue.clamped(config["targetHeight"], to: ConfigValue.targetHeightRange) { targetHeight = v }
        if let v = config["sharedMemoryName"] as? String {
            // POSIX SHM names: leading '/', no other '/', and short enough for "-registry" (PSHMNAMLEN = 31).
            if v.hasPrefix("/"), !v.dropFirst().contains("/"), v.utf8.count + "-registry".utf8.count <= 31 {
                sharedMemoryName = v
            } else {
                NSLog("[Helper] Ignoring invalid sharedMemoryName (must start with '/' and be <= 22 chars)")
            }
        }
        if let v = ConfigValue.clamped(config["frameCount"], to: ConfigValue.frameCountRange) { frameCount = v }
        if let v = config["deviceId"] as? String, !v.isEmpty { preferredDeviceId = v }

        NSLog("[Helper] Configured: fps=%u, targetHeight=%u, shm=%@, deviceId=%@",
              fps, targetHeight, sharedMemoryName, preferredDeviceId ?? "(default)")
    }

    func startCapture(deviceIds: [String]) -> [String: Any] {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            break
        case .notDetermined:
            // Wait (bounded) for the user to answer the TCC prompt; the completion handler runs
            // on an arbitrary queue, so blocking the main thread here cannot deadlock.
            let answered = DispatchSemaphore(value: 0)
            var granted = false
            AVCaptureDevice.requestAccess(for: .video) { ok in
                granted = ok
                answered.signal()
            }
            if answered.wait(timeout: .now() + 25) == .timedOut || !granted {
                NSLog("[Helper] Camera permission not granted")
                return [
                    "success": false,
                    "error": "Camera permission not granted. Enable Camera for this app in System Settings → Privacy & Security → Camera, then retry.",
                ]
            }
        case .denied, .restricted:
            return [
                "success": false,
                "error": "Camera permission denied. Enable Camera in System Settings → Privacy & Security.",
            ]
        @unknown default:
            return ["success": false, "error": "Unknown camera authorization status"]
        }

        let available = listCaptureDevices()
        guard !available.isEmpty else {
            return ["success": false, "error": "No camera devices found"]
        }

        var ids = deviceIds
        if ids.isEmpty {
            if let preferred = preferredDeviceId, available.contains(where: { $0.uniqueID == preferred }) {
                ids = [preferred]
            } else {
                // Match screen-stream: when no device is specified, capture every camera.
                ids = available.map { $0.uniqueID }
            }
        }

        if isCapturing {
            var started: [String] = []
            for id in ids where sessions[id] == nil {
                if startDevice(id) { started.append(id) }
            }
            NSLog("[Helper] Added %d camera device(s) to existing capture", started.count)
            return ["success": true]
        }

        if !multiDisplayShm.initialize(baseName: sharedMemoryName, framesPerDisplay: frameCount) {
            // Not fatal: captureLatestFrame still works from the in-process frame cache.
            NSLog("[Helper] Failed to initialize shared memory")
        }

        latestFramesLock.lock()
        loggedFirstFrame = false
        latestFramesLock.unlock()
        // Accept frames before startRunning so the first buffers are not dropped.
        setCapturing(true)

        var started: [String] = []
        for id in ids {
            if startDevice(id) {
                started.append(id)
            }
        }

        guard !started.isEmpty else {
            setCapturing(false)
            multiDisplayShm.shutdown()
            return ["success": false, "error": "Failed to start any camera device"]
        }

        NSLog("[Helper] Camera capture started (%d device(s))", started.count)
        return ["success": true]
    }

    func stopCapture() {
        guard isCapturing else { return }
        setCapturing(false)

        for id in Array(sessions.keys) {
            stopDevice(id)
        }

        latestFramesLock.lock()
        latestFrames.removeAll()
        frameNumbers.removeAll()
        latestFramesLock.unlock()

        multiDisplayShm.shutdown()
        NSLog("[Helper] Camera capture stopped")
    }

    func getDevices() -> [[String: Any]] {
        listCaptureDevices().map { device in
            [
                "id": device.uniqueID,
                "name": device.localizedName,
                "position": positionString(device.position),
                "active": sessions[device.uniqueID] != nil,
                "manufacturer": device.manufacturer,
            ] as [String: Any]
        }
    }

    func configureDevice(_ deviceId: String, config: [String: Any]) -> [String: Any] {
        if let v = ConfigValue.clamped(config["fps"], to: ConfigValue.fpsRange) { deviceFps[deviceId] = v }
        if let v = ConfigValue.clamped(config["targetHeight"], to: ConfigValue.targetHeightRange) {
            deviceTargetHeight[deviceId] = v
        }

        if isCapturing, sessions[deviceId] != nil {
            stopDevice(deviceId)
            if !startDevice(deviceId) {
                return ["error": "Failed to restart device capture"]
            }
        }
        return ["success": true]
    }

    func getDeviceConfigs() -> [String: [String: Any]] {
        var result: [String: [String: Any]] = [:]
        let ids = Set(deviceFps.keys).union(deviceTargetHeight.keys)
        for id in ids {
            var cfg: [String: Any] = [:]
            if let f = deviceFps[id] { cfg["fps"] = f }
            if let h = deviceTargetHeight[id] { cfg["targetHeight"] = h }
            result[id] = cfg
        }
        return result
    }

    /// Thread-safe; called off the main thread so JPEG encoding never blocks commands.
    func captureLatestFrame(deviceId: String, jpegQuality: Double = 0.7) -> [String: Any] {
        latestFramesLock.lock()
        let snapshot = latestFrames[deviceId]
        latestFramesLock.unlock()

        guard let frame = snapshot else {
            return ["success": false, "error": "No frame available for \(deviceId) yet"]
        }

        let cs = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue |
                         CGImageAlphaInfo.premultipliedFirst.rawValue
        let width = Int(frame.width)
        let height = Int(frame.height)

        // CFData copies/retains the bytes, so the provider never outlives its backing store.
        guard frame.data.count >= frame.bytesPerRow * height,
              let provider = CGDataProvider(data: frame.data as CFData),
              let image = CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: frame.bytesPerRow,
                space: cs,
                bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo),
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
              )
        else {
            return ["success": false, "error": "Failed to construct CGImage for \(deviceId)"]
        }

        let jpegData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            jpegData as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            return ["success": false, "error": "JPEG encoding failed for \(deviceId)"]
        }
        CGImageDestinationAddImage(dest, image, [
            kCGImageDestinationLossyCompressionQuality: ConfigValue.jpegQuality(jpegQuality),
        ] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            return ["success": false, "error": "JPEG encoding failed for \(deviceId)"]
        }

        return [
            "success": true,
            "deviceId": deviceId,
            "width": width,
            "height": height,
            "jpegSize": jpegData.length,
            "data": jpegData.base64EncodedString(),
            "timestamp": frame.timestamp,
            "frameNumber": frame.frameNumber,
        ]
    }

    // MARK: - Device start / stop

    @discardableResult
    private func startDevice(_ deviceId: String) -> Bool {
        guard sessions[deviceId] == nil else { return true }

        let devices = listCaptureDevices()
        guard let device = devices.first(where: { $0.uniqueID == deviceId }) else {
            NSLog("[Helper] Device not found: %@", deviceId)
            return false
        }

        let wrapper = DeviceSession(deviceId: deviceId)
        wrapper.session.beginConfiguration()
        wrapper.session.sessionPreset = .high

        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard wrapper.session.canAddInput(input) else {
                NSLog("[Helper] Cannot add input for %@", device.localizedName)
                wrapper.session.commitConfiguration()
                return false
            }
            wrapper.session.addInput(input)
        } catch {
            NSLog("[Helper] Failed to create input: %@", error.localizedDescription)
            wrapper.session.commitConfiguration()
            return false
        }

        wrapper.output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ]
        wrapper.output.alwaysDiscardsLateVideoFrames = true
        wrapper.output.setSampleBufferDelegate(self, queue: wrapper.queue)

        guard wrapper.session.canAddOutput(wrapper.output) else {
            NSLog("[Helper] Cannot add video output for %@", device.localizedName)
            wrapper.session.commitConfiguration()
            return false
        }
        wrapper.session.addOutput(wrapper.output)

        let deviceFpsValue = deviceFps[deviceId] ?? fps
        configureFrameRate(device, fps: deviceFpsValue)

        wrapper.session.commitConfiguration()

        let nativeSize = preferredCaptureSize(for: device)
        let outH = min(Int(deviceTargetHeight[deviceId] ?? targetHeight), nativeSize.height)
        let outW = max(2, (nativeSize.width * outH / max(nativeSize.height, 1)) & ~1)
        let evenH = max(2, outH & ~1)
        wrapper.captureWidth = UInt32(outW)
        wrapper.captureHeight = UInt32(evenH)

        if !multiDisplayShm.addDisplay(deviceId, width: wrapper.captureWidth, height: wrapper.captureHeight,
                                        logicalWidth: wrapper.captureWidth, logicalHeight: wrapper.captureHeight) {
            NSLog("[Helper] Failed to add SHM for device '%@'", device.localizedName)
        }

        sinksLock.lock()
        sinks[ObjectIdentifier(wrapper.output)] = Sink(
            deviceId: deviceId, width: Int(wrapper.captureWidth), height: Int(wrapper.captureHeight))
        sinksLock.unlock()
        sessions[deviceId] = wrapper
        observeSession(wrapper)
        wrapper.session.startRunning()

        NSLog("[Helper] Started camera '%@' (%ux%u @ %u fps)",
              device.localizedName, wrapper.captureWidth, wrapper.captureHeight, deviceFpsValue)
        return true
    }

    private func stopDevice(_ deviceId: String) {
        guard let wrapper = sessions.removeValue(forKey: deviceId) else { return }
        for observer in wrapper.observers {
            NotificationCenter.default.removeObserver(observer)
        }
        wrapper.observers.removeAll()
        sinksLock.lock()
        sinks.removeValue(forKey: ObjectIdentifier(wrapper.output))
        sinksLock.unlock()
        wrapper.output.setSampleBufferDelegate(nil, queue: nil)
        wrapper.session.stopRunning()
        multiDisplayShm.removeDisplay(deviceId, destroyShm: true)
        latestFramesLock.lock()
        latestFrames.removeValue(forKey: deviceId)
        frameNumbers.removeValue(forKey: deviceId)
        latestFramesLock.unlock()
    }

    /// Surface runtime failures (camera grabbed exclusively by another app, device errors,
    /// permission revoked) instead of silently producing no frames. One automatic restart is
    /// attempted per failure burst.
    private func observeSession(_ wrapper: DeviceSession) {
        let center = NotificationCenter.default
        let deviceId = wrapper.deviceId
        wrapper.observers.append(center.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification, object: wrapper.session, queue: .main
        ) { [weak self] note in
            let err = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
            let message = err?.localizedDescription ?? "Capture session runtime error"
            NSLog("[Helper] Capture runtime error: %@", message)
            self?.captureErrorCallback?(deviceId, message)
            self?.scheduleRestart(deviceId)
        })
        wrapper.observers.append(center.addObserver(
            forName: AVCaptureSession.wasInterruptedNotification, object: wrapper.session, queue: .main
        ) { [weak self] _ in
            NSLog("[Helper] Capture session interrupted")
            self?.captureErrorCallback?(deviceId, "Capture interrupted (camera may be in use by another app)")
        })
        wrapper.observers.append(center.addObserver(
            forName: AVCaptureSession.didStartRunningNotification, object: wrapper.session, queue: .main
        ) { [weak self] _ in
            self?.sessions[deviceId]?.restartAttempts = 0
        })
    }

    private func scheduleRestart(_ deviceId: String) {
        guard let wrapper = sessions[deviceId], wrapper.restartAttempts < 1 else { return }
        wrapper.restartAttempts += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.isCapturing, let current = self.sessions[deviceId], current === wrapper,
                  !wrapper.session.isRunning else { return }
            NSLog("[Helper] Restarting capture session after error")
            wrapper.session.startRunning()
        }
    }

    private func configureFrameRate(_ device: AVCaptureDevice, fps: UInt32) {
        let clamped = max(1, min(fps, 60))
        do {
            try device.lockForConfiguration()
            let duration = CMTime(value: 1, timescale: CMTimeScale(clamped))
            if device.activeFormat.videoSupportedFrameRateRanges.contains(where: {
                Double(clamped) >= $0.minFrameRate && Double(clamped) <= $0.maxFrameRate
            }) {
                device.activeVideoMinFrameDuration = duration
                device.activeVideoMaxFrameDuration = duration
            }
            device.unlockForConfiguration()
        } catch {
            NSLog("[Helper] Failed to set frame rate: %@", error.localizedDescription)
        }
    }

    private func preferredCaptureSize(for device: AVCaptureDevice) -> (width: Int, height: Int) {
        let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        return (Int(dims.width), Int(dims.height))
    }

    // MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard isCapturing else { return }
        sinksLock.lock()
        let sink = sinks[ObjectIdentifier(output)]
        sinksLock.unlock()
        guard let sink, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let deviceId = sink.deviceId

        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let srcBase = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
        let srcW = CVPixelBufferGetWidth(pixelBuffer)
        let srcH = CVPixelBufferGetHeight(pixelBuffer)
        let srcRow = CVPixelBufferGetBytesPerRow(pixelBuffer)

        let dstW = sink.width
        let dstH = sink.height
        guard dstW > 0, dstH > 0, srcW > 0, srcH > 0 else { return }
        guard CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA else { return }

        let packedRow = dstW * 4
        var packed: Data

        if srcW == dstW && srcH == dstH {
            packed = Data(count: packedRow * dstH)
            packed.withUnsafeMutableBytes { dst in
                guard let dstBase = dst.baseAddress else { return }
                if srcRow == packedRow {
                    memcpy(dstBase, srcBase, packedRow * dstH)
                } else {
                    for y in 0..<dstH {
                        memcpy(dstBase + y * packedRow, srcBase + y * srcRow, packedRow)
                    }
                }
            }
        } else {
            guard let scaled = scaleBGRA(
                src: srcBase.assumingMemoryBound(to: UInt8.self),
                srcW: srcW, srcH: srcH, srcRow: srcRow,
                dstW: dstW, dstH: dstH
            ) else { return }
            packed = scaled
        }

        let timestamp = UInt64(Date().timeIntervalSince1970 * 1_000_000)
        latestFramesLock.lock()
        let nextNum = (frameNumbers[deviceId] ?? 0) + 1
        frameNumbers[deviceId] = nextNum
        latestFrames[deviceId] = LatestFrame(
            timestamp: timestamp,
            frameNumber: nextNum,
            width: UInt32(dstW),
            height: UInt32(dstH),
            bytesPerRow: packedRow,
            data: packed
        )
        let logFirst = !loggedFirstFrame
        loggedFirstFrame = true
        latestFramesLock.unlock()

        if logFirst {
            NSLog("[Helper] First camera frame %dx%d", dstW, dstH)
        }

        packed.withUnsafeBytes { raw in
            guard let ptr = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            _ = multiDisplayShm.writeFrame(
                displayId: deviceId,
                timestamp: timestamp,
                data: ptr,
                width: UInt32(dstW),
                height: UInt32(dstH),
                bytesPerRow: packedRow
            )
        }
    }

    private func scaleBGRA(src: UnsafePointer<UInt8>, srcW: Int, srcH: Int, srcRow: Int,
                           dstW: Int, dstH: Int) -> Data? {
        var srcBuf = vImage_Buffer(
            data: UnsafeMutableRawPointer(mutating: src),
            height: vImagePixelCount(srcH),
            width: vImagePixelCount(srcW),
            rowBytes: srcRow
        )
        let dstCount = dstW * dstH * 4
        let dstPtr = UnsafeMutablePointer<UInt8>.allocate(capacity: dstCount)
        var dstBuf = vImage_Buffer(
            data: dstPtr,
            height: vImagePixelCount(dstH),
            width: vImagePixelCount(dstW),
            rowBytes: dstW * 4
        )
        let err = vImageScale_ARGB8888(&srcBuf, &dstBuf, nil, vImage_Flags(kvImageNoFlags))
        if err != kvImageNoError {
            dstPtr.deallocate()
            return nil
        }
        let data = Data(bytes: dstPtr, count: dstCount)
        dstPtr.deallocate()
        return data
    }

    // MARK: - Device discovery / monitoring

    private func listCaptureDevices() -> [AVCaptureDevice] {
        var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
        if #available(macOS 13.0, *) {
            types.append(.deskViewCamera)
        }
        if #available(macOS 14.0, *) {
            types.append(.external)
            types.append(.continuityCamera)
        } else {
            types.append(.externalUnknown)
        }
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: types,
            mediaType: .video,
            position: .unspecified
        )
        // Deduplicate — Continuity Camera can appear under more than one type.
        var seen = Set<String>()
        return session.devices.filter { seen.insert($0.uniqueID).inserted }
    }

    private func positionString(_ position: AVCaptureDevice.Position) -> String {
        switch position {
        case .front: return "front"
        case .back: return "back"
        default: return "unspecified"
        }
    }

    private func startDeviceMonitoring() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: .AVCaptureDeviceWasConnected,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            // These notifications also fire for microphones and other AV devices.
            guard let device = notification.object as? AVCaptureDevice, device.hasMediaType(.video) else { return }
            if self?.isCapturing == true {
                _ = self?.startDevice(device.uniqueID)
            }
            self?.deviceChangeCallback?(device.uniqueID, "added")
        })
        observers.append(center.addObserver(
            forName: .AVCaptureDeviceWasDisconnected,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let device = notification.object as? AVCaptureDevice, device.hasMediaType(.video) else { return }
            self?.handleDeviceRemoved(device.uniqueID)
        })
    }

    private func stopDeviceMonitoring() {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
    }

    /// Capture stays "armed" when the last camera is unplugged so that re-plugging it (or
    /// connecting another camera) resumes streaming without a new `start` command.
    private func handleDeviceRemoved(_ deviceId: String) {
        stopDevice(deviceId)
        deviceChangeCallback?(deviceId, "removed")
    }
}
