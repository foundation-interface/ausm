import Foundation

// MARK: - CommandServer

/// Accepts JSON commands over a Unix domain socket, dispatches to CaptureManager.
///
/// Protocol: the client connects, writes one JSON object (`{"command": "...", ...}`), and
/// reads one JSON object back; the server then closes the connection. The socket is created
/// with mode 0600 so only the current user can drive the camera.
final class CommandServer {
    private let manager: CaptureManager
    private let notifier: NotificationServer
    private var running = false
    private var serverFd: Int32 = -1
    private var socketPath = ""
    private let commandQueue = DispatchQueue(label: "com.ausm.cameraCommandServer",
                                             qos: .userInitiated,
                                             attributes: .concurrent)

    init(manager: CaptureManager, notifier: NotificationServer) {
        self.manager = manager
        self.notifier = notifier
    }

    func start(socketPath: String) -> Bool {
        self.socketPath = socketPath

        serverFd = bindPrivateUnixSocket(path: socketPath)
        guard serverFd >= 0 else {
            NSLog("[Helper] Failed to bind command socket: %s", strerror(errno))
            return false
        }

        guard listen(serverFd, 16) >= 0 else {
            NSLog("[Helper] Failed to listen on socket")
            Darwin.close(serverFd)
            serverFd = -1
            return false
        }

        running = true

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.acceptLoop()
        }

        NSLog("[Helper] Command server started on %@", socketPath)
        return true
    }

    func stop() {
        running = false
        if serverFd >= 0 {
            Darwin.shutdown(serverFd, SHUT_RDWR)
            Darwin.close(serverFd)
            serverFd = -1
        }
        unlink(socketPath)
    }

    private func acceptLoop() {
        let fd = serverFd
        while running {
            let clientFd = accept(fd, nil, nil)
            guard clientFd >= 0 else {
                if running { usleep(100_000) }
                continue
            }
            configureClientSocket(clientFd, timeoutSeconds: 10)

            commandQueue.async { [weak self] in
                self?.handleClient(clientFd)
            }
        }
    }

    /// Reads until the bytes received so far form a complete JSON object (clients do not
    /// half-close), EOF, the receive timeout, or `maxCommandBytes`.
    private static let maxCommandBytes = 1 << 20

    private func readCommand(_ clientFd: Int32) -> [String: Any]? {
        var received = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while received.count < Self.maxCommandBytes {
            let n = read(clientFd, &chunk, chunk.count)
            if n <= 0 { break }
            received.append(contentsOf: chunk[0..<n])
            if let obj = try? JSONSerialization.jsonObject(with: received) as? [String: Any] {
                return obj
            }
        }
        return nil
    }

    private func handleClient(_ clientFd: Int32) {
        defer { Darwin.close(clientFd) }

        guard let jsonData = readCommand(clientFd) else {
            sendResponse(clientFd, response: ["success": false, "error": "Invalid JSON"])
            return
        }

        let cmd = jsonData["command"] as? String ?? ""
        // Everything that touches AVFoundation sessions or CaptureManager's main-thread state
        // runs on the main queue. captureLatestFrame / status only use lock-protected state.
        let offMain: Set<String> = ["captureLatestFrame", "status"]
        let needsMainQueue = !offMain.contains(cmd)

        let response: [String: Any]
        if needsMainQueue {
            response = DispatchQueue.main.sync { [self] in
                processCommand(cmd, params: jsonData)
            }
        } else {
            response = processCommand(cmd, params: jsonData)
        }

        sendResponse(clientFd, response: response)
    }

    private func processCommand(_ cmd: String, params: [String: Any]) -> [String: Any] {
        switch cmd {
        case "configure":
            if let config = params["config"] as? [String: Any] {
                manager.configure(config)
            }
            return ["success": true]

        case "start":
            let deviceIds = params["deviceIds"] as? [String] ?? []
            let result = manager.startCapture(deviceIds: deviceIds)
            if result["success"] as? Bool == true {
                notifier.sendNotification(["type": "capture_started"])
            }
            return result

        case "stop":
            notifier.sendNotification(["type": "capture_stopped"])
            manager.stopCapture()
            return ["success": true]

        case "status":
            return [
                "success": true,
                "streaming": manager.isCapturing,
                "capturing": manager.isCapturing,
            ]

        case "devices":
            return ["devices": manager.getDevices()]

        case "configureDevice":
            guard let deviceId = params["deviceId"] as? String,
                  let config = params["config"] as? [String: Any] else {
                return ["error": "Missing deviceId or config"]
            }
            return manager.configureDevice(deviceId, config: config)

        case "getDeviceConfigs":
            return [
                "success": true,
                "deviceConfigs": manager.getDeviceConfigs(),
            ]

        case "captureLatestFrame":
            guard let deviceId = params["deviceId"] as? String else {
                return ["success": false, "error": "Missing or invalid deviceId"]
            }
            return manager.captureLatestFrame(deviceId: deviceId,
                                              jpegQuality: ConfigValue.jpegQuality(params["jpegQuality"]))

        case "quit":
            manager.stopCapture()
            DispatchQueue.main.async {
                CFRunLoopStop(CFRunLoopGetMain())
            }
            return ["success": true]

        default:
            return ["success": false, "error": "Unknown command: \(cmd)"]
        }
    }

    private func sendResponse(_ clientFd: Int32, response: [String: Any]) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: response) else { return }
        jsonData.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            var written = 0
            let total = buffer.count
            while written < total {
                let n = write(clientFd, base + written, total - written)
                if n <= 0 { break }
                written += n
            }
        }
    }
}
