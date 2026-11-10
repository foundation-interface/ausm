import XCTest
import CoreMedia
@testable import ScreenCaptureHelper

final class ShmLayoutTests: XCTestCase {
    func testLayoutConstantsMatchSpec() {
        // These offsets are a cross-language ABI (Python reader, camera helper).
        XCTAssertEqual(ShmHeaderLayout.totalSize, 72)
        XCTAssertEqual(ShmHeaderLayout.frameNumber, 32)
        XCTAssertEqual(ShmHeaderLayout.generation, 40)
        XCTAssertEqual(FrameHeaderLayout.totalSize, 40)
        XCTAssertEqual(FrameHeaderLayout.ready, 32)
        XCTAssertEqual(RegistryHeaderLayout.totalSize, 48)
        XCTAssertEqual(DisplayEntryLayout.totalSize, 240)
        XCTAssertEqual(DisplayEntryLayout.logicalHeight, 224)
        XCTAssertEqual(ShmMath.registrySize, 48 + 8 * 240)
    }

    func testFrameAndTotalSize() {
        XCTAssertEqual(ShmMath.frameDataSize(width: 1920, height: 1080), 1920 * 1080 * 4)
        XCTAssertEqual(ShmMath.totalSize(frameCount: 5, width: 1920, height: 1080),
                       72 + 5 * (40 + 1920 * 1080 * 4))
        XCTAssertEqual(ShmMath.slotOffset(index: 0, frameDataSize: 400), 72)
        XCTAssertEqual(ShmMath.slotOffset(index: 3, frameDataSize: 400), 72 + 3 * 440)
    }

    func testSizeRejectsInvalidAndOverflow() {
        XCTAssertNil(ShmMath.totalSize(frameCount: 0, width: 10, height: 10))
        XCTAssertNil(ShmMath.totalSize(frameCount: 1, width: 0, height: 10))
        // 40000 x 40000 x 4 > UInt32.max: must not fit the frameSize header field.
        XCTAssertNil(ShmMath.frameDataSize(width: 40_000, height: 40_000))
        XCTAssertNil(ShmMath.frameDataSize(width: .max, height: .max))
    }

    func testCaptureSizeRetinaAndEven() {
        // 2880x1800 Retina panel scaled to 1080p height.
        let s = ShmMath.captureSize(pixelWidth: 2880, pixelHeight: 1800, targetHeight: 1080)
        XCTAssertEqual(s.width, 1728)
        XCTAssertEqual(s.height, 1080)
        // Native when target is 0 or >= native height.
        XCTAssertEqual(ShmMath.captureSize(pixelWidth: 3024, pixelHeight: 1964, targetHeight: 0).height, 1964)
        XCTAssertEqual(ShmMath.captureSize(pixelWidth: 1920, pixelHeight: 1080, targetHeight: 4000).width, 1920)
        // Odd values are rounded up to even.
        let odd = ShmMath.captureSize(pixelWidth: 1001, pixelHeight: 999, targetHeight: 0)
        XCTAssertEqual(odd.width % 2, 0)
        XCTAssertEqual(odd.height % 2, 0)
        // Degenerate input never yields zero.
        let zero = ShmMath.captureSize(pixelWidth: 0, pixelHeight: 0, targetHeight: 720)
        XCTAssertGreaterThan(zero.width, 0)
        XCTAssertGreaterThan(zero.height, 0)
    }

    func testShmNameValidation() {
        XCTAssertTrue(ShmMath.isValidShmName("/ausm-frames-registry"))
        XCTAssertTrue(ShmMath.isValidShmName("/ausm-frames-display-69733382"))  // 29 bytes
        XCTAssertFalse(ShmMath.isValidShmName("ausm-frames"))
        XCTAssertFalse(ShmMath.isValidShmName("/"))
        XCTAssertFalse(ShmMath.isValidShmName("/a/b"))
        XCTAssertFalse(ShmMath.isValidShmName("/" + String(repeating: "x", count: 31)))
    }

    func testTimestampMicrosHandlesInvalidTime() {
        XCTAssertEqual(FrameBuffer.timestampMicros(CMTime(value: 3, timescale: 2)), 1_500_000)
        // Invalid / indefinite times must not trap (UInt64(NaN) would).
        XCTAssertGreaterThan(FrameBuffer.timestampMicros(.invalid), 0)
        XCTAssertGreaterThan(FrameBuffer.timestampMicros(.indefinite), 0)
    }
}
