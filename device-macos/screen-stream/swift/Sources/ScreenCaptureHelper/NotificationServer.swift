import Foundation

// MARK: - NotificationServer

/// Accepts persistent connections and broadcasts newline-delimited JSON
/// notifications. Slow or dead clients are dropped instead of blocking the
/// sender (notifications are sent from the main queue).
final class NotificationServer {
    private var running = false
    private var serverFd: Int32 = -1
    private var socketPath = ""
    private var clients: [Int32] = []
    private let clientsLock = NSLock()
    private let acceptDone = DispatchSemaphore(value: 0)

    deinit { stop() }

    func start(socketPath: String) -> Bool {
        guard let fd = UnixSocket.listen(path: socketPath, tag: "NotificationServer") else { return false }
        self.socketPath = socketPath
        serverFd = fd

        // Non-blocking accept so the loop can observe `running` and exit.
        let flags = fcntl(serverFd, F_GETFL, 0)
        _ = fcntl(serverFd, F_SETFL, flags | O_NONBLOCK)

        clientsLock.lock(); running = true; clientsLock.unlock()

        let listenFd = serverFd
        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.acceptLoop(listenFd)
        }
        return true
    }

    func stop() {
        clientsLock.lock()
        let wasRunning = running
        running = false
        clientsLock.unlock()
        guard wasRunning else { return }

        // Wait (bounded) for the accept loop to observe `running == false`
        // before closing its fd.
        _ = acceptDone.wait(timeout: .now() + 1.0)
        if serverFd >= 0 {
            Darwin.close(serverFd)
            serverFd = -1
        }

        clientsLock.lock()
        for fd in clients { Darwin.close(fd) }
        clients.removeAll()
        clientsLock.unlock()

        unlink(socketPath)
    }

    func sendNotification(_ notification: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(notification),
              var msgData = try? JSONSerialization.data(withJSONObject: notification) else { return }
        msgData.append(UInt8(ascii: "\n"))

        clientsLock.lock()
        defer { clientsLock.unlock() }
        guard running else { return }

        var deadClients: [Int32] = []
        for fd in clients {
            // Client sockets are non-blocking: a client whose receive buffer is
            // full (not reading) is dropped rather than stalling the helper.
            if !UnixSocket.writeAll(fd, msgData) {
                deadClients.append(fd)
            }
        }
        for fd in deadClients {
            Darwin.close(fd)
            clients.removeAll { $0 == fd }
        }
    }

    // MARK: - Private

    private func acceptLoop(_ listenFd: Int32) {
        defer { acceptDone.signal() }
        while true {
            clientsLock.lock()
            let isRunning = running
            clientsLock.unlock()
            guard isRunning else { return }

            let clientFd = accept(listenFd, nil, nil)
            if clientFd >= 0 {
                UnixSocket.configureClient(clientFd)
                let flags = fcntl(clientFd, F_GETFL, 0)
                _ = fcntl(clientFd, F_SETFL, flags | O_NONBLOCK)

                clientsLock.lock()
                if running {
                    clients.append(clientFd)
                } else {
                    Darwin.close(clientFd)
                }
                clientsLock.unlock()
            } else {
                // No pending connection: wait for one (or 200 ms, to re-check `running`).
                var pfd = pollfd(fd: listenFd, events: Int16(POLLIN), revents: 0)
                _ = poll(&pfd, 1, 200)
            }
        }
    }
}

// MARK: - Unix socket helpers

enum UnixSocket {
    /// Maximum usable path length for sockaddr_un.sun_path (excluding NUL).
    static var maxPathLength: Int {
        MemoryLayout.size(ofValue: sockaddr_un().sun_path) - 1
    }

    /// Create, bind (owner-only, mode 0600) and listen on a Unix socket.
    static func listen(path: String, tag: String) -> Int32? {
        guard !path.isEmpty, path.utf8.count <= maxPathLength else {
            NSLog("[%@] Socket path is empty or longer than %d bytes: %@", tag, maxPathLength, path)
            return nil
        }
        // Remove a stale socket from a previous run, but never another file type.
        var st = stat()
        if lstat(path, &st) == 0 {
            guard (st.st_mode & S_IFMT) == S_IFSOCK else {
                NSLog("[%@] Refusing to replace non-socket file at %@", tag, path)
                return nil
            }
            unlink(path)
        }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            NSLog("[%@] socket() failed: %s", tag, strerror(errno))
            return nil
        }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        setSockAddrPath(&addr, path)

        // Bind with a restrictive umask so the socket is never connectable by
        // other users (commands can return screen contents), then enforce it.
        let oldMask = umask(0o077)
        let bindResult = withUnsafePointer(to: &addr) { addrPtr in
            addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                bind(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        umask(oldMask)

        guard bindResult == 0 else {
            NSLog("[%@] bind(%@) failed: %s", tag, path, strerror(errno))
            Darwin.close(fd)
            return nil
        }
        _ = chmod(path, 0o600)

        guard Darwin.listen(fd, 16) == 0 else {
            NSLog("[%@] listen() failed: %s", tag, strerror(errno))
            Darwin.close(fd)
            unlink(path)
            return nil
        }
        return fd
    }

    /// Per-connection options: no SIGPIPE, close-on-exec.
    static func configureClient(_ fd: Int32) {
        var one: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    }

    static func setTimeouts(_ fd: Int32, seconds: Int) {
        var tv = timeval(tv_sec: seconds, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    /// Write all of `data`, retrying on EINTR and short writes. EAGAIN
    /// (non-blocking socket full, or SO_SNDTIMEO expired) is a failure.
    @discardableResult
    static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> Bool in
            guard let base = buf.baseAddress else { return true }
            var offset = 0
            while offset < buf.count {
                let n = write(fd, base + offset, buf.count - offset)
                if n > 0 {
                    offset += n
                } else if n < 0 && errno == EINTR {
                    continue
                } else {
                    return false
                }
            }
            return true
        }
    }
}

func setSockAddrPath(_ addr: inout sockaddr_un, _ path: String) {
    let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
    withUnsafeMutableBytes(of: &addr.sun_path) { rawBuf in
        rawBuf.initializeMemory(as: UInt8.self, repeating: 0)
        let bytes = Array(path.utf8.prefix(maxLen))
        bytes.withUnsafeBytes { src in
            if let base = src.baseAddress, let dst = rawBuf.baseAddress { memcpy(dst, base, src.count) }
        }
    }
}
