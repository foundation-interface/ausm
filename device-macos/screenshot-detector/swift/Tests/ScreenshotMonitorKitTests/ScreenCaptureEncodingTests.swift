import CoreGraphics
import Foundation
import XCTest
@testable import ScreenshotMonitorKit

final class ScreenCaptureEncodingTests: XCTestCase {
    private func makeImage(width: Int = 8, height: Int = 4) throws -> CGImage {
        let ctx = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
        ))
        ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try XCTUnwrap(ctx.makeImage())
    }

    private func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ausm-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    func testFormatMetadata() {
        XCTAssertEqual(ScreenCapture.ImageFormat.png.mimeType, "image/png")
        XCTAssertEqual(ScreenCapture.ImageFormat.png.fileExtension, "png")
        XCTAssertEqual(ScreenCapture.ImageFormat.jpeg(quality: 0.5).mimeType, "image/jpeg")
        XCTAssertEqual(ScreenCapture.ImageFormat.jpeg(quality: 0.5).fileExtension, "jpg")
    }

    func testEncodeProducesValidImages() throws {
        let image = try makeImage()
        let png = try XCTUnwrap(ScreenCapture.encode(image, as: .png))
        XCTAssertEqual(Array(png.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
        let jpeg = try XCTUnwrap(ScreenCapture.encode(image, as: .jpeg(quality: 0.8)))
        XCTAssertEqual(Array(jpeg.prefix(2)), [0xFF, 0xD8])
        // Out-of-range quality is clamped, not rejected.
        XCTAssertNotNil(ScreenCapture.encode(image, as: .jpeg(quality: 7)))
    }

    func testWriteTempIsPrivateAndUnique() throws {
        let dir = try tempDir()
        let image = try makeImage()
        let a = try XCTUnwrap(ScreenCapture.writeTemp(image, as: .png, directory: dir))
        let b = try XCTUnwrap(ScreenCapture.writeTemp(image, as: .png, directory: dir))
        XCTAssertNotEqual(a, b)
        XCTAssertTrue((a as NSString).lastPathComponent.hasPrefix(ScreenCapture.tempFilePrefix))
        let attrs = try FileManager.default.attributesOfItem(atPath: a)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testRemoveStaleTempFiles() throws {
        let dir = try tempDir()
        let image = try makeImage()
        let old = try XCTUnwrap(ScreenCapture.writeTemp(image, as: .png, directory: dir))
        let fresh = try XCTUnwrap(ScreenCapture.writeTemp(image, as: .png, directory: dir))
        let unrelated = dir.appendingPathComponent("keep-me.png").path
        FileManager.default.createFile(atPath: unrelated, contents: Data([1]))
        let past = Date().addingTimeInterval(-7200)
        try FileManager.default.setAttributes([.modificationDate: past], ofItemAtPath: old)
        try FileManager.default.setAttributes([.modificationDate: past], ofItemAtPath: unrelated)

        XCTAssertEqual(ScreenCapture.removeStaleTempFiles(olderThan: 3600, directory: dir), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: old))
        XCTAssertTrue(FileManager.default.fileExists(atPath: fresh))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated))
    }

    func testEndedPayloadShape() throws {
        let image = try makeImage(width: 400, height: 200)
        let capture = ScreenshotMonitor.Capture(
            image: image, rect: CGRect(x: 10, y: 20, width: 200, height: 100), displayID: 7, scale: 2,
            mode: .selection, destination: .file, tempFilePath: "/tmp/x.jpg", timestamp: Date()
        )
        let payload = ScreenshotWire.ended(pid: 42, mode: .selection, destination: .file, cancelled: false,
                                           capture: capture, mimeType: "image/jpeg")
        XCTAssertTrue(JSONSerialization.isValidJSONObject(payload))
        XCTAssertEqual(payload["type"] as? String, "screencapture_ended")
        XCTAssertEqual(payload["pid"] as? Int, 42)
        XCTAssertEqual(payload["mode"] as? String, "selection")
        XCTAssertEqual(payload["destination"] as? String, "file")
        XCTAssertEqual(payload["cancelled"] as? Bool, false)
        XCTAssertEqual(payload["imageWidth"] as? Int, 400)
        XCTAssertEqual(payload["imageHeight"] as? Int, 200)
        XCTAssertEqual(payload["displayId"] as? String, "7")
        XCTAssertEqual(payload["scale"] as? Double, 2)
        XCTAssertEqual(payload["imagePath"] as? String, "/tmp/x.jpg")
        XCTAssertEqual(payload["imageMimeType"] as? String, "image/jpeg")
        let rect = try XCTUnwrap(payload["rect"] as? [String: Any])
        XCTAssertEqual(rect["x"] as? Double, 10)
        XCTAssertEqual(rect["width"] as? Double, 200)

        let cancelled = ScreenshotWire.ended(pid: 1, mode: .interactive, destination: .clipboard, cancelled: true,
                                             capture: nil, mimeType: "image/jpeg")
        XCTAssertEqual(cancelled["cancelled"] as? Bool, true)
        XCTAssertNil(cancelled["imagePath"])
        XCTAssertNil(cancelled["rect"])
    }

    func testMonitorStartStopIsIdempotentAndReentrant() {
        // No TCC needed: a missing event tap / Screen Recording grant is reported, not fatal.
        var options = ScreenshotMonitor.Options()
        options.writeTempFile = false
        options.installsEventTap = false
        let monitor = ScreenshotMonitor(options: options)
        var types: [String] = []
        let lock = NSLock()
        monitor.onEvent = { event in
            lock.lock(); types.append(event["type"] as? String ?? "?"); lock.unlock()
            if event["type"] as? String == "ready" { monitor.stop() } // stop from inside a callback
        }
        monitor.start()
        monitor.start()
        XCTAssertFalse(monitor.isRunning)
        monitor.stop()
        lock.lock(); defer { lock.unlock() }
        XCTAssertEqual(types.first, "ready")
    }
}
