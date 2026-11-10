import Foundation

// MARK: - NotificationServer

/// Accepts persistent connections on `<socket>.notify` and broadcasts newline-delimited
/// JSON notifications (`device_change`, `capture_started`, `capture_stopped`, `capture_error`).
final class NotificationServer {
    private var running = false
    private var acceptThreadRunning = false
    private var serverFd: Int32 = -1
    private var socketPath = ""
    private var clients: [Int32] = []
    private let clientsLock = NSLock()

    deinit { stop() }

    func start(socketPath: String) -> Bool {
        self.socketPath = socketPath

        serverFd = bindPrivateUnixSocket(path: socketPath)
        guard serverFd >= 0 else { return false }

        let flags = fcntl(serverFd, F_GETFL, 0)
        _ = fcntl(serverFd, F_SETFL, flags | O_NONBLOCK)

        guard listen(serverFd, 5) >= 0 else {
            Darwin.close(serverFd)
            serverFd = -1
            return false
        }

        running = true
        acceptThreadRunning = true

        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.acceptLoop()
        }

        return true
    }

    func stop() {
        guard running else { return }
        running = false

        if serverFd >= 0 {
            Darwin.close(serverFd)
            serverFd = -1
        }

        var waitCount = 0
        while acceptThreadRunning && waitCount < 20 {
            usleep(50000)
            waitCount += 1
        }

        clientsLock.lock()
        for fd in clients { Darwin.close(fd) }
        clients.removeAll()
        clientsLock.unlock()

        unlink(socketPath)
    }

    func sendNotification(_ notification: [String: Any]) {
        guard running else { return }
        guard let jsonData = try? JSONSerialization.data(withJSONObject: notification) else { return }

        var msgData = jsonData
        msgData.append(contentsOf: [UInt8(ascii: "\n")])

        clientsLock.lock()
        defer { clientsLock.unlock() }
        guard running else { return }

        var deadClients: [Int32] = []

        // Client sockets are non-blocking (inherited from the listener), so a client that
        // stops reading is dropped instead of stalling the main thread.
        for fd in clients {
            let written = msgData.withUnsafeBytes { buffer -> Int in
                guard let base = buffer.baseAddress else { return 0 }
                return write(fd, base, buffer.count)
            }
            if written < msgData.count {
                deadClients.append(fd)
            }
        }

        for fd in deadClients {
            Darwin.close(fd)
            clients.removeAll { $0 == fd }
        }
    }

    private func acceptLoop() {
        let fd = serverFd
        while running {
            let clientFd = accept(fd, nil, nil)
            if clientFd >= 0 {
                configureClientSocket(clientFd, timeoutSeconds: 1)
                clientsLock.lock()
                if running {
                    clients.append(clientFd)
                    NSLog("[Helper] Notification client connected")
                } else {
                    Darwin.close(clientFd)
                }
                clientsLock.unlock()
            } else if running {
                usleep(100_000)
            }
        }
        acceptThreadRunning = false
    }
}

// MARK: - Socket helpers

/// Maximum usable `sun_path` length (excluding the terminating NUL).
let maxUnixSocketPathLength = MemoryLayout.size(ofValue: sockaddr_un().sun_path) - 1

/// Creates and binds a Unix-domain stream socket at `path` that only the current user can
/// connect to (mode 0600). Returns the fd, or -1 with errno set.
func bindPrivateUnixSocket(path: String) -> Int32 {
    let pathBytes = Array(path.utf8)
    guard !pathBytes.isEmpty, pathBytes.count <= maxUnixSocketPathLength else {
        NSLog("[Helper] Socket path too long (max %d bytes)", maxUnixSocketPathLength)
        errno = ENAMETOOLONG
        return -1
    }

    unlink(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return -1 }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        raw.copyBytes(from: pathBytes)
    }

    // Restrict permissions at creation time (no window where the socket is world-connectable).
    let oldMask = umask(0o077)
    let bindResult = withUnsafePointer(to: &addr) { addrPtr in
        addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
            bind(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    umask(oldMask)

    guard bindResult >= 0 else {
        let saved = errno
        Darwin.close(fd)
        errno = saved
        return -1
    }
    _ = chmod(path, 0o600)
    return fd
}

/// Per-connection socket options: no SIGPIPE, bounded blocking on read/write.
func configureClientSocket(_ fd: Int32, timeoutSeconds: Int) {
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var tv = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
}
