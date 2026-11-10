import Foundation
import XCTest
@testable import ClipboardHelper

final class ClipboardClassifierTests: XCTestCase {
    func testContentTypeMapping() {
        XCTAssertEqual(ClipboardClassifier.contentType(forPasteboardType: "public.file-url"), "FILE")
        XCTAssertEqual(ClipboardClassifier.contentType(forPasteboardType: "public.url"), "URL")
        XCTAssertEqual(ClipboardClassifier.contentType(forPasteboardType: "public.png"), "IMAGE")
        XCTAssertEqual(ClipboardClassifier.contentType(forPasteboardType: "public.tiff"), "IMAGE")
        XCTAssertEqual(ClipboardClassifier.contentType(forPasteboardType: "public.html"), "HTML")
        XCTAssertEqual(ClipboardClassifier.contentType(forPasteboardType: "public.rtf"), "RTF")
        XCTAssertEqual(ClipboardClassifier.contentType(forPasteboardType: "public.utf8-plain-text"), "TEXT")
        XCTAssertEqual(ClipboardClassifier.typeOrder.first, "public.file-url")
        XCTAssertEqual(ClipboardClassifier.typeOrder.last, "public.utf8-plain-text")
    }

    func testConcealedMarkers() {
        XCTAssertTrue(ClipboardClassifier.isConcealed(types: ["public.utf8-plain-text", "org.nspasteboard.ConcealedType"]))
        XCTAssertTrue(ClipboardClassifier.isConcealed(types: ["org.nspasteboard.TransientType"]))
        XCTAssertFalse(ClipboardClassifier.isConcealed(types: ["public.utf8-plain-text", "public.html"]))
    }

    func testTruncateRespectsCharacterBoundaries() {
        XCTAssertEqual(ClipboardClassifier.truncate("hello", maxBytes: 10).0, "hello")
        XCTAssertFalse(ClipboardClassifier.truncate("hello", maxBytes: 5).1)
        let (cut, truncated) = ClipboardClassifier.truncate("hello", maxBytes: 3)
        XCTAssertEqual(cut, "hel")
        XCTAssertTrue(truncated)
        // "é" is 2 bytes, "👍🏽" is a single 8-byte character: never split them.
        XCTAssertEqual(ClipboardClassifier.truncate("aé", maxBytes: 2).0, "a")
        XCTAssertEqual(ClipboardClassifier.truncate("x👍🏽y", maxBytes: 6).0, "x")
        XCTAssertEqual(ClipboardClassifier.truncate("x👍🏽y", maxBytes: 9).0, "x👍🏽")
        XCTAssertEqual(ClipboardClassifier.truncate("abc", maxBytes: 0).0, "")
    }

    func testFilePathsDropsNonFileURLs() {
        let urls = [URL(fileURLWithPath: "/tmp/a.txt"), URL(string: "https://example.com")!]
        XCTAssertEqual(ClipboardClassifier.filePaths(from: urls), ["/tmp/a.txt"])
    }

    func testChangedEventShape() {
        let obj = ClipboardClassifier.changedEvent(
            changeCount: 7, timestampMs: 1000, contentType: "FILE", concealed: false,
            content: "/a\n/b", contentPaths: ["/a", "/b"], options: .init())
        XCTAssertTrue(JSONSerialization.isValidJSONObject(obj))
        XCTAssertEqual(obj["type"] as? String, "clipboard_changed")
        XCTAssertEqual(obj["changeCount"] as? Int, 7)
        XCTAssertEqual(obj["timestamp"] as? Int64, 1000)
        XCTAssertEqual(obj["contentType"] as? String, "FILE")
        XCTAssertEqual(obj["content"] as? String, "/a\n/b")
        XCTAssertEqual(obj["contentPaths"] as? [String], ["/a", "/b"])
        XCTAssertNil(obj["contentTruncated"])
        XCTAssertNil(obj["concealed"])
    }

    func testConcealedEventCarriesNoContent() {
        let obj = ClipboardClassifier.changedEvent(
            changeCount: 1, timestampMs: 1, contentType: "TEXT", concealed: true,
            content: "hunter2", contentPaths: nil, options: .init())
        XCTAssertEqual(obj["concealed"] as? Bool, true)
        XCTAssertNil(obj["content"])
    }

    func testNoContentOptionAndTruncation() {
        var noContent = ClipboardClassifier.Options()
        noContent.includeContent = false
        let a = ClipboardClassifier.changedEvent(changeCount: 1, timestampMs: 1, contentType: "TEXT", concealed: false,
                                                 content: "secret", contentPaths: nil, options: noContent)
        XCTAssertNil(a["content"])
        XCTAssertEqual(a["contentType"] as? String, "TEXT")

        var small = ClipboardClassifier.Options()
        small.maxContentBytes = 4
        let b = ClipboardClassifier.changedEvent(changeCount: 1, timestampMs: 1, contentType: "TEXT", concealed: false,
                                                 content: "abcdefgh", contentPaths: nil, options: small)
        XCTAssertEqual(b["content"] as? String, "abcd")
        XCTAssertEqual(b["contentTruncated"] as? Bool, true)
    }

    func testArgumentParsing() {
        let d = ClipboardClassifier.options(fromArguments: ["helper"])
        XCTAssertTrue(d.includeContent)
        XCTAssertEqual(d.maxContentBytes, 1_048_576)
        let o = ClipboardClassifier.options(fromArguments: ["helper", "--no-content", "--max-content-bytes", "100"])
        XCTAssertFalse(o.includeContent)
        XCTAssertEqual(o.maxContentBytes, 100)
        XCTAssertEqual(ClipboardClassifier.options(fromArguments: ["h", "--max-content-bytes", "-5"]).maxContentBytes, 1_048_576)
        XCTAssertEqual(ClipboardClassifier.options(fromArguments: ["h", "--max-content-bytes"]).maxContentBytes, 1_048_576)
    }
}
