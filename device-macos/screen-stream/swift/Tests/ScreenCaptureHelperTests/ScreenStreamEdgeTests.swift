import XCTest
import CHelpers
@testable import ScreenCaptureHelper

private var nameCounter = 0
/// Short, process-unique POSIX shm base names (macOS limits names to 31 bytes).
private func uniqueBase(_ tag: String) -> String {
    nameCounter += 1
    return "/ausme\(tag)\(getpid() % 10_000)\(nameCounter)"
}

private func shmExists(_ name: String) -> Bool {
    let fd = ausm_shm_open(name, O_RDONLY, 0)
    if fd >= 0 { close(fd); return true }
    return false
}

/// Read-only raw view of a registry for assertions.
private func withRegistry(_ name: String, _ body: (UnsafeRawPointer) -> Void) throws {
    let fd = ausm_shm_open(name, O_RDONLY, 0)
    XCTAssertGreaterThanOrEqual(fd, 0)
    defer { close(fd) }
    let mem = try XCTUnwrap(mmap(nil, ShmMath.registrySize, PROT_READ, MAP_SHARED, fd, 0))
    defer { munmap(mem, ShmMath.registrySize) }
    body(UnsafeRawPointer(mem))
}

final class MultiDisplayShmEdgeTests: XCTestCase {
    private let pixels = [UInt8](repeating: 7, count: 4 * 2 * 4)

    func testRetainedSegmentIsUnlinkedAtShutdown() {
        // Regression: restartDisplayCapture removes a display without destroying its segment;
        // if the restart then failed, shutdown() never unlinked it and the last screen frame
        // stayed readable in shared memory until reboot.
        let base = uniqueBase("r")
        let m = MultiDisplayShmManager()
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 2))
        XCTAssertTrue(m.addDisplay("display-1", width: 4, height: 2))
        m.removeDisplay("display-1")                       // destroyShm: false
        XCTAssertTrue(shmExists(base + "-display-1"), "kept for a quick re-add")
        m.shutdown()
        XCTAssertFalse(shmExists(base + "-display-1"))
        XCTAssertFalse(shmExists(base + "-registry"))
    }

    func testReAddedSegmentIsNotDoubleTracked() {
        let base = uniqueBase("a")
        let m = MultiDisplayShmManager()
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 2))
        XCTAssertTrue(m.addDisplay("display-1", width: 4, height: 2))
        m.removeDisplay("display-1")
        XCTAssertTrue(m.addDisplay("display-1", width: 4, height: 2))
        m.removeDisplay("display-1", destroyShm: true)
        XCTAssertFalse(shmExists(base + "-display-1"))
        m.shutdown()
    }

    func testReinitializeWithNewBaseNameReleasesPreviousSegments() {
        // Regression: initialize() with a different base name overwrote the registry mapping
        // without unmapping/unlinking it, and kept serving the old per-display segments.
        let a = uniqueBase("x"), b = uniqueBase("y")
        let m = MultiDisplayShmManager()
        XCTAssertTrue(m.initialize(baseName: a, framesPerDisplay: 2))
        XCTAssertTrue(m.addDisplay("display-1", width: 4, height: 2))
        XCTAssertTrue(m.initialize(baseName: b, framesPerDisplay: 2))
        XCTAssertFalse(shmExists(a + "-registry"))
        XCTAssertFalse(shmExists(a + "-display-1"))
        XCTAssertTrue(shmExists(b + "-registry"))
        XCTAssertEqual(m.getActiveDisplays(), [])
        XCTAssertTrue(m.addDisplay("display-1", width: 4, height: 2))
        XCTAssertTrue(shmExists(b + "-display-1"))
        m.shutdown()
        XCTAssertFalse(shmExists(b + "-registry"))
        XCTAssertFalse(shmExists(b + "-display-1"))
    }

    func testReinitializeSameBaseKeepsDisplays() {
        let base = uniqueBase("s")
        let m = MultiDisplayShmManager()
        defer { m.shutdown() }
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 2))
        XCTAssertTrue(m.addDisplay("display-1", width: 4, height: 2))
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 3))
        XCTAssertEqual(m.getActiveDisplays(), ["display-1"])
    }

    func testAddBeforeInitializeAndAfterShutdownFails() {
        let m = MultiDisplayShmManager()
        XCTAssertFalse(m.addDisplay("display-1", width: 4, height: 2))
        XCTAssertEqual(m.getActiveDisplays(), [])
        let base = uniqueBase("b")
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 2))
        m.shutdown()
        XCTAssertFalse(m.addDisplay("display-1", width: 4, height: 2))
        XCTAssertEqual(m.getActiveDisplays(), [])
        m.shutdown()  // idempotent
        m.removeDisplay("display-1")
    }

    func testInvalidBaseNamesAreRejected() {
        let m = MultiDisplayShmManager()
        XCTAssertFalse(m.initialize(baseName: "no-slash"))
        XCTAssertFalse(m.initialize(baseName: "/" + String(repeating: "z", count: 30)))
        XCTAssertFalse(m.initialize(baseName: "/a/b"))
    }

    func testDuplicateAddIsIdempotent() throws {
        let base = uniqueBase("d")
        let m = MultiDisplayShmManager()
        defer { m.shutdown() }
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 2))
        XCTAssertTrue(m.addDisplay("display-1", width: 4, height: 2))
        XCTAssertTrue(m.addDisplay("display-1", width: 8, height: 8))
        try withRegistry(base + "-registry") { mem in
            XCTAssertEqual(mem.load(fromByteOffset: RegistryHeaderLayout.activeCount, as: UInt32.self), 1)
            let entry = mem + RegistryHeaderLayout.totalSize
            XCTAssertEqual(entry.load(fromByteOffset: DisplayEntryLayout.width, as: UInt32.self), 4,
                           "a duplicate add does not resize the live segment")
        }
    }

    func testRegistryHoldsAtMostEightDisplays() {
        let base = uniqueBase("f")
        let m = MultiDisplayShmManager()
        defer { m.shutdown() }
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 1))
        for i in 0..<Int(MAX_DISPLAYS) { XCTAssertTrue(m.addDisplay("d\(i)", width: 2, height: 2)) }
        XCTAssertFalse(m.addDisplay("d-extra", width: 2, height: 2))
        XCTAssertEqual(m.getActiveDisplays().count, Int(MAX_DISPLAYS))
        // Freeing a slot makes room again, and the new display takes the freed slot.
        m.removeDisplay("d3", destroyShm: true)
        XCTAssertTrue(m.addDisplay("d-extra", width: 2, height: 2))
        XCTAssertEqual(Set(m.getActiveDisplays()).count, Int(MAX_DISPLAYS))
    }

    func testRemovedDisplayReusesItsOldSlot() throws {
        let base = uniqueBase("o")
        let m = MultiDisplayShmManager()
        defer { m.shutdown() }
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 1))
        XCTAssertTrue(m.addDisplay("a", width: 2, height: 2))
        XCTAssertTrue(m.addDisplay("b", width: 2, height: 2))
        m.removeDisplay("a", destroyShm: true)
        m.removeDisplay("b", destroyShm: true)
        XCTAssertTrue(m.addDisplay("b", width: 2, height: 2))
        try withRegistry(base + "-registry") { mem in
            let slot1 = mem + RegistryHeaderLayout.totalSize + DisplayEntryLayout.totalSize
            XCTAssertEqual(MultiDisplayShmManager.readString(slot1 + DisplayEntryLayout.displayId, capacity: 64), "b")
            XCTAssertEqual(slot1.load(fromByteOffset: DisplayEntryLayout.active, as: UInt32.self), 1)
            XCTAssertEqual(mem.load(fromByteOffset: RegistryHeaderLayout.activeCount, as: UInt32.self), 1)
        }
    }

    func testOverlongOrInvalidDisplayIdsAreRejected() {
        let base = uniqueBase("l")
        let m = MultiDisplayShmManager()
        defer { m.shutdown() }
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 1))
        XCTAssertFalse(m.addDisplay(String(repeating: "i", count: 64), width: 2, height: 2))
        XCTAssertFalse(m.addDisplay("has/slash", width: 2, height: 2), "segment name must stay a valid shm name")
        XCTAssertFalse(m.addDisplay("display-123456789012345", width: 2, height: 2), "segment name over 31 bytes")
        XCTAssertFalse(m.addDisplay("zero", width: 0, height: 2))
        XCTAssertEqual(m.getActiveDisplays(), [])
    }

    func testWriteFrameUpdatesRegistryStatsAndRejectsUnknownDisplay() throws {
        let base = uniqueBase("w")
        let m = MultiDisplayShmManager()
        defer { m.shutdown() }
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 2))
        XCTAssertTrue(m.addDisplay("display-1", width: 4, height: 2))
        pixels.withUnsafeBufferPointer { buf in
            XCTAssertEqual(m.writeFrame(displayId: "nope", timestamp: 1, data: buf.baseAddress!, width: 4, height: 2, bytesPerRow: 16), -1)
            XCTAssertEqual(m.writeFrame(displayId: "display-1", timestamp: 111, data: buf.baseAddress!, width: 4, height: 2, bytesPerRow: 16), 0)
            XCTAssertEqual(m.writeFrame(displayId: "display-1", timestamp: 222, data: buf.baseAddress!, width: 4, height: 2, bytesPerRow: 16), 1)
            XCTAssertEqual(m.writeFrame(displayId: "display-1", timestamp: 333, data: buf.baseAddress!, width: 8, height: 8, bytesPerRow: 32), -1)
        }
        try withRegistry(base + "-registry") { mem in
            let entry = mem + RegistryHeaderLayout.totalSize
            XCTAssertEqual(entry.load(fromByteOffset: DisplayEntryLayout.lastFrameTime, as: UInt64.self), 222)
            XCTAssertEqual(entry.load(fromByteOffset: DisplayEntryLayout.frameCount, as: UInt64.self), 2,
                           "rejected frames are not counted")
        }
        m.removeDisplay("display-1", destroyShm: true)
        pixels.withUnsafeBufferPointer { buf in
            XCTAssertEqual(m.writeFrame(displayId: "display-1", timestamp: 4, data: buf.baseAddress!, width: 4, height: 2, bytesPerRow: 16), -1)
        }
    }

    func testStaleCleanupNeverUnlinksForeignNames() throws {
        // A registry entry naming a segment outside our base prefix (corrupt or hostile) must
        // not make us unlink it.
        let base = uniqueBase("c")
        let foreign = uniqueBase("v")
        let other = SharedMemoryManager()
        XCTAssertTrue(other.create(name: foreign, frameCount: 1, frameWidth: 2, frameHeight: 2))
        defer { other.close(unlink: true) }

        let m = MultiDisplayShmManager()
        XCTAssertTrue(m.initialize(baseName: base, framesPerDisplay: 1))
        // Overwrite slot 0's shmName with the foreign name through a writable mapping.
        let fd = ausm_shm_open(base + "-registry", O_RDWR, 0)
        let mem = try XCTUnwrap(mmap(nil, ShmMath.registrySize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0))
        MultiDisplayShmManager.writeString(foreign, to: mem + RegistryHeaderLayout.totalSize + DisplayEntryLayout.shmName,
                                           capacity: DisplayEntryLayout.shmNameSize)
        munmap(mem, ShmMath.registrySize); close(fd)

        MultiDisplayShmManager.unlinkStaleSegments(registryName: base + "-registry", baseName: base)
        XCTAssertTrue(shmExists(foreign))
        m.shutdown()
    }

    func testStaleCleanupToleratesMissingOrGarbageRegistry() {
        MultiDisplayShmManager.unlinkStaleSegments(registryName: uniqueBase("m") + "-registry", baseName: "/x")
        let junk = uniqueBase("j")
        let fd = ausm_shm_open(junk, O_CREAT | O_EXCL | O_RDWR, 0o600)
        XCTAssertGreaterThanOrEqual(fd, 0)
        _ = ftruncate(fd, 16)    // smaller than a registry
        close(fd)
        MultiDisplayShmManager.unlinkStaleSegments(registryName: junk, baseName: "/x")
        shm_unlink(junk)
    }

    func testFixedStringsWithMultibyteUTF8() {
        var buf = [UInt8](repeating: 0xAA, count: 6)
        buf.withUnsafeMutableBytes { raw in
            // "é" is 2 bytes; truncation may split it, reading must still not trap.
            MultiDisplayShmManager.writeString("éééé", to: raw.baseAddress!, capacity: 6)
            let s = MultiDisplayShmManager.readString(raw.baseAddress!, capacity: 6)
            XCTAssertTrue(s.hasPrefix("éé"))
            MultiDisplayShmManager.writeString("", to: raw.baseAddress!, capacity: 6)
            XCTAssertEqual(MultiDisplayShmManager.readString(raw.baseAddress!, capacity: 6), "")
        }
    }
}

final class SharedMemoryEdgeTests: XCTestCase {
    func testOpenRejectsMissingSmallAndForeignSegments() {
        let reader = SharedMemoryManager()
        XCTAssertFalse(reader.open(name: uniqueBase("n")))

        let small = uniqueBase("t")
        var fd = ausm_shm_open(small, O_CREAT | O_EXCL | O_RDWR, 0o600)
        _ = ftruncate(fd, 16); close(fd)
        XCTAssertFalse(reader.open(name: small))
        shm_unlink(small)

        let foreign = uniqueBase("g")
        fd = ausm_shm_open(foreign, O_CREAT | O_EXCL | O_RDWR, 0o600)
        _ = ftruncate(fd, off_t(ShmHeaderLayout.totalSize + 64)); close(fd)   // zeroed: wrong magic
        XCTAssertFalse(reader.open(name: foreign))
        shm_unlink(foreign)
        XCTAssertFalse(reader.isOpen)
    }

    func testReaderCannotWriteAndCloseDoesNotUnlink() {
        let name = uniqueBase("p")
        let owner = SharedMemoryManager()
        XCTAssertTrue(owner.create(name: name, frameCount: 1, frameWidth: 2, frameHeight: 2))
        defer { owner.close(unlink: true) }
        let reader = SharedMemoryManager()
        XCTAssertTrue(reader.open(name: name))
        let px = [UInt8](repeating: 1, count: 16)
        px.withUnsafeBufferPointer {
            XCTAssertEqual(reader.writeFrame(displayId: 0, timestamp: 0, data: $0.baseAddress!, width: 2, height: 2, bytesPerRow: 8), -1)
        }
        reader.close(unlink: true)        // not the owner: must not unlink
        XCTAssertTrue(shmExists(name))
    }

    func testPackedWriteSmallerFrameAndZeroSize() throws {
        let name = uniqueBase("k")
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: name, frameCount: 1, frameWidth: 4, frameHeight: 4))
        defer { shm.close(unlink: true) }
        let px = (0..<(2 * 2 * 4)).map { UInt8($0) }
        try px.withUnsafeBufferPointer { buf in
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 5, data: buf.baseAddress!, width: 2, height: 2, bytesPerRow: 8), 0)
            let mem = try XCTUnwrap(shm.rawMemory)
            let slot = ShmMath.slotOffset(index: 0, frameDataSize: 64)
            XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.width, as: UInt32.self), 2)
            XCTAssertEqual(mem.load(fromByteOffset: slot + FrameHeaderLayout.byteLength, as: UInt32.self), 16)
            XCTAssertEqual(Array(UnsafeRawBufferPointer(start: mem + slot + FrameHeaderLayout.totalSize, count: 16)), px)
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 5, data: buf.baseAddress!, width: 0, height: 2, bytesPerRow: 8), -1)
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 5, data: buf.baseAddress!, width: 2, height: 0, bytesPerRow: 8), -1)
        }
    }

    func testWriteAfterCloseFails() {
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: uniqueBase("q"), frameCount: 1, frameWidth: 2, frameHeight: 2))
        shm.close(unlink: true)
        let px = [UInt8](repeating: 0, count: 16)
        px.withUnsafeBufferPointer {
            XCTAssertEqual(shm.writeFrame(displayId: 0, timestamp: 0, data: $0.baseAddress!, width: 2, height: 2, bytesPerRow: 8), -1)
        }
        shm.close(unlink: true)  // double close
    }

    func testRecreateReplacesPreviousSegment() throws {
        let a = uniqueBase("e"), b = uniqueBase("f")
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: a, frameCount: 1, frameWidth: 2, frameHeight: 2))
        XCTAssertTrue(shm.create(name: b, frameCount: 2, frameWidth: 4, frameHeight: 4))
        defer { shm.close(unlink: true) }
        XCTAssertFalse(shmExists(a), "the first segment is unlinked when the manager is re-used")
        XCTAssertEqual(shm.shmName, b)
        let mem = try XCTUnwrap(shm.rawMemory)
        XCTAssertEqual(mem.load(fromByteOffset: ShmHeaderLayout.frameCount, as: UInt32.self), 2)
    }

    func testCreateOverStaleSegmentWithSameName() {
        let name = uniqueBase("z")
        let fd = ausm_shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0o644)
        _ = ftruncate(fd, 8); close(fd)
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: name, frameCount: 1, frameWidth: 2, frameHeight: 2))
        defer { shm.close(unlink: true) }
        let reader = SharedMemoryManager()
        XCTAssertTrue(reader.open(name: name), "the stale segment was replaced, not reused")
        reader.close(unlink: false)
    }

    func testGenerationChangesAcrossRecreate() throws {
        let name = uniqueBase("h")
        let shm = SharedMemoryManager()
        XCTAssertTrue(shm.create(name: name, frameCount: 1, frameWidth: 2, frameHeight: 2))
        let g1 = try XCTUnwrap(shm.rawMemory).load(fromByteOffset: ShmHeaderLayout.generation, as: UInt64.self)
        usleep(2000)
        XCTAssertTrue(shm.create(name: name, frameCount: 1, frameWidth: 2, frameHeight: 2))
        defer { shm.close(unlink: true) }
        let g2 = try XCTUnwrap(shm.rawMemory).load(fromByteOffset: ShmHeaderLayout.generation, as: UInt64.self)
        XCTAssertGreaterThan(g2, g1)
    }
}

final class ProtocolEdgeTests: XCTestCase {
    private func parse(_ s: String, eof: Bool = false) -> CommandFraming.Result {
        CommandFraming.parse(Data(s.utf8), eof: eof)
    }

    func testCRLFAndSurroundingWhitespace() {
        guard case .complete(let d) = parse("  {\"command\":\"status\"}\r\n") else { return XCTFail() }
        XCTAssertEqual(d["command"] as? String, "status")
        guard case .invalid = parse("\r\n") else { return XCTFail() }
        guard case .incomplete = parse("   \t") else { return XCTFail() }
    }

    func testBytesAfterFirstNewlineAreIgnored() {
        guard case .complete(let d) = parse("{\"command\":\"a\"}\n{\"command\":\"b\"}\n") else { return XCTFail() }
        XCTAssertEqual(d["command"] as? String, "a")
        guard case .complete = parse("{\"command\":\"a\"}\ngarbage") else { return XCTFail() }
    }

    func testUnicodeAndEmojiValues() {
        guard case .complete(let d) = parse(#"{"displayId":"display-📺","path":"/tmp/שלום/ملف"}"#) else { return XCTFail() }
        XCTAssertEqual(d["displayId"] as? String, "display-📺")
        XCTAssertEqual(d["path"] as? String, "/tmp/שלום/ملف")
    }

    func testSplitMultibyteCharacterIsIncompleteNotInvalid() {
        var data = Data(#"{"a":"é"#.utf8)
        data.removeLast()                 // cut the 2-byte é in half
        guard case .incomplete = CommandFraming.parse(data, eof: false) else { return XCTFail() }
        guard case .invalid = CommandFraming.parse(data, eof: true) else { return XCTFail() }
    }

    func testTrailingGarbageWithoutNewlineWaitsForEof() {
        guard case .incomplete = parse(#"{"a":1}x"#) else { return XCTFail() }
        guard case .invalid = parse(#"{"a":1}x"#, eof: true) else { return XCTFail() }
    }

    func testSizeLimitBoundary() {
        let pad = CommandFraming.maxRequestBytes - #"{"a":""}"#.utf8.count
        let exact = Data(#"{"a":""#.utf8) + Data(repeating: 0x61, count: pad) + Data(#""}"#.utf8)
        XCTAssertEqual(exact.count, CommandFraming.maxRequestBytes)
        guard case .complete = CommandFraming.parse(exact, eof: false) else { return XCTFail() }
        guard case .invalid = CommandFraming.parse(exact + Data([0x0A]), eof: false) else { return XCTFail("one byte over") }
    }

    func testOverflowingNumberIsAnInvalidRequestNotATrap() {
        guard case .invalid = parse("{\"fps\":1e400}\n") else { return XCTFail() }
    }

    func testNonObjectTopLevelValues() {
        for s in ["null\n", "42\n", "true\n", "[]\n"] {
            guard case .invalid = parse(s) else { return XCTFail(s) }
        }
        guard case .complete(let d) = parse("{}\n") else { return XCTFail() }
        XCTAssertTrue(d.isEmpty)
    }

    func testParamStringLimitsCountBytesNotCharacters() {
        XCTAssertEqual(Param.string("😀", maxLength: 4), "😀")
        XCTAssertNil(Param.string("😀", maxLength: 3))
        XCTAssertEqual(Param.string("", maxLength: 0), "")
        XCTAssertNil(Param.string(NSNumber(value: 1)))
        XCTAssertNil(Param.string(NSNull()))
    }

    func testStringArrayLimits() {
        XCTAssertEqual(Param.stringArray([]), [])
        XCTAssertNil(Param.stringArray(Array(repeating: "d", count: 65)))
        XCTAssertNil(Param.stringArray([String(repeating: "x", count: 257)]))
        XCTAssertEqual(Param.stringArray(["a"], maxCount: 1), ["a"])
    }

    func testParamBoolAndIntFromJSON() throws {
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(#"{"t":true,"one":1,"zero":0,"f":1.0}"#.utf8)) as? [String: Any])
        XCTAssertEqual(Param.bool(obj["t"]), true)
        XCTAssertNil(Param.bool(obj["one"]), "1 is not a boolean")
        XCTAssertNil(Param.bool(obj["zero"]))
        XCTAssertNil(Param.int(obj["t"], in: 0...10), "true is not an integer")
        XCTAssertEqual(Param.int(obj["f"], in: 0...10), 1, "1.0 is integral")
        XCTAssertEqual(Param.int(obj["one"], in: 1...1), 1)
    }

    func testConfigUpdateNullsAreIgnoredAndBoolsRejected() {
        let u = CaptureConfigUpdate(["fps": NSNull(), "targetHeight": NSNumber(value: true),
                                     "frameCount": NSNumber(value: 2.5), "enableRecording": NSNumber(value: false),
                                     "outputDirectory": String(repeating: "d", count: 1025)])
        XCTAssertNil(u.fps)
        XCTAssertEqual(u.enableRecording, false)
        XCTAssertEqual(u.rejected, ["frameCount", "outputDirectory", "targetHeight"])
    }

    func testConfigUpdateBoundaries() {
        let lo = CaptureConfigUpdate(["fps": 1, "targetHeight": 0, "frameCount": 1])
        XCTAssertEqual(lo.fps, 1); XCTAssertEqual(lo.targetHeight, 0); XCTAssertEqual(lo.frameCount, 1)
        let hi = CaptureConfigUpdate(["fps": 120, "targetHeight": 16_384, "frameCount": 120])
        XCTAssertEqual(hi.rejected, [])
        let over = CaptureConfigUpdate(["fps": 121, "targetHeight": 16_385, "frameCount": 121])
        XCTAssertEqual(over.rejected, ["fps", "frameCount", "targetHeight"])
        XCTAssertEqual(CaptureConfigUpdate(["sharedMemoryName": "/a/b"]).rejected, ["sharedMemoryName"])
        XCTAssertEqual(CaptureConfigUpdate(["outputDirectory": "/Users/x/Movies/🎬"]).outputDirectory, "/Users/x/Movies/🎬")
        XCTAssertEqual(CaptureConfigUpdate([:]), CaptureConfigUpdate([:]))
    }

    func testCaptureSizeOddTargetsAndExtremeAspect() {
        let s = ShmMath.captureSize(pixelWidth: 3024, pixelHeight: 1964, targetHeight: 721)
        XCTAssertEqual(s.height, 722)
        XCTAssertEqual(s.width % 2, 0)
        let tall = ShmMath.captureSize(pixelWidth: 2, pixelHeight: 10_000, targetHeight: 100)
        XCTAssertGreaterThanOrEqual(tall.width, 2)
        let neg = ShmMath.captureSize(pixelWidth: -5, pixelHeight: -5, targetHeight: 0)
        XCTAssertEqual(neg.width, 2); XCTAssertEqual(neg.height, 2)
    }

    func testShmNameValidationCountsBytes() {
        XCTAssertTrue(ShmMath.isValidShmName("/é"))
        XCTAssertFalse(ShmMath.isValidShmName("/" + String(repeating: "é", count: 16)), "33 bytes")
        XCTAssertTrue(ShmMath.isValidShmName("/" + String(repeating: "é", count: 15)), "31 bytes")
        XCTAssertFalse(ShmMath.isValidShmName(""))
    }
}

final class UnixSocketTests: XCTestCase {
    private func tempPath(_ tag: String) -> String {
        let p = "/tmp/ausm-t-\(getpid())-\(tag)-\(Int.random(in: 0..<1_000_000)).sock"
        addTeardownBlock { unlink(p) }
        return p
    }

    func testListenCreatesOwnerOnlySocketAndReplacesStaleOne() {
        let path = tempPath("l")
        let fd1 = UnixSocket.listen(path: path, tag: "test")
        XCTAssertNotNil(fd1)
        var st = stat()
        XCTAssertEqual(lstat(path, &st), 0)
        XCTAssertEqual(st.st_mode & S_IFMT, S_IFSOCK)
        XCTAssertEqual(st.st_mode & 0o777, 0o600)
        if let fd1 { close(fd1) }       // socket file left behind = stale
        let fd2 = UnixSocket.listen(path: path, tag: "test")
        XCTAssertNotNil(fd2)
        if let fd2 { close(fd2) }
    }

    func testListenRefusesToReplaceRegularFile() {
        let path = tempPath("f")
        FileManager.default.createFile(atPath: path, contents: Data("keep".utf8))
        XCTAssertNil(UnixSocket.listen(path: path, tag: "test"))
        XCTAssertEqual(FileManager.default.contents(atPath: path), Data("keep".utf8))
    }

    func testListenRejectsEmptyAndOverlongPaths() {
        XCTAssertNil(UnixSocket.listen(path: "", tag: "test"))
        XCTAssertNil(UnixSocket.listen(path: "/tmp/" + String(repeating: "x", count: UnixSocket.maxPathLength), tag: "test"))
    }

    func testWriteAllToClosedPeerFailsWithoutSIGPIPE() {
        var fds: [Int32] = [0, 0]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
        UnixSocket.configureClient(fds[0])
        XCTAssertTrue(UnixSocket.writeAll(fds[0], Data("hi\n".utf8)))
        XCTAssertTrue(UnixSocket.writeAll(fds[0], Data()), "empty write is a no-op")
        close(fds[1])
        XCTAssertFalse(UnixSocket.writeAll(fds[0], Data(repeating: 1, count: 1024)))
        close(fds[0])
    }

    func testSockAddrPathTruncatesAndTerminates() {
        var addr = sockaddr_un()
        setSockAddrPath(&addr, String(repeating: "p", count: 300))
        let len = withUnsafeBytes(of: &addr.sun_path) { $0.firstIndex(of: 0) }
        XCTAssertEqual(len, UnixSocket.maxPathLength)
    }

    func testNotificationServerBroadcastsLinesAndCleansUp() throws {
        let path = tempPath("n")
        let server = NotificationServer()
        XCTAssertTrue(server.start(socketPath: path))

        let client = socket(AF_UNIX, SOCK_STREAM, 0)
        defer { close(client) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        setSockAddrPath(&addr, path)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(client, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        XCTAssertEqual(rc, 0)
        UnixSocket.setTimeouts(client, seconds: 2)

        // The accept loop picks the client up asynchronously; resend until it arrives.
        var received = Data()
        let deadline = Date().addingTimeInterval(3)
        var buf = [UInt8](repeating: 0, count: 4096)
        let flags = fcntl(client, F_GETFL, 0)
        _ = fcntl(client, F_SETFL, flags | O_NONBLOCK)
        while !received.contains(UInt8(ascii: "\n")) && Date() < deadline {
            server.sendNotification(["type": "display_change", "displayId": "display-📺", "n": 1])
            usleep(20_000)
            let n = read(client, &buf, buf.count)
            if n > 0 { received.append(contentsOf: buf[0..<n]) }
        }
        let line = try XCTUnwrap(received.split(separator: UInt8(ascii: "\n")).first)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line)) as? [String: Any])
        XCTAssertEqual(obj["displayId"] as? String, "display-📺")

        server.sendNotification(["bad": Date()])     // not JSON-able: dropped, no crash
        server.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        server.sendNotification(["type": "after-stop"])
        server.stop()
    }
}

final class VideoSegmentPathTests: XCTestCase {
    func testSegmentPathIsUniquePerSegment() {
        // Regression: the path used to be fixed `<dir>/<displayId>.mp4` and VideoWriter deleted it on
        // init, so re-adding a display after a reconfigure destroyed the just-finalized recording.
        let date = Date(timeIntervalSince1970: 1_700_000_000.123)
        let first = VideoWriter.segmentPath(directory: "/rec", displayId: "display-1", date: date,
                                            fileExists: { _ in false })
        XCTAssertTrue(first.hasPrefix("/rec/display-1-"))
        XCTAssertTrue(first.hasSuffix(".mp4"))
        XCTAssertNotEqual(first, "/rec/display-1.mp4")

        var taken: Set<String> = [first]
        let second = VideoWriter.segmentPath(directory: "/rec", displayId: "display-1", date: date,
                                             fileExists: { taken.contains($0) })
        XCTAssertEqual(second, String(first.dropLast(4)) + "-1.mp4")
        taken.insert(second)
        let third = VideoWriter.segmentPath(directory: "/rec", displayId: "display-1", date: date,
                                            fileExists: { taken.contains($0) })
        XCTAssertEqual(third, String(first.dropLast(4)) + "-2.mp4")
    }

    func testInitializeDoesNotDeleteExistingFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ausm-vw-\(getpid())-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let existing = dir.appendingPathComponent("display-1.mp4").path
        XCTAssertTrue(FileManager.default.createFile(atPath: existing, contents: Data("keep".utf8)))
        let writer = VideoWriter()
        _ = writer.initialize(outputPath: existing, width: 16, height: 16, fps: 1)
        writer.finalize()
        XCTAssertEqual(FileManager.default.contents(atPath: existing), Data("keep".utf8))
    }
}
