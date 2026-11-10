/// CameraHelper — AVFoundation webcam capture → POSIX shared memory.
///
/// Control:       JSON request/response over the Unix socket given by `--socket`
///                (default /tmp/ausm-camera.sock). See CommandServer.swift.
/// Notifications: newline-delimited JSON on `<socket>.notify`. See NotificationServer.swift.
/// Frames:        SHM registry `<shm>-registry` + ring buffers `<shm>-<slot>` (mode 0600).
/// Logs:          stderr (NSLog). "Ready and waiting for commands..." marks readiness.
///
/// Exits on SIGINT/SIGTERM, the `quit` command, stdin EOF (when stdin is a pipe), or when the
/// parent process dies; capture is stopped and all SHM segments/sockets are removed.

import Foundation
import AVFoundation

// MARK: - Parse Arguments

var socketPath = "/tmp/ausm-camera.sock"
var argIndex = 1
while argIndex < CommandLine.arguments.count {
    if CommandLine.arguments[argIndex] == "--socket", argIndex + 1 < CommandLine.arguments.count {
        socketPath = CommandLine.arguments[argIndex + 1]
        argIndex += 2
    } else {
        argIndex += 1
    }
}

NSLog("[Helper] Camera Helper starting...")
NSLog("[Helper] Socket: %@", socketPath)

// MARK: - Signal Handling

signal(SIGPIPE, SIG_IGN)
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

func requestShutdown(_ reason: String) {
    NSLog("[Helper] %@, shutting down...", reason)
    CFRunLoopStop(CFRunLoopGetMain())
}

let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigintSource.setEventHandler { requestShutdown("Received SIGINT") }
sigintSource.resume()

let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigtermSource.setEventHandler { requestShutdown("Received SIGTERM") }
sigtermSource.resume()

// MARK: - Stale resources from a previous (crashed) run

MultiDisplayShmManager.unlinkAll(baseName: "/ausm-camera-frames")

// MARK: - Create Services

let notifier = NotificationServer()
let notifySocketPath = socketPath + ".notify"

if !notifier.start(socketPath: notifySocketPath) {
    NSLog("[Helper] Failed to start notification server")
} else {
    NSLog("[Helper] Notification server started on %@", notifySocketPath)
}

let manager = CaptureManager()
let server = CommandServer(manager: manager, notifier: notifier)

manager.setDeviceChangeCallback { deviceId, eventType in
    notifier.sendNotification([
        "type": "device_change",
        "deviceId": deviceId,
        "event": eventType,
    ])
}

manager.setCaptureErrorCallback { deviceId, message in
    notifier.sendNotification([
        "type": "capture_error",
        "deviceId": deviceId,
        "error": message,
    ])
}

guard server.start(socketPath: socketPath) else {
    NSLog("[Helper] Failed to start command server")
    notifier.stop()
    exit(1)
}

NSLog("[Helper] Ready and waiting for commands...")

// MARK: - Parent Death Detection

var stdinSource: DispatchSourceRead? = nil
var stdinStat = stat()
if fstat(STDIN_FILENO, &stdinStat) == 0 &&
    (stdinStat.st_mode & S_IFMT == S_IFIFO || stdinStat.st_mode & S_IFMT == S_IFSOCK) {
    NSLog("[Helper] Stdin is a pipe - monitoring for parent death")
    let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
    source.setEventHandler {
        var buf = [UInt8](repeating: 0, count: 64)
        let n = read(STDIN_FILENO, &buf, buf.count)
        if n <= 0 {
            source.cancel()
            requestShutdown("Parent process died (stdin EOF)")
        }
    }
    source.resume()
    stdinSource = source
}

// Covers parents that did not give us a stdin pipe: when the parent exits we are re-parented.
let originalParentPid = getppid()
var parentWatch: DispatchSourceTimer? = nil
if originalParentPid > 1 {
    let watch = DispatchSource.makeTimerSource(queue: .main)
    watch.schedule(deadline: .now() + 1, repeating: 1)
    watch.setEventHandler {
        if getppid() != originalParentPid {
            watch.cancel()
            requestShutdown("Parent process exited")
        }
    }
    watch.resume()
    parentWatch = watch
}

CFRunLoopRun()

stdinSource?.cancel()

server.stop()
notifier.stop()
manager.stopCapture()

NSLog("[Helper] Shutdown complete")
exit(0)
