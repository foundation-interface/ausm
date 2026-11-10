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

final class ScreenCaptureGeometryTests: XCTestCase {
    typealias G = ScreenCapture.Geometry
    let main = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let left = CGRect(x: -1920, y: -300, width: 1920, height: 1080)

    func testClippedCrop() {
        XCTAssertNil(G.clippedCrop(nil, to: main))
        XCTAssertEqual(G.clippedCrop(CGRect(x: 10, y: 10, width: 100, height: 50), to: main),
                       CGRect(x: 10, y: 10, width: 100, height: 50))
        // Spanning two displays: clipped to the one being captured.
        XCTAssertEqual(G.clippedCrop(CGRect(x: -100, y: 10, width: 200, height: 50), to: main),
                       CGRect(x: 0, y: 10, width: 100, height: 50))
        XCTAssertEqual(G.clippedCrop(CGRect(x: -100, y: 10, width: 200, height: 50), to: left),
                       CGRect(x: -100, y: 10, width: 100, height: 50))
        // Misses the display / sub-point: whole display.
        XCTAssertNil(G.clippedCrop(CGRect(x: 5000, y: 0, width: 10, height: 10), to: main))
        XCTAssertNil(G.clippedCrop(CGRect(x: 0, y: 0, width: 0.5, height: 10), to: main))
        XCTAssertNil(G.clippedCrop(CGRect(x: 1511.5, y: 0, width: 10, height: 10), to: main))
        XCTAssertNil(G.clippedCrop(.null, to: main))
    }

    func testDisplayLocalForNegativeOrigin() {
        XCTAssertEqual(G.displayLocal(CGRect(x: -1800, y: -200, width: 400, height: 300), in: left),
                       CGRect(x: 120, y: 100, width: 400, height: 300))
        XCTAssertEqual(G.displayLocal(main, in: main), main)
    }

    func testPixelSizeRetinaAndDegenerate() {
        XCTAssertTrue(G.pixelSize(of: CGSize(width: 200, height: 100), scale: 2) == (400, 200))
        XCTAssertTrue(G.pixelSize(of: CGSize(width: 100.25, height: 0.2), scale: 2) == (201, 1))
        XCTAssertTrue(G.pixelSize(of: CGSize(width: 0, height: -5), scale: 2) == (1, 1))
        XCTAssertTrue(G.pixelSize(of: CGSize(width: 10, height: 10), scale: CGFloat.nan) == (1, 1))
        XCTAssertTrue(G.pixelSize(of: CGSize(width: CGFloat.infinity, height: 10), scale: 1) == (1, 10))
        XCTAssertEqual(G.pixelSize(of: CGSize(width: 1e12, height: 1), scale: 1).width, Int(Int32.max))
    }

    func testPixelCropRetinaAndOffset() {
        // Main display: 1512x982 points, 3024x1964 pixels.
        XCTAssertEqual(G.pixelCrop(CGRect(x: 10, y: 20, width: 100, height: 50), displayBounds: main,
                                   imageWidth: 3024, imageHeight: 1964),
                       CGRect(x: 20, y: 40, width: 200, height: 100))
        // Secondary display with negative origin at 1x.
        XCTAssertEqual(G.pixelCrop(CGRect(x: -1800, y: -200, width: 400, height: 300), displayBounds: left,
                                   imageWidth: 1920, imageHeight: 1080),
                       CGRect(x: 120, y: 100, width: 400, height: 300))
    }

    func testPixelCropClampsBothEdges() {
        // Starts left of the display: the visible part only, not a shifted full-width rect.
        XCTAssertEqual(G.pixelCrop(CGRect(x: -50, y: 0, width: 100, height: 10), displayBounds: main,
                                   imageWidth: 1512, imageHeight: 982),
                       CGRect(x: 0, y: 0, width: 50, height: 10))
        XCTAssertEqual(G.pixelCrop(CGRect(x: 1500, y: 970, width: 100, height: 100), displayBounds: main,
                                   imageWidth: 1512, imageHeight: 982),
                       CGRect(x: 1500, y: 970, width: 12, height: 12))
        XCTAssertNil(G.pixelCrop(CGRect(x: 2000, y: 0, width: 10, height: 10), displayBounds: main,
                                 imageWidth: 1512, imageHeight: 982))
        XCTAssertNil(G.pixelCrop(CGRect(x: 0, y: 0, width: 10, height: 10), displayBounds: .zero,
                                 imageWidth: 10, imageHeight: 10))
        XCTAssertNil(G.pixelCrop(CGRect(x: 0, y: 0, width: 10, height: 10), displayBounds: main,
                                 imageWidth: 0, imageHeight: 10))
    }

    func testPixelCropFractionalPointsCoverWholePixels() {
        let r = G.pixelCrop(CGRect(x: 0.25, y: 0.25, width: 1, height: 1), displayBounds: main,
                            imageWidth: 3024, imageHeight: 1964)
        XCTAssertEqual(r, CGRect(x: 0, y: 0, width: 3, height: 3))
    }
}

final class ScreenCaptureTempFileEdgeTests: XCTestCase {
    private func image() -> CGImage { FakeScreenshotSystem.image(width: 3, height: 3) }

    func testWriteTempIntoMissingDirectoryFails() {
        XCTAssertNil(ScreenCapture.writeTemp(image(), as: .png,
                                             directory: URL(fileURLWithPath: "/nonexistent-\(UUID().uuidString)")))
    }

    func testWriteTempIntoUnicodeDirectory() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ausm-📸-שלום-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let path = try XCTUnwrap(ScreenCapture.writeTemp(image(), as: .jpeg(quality: -3), directory: dir))
        XCTAssertTrue(path.hasSuffix(".jpg"))
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        XCTAssertEqual(Array(data.prefix(2)), [0xFF, 0xD8])
    }

    func testSweepSkipsDirectoriesAndSymlinksAndHandlesMissingDir() throws {
        XCTAssertEqual(ScreenCapture.removeStaleTempFiles(olderThan: 0, directory: URL(fileURLWithPath: "/nonexistent-\(UUID().uuidString)")), 0)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ausm-sweep-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let target = dir.appendingPathComponent("target.txt")
        FileManager.default.createFile(atPath: target.path, contents: Data([1]))
        let subdir = dir.appendingPathComponent(ScreenCapture.tempFilePrefix + "dir")
        try FileManager.default.createDirectory(at: subdir, withIntermediateDirectories: true)
        let link = dir.appendingPathComponent(ScreenCapture.tempFilePrefix + "link.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let past = Date().addingTimeInterval(-7200)
        try FileManager.default.setAttributes([.modificationDate: past], ofItemAtPath: subdir.path)
        try FileManager.default.setAttributes([.modificationDate: past], ofItemAtPath: target.path)

        XCTAssertEqual(ScreenCapture.removeStaleTempFiles(olderThan: 60, directory: dir), 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: subdir.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path), "a symlink is never followed")
    }

    func testWireRectAndEndedWithoutTempPath() throws {
        let r = ScreenshotWire.rect(CGRect(x: -1920.5, y: -300, width: 10, height: 20))
        XCTAssertEqual(r["x"] as? Double, -1920.5)
        XCTAssertEqual(r["y"] as? Double, -300)
        let capture = ScreenshotMonitor.Capture(
            image: image(), rect: nil, displayID: 3, scale: 1.5, mode: .window, destination: .clipboard,
            tempFilePath: nil, timestamp: Date())
        let p = ScreenshotWire.ended(pid: 1, mode: .window, destination: .clipboard, cancelled: false,
                                     capture: capture, mimeType: "image/png")
        XCTAssertNil(p["imagePath"])
        XCTAssertNil(p["imageMimeType"], "no MIME type without a file")
        XCTAssertNil(p["rect"])
        XCTAssertEqual(p["scale"] as? Double, 1.5)
        XCTAssertEqual(p["displayId"] as? String, "3")
        XCTAssertTrue(JSONSerialization.isValidJSONObject(p))
    }
}
