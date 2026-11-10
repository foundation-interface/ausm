import Foundation
import AVFoundation
import CoreMedia
import CoreVideo

// MARK: - VideoWriter

/// Writes BGRA frames to an MP4 file using AVAssetWriter.
///
/// `appendFrame` is called from a display's capture queue and `finalize`
/// from the main queue (after that queue has been drained); `lock` makes the
/// pair safe regardless.
final class VideoWriter {
    private let lock = NSLock()
    private var outputPath = ""
    private var assetWriter: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var pixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor?

    private var firstPresentationTime = CMTime.zero
    private var sessionStarted = false
    private var active = false
    private(set) var frameCount: UInt64 = 0

    deinit { finalize() }

    var isActive: Bool {
        lock.lock(); defer { lock.unlock() }
        return active
    }

    // MARK: - Initialize

    func initialize(outputPath: String, width: UInt32, height: UInt32,
                    fps: UInt32, codec: VideoCodec = .h264, bitrate: UInt32 = 2_000_000) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        guard !active else {
            NSLog("[VideoWriter] Already initialized")
            return false
        }
        guard width > 0, height > 0 else { return false }

        self.outputPath = outputPath

        // Replace any previous recording at this path.
        let url = URL(fileURLWithPath: outputPath)
        try? FileManager.default.removeItem(at: url)

        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        } catch {
            NSLog("[VideoWriter] Failed to create asset writer: %@", error.localizedDescription)
            return false
        }

        var compressionProps: [String: Any] = [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoMaxKeyFrameIntervalKey: max(1, fps) * 10,
            AVVideoAllowFrameReorderingKey: true,
        ]
        if codec == .h264 {
            compressionProps[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
        }

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: codec == .hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: compressionProps,
        ]

        let input = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        input.expectsMediaDataInRealTime = true

        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ]
        )

        guard writer.canAdd(input) else {
            NSLog("[VideoWriter] Cannot add video input to asset writer")
            return false
        }
        writer.add(input)

        guard writer.startWriting() else {
            NSLog("[VideoWriter] Failed to start writing: %@", writer.error?.localizedDescription ?? "unknown")
            return false
        }

        assetWriter = writer
        videoInput = input
        pixelBufferAdaptor = adaptor
        active = true
        sessionStarted = false
        frameCount = 0

        NSLog("[VideoWriter] Initialized: %@ (%ux%u @ %u fps)", outputPath, width, height, fps)
        return true
    }

    // MARK: - Append Frame

    /// Append one BGRA frame (`height` rows of `bytesPerRow` bytes).
    /// Frames arriving while the encoder is busy are dropped (real-time).
    func appendFrame(bgra data: UnsafePointer<UInt8>, width: Int, height: Int,
                     bytesPerRow: Int, timestamp: CMTime) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        guard active, let writer = assetWriter, let input = videoInput, let adaptor = pixelBufferAdaptor else {
            return false
        }
        guard writer.status == .writing else {
            NSLog("[VideoWriter] Writer not in writing state: %ld (%@)", writer.status.rawValue,
                  writer.error?.localizedDescription ?? "no error")
            return false
        }

        if !sessionStarted {
            firstPresentationTime = timestamp
            writer.startSession(atSourceTime: .zero)
            sessionStarted = true
        }

        // Real-time input: don't block the capture queue; drop instead.
        guard input.isReadyForMoreMediaData else { return false }

        guard let pool = adaptor.pixelBufferPool else {
            NSLog("[VideoWriter] Pixel buffer pool not available")
            return false
        }
        var poolBuffer: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &poolBuffer)
        guard status == kCVReturnSuccess, let poolBuffer else {
            NSLog("[VideoWriter] Failed to create pixel buffer from pool: %d", status)
            return false
        }

        CVPixelBufferLockBaseAddress(poolBuffer, [])
        if let dstBase = CVPixelBufferGetBaseAddress(poolBuffer) {
            let dstBytesPerRow = CVPixelBufferGetBytesPerRow(poolBuffer)
            let rows = min(height, CVPixelBufferGetHeight(poolBuffer))
            let rowBytes = min(width * 4, bytesPerRow, dstBytesPerRow)
            for y in 0..<rows {
                memcpy(dstBase + y * dstBytesPerRow, data + y * bytesPerRow, rowBytes)
            }
        }
        CVPixelBufferUnlockBaseAddress(poolBuffer, [])

        let rebasedTime = CMTimeSubtract(timestamp, firstPresentationTime)
        guard adaptor.append(poolBuffer, withPresentationTime: rebasedTime) else {
            NSLog("[VideoWriter] Failed to append frame: %@", writer.error?.localizedDescription ?? "unknown")
            return false
        }
        frameCount += 1
        return true
    }

    // MARK: - Finalize

    /// Finish the file (blocking up to 5 s). Idempotent.
    func finalize() {
        lock.lock()
        defer { lock.unlock() }

        guard active else { return }
        active = false

        if let writer = assetWriter, writer.status == .writing {
            if sessionStarted {
                videoInput?.markAsFinished()
                let semaphore = DispatchSemaphore(value: 0)
                writer.finishWriting { semaphore.signal() }
                if semaphore.wait(timeout: .now() + 5) == .timedOut {
                    NSLog("[VideoWriter] Timed out finalizing %@", outputPath)
                }
                switch writer.status {
                case .completed:
                    NSLog("[VideoWriter] Finalized video with %llu frames: %@", frameCount, outputPath)
                case .failed:
                    NSLog("[VideoWriter] Failed to finalize: %@", writer.error?.localizedDescription ?? "unknown")
                default:
                    NSLog("[VideoWriter] Unexpected status after finalize: %ld", writer.status.rawValue)
                }
            } else {
                // No frames were written; an empty MP4 is not useful.
                writer.cancelWriting()
                try? FileManager.default.removeItem(atPath: outputPath)
            }
        }

        assetWriter = nil
        videoInput = nil
        pixelBufferAdaptor = nil
    }
}
