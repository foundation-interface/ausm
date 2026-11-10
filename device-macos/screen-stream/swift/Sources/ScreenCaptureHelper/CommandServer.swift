import Foundation
import CoreGraphics

// MARK: - CommandServer

/// Accepts one JSON request per connection over a Unix domain socket,
/// dispatches it to CaptureManager and writes one JSON response, then closes.
/// See README.md ("Command protocol") for the wire format.
final class CommandServer {
    private let manager: CaptureManager
    private let notifier: NotificationServer
    private let stateLock = NSLock()
    private var running = false
    private var serverFd: Int32 = -1
    private var socketPath = ""

    /// Per-connection handling. Concurrent so that read-only commands
    /// (status, displays, captureLatestFrame, captureWindow) are not blocked
    /// behind long-running mutations (start/stop capture).
    private let commandQueue = DispatchQueue(label: "com.ausm.commandServer",
                                             qos: .userInitiated,
                                             attributes: .concurrent)
    /// Serialises commands that mutate capture state. They then run on the
    /// main queue (ScreenCaptureKit completion handlers need the run loop),
    /// one at a time, so a "stop" cannot interleave with an in-flight "start".
    private let mutationQueue = DispatchQueue(label: "com.ausm.commandServer.mutations")

    /// Seconds a client may take to send its request / accept the response.
    private static let ioTimeoutSeconds = 10

    /// Commands that mutate CaptureManager state and must run on the main queue.
    static let mainQueueCommands: Set<String> = [
        "start", "stop", "configure", "update_config", "configureDisplay", "getDisplayConfigs", "quit",
    ]

    init(manager: CaptureManager, notifier: NotificationServer) {
        self.manager = manager
        self.notifier = notifier
    }

    func start(socketPath: String) -> Bool {
        guard let fd = UnixSocket.listen(path: socketPath, tag: "CommandServer") else { return false }
        self.socketPath = socketPath
        stateLock.lock()
        serverFd = fd
        running = true
        stateLock.unlock()

        let thread = Thread { [weak self] in self?.acceptLoop(fd) }
        thread.name = "com.ausm.commandServer.accept"
        thread.start()

        NSLog("[Helper] Command server started on %@", socketPath)
        return true
    }

    func stop() {
        stateLock.lock()
        let fd = serverFd
        running = false
        serverFd = -1
        stateLock.unlock()
        if fd >= 0 {
            // shutdown() wakes a thread blocked in accept(); close() alone may not.
            Darwin.shutdown(fd, SHUT_RDWR)
            Darwin.close(fd)
        }
        if !socketPath.isEmpty { unlink(socketPath) }
    }

    // MARK: - Private

    private var isRunning: Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        return running
    }

    private func acceptLoop(_ listenFd: Int32) {
        while isRunning {
            let clientFd = accept(listenFd, nil, nil)
            guard clientFd >= 0 else {
                if errno == EINTR { continue }
                if isRunning { usleep(100_000) }
                continue
            }
            UnixSocket.configureClient(clientFd)
            UnixSocket.setTimeouts(clientFd, seconds: Self.ioTimeoutSeconds)
            commandQueue.async { [weak self] in
                guard let self else { Darwin.close(clientFd); return }
                self.handleClient(clientFd)
            }
        }
    }

    /// Read until a complete JSON object, EOF, timeout or size limit.
    private func readRequest(_ fd: Int32) -> CommandFraming.Result {
        var data = Data()
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n > 0 {
                data.append(chunk, count: n)
                let result = CommandFraming.parse(data, eof: false)
                if case .incomplete = result { continue }
                return result
            }
            if n < 0 && errno == EINTR { continue }
            if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                return .invalid("Request timeout")
            }
            // EOF (or error): judge what we have.
            return data.isEmpty ? .invalid("Empty request") : CommandFraming.parse(data, eof: true)
        }
    }

    private func handleClient(_ clientFd: Int32) {
        defer { Darwin.close(clientFd) }

        let request: [String: Any]
        switch readRequest(clientFd) {
        case .complete(let dict):
            request = dict
        case .invalid(let reason):
            sendResponse(clientFd, ["success": false, "error": reason, "code": HelperErrorCode.invalidRequest.rawValue])
            return
        case .incomplete:
            return  // unreachable
        }

        guard let cmd = request["command"] as? String, !cmd.isEmpty else {
            sendResponse(clientFd, ["success": false, "error": "Missing command", "code": HelperErrorCode.invalidRequest.rawValue])
            return
        }

        let response: [String: Any]
        if Self.mainQueueCommands.contains(cmd) {
            response = mutationQueue.sync {
                DispatchQueue.main.sync { self.processCommand(cmd, params: request) }
            }
        } else {
            response = processCommand(cmd, params: request)
        }
        sendResponse(clientFd, response)
    }

    private func processCommand(_ cmd: String, params: [String: Any]) -> [String: Any] {
        switch cmd {
        case "configure":
            guard let config = params["config"] as? [String: Any] else {
                return invalid("Missing or invalid config")
            }
            let update = CaptureConfigUpdate(config)
            manager.configure(update)
            var response: [String: Any] = ["success": true]
            if !update.rejected.isEmpty { response["rejected"] = update.rejected }
            return response

        case "start":
            var displayIds: [String] = []
            if params["displayIds"] != nil && !(params["displayIds"] is NSNull) {
                guard let ids = Param.stringArray(params["displayIds"]) else {
                    return invalid("displayIds must be an array of strings")
                }
                displayIds = ids
            }
            if let failure = manager.startCapture(displayIds: displayIds) {
                notifier.sendNotification(["type": "error", "code": failure.code.rawValue, "error": failure.message])
                return ["success": false, "error": failure.message, "code": failure.code.rawValue]
            }
            notifier.sendNotification(["type": "capture_started"])
            return ["success": true]

        case "stop":
            notifier.sendNotification(["type": "capture_stopped"])
            manager.stopCapture()
            return ["success": true]

        case "status":
            let capturing = manager.isCapturing
            // `streaming` is an alias kept for the TypeScript client.
            return ["success": true, "capturing": capturing, "streaming": capturing,
                    "permission": DisplayManager.hasPermission()]

        case "displays":
            return ["success": true, "displays": manager.getDisplays()]

        case "update_config":
            guard let config = params["config"] as? [String: Any] else {
                return invalid("Missing or invalid config")
            }
            let update = CaptureConfigUpdate(config)
            let ok = manager.updateConfiguration(update)
            var response: [String: Any] = ["success": ok]
            if !ok { response["error"] = "Cannot update config while capturing - stop first" }
            if !update.rejected.isEmpty { response["rejected"] = update.rejected }
            return response

        case "configureDisplay":
            guard let displayId = Param.string(params["displayId"], maxLength: 64),
                  let config = params["config"] as? [String: Any] else {
                return invalid("Missing displayId or config")
            }
            let update = CaptureConfigUpdate(config)
            manager.configureDisplay(displayId, fps: update.fps, targetHeight: update.targetHeight)

            if manager.isCapturing {
                guard manager.restartDisplayCapture(displayId) else {
                    return ["success": false, "error": "Failed to restart display capture",
                            "code": HelperErrorCode.streamFailed.rawValue]
                }
                notifier.sendNotification(["type": "capture_started"])
            }
            return ["success": true]

        case "getDisplayConfigs":
            return ["success": true, "displayConfigs": manager.getDisplayConfigs()]

        case "captureWindow":
            guard let windowId = Param.int(params["windowId"], in: ConfigLimits.windowId) else {
                return invalid("Missing or invalid windowId")
            }
            let jpegQuality = Param.double(params["jpegQuality"], clampedTo: ConfigLimits.jpegQuality) ?? 0.85
            let displayId = Param.string(params["displayId"], maxLength: 64)
            return manager.captureWindow(windowId: CGWindowID(windowId), displayId: displayId, jpegQuality: jpegQuality)

        case "captureLatestFrame":
            guard let displayId = Param.string(params["displayId"], maxLength: 64) else {
                return invalid("Missing or invalid displayId")
            }
            let jpegQuality = Param.double(params["jpegQuality"], clampedTo: ConfigLimits.jpegQuality) ?? 0.7
            return manager.captureLatestFrame(displayId: displayId, jpegQuality: jpegQuality)

        case "quit":
            manager.stopCapture()
            DispatchQueue.main.async {
                CFRunLoopStop(CFRunLoopGetMain())
            }
            return ["success": true]

        default:
            return invalid("Unknown command: \(cmd.prefix(64))")
        }
    }

    private func invalid(_ message: String) -> [String: Any] {
        ["success": false, "error": message, "code": HelperErrorCode.invalidRequest.rawValue]
    }

    private func sendResponse(_ clientFd: Int32, _ response: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(response),
              let jsonData = try? JSONSerialization.data(withJSONObject: response) else {
            NSLog("[Helper] Failed to serialise response")
            return
        }
        UnixSocket.writeAll(clientFd, jsonData)
    }
}
