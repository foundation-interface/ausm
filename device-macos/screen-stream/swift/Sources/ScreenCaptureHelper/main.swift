import Foundation
import ScreenCaptureKit

// screen-capture-helper
//
// Usage: screen-capture-helper [--socket <path>]
//
// Listens for JSON commands on <path> (default /tmp/ausm-frames.sock) and
// broadcasts notifications on <path>.notify. Frames are written to POSIX
// shared memory once a client sends "configure" (with sharedMemoryName and
// frameCount) and "start". See ../../README.md for the protocol.

// MARK: - Parse Arguments

var socketPath = "/tmp/ausm-frames.sock"
var argIndex = 1
let args = CommandLine.arguments
while argIndex < args.count {
    switch args[argIndex] {
    case "--socket" where argIndex + 1 < args.count:
        socketPath = args[argIndex + 1]
        argIndex += 2
    case "--help", "-h":
        print("Usage: screen-capture-helper [--socket <path>]")
        exit(0)
    default:
        argIndex += 1
    }
}

let notifySocketPath = socketPath + ".notify"
guard notifySocketPath.utf8.count <= UnixSocket.maxPathLength else {
    NSLog("[Helper] Socket path too long (max %d bytes including '.notify'): %@",
          UnixSocket.maxPathLength - 7, socketPath)
    exit(2)
}

NSLog("[Helper] Screen Capture Helper starting (socket %@)", socketPath)
if !DisplayManager.hasPermission() {
    NSLog("[Helper] Screen Recording permission is not granted; 'start' will fail until it is enabled")
}

// MARK: - Signal Handling

signal(SIGPIPE, SIG_IGN)  // Never die writing to a closed socket
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
signal(SIGHUP, SIG_IGN)

func makeShutdownSource(_ sig: Int32, _ name: String) -> DispatchSourceSignal {
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        NSLog("[Helper] Received %@, shutting down...", name)
        CFRunLoopStop(CFRunLoopGetMain())
    }
    source.resume()
    return source
}
let signalSources = [
    makeShutdownSource(SIGINT, "SIGINT"),
    makeShutdownSource(SIGTERM, "SIGTERM"),
    makeShutdownSource(SIGHUP, "SIGHUP"),
]

// MARK: - Create Services

let notifier = NotificationServer()
if !notifier.start(socketPath: notifySocketPath) {
    NSLog("[Helper] Failed to start notification server (continuing without push notifications)")
}

let manager = CaptureManager()
let server = CommandServer(manager: manager, notifier: notifier)

manager.setDisplayChangeCallback { displayId, eventType in
    notifier.sendNotification([
        "type": "display_change",
        "displayId": displayId,
        "event": eventType,
    ])
}
manager.setErrorCallback { code, message, displayId in
    var payload: [String: Any] = ["type": "error", "code": code.rawValue, "error": message]
    if let displayId { payload["displayId"] = displayId }
    notifier.sendNotification(payload)
}

guard server.start(socketPath: socketPath) else {
    NSLog("[Helper] Failed to start command server")
    notifier.stop()
    exit(1)
}

// The TypeScript client waits for this exact line on stderr.
NSLog("[Helper] Ready and waiting for commands...")

// MARK: - Parent Death Detection
// When launched by HelperClient, stdin is a pipe. If the parent process dies
// (crash, SIGKILL, ...), the write end closes and we read EOF, triggering a
// clean shutdown. As a backup we also watch the parent PID. When run from a
// terminal (stdin is a TTY) only the PID watch applies, and only if the
// parent is not launchd.

var stdinSource: DispatchSourceRead?
var stdinStat = stat()
if fstat(STDIN_FILENO, &stdinStat) == 0 &&
    ((stdinStat.st_mode & S_IFMT) == S_IFIFO || (stdinStat.st_mode & S_IFMT) == S_IFSOCK) {
    let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
    source.setEventHandler {
        var buf = [UInt8](repeating: 0, count: 256)
        let n = read(STDIN_FILENO, &buf, buf.count)
        if n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN) {
            NSLog("[Helper] Parent process went away (stdin EOF), shutting down...")
            source.cancel()
            CFRunLoopStop(CFRunLoopGetMain())
        }
    }
    source.resume()
    stdinSource = source
}

var parentSource: DispatchSourceProcess?
let parentPid = getppid()
if parentPid > 1 {
    let source = DispatchSource.makeProcessSource(identifier: parentPid, eventMask: .exit, queue: .main)
    source.setEventHandler {
        NSLog("[Helper] Parent process %d exited, shutting down...", parentPid)
        CFRunLoopStop(CFRunLoopGetMain())
    }
    source.resume()
    parentSource = source
    // The parent may have died before the source was armed.
    if getppid() != parentPid {
        DispatchQueue.main.async { CFRunLoopStop(CFRunLoopGetMain()) }
    }
}

// MARK: - Run
// ScreenCaptureKit completion handlers and display polling need the main run loop.
CFRunLoopRun()

// MARK: - Cleanup
stdinSource?.cancel()
parentSource?.cancel()
signalSources.forEach { $0.cancel() }

server.stop()            // stop accepting commands
manager.stopCapture()    // stop streams, finalize recordings, unlink shared memory
notifier.stop()

NSLog("[Helper] Shutdown complete")
exit(0)
