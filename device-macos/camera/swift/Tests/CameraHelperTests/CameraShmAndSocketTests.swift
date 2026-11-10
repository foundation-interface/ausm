import XCTest
import CHelpers
@testable import CameraHelper

private var counter = 0
/// Short, process-unique shm base names (macOS: 31 bytes max including the slot suffix).
private func uniqueBase(_ tag: String) -> String {
    counter += 1
    return "/ausmc\(tag)\(getpid() % 10_000)\(counter)"
}

private func shmExists(_ name: String) -> Bool {
    let fd = ausm_shm_open(name, O_RDONLY, 0)
    if fd >= 0 { close(fd); return true }
    return false
}

private func shmMode(_ name: String) -> mode_t? {
    let fd = ausm_shm_open(name, O_RDONLY, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var sb = stat()
    return fstat(fd, &sb) == 0 ? sb.st_mode & 0o777 : nil
}

/// Read-only mapping of a segment for assertions.
private func withMapping(_ name: String, size: Int, _ body: (UnsafeRawPointer) throws -> Void) throws {
    let fd = ausm_shm_open(name, O_RDONLY, 0)
    XCTAssertGreaterThanOrEqual(fd, 0, "segment \(name) missing")
    guard fd >= 0 else { return }
    defer { close(fd) }
    let mem = try XCTUnwrap(mmap(nil, size, PROT_READ, MAP_SHARED, fd, 0))
    defer { munmap(mem, size) }
    try body(UnsafeRawPointer(mem))
}

final class CameraSharedMemoryTests: XCTestCase {
    func testCreateWritesHeaderPrivately() throws {
        let name = uniqueBase("h")
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: name, frameCount: 3, frameWidth: 4, frameHeight: 2))
        defer { shm.close(unlink: true) }
        XCTAssertTrue(shm.isOpen)
        XCTAssertEqual(shm.shmName, name)
        XCTAssertEqual(shmMode(name), 0o600)
        try withMapping(name, size: ShmMath.totalSize(frameCount: 3, width: 4, height: 2)!) { mem in
            XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.magic, as: UInt32.self), SHM_MAGIC)
            XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.frameCount, as: UInt32.self), 3)
            XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.frameSize, as: UInt32.self), 32)
            XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.writeIndex, as: UInt32.self), 0)
            for i in 0..<3 {
                let slot = ShmMath.frameOffset(index: UInt32(i), frameDataSize: 32)
                XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.ready, as: UInt32.self), 0)
            }
        }
    }

    func testWriteFrameStripsStrideWrapsRingAndPublishes() throws {
        let name = uniqueBase("w")
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: name, frameCount: 2, frameWidth: 2, frameHeight: 2))
        defer { shm.close(unlink: true) }
        let src: [UInt8] = [1, 2, 3, 4, 5, 6, 7, 8, 0xEE, 0xEE,
                            9, 10, 11, 12, 13, 14, 15, 16, 0xEE, 0xEE]
        let indices = (0..<3).map { _ in
            src.withUnsafeBufferPointer {
                shm.writeFrame(displayId: 9, timestamp: 77, data: $0.baseAddress!, width: 2, height: 2, bytesPerRow: 10)
            }
        }
        XCTAssertEqual(indices, [0, 1, 0])
        try withMapping(name, size: ShmMath.totalSize(frameCount: 2, width: 2, height: 2)!) { mem in
            let slot = ShmMath.frameOffset(index: 0, frameDataSize: 16)
            XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.ready, as: UInt32.self), 1)
            XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.frameNumber, as: UInt64.self), 2)
            XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.displayId, as: UInt32.self), 9)
            XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.timestamp, as: UInt64.self), 77)
            XCTAssertEqual(Array(UnsafeRawBufferPointer(start: mem + slot + FrameHeaderLayout.totalSize, count: 16)),
                           [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
            XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.frameNumber, as: UInt64.self), 3)
            XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.writeIndex, as: UInt32.self), 3)
        }
    }

    func testWriteFrameRejectsBadInput() {
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: uniqueBase("r"), frameCount: 1, frameWidth: 2, frameHeight: 2))
        defer { shm.close(unlink: true) }
        let px = [UInt8](repeating: 0, count: 256)
        px.withUnsafeBufferPointer { b in
            let p = b.baseAddress!
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 0, data: p, width: 4, height: 4, bytesPerRow: 16), -1, "too big")
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 0, data: p, width: 2, height: 2, bytesPerRow: 4), -1, "stride < row")
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 0, data: p, width: 0, height: 2, bytesPerRow: 8), -1, "zero width")
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 0, data: p, width: 2, height: 0, bytesPerRow: 8), -1, "zero height")
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 0, data: p, width: 1, height: 1, bytesPerRow: 4), 0, "smaller frame fits")
        }
    }

    func testInvalidGeometryAndCloseSemantics() {
        let shm = SharedMemoryManager()
        XCTAssertFalse(shm.create(name: uniqueBase("g"), frameCount: 0, frameWidth: 2, frameHeight: 2))
        XCTAssertFalse(shm.create(name: uniqueBase("g"), frameCount: 1, frameWidth: 0, frameHeight: 2))
        XCTAssertFalse(shm.isOpen)
        let name = uniqueBase("c")
        XCTAssertTrue(shm.create(name: name, frameCount: 1, frameWidth: 2, frameHeight: 2))
        shm.close(unlink: false)
        XCTAssertTrue(shmExists(name), "close without unlink keeps the segment")
        shm_unlink(name)
        let px = [UInt8](repeating: 0, count: 16)
        px.withUnsafeBufferPointer {
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 0, data: $0.baseAddress!, width: 2, height: 2, bytesPerRow: 8), -1)
        }
        shm.close(unlink: true)
    }

    func testRecreateReplacesStaleSegment() throws {
        let name = uniqueBase("s")
        let fd = ausm_shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0o644)
        _ = ftruncate(fd, 8); close(fd)
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: name, frameCount: 1, frameWidth: 2, frameHeight: 2))
        defer { shm.close(unlink: true) }
        XCTAssertEqual(shmMode(name), 0o600, "a stale world-readable segment is replaced, not reused")
    }
}

final class CameraRegistryTests: XCTestCase {
    func testAddRemoveAndRegistryEntries() throws {
        let base = uniqueBase("a")
        let m = MultiDisplayShmManager()
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 2))
        XCTAssertEqual(m.registryShmName, base + "-registry")
        XCTAssertEqual(shmMode(base + "-registry"), 0o600)
        XCTAssertTrue(m.addDisplay("0x1424000005ac8600", width: 4, height: 2, logicalWidth: 4, logicalHeight: 2))
        XCTAssertTrue(m.addDisplay("FaceTime HD 📷", width: 4, height: 2))
        XCTAssertTrue(m.addDisplay("0x1424000005ac8600", width: 8, height: 8), "duplicate add is idempotent")
        XCTAssertEqual(Set(m.getActiveDisplays()), ["0x1424000005ac8600", "FaceTime HD 📷"])
        XCTAssertTrue(m.isDisplayActive("FaceTime HD 📷"))
        XCTAssertTrue(shmExists(base + "-0"))
        XCTAssertTrue(shmExists(base + "-1"))

        try withMapping(base + "-registry", size: ShmMath.registrySize) { mem in
            XCTAssertEqual(mem.load(fromByteOffset: RegistryHeaderLayout.magic, as: UInt32.self), REGISTRY_MAGIC)
            XCTAssertEqual(mem.load(fromByteOffset: RegistryHeaderLayout.activeCount, as: UInt32.self), 2)
            let e1 = mem + RegistryHeaderLayout.totalSize + DisplayEntryLayout.totalSize
            XCTAssertEqual(readFixedCString(e1 + DisplayEntryLayout.displayId, maxLength: 64), "FaceTime HD 📷")
            XCTAssertEqual(readFixedCString(e1 + DisplayEntryLayout.shmName, maxLength: 128), base + "-1")
        }

        m.removeDisplay("FaceTime HD 📷", destroyShm: true)
        XCTAssertFalse(m.isDisplayActive("FaceTime HD 📷"))
        XCTAssertFalse(shmExists(base + "-1"))
        try withMapping(base + "-registry", size: ShmMath.registrySize) { mem in
            XCTAssertEqual(mem.load(fromByteOffset: RegistryHeaderLayout.activeCount, as: UInt32.self), 1)
        }
        m.removeDisplay("unknown")   // no-op
        m.shutdown()
        XCTAssertFalse(shmExists(base + "-registry"))
        XCTAssertFalse(shmExists(base + "-0"))
        m.shutdown()
    }

    func testAtMostEightDevicesAndSlotReuse() {
        let base = uniqueBase("f")
        let m = MultiDisplayShmManager()
        defer { m.shutdown() }
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 2))
        for i in 0..<Int(MAX_DISPLAYS) { XCTAssertTrue(m.addDisplay("cam\(i)", width: 2, height: 2)) }
        XCTAssertFalse(m.addDisplay("cam-extra", width: 2, height: 2))
        m.removeDisplay("cam5", destroyShm: true)
        XCTAssertTrue(m.addDisplay("cam-extra", width: 2, height: 2))
        XCTAssertTrue(shmExists(base + "-5"), "the new device takes the freed slot")
    }

    func testWriteFrameUpdatesStatsAndUnknownDeviceFails() throws {
        let base = uniqueBase("w")
        let m = MultiDisplayShmManager()
        defer { m.shutdown() }
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 2))
        XCTAssertTrue(m.addDisplay("cam", width: 2, height: 2))
        let px = [UInt8](repeating: 3, count: 16)
        px.withUnsafeBufferPointer { b in
            XCTAssertEqual(m.writeFrame(displayId: "nope", timestamp: 1, data: b.baseAddress!, width: 2, height: 2, bytesPerRow: 8), -1)
            XCTAssertEqual(m.writeFrame(displayId: "cam", timestamp: 500, data: b.baseAddress!, width: 2, height: 2, bytesPerRow: 8), 0)
            XCTAssertEqual(m.writeFrame(displayId: "cam", timestamp: 600, data: b.baseAddress!, width: 9, height: 9, bytesPerRow: 36), -1)
        }
        try withMapping(base + "-registry", size: ShmMath.registrySize) { mem in
            let e0 = mem + RegistryHeaderLayout.totalSize
            XCTAssertEqual(e0.load(fromByteOffset: DisplayEntryLayout.lastFrameTime, as: UInt64.self), 500)
            XCTAssertEqual(e0.load(fromByteOffset: DisplayEntryLayout.frameCount, as: UInt64.self), 1)
        }
    }

    func testReinitializeWithOtherBaseReleasesOldSegmentsAndSameBaseReuses() {
        let a = uniqueBase("x"), b = uniqueBase("y")
        let m = MultiDisplayShmManager()
        XCTAssertTrue(m.initialize(baseName: a, framesPerDisplay: 2))
        XCTAssertTrue(m.addDisplay("cam", width: 2, height: 2))
        XCTAssertTrue(m.initialize(baseName: a, framesPerDisplay: 3))
        XCTAssertEqual(m.getActiveDisplays(), ["cam"], "same base: reused")
        XCTAssertTrue(m.initialize(baseName: b, framesPerDisplay: 2))
        XCTAssertFalse(shmExists(a + "-registry"))
        XCTAssertFalse(shmExists(a + "-0"))
        XCTAssertEqual(m.getActiveDisplays(), [])
        m.shutdown()
        XCTAssertFalse(shmExists(b + "-registry"))
    }

    func testInitializeRemovesLeftoversFromCrashedRun() {
        let base = uniqueBase("k")
        for name in [base + "-registry", base + "-0", base + "-7"] {
            let fd = ausm_shm_open(name, O_CREAT | O_RDWR, 0o600)
            _ = ftruncate(fd, 64); close(fd)
        }
        let m = MultiDisplayShmManager()
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 2))
        XCTAssertFalse(shmExists(base + "-0"))
        XCTAssertFalse(shmExists(base + "-7"))
        m.shutdown()
        MultiDisplayShmManager.unlinkAll(baseName: base)   // nothing left: harmless
    }

    func testAddBeforeInitializeFails() {
        let m = MultiDisplayShmManager()
        XCTAssertFalse(m.addDisplay("cam", width: 2, height: 2))
        let px = [UInt8](repeating: 0, count: 16)
        px.withUnsafeBufferPointer {
            XCTAssertEqual(m.writeFrame(displayId: "cam", timestamp: 0, data: $0.baseAddress!, width: 2, height: 2, bytesPerRow: 8), -1)
        }
        XCTAssertEqual(m.getActiveDisplays(), [])
    }

    func testOverlongDeviceIdIsTruncatedInRegistry() throws {
        let base = uniqueBase("l")
        let m = MultiDisplayShmManager()
        defer { m.shutdown() }
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 1))
        let long = String(repeating: "u", count: 100)
        XCTAssertTrue(m.addDisplay(long, width: 2, height: 2))
        try withMapping(base + "-registry", size: ShmMath.registrySize) { mem in
            let id = readFixedCString(mem + RegistryHeaderLayout.totalSize + DisplayEntryLayout.displayId, maxLength: 64)
            XCTAssertEqual(id.utf8.count, 63)
        }
        XCTAssertTrue(m.isDisplayActive(long))
    }
}

final class CameraConfigValueEdgeTests: XCTestCase {
    func testBooleansAreNotNumbers() throws {
        // Regression: {"fps": true} was accepted as 1 fps and {"jpegQuality": true} as 1.0.
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(#"{"fps":true,"q":false}"#.utf8)) as? [String: Any])
        XCTAssertNil(ConfigValue.int(obj["fps"]))
        XCTAssertNil(ConfigValue.clamped(obj["fps"], to: ConfigValue.fpsRange))
        XCTAssertEqual(ConfigValue.jpegQuality(obj["q"]), 0.7)
        XCTAssertNil(ConfigValue.int(true))
    }

    func testIntParsing() {
        XCTAssertEqual(ConfigValue.int(Int.max), Int.max)
        XCTAssertEqual(ConfigValue.clamped(Int.max, to: ConfigValue.fpsRange), 60)
        XCTAssertEqual(ConfigValue.clamped(Int.min, to: ConfigValue.fpsRange), 1)
        XCTAssertNil(ConfigValue.int(1e10), "absurd doubles are rejected")
        XCTAssertNil(ConfigValue.int(-Double.infinity))
        XCTAssertEqual(ConfigValue.int(-2.9), -2)
        XCTAssertNil(ConfigValue.int(NSNull()))
        XCTAssertNil(ConfigValue.int([1]))
    }

    func testJpegQualityEdges() {
        XCTAssertEqual(ConfigValue.jpegQuality(Double.nan), 0.7)
        XCTAssertEqual(ConfigValue.jpegQuality(Double.infinity), 0.7)
        XCTAssertEqual(ConfigValue.jpegQuality(0), 0.05)
        XCTAssertEqual(ConfigValue.jpegQuality(1), 1.0)
        XCTAssertEqual(ConfigValue.jpegQuality("0.5"), 0.7)
        XCTAssertEqual(ConfigValue.jpegQuality(NSNumber(value: 0.25)), 0.25)
    }

    func testFixedCStringMultibyteAndEmpty() {
        var buf = [UInt8](repeating: 0xAA, count: 5)
        buf.withUnsafeMutableBytes { raw in
            writeFixedCString("📷📷", to: raw.baseAddress!, maxLength: 5)   // 4 of 8 bytes fit
            XCTAssertEqual(readFixedCString(raw.baseAddress!, maxLength: 5), "📷")
            writeFixedCString("", to: raw.baseAddress!, maxLength: 5)
            XCTAssertEqual(readFixedCString(raw.baseAddress!, maxLength: 5), "")
        }
    }
}

final class CameraSocketTests: XCTestCase {
    private func tempPath(_ tag: String) -> String {
        let p = "/tmp/ausm-ct-\(getpid())-\(tag)-\(Int.random(in: 0..<1_000_000)).sock"
        addTeardownBlock { unlink(p) }
        return p
    }

    func testBindCreatesOwnerOnlySocketAndReplacesStaleSocket() {
        let path = tempPath("b")
        let fd1 = bindPrivateUnixSocket(path: path)
        XCTAssertGreaterThanOrEqual(fd1, 0)
        var st = stat()
        XCTAssertEqual(lstat(path, &st), 0)
        XCTAssertEqual(st.st_mode & S_IFMT, S_IFSOCK)
        XCTAssertEqual(st.st_mode & 0o777, 0o600)
        close(fd1)
        let fd2 = bindPrivateUnixSocket(path: path)
        XCTAssertGreaterThanOrEqual(fd2, 0, "stale socket from a crashed run is replaced")
        close(fd2)
    }

    func testBindNeverDeletesARegularFile() {
        // Regression: the path was unlink()ed unconditionally, so a misconfigured socketPath
        // pointing at a user's file deleted it.
        let path = tempPath("f")
        FileManager.default.createFile(atPath: path, contents: Data("precious".utf8))
        XCTAssertEqual(bindPrivateUnixSocket(path: path), -1)
        XCTAssertEqual(errno, EEXIST)
        XCTAssertEqual(FileManager.default.contents(atPath: path), Data("precious".utf8))
    }

    func testBindRejectsEmptyPathAndMaxLengthBoundary() {
        XCTAssertEqual(bindPrivateUnixSocket(path: ""), -1)
        let over = "/tmp/" + String(repeating: "y", count: maxUnixSocketPathLength - 4)
        XCTAssertEqual(over.utf8.count, maxUnixSocketPathLength + 1)
        XCTAssertEqual(bindPrivateUnixSocket(path: over), -1)
        XCTAssertEqual(errno, ENAMETOOLONG)
    }

    func testNotificationServerRefusesRegularFileAndCleansUpItsSocket() {
        let file = tempPath("n")
        FileManager.default.createFile(atPath: file, contents: Data("keep".utf8))
        let refused = NotificationServer()
        XCTAssertFalse(refused.start(socketPath: file))
        refused.stop()
        XCTAssertEqual(FileManager.default.contents(atPath: file), Data("keep".utf8))

        let path = tempPath("s")
        let server = NotificationServer()
        XCTAssertTrue(server.start(socketPath: path))
        server.sendNotification(["type": "device_change", "deviceId": "📷"])   // no clients: no-op
        server.sendNotification(["bad": Date()])
        server.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        server.stop()
    }

    func testConfigureClientSocketPreventsSIGPIPE() {
        var fds: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
        configureClientSocket(fds[0], timeoutSeconds: 1)
        close(fds[1])
        let bytes = [UInt8](repeating: 1, count: 64)
        let n = bytes.withUnsafeBytes { write(fds[0], $0.baseAddress, $0.count) }
        XCTAssertEqual(n, -1)
        XCTAssertEqual(errno, EPIPE)
        close(fds[0])
    }
}
