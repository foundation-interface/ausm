import Foundation
import CoreVideo
import CoreMedia
import Accelerate

// MARK: - FrameBuffer

/// Normalises ScreenCaptureKit pixel buffers to BGRA and hands them to a
/// callback. Shared by all display streams; serialised by `lock`.
final class FrameBuffer {
    private var frameCount: UInt64 = 0
    private let lock = NSLock()
    private var bufferPool: CVPixelBufferPool?
    private var poolWidth = 0
    private var poolHeight = 0

    /// Convert a presentation time to microseconds; falls back to the current
    /// host time if the sample carries no valid timestamp.
    static func timestampMicros(_ time: CMTime) -> UInt64 {
        let seconds = CMTimeGetSeconds(time)
        if time.isValid && seconds.isFinite && seconds >= 0 {
            return UInt64(seconds * 1_000_000.0)
        }
        let now = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()))
        return now.isFinite && now >= 0 ? UInt64(now * 1_000_000.0) : 0
    }

    /// Process a CVPixelBuffer from ScreenCaptureKit.
    /// Converts to BGRA if needed and invokes callback while the pixels are locked.
    @discardableResult
    func processFrame(
        _ pixelBuffer: CVPixelBuffer,
        presentationTime: CMTime,
        displayId: UInt32,
        callback: (FrameData) -> Void
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        guard let bgraBuffer = convertToBGRA(pixelBuffer) else { return false }

        guard CVPixelBufferLockBaseAddress(bgraBuffer, .readOnly) == kCVReturnSuccess else { return false }
        defer { CVPixelBufferUnlockBaseAddress(bgraBuffer, .readOnly) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(bgraBuffer) else { return false }

        frameCount += 1
        let bytesPerRow = CVPixelBufferGetBytesPerRow(bgraBuffer)
        let width = CVPixelBufferGetWidth(bgraBuffer)
        let height = CVPixelBufferGetHeight(bgraBuffer)
        guard width > 0, height > 0, bytesPerRow >= width * 4 else { return false }

        let frameData = FrameData(
            displayId: displayId,
            timestamp: Self.timestampMicros(presentationTime),
            width: UInt32(width),
            height: UInt32(height),
            data: UnsafePointer(baseAddress.assumingMemoryBound(to: UInt8.self)),
            dataSize: bytesPerRow * height,
            bytesPerRow: bytesPerRow,
            frameNumber: frameCount
        )

        callback(frameData)
        return true
    }

    // MARK: - Private

    /// The stream is configured for BGRA, so conversion is normally a no-op.
    /// ARGB / RGBA are channel-permuted; any other (e.g. planar YUV) format is
    /// rejected rather than copied as garbage.
    private func convertToBGRA(_ sourceBuffer: CVPixelBuffer) -> CVPixelBuffer? {
        let sourceFormat = CVPixelBufferGetPixelFormatType(sourceBuffer)

        if sourceFormat == kCVPixelFormatType_32BGRA {
            return sourceBuffer
        }

        let permuteMap: [UInt8]
        switch sourceFormat {
        case kCVPixelFormatType_32ARGB: permuteMap = [3, 2, 1, 0]
        case kCVPixelFormatType_32RGBA: permuteMap = [2, 1, 0, 3]
        default:
            NSLog("[FrameBuffer] Unsupported source pixel format: %u", sourceFormat)
            return nil
        }

        let width = CVPixelBufferGetWidth(sourceBuffer)
        let height = CVPixelBufferGetHeight(sourceBuffer)

        if bufferPool == nil || poolWidth != width || poolHeight != height {
            let poolAttrs: [String: Any] = [
                kCVPixelBufferPoolMinimumBufferCountKey as String: 3
            ]
            let pixelBufferAttrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
            ]

            var pool: CVPixelBufferPool?
            let status = CVPixelBufferPoolCreate(kCFAllocatorDefault, poolAttrs as CFDictionary,
                                                 pixelBufferAttrs as CFDictionary, &pool)
            guard status == kCVReturnSuccess, let pool else {
                NSLog("[FrameBuffer] Failed to create pixel buffer pool: %d", status)
                return nil
            }
            bufferPool = pool
            poolWidth = width
            poolHeight = height
        }

        guard let pool = bufferPool else { return nil }
        var destBuffer: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &destBuffer)
        guard status == kCVReturnSuccess, let destBuffer else {
            NSLog("[FrameBuffer] Failed to create pixel buffer from pool: %d", status)
            return nil
        }

        CVPixelBufferLockBaseAddress(sourceBuffer, .readOnly)
        CVPixelBufferLockBaseAddress(destBuffer, [])
        defer {
            CVPixelBufferUnlockBaseAddress(destBuffer, [])
            CVPixelBufferUnlockBaseAddress(sourceBuffer, .readOnly)
        }

        guard let srcBase = CVPixelBufferGetBaseAddress(sourceBuffer),
              let dstBase = CVPixelBufferGetBaseAddress(destBuffer) else { return nil }

        var srcVImage = vImage_Buffer(data: srcBase, height: vImagePixelCount(height),
                                      width: vImagePixelCount(width),
                                      rowBytes: CVPixelBufferGetBytesPerRow(sourceBuffer))
        var dstVImage = vImage_Buffer(data: dstBase, height: vImagePixelCount(height),
                                      width: vImagePixelCount(width),
                                      rowBytes: CVPixelBufferGetBytesPerRow(destBuffer))
        let err = vImagePermuteChannels_ARGB8888(&srcVImage, &dstVImage, permuteMap, vImage_Flags(kvImageNoFlags))
        guard err == kvImageNoError else {
            NSLog("[FrameBuffer] vImage permute failed: %ld", err)
            return nil
        }
        return destBuffer
    }
}
