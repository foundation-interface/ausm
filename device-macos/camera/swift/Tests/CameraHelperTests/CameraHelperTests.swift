import XCTest
@testable import CameraHelper

final class ShmLayoutTests: XCTestCase {
    func testHeaderLayoutsAreContiguousAndSized() {
        // Offsets must match screen-stream / screen_stream_reader exactly.
        XCTAssertEqual(ShmHeaderLayout.frameNumber, 32)
        XCTAssertEqual(ShmHeaderLayout.reserved + 4 * 8, ShmHeaderLayout.totalSize)
        XCTAssertEqual(ShmHeaderLayout.totalSize, 72)

        XCTAssertEqual(FrameHeaderLayout.ready, 32)
        XCTAssertEqual(FrameHeaderLayout.reserved + 4, FrameHeaderLayout.totalSize)
        XCTAssertEqual(FrameHeaderLayout.totalSize, 40)

        XCTAssertEqual(RegistryHeaderLayout.reserved + 6 * 4, RegistryHeaderLayout.totalSize)
        XCTAssertEqual(RegistryHeaderLayout.totalSize, 48)

        XCTAssertEqual(DisplayEntryLayout.shmName, 64)
        XCTAssertEqual(DisplayEntryLayout.width, 64 + 128)
        XCTAssertEqual(DisplayEntryLayout.reserved + 3 * 4, DisplayEntryLayout.totalSize)
        XCTAssertEqual(DisplayEntryLayout.totalSize, 240)

        // 8-byte fields must be 8-byte aligned for atomic-ish loads/stores.
        for off in [ShmHeaderLayout.frameNumber, FrameHeaderLayout.timestamp, FrameHeaderLayout.frameNumber,
                    RegistryHeaderLayout.lastUpdateTime, DisplayEntryLayout.lastFrameTime,
                    DisplayEntryLayout.frameCount] {
            XCTAssertEqual(off % 8, 0, "offset \(off) not 8-byte aligned")
        }
    }

    func testMagicAndVersion() {
        XCTAssertEqual(SHM_MAGIC, 0x4155_5346)
        XCTAssertEqual(REGISTRY_MAGIC, 0x4155_5352)
        XCTAssertEqual(SHM_VERSION, 1)
        XCTAssertEqual(REGISTRY_VERSION, 1)
        XCTAssertEqual(SHM_MODE, 0o600)
    }

    func testFrameSizeMath() {
        XCTAssertEqual(ShmMath.frameDataSize(width: 1280, height: 720), 1280 * 720 * 4)
        XCTAssertNil(ShmMath.frameDataSize(width: 0, height: 720))
        XCTAssertNil(ShmMath.frameDataSize(width: 65536, height: 65536), "must not overflow UInt32 byteLength")

        let size = ShmMath.totalSize(frameCount: 5, width: 1280, height: 720)
        XCTAssertEqual(size, 72 + 5 * (40 + 1280 * 720 * 4))
        XCTAssertNil(ShmMath.totalSize(frameCount: 0, width: 1280, height: 720))

        let data = 1280 * 720 * 4
        XCTAssertEqual(ShmMath.frameOffset(index: 0, frameDataSize: data), 72)
        XCTAssertEqual(ShmMath.frameOffset(index: 4, frameDataSize: data), 72 + 4 * (40 + data))
        XCTAssertEqual(ShmMath.frameOffset(index: 4, frameDataSize: data) + 40 + data, size)

        XCTAssertEqual(ShmMath.registrySize, 48 + 8 * 240)
    }
}

final class ConfigValueTests: XCTestCase {
    func testClampingNeverTraps() {
        XCTAssertEqual(ConfigValue.clamped(-5, to: ConfigValue.fpsRange), 1)
        XCTAssertEqual(ConfigValue.clamped(1000, to: ConfigValue.fpsRange), 60)
        XCTAssertEqual(ConfigValue.clamped(NSNumber(value: 30), to: ConfigValue.fpsRange), 30)
        XCTAssertEqual(ConfigValue.clamped(29.97, to: ConfigValue.fpsRange), 29)
        XCTAssertEqual(ConfigValue.clamped(0, to: ConfigValue.frameCountRange), 2)
        XCTAssertNil(ConfigValue.clamped("10", to: ConfigValue.fpsRange))
        XCTAssertNil(ConfigValue.clamped(nil, to: ConfigValue.fpsRange))
        XCTAssertNil(ConfigValue.clamped(Double.nan, to: ConfigValue.fpsRange))
    }

    func testJpegQuality() {
        XCTAssertEqual(ConfigValue.jpegQuality(nil), 0.7)
        XCTAssertEqual(ConfigValue.jpegQuality(2.0), 1.0)
        XCTAssertEqual(ConfigValue.jpegQuality(-1), 0.05)
        XCTAssertEqual(ConfigValue.jpegQuality(0.5), 0.5)
    }

    func testCommandJSONParsesAsExpected() throws {
        // JSONSerialization yields NSNumber; make sure parsing goes through the clamp path.
        let obj = try JSONSerialization.jsonObject(with: Data(#"{"fps": -3, "targetHeight": 100000}"#.utf8))
        let dict = try XCTUnwrap(obj as? [String: Any])
        XCTAssertEqual(ConfigValue.clamped(dict["fps"], to: ConfigValue.fpsRange), 1)
        XCTAssertEqual(ConfigValue.clamped(dict["targetHeight"], to: ConfigValue.targetHeightRange), 4320)
    }
}

final class FixedCStringTests: XCTestCase {
    func testRoundTripAndTruncation() {
        var buf = [UInt8](repeating: 0xFF, count: 16)
        buf.withUnsafeMutableBytes { raw in
            writeFixedCString("0x1234-camera-id-long", to: raw.baseAddress!, maxLength: 16)
            XCTAssertEqual(readFixedCString(raw.baseAddress!, maxLength: 16), "0x1234-camera-i")
            XCTAssertEqual(raw[15], 0, "terminator must always fit")
        }
    }

    func testUnterminatedBufferIsBounded() {
        let buf = [UInt8](repeating: 0x41, count: 8)  // no NUL
        buf.withUnsafeBytes { raw in
            XCTAssertEqual(readFixedCString(raw.baseAddress!, maxLength: 8), "AAAAAAAA")
        }
    }
}

final class SocketPathTests: XCTestCase {
    func testOverlongSocketPathIsRejected() {
        let long = "/tmp/" + String(repeating: "x", count: 200)
        XCTAssertEqual(bindPrivateUnixSocket(path: long), -1)
    }
}
