import XCTest
import CHelpers
@testable import ScreenCaptureHelper

final class SharedMemoryTests: XCTestCase {
    private static var counter = 0
    private func uniqueName(_ tag: String) -> String {
        Self.counter += 1
        return "/ausmt\(tag)\(getpid() % 100_000)-\(Self.counter)"
    }

    private func modeOf(_ name: String) -> mode_t? {
        let fd = ausm_shm_open(name, O_RDONLY, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var sb = stat()
        guard fstat(fd, &sb) == 0 else { return nil }
        return sb.st_mode & 0o777
    }

    private func exists(_ name: String) -> Bool {
        let fd = ausm_shm_open(name, O_RDONLY, 0)
        if fd >= 0 { close(fd); return true }
        return false
    }

    func testCreateWritesHeaderWithOwnerOnlyPermissions() throws {
        let name = uniqueName("h")
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: name, frameCount: 3, frameWidth: 4, frameHeight: 2))
        defer { shm.close(unlink: true) }

        XCTAssertEqual(modeOf(name), 0o600)

        let mem = try XCTUnwrap(shm.rawMemory)
        XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.magic, as: UInt32.self), SHM_MAGIC)
        XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.version, as: UInt32.self), SHM_VERSION)
        XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.frameCount, as: UInt32.self), 3)
        XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.frameSize, as: UInt32.self), 4 * 2 * 4)
        XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.width, as: UInt32.self), 4)
        XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.height, as: UInt32.self), 2)
        XCTAssertNotEqual(mem.load(fromByteOffset: ShmHeaderLayout.generation, as: UInt64.self), 0)

        // A consumer can open and validate it.
        let reader = SharedMemoryManager()
        XCTAssertTrue(reader.open(name: name))
        reader.close(unlink: false)
    }

    func testWriteFrameStripsStrideAndPublishes() throws {
        let name = uniqueName("w")
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: name, frameCount: 2, frameWidth: 2, frameHeight: 2))
        defer { shm.close(unlink: true) }

        // 2x2 BGRA with 4 bytes of row padding (bytesPerRow = 12).
        let src: [UInt8] = [1, 2, 3, 4, 5, 6, 7, 8, 0xEE, 0xEE, 0xEE, 0xEE,
                            9, 10, 11, 12, 13, 14, 15, 16, 0xEE, 0xEE, 0xEE, 0xEE]
        let idx = src.withUnsafeBufferPointer {
            shm.writeFrame(displayId: 0, timestamp: 42, data: $0.baseAddress!, width: 2, height: 2, bytesPerRow: 12)
        }
        XCTAssertEqual(idx, 0)

        let mem = try XCTUnwrap(shm.rawMemory)
        let slot = ShmMath.slotOffset(index: 0, frameDataSize: 16)
        XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.ready, as: UInt32.self), 1)
        XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.timestamp, as: UInt64.self), 42)
        XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.frameNumber, as: UInt64.self), 0)
        XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.byteLength, as: UInt32.self), 16)
        let pixels = Array(UnsafeRawBufferPointer(start: mem + slot + FrameHeaderLayout.totalSize, count: 16))
        XCTAssertEqual(pixels, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])

        // Ring wraps; frame numbers keep increasing.
        for _ in 0..<2 {
            _ = src.withUnsafeBufferPointer {
                shm.writeFrame(displayId: 0, timestamp: 43, data: $0.baseAddress!, width: 2, height: 2, bytesPerRow: 12)
            }
        }
        XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.writeIndex, as: UInt32.self), 3)
        XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.frameNumber, as: UInt64.self), 3)
        XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.frameNumber, as: UInt64.self), 2)
    }

    func testWriteFrameRejectsOversizedOrBadStride() {
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: uniqueName("r"), frameCount: 1, frameWidth: 2, frameHeight: 2))
        defer { shm.close(unlink: true) }
        let big = [UInt8](repeating: 0, count: 4 * 4 * 4)
        big.withUnsafeBufferPointer { buf in
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 0, data: buf.baseAddress!, width: 4, height: 4, bytesPerRow: 16), -1)
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 0, data: buf.baseAddress!, width: 2, height: 2, bytesPerRow: 4), -1)
        }
    }

    func testCreateRejectsInvalidGeometryAndNames() {
        let shm = SharedMemoryManager()
        XCTAssertFalse(shm.create(name: uniqueName("g"), frameCount: 0, frameWidth: 2, frameHeight: 2))
        XCTAssertFalse(shm.create(name: "/" + String(repeating: "n", count: 40), frameCount: 1, frameWidth: 2, frameHeight: 2))
        XCTAssertFalse(shm.isOpen)
    }

    func testCloseUnlinks() {
        let name = uniqueName("c")
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: name, frameCount: 1, frameWidth: 2, frameHeight: 2))
        XCTAssertTrue(exists(name))
        shm.close(unlink: true)
        XCTAssertFalse(exists(name))
    }

    func testRegistryLifecycleAndStaleCleanup() throws {
        let base = "/ausmt\(getpid() % 100_000)"
        let registryName = base + "-registry"

        let first = MultiDisplayShmManager()
        XCTAssertTrue(first.initialize(baseName: base, framesPerDisplay: 2))
        XCTAssertEqual(modeOf(registryName), 0o600)
        XCTAssertTrue(first.addDisplay("display-1", width: 4, height: 2, logicalWidth: 2, logicalHeight: 1))
        XCTAssertTrue(first.addDisplay("display-2", width: 4, height: 2))
        XCTAssertEqual(Set(first.getActiveDisplays()), ["display-1", "display-2"])

        // Verify the entry encoding via a raw read-only mapping.
        let fd = ausm_shm_open(registryName, O_RDONLY, 0)
        XCTAssertGreaterThanOrEqual(fd, 0)
        let mem = try XCTUnwrap(mmap(nil, ShmMath.registrySize, PROT_READ, MAP_SHARED, fd, 0))
        XCTAssertEqual(mem.load(fromByteOffset: RegistryHeaderLayout.magic, as: UInt32.self), REGISTRY_MAGIC)
        XCTAssertEqual(mem.load(fromByteOffset: RegistryHeaderLayout.activeCount, as: UInt32.self), 2)
        let entry = mem + RegistryHeaderLayout.totalSize
        XCTAssertEqual(MultiDisplayShmManager.readString(entry + DisplayEntryLayout.shmName,
                                                         capacity: DisplayEntryLayout.shmNameSize),
                       base + "-display-1")
        XCTAssertEqual(entry.load(fromByteOffset: DisplayEntryLayout.logicalHeight, as: UInt32.self), 1)
        munmap(mem, ShmMath.registrySize)
        close(fd)

        first.removeDisplay("display-2")
        XCTAssertEqual(first.getActiveDisplays(), ["display-1"])

        // Simulate a crash: unlink nothing, then a new helper initializes the
        // same base name. Segments listed in the old registry are removed.
        XCTAssertTrue(exists(base + "-display-1"))
        MultiDisplayShmManager.unlinkStaleSegments(registryName: registryName, baseName: base)
        XCTAssertFalse(exists(base + "-display-1"))

        first.shutdown()
        XCTAssertFalse(exists(registryName))
    }

    func testFixedStringFieldsAreBoundedAndTerminated() {
        var buf = [UInt8](repeating: 0xFF, count: 8)
        buf.withUnsafeMutableBytes { raw in
            MultiDisplayShmManager.writeString("display-12345", to: raw.baseAddress!, capacity: 8)
            XCTAssertEqual(MultiDisplayShmManager.readString(raw.baseAddress!, capacity: 8), "display")
        }
        XCTAssertEqual(buf[7], 0)
        // No terminator at all: reading stays within capacity.
        let full = [UInt8](repeating: 0x41, count: 4)
        full.withUnsafeBytes { raw in
            XCTAssertEqual(MultiDisplayShmManager.readString(raw.baseAddress!, capacity: 4), "AAAA")
        }
    }
}
