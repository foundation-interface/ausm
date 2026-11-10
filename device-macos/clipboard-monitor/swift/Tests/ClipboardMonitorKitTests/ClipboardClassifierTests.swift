import Foundation
import XCTest
@testable import ClipboardMonitorKit

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

final class ClipboardClassifierEdgeTests: XCTestCase {
    func testTypedContentTypeAndUnknownFallsBackToText() {
        XCTAssertEqual(ClipboardClassifier.contentType(for: "public.file-url"), .file)
        XCTAssertEqual(ClipboardClassifier.contentType(for: "public.png"), .image)
        XCTAssertEqual(ClipboardClassifier.contentType(for: "com.example.whatever"), .text)
        XCTAssertEqual(ClipboardClassifier.contentType(forPasteboardType: ""), "TEXT")
    }

    func testPreferredTypePriority() {
        typealias C = ClipboardClassifier
        XCTAssertNil(C.preferredType(in: []))
        XCTAssertNil(C.preferredType(in: ["com.example.x", "public.jpeg"]))
        XCTAssertEqual(C.preferredType(in: ["public.utf8-plain-text", "public.html"]), "public.html")
        XCTAssertEqual(C.preferredType(in: ["public.utf8-plain-text", "public.rtf"]), "public.rtf")
        XCTAssertEqual(C.preferredType(in: ["public.html", "public.tiff"]), "public.tiff")
        XCTAssertEqual(C.preferredType(in: ["public.tiff", "public.png"]), "public.png")
        XCTAssertEqual(C.preferredType(in: ["public.png", "public.url"]), "public.url")
        XCTAssertEqual(C.preferredType(in: ["public.url", "public.file-url"]), "public.file-url")
        // Order of the input does not matter.
        XCTAssertEqual(C.preferredType(in: C.typeOrder.reversed()), "public.file-url")
    }

    func testConcealedWithAdditionalAndEmpty() {
        XCTAssertFalse(ClipboardClassifier.isConcealed(types: []))
        XCTAssertTrue(ClipboardClassifier.isConcealed(types: ["com.agilebits.onepassword"]))
        XCTAssertTrue(ClipboardClassifier.isConcealed(types: ["de.petermaurer.TransientPasteboardType"]))
        XCTAssertFalse(ClipboardClassifier.isConcealed(types: ["org.nspasteboard.concealedtype"]), "case-sensitive like UTIs on the pasteboard")
        XCTAssertFalse(ClipboardClassifier.isConcealed(types: ["org.nspasteboard.AutoGeneratedType"]), "auto-generated is not secret")
        XCTAssertTrue(ClipboardClassifier.isConcealed(types: ["x.custom"], additional: ["x.custom"]))
        XCTAssertFalse(ClipboardClassifier.isConcealed(types: ["x.custom"], additional: ["x.other"]))
    }

    func testTruncateEdgeCases() {
        XCTAssertEqual(ClipboardClassifier.truncate("", maxBytes: 0).0, "")
        XCTAssertFalse(ClipboardClassifier.truncate("", maxBytes: 0).1)
        XCTAssertEqual(ClipboardClassifier.truncate("abc", maxBytes: -1).0, "abc", "negative cap is ignored")
        // "e" + combining acute accent is one Character of 3 bytes.
        let combining = "ae\u{301}b"
        XCTAssertEqual(ClipboardClassifier.truncate(combining, maxBytes: 2).0, "a")
        XCTAssertEqual(ClipboardClassifier.truncate(combining, maxBytes: 4).0, "ae\u{301}")
        // 3-byte CJK.
        XCTAssertEqual(ClipboardClassifier.truncate("中文", maxBytes: 5).0, "中")
        XCTAssertEqual(ClipboardClassifier.truncate("中文", maxBytes: 6).0, "中文")
        // Every prefix is valid UTF-8 and within the cap.
        let mixed = "aé中👍🏽\r\nz"
        for n in 0...mixed.utf8.count {
            let (cut, flag) = ClipboardClassifier.truncate(mixed, maxBytes: n)
            XCTAssertLessThanOrEqual(cut.utf8.count, n)
            XCTAssertTrue(mixed.hasPrefix(cut))
            XCTAssertEqual(flag, n < mixed.utf8.count)
        }
    }

    func testFilePathsEdgeCases() {
        XCTAssertEqual(ClipboardClassifier.filePaths(from: []), [])
        let spaced = URL(fileURLWithPath: "/tmp/a b/c.txt")
        XCTAssertEqual(ClipboardClassifier.filePaths(from: [spaced]), ["/tmp/a b/c.txt"])
        XCTAssertEqual(ClipboardClassifier.filePaths(from: [URL(string: "mailto:x@example.com")!]), [])
    }

    func testMakeEventConcealedWinsOverEverything() {
        var o = ClipboardClassifier.Options()
        o.maxContentBytes = 1
        let e = ClipboardClassifier.makeEvent(changeCount: 1, timestampMs: 1, contentType: .file, concealed: true,
                                              content: "abc", contentPaths: ["/a"], options: o)
        XCTAssertNil(e.content)
        XCTAssertNil(e.contentPaths)
        XCTAssertFalse(e.contentTruncated)
        XCTAssertTrue(e.concealed)
        XCTAssertEqual(e.contentType, .file)
    }

    func testMakeEventExactCapIsNotTruncated() {
        var o = ClipboardClassifier.Options()
        o.maxContentBytes = 3
        let e = ClipboardClassifier.makeEvent(changeCount: 1, timestampMs: 1, contentType: .text, concealed: false,
                                              content: "abc", contentPaths: nil, options: o)
        XCTAssertEqual(e.content, "abc")
        XCTAssertFalse(e.contentTruncated)
    }

    func testMakeEventEmptyStringContentIsKept() {
        let e = ClipboardClassifier.makeEvent(changeCount: 1, timestampMs: 1, contentType: .text, concealed: false,
                                              content: "", contentPaths: [], options: .init())
        XCTAssertEqual(e.content, "")
        XCTAssertNil(e.contentPaths)
    }

    func testChangedEventUnknownContentTypeStringMapsToText() {
        let obj = ClipboardClassifier.changedEvent(changeCount: 1, timestampMs: 1, contentType: "WEIRD", concealed: false,
                                                   content: nil, contentPaths: nil, options: .init())
        XCTAssertEqual(obj["contentType"] as? String, "TEXT")
        let none = ClipboardClassifier.changedEvent(changeCount: 1, timestampMs: 1, contentType: nil, concealed: false,
                                                    content: nil, contentPaths: nil, options: .init())
        XCTAssertNil(none["contentType"])
    }

    func testArgumentParsingMore() {
        XCTAssertEqual(ClipboardClassifier.options(fromArguments: ["h", "--max-content-bytes", "0"]).maxContentBytes, 1_048_576)
        XCTAssertEqual(ClipboardClassifier.options(fromArguments: ["h", "--max-content-bytes", "abc"]).maxContentBytes, 1_048_576)
        XCTAssertEqual(ClipboardClassifier.options(fromArguments: ["h", "--max-content-bytes", "1.5"]).maxContentBytes, 1_048_576)
        XCTAssertEqual(ClipboardClassifier.options(fromArguments: ["h", "--max-content-bytes", "7", "--no-content"]).maxContentBytes, 7)
        XCTAssertTrue(ClipboardClassifier.options(fromArguments: ["h", "--no-contents"]).includeContent)
        let d = ClipboardMonitor.Options()
        XCTAssertEqual(d.pollInterval, 0.2)
        XCTAssertTrue(d.additionalConcealedTypes.isEmpty)
    }
}
