import Foundation
import XCTest
@testable import ClipboardMonitorKit

/// In-memory pasteboard: the tests never touch the real clipboard.
final class FakePasteboard: PasteboardReading {
    var changeCount = 0
    var typeIdentifiers: [String] = []
    var contents: [String: (String?, [String]?)] = [:]
    var accessProblem: ClipboardMonitor.Problem?
    private(set) var reads: [String] = []
    private(set) var changeCountReads = 0

    func availableType(from types: [String]) -> String? {
        let present = Set(typeIdentifiers)
        return types.first(where: present.contains)
    }

    /// Runs during a content read (to simulate a copy racing the poll).
    var onRead: (() -> Void)?

    func readContent(ofType type: String) -> (content: String?, paths: [String]?) {
        reads.append(type)
        if let hook = onRead { onRead = nil; hook() }
        let c = contents[type]
        return (c?.0 ?? nil, c?.1 ?? nil)
    }

    /// Simulate a copy.
    func copy(_ types: [String], _ contents: [String: (String?, [String]?)] = [:]) {
        changeCount += 1
        typeIdentifiers = types
        self.contents = contents
    }
}

final class ClipboardMonitorTests: XCTestCase {
    private var board: FakePasteboard!
    private var clock: Int64 = 1_000
    private var events: [ClipboardEvent] = []
    private var errors: [ClipboardMonitor.Problem] = []

    override func setUp() {
        board = FakePasteboard()
        clock = 1_000
        events = []
        errors = []
    }

    private func makeMonitor(_ configure: (inout ClipboardMonitor.Options) -> Void = { _ in }) -> ClipboardMonitor {
        var o = ClipboardMonitor.Options()
        configure(&o)
        let m = ClipboardMonitor(options: o, pasteboard: board, now: { [unowned self] in self.clock })
        m.onEvent = { [unowned self] in self.events.append($0) }
        m.onError = { [unowned self] p, _ in self.errors.append(p) }
        m.startOnQueue(scheduleTimer: false)
        return m
    }

    func testChangesBeforeStartAreNotReported() {
        board.copy(["public.utf8-plain-text"], ["public.utf8-plain-text": ("a", nil)])
        let m = makeMonitor()
        m.poll()
        XCTAssertTrue(events.isEmpty)
    }

    func testChangeDuringReadIsDroppedAndNextPollReportsNewItem() {
        let m = makeMonitor()
        board.copy(["public.utf8-plain-text"], ["public.utf8-plain-text": ("abc", nil)])
        // A concealed item lands between the concealed check and the content read.
        board.onRead = { [unowned self] in
            self.board.copy(["org.nspasteboard.ConcealedType", "public.utf8-plain-text"],
                            ["public.utf8-plain-text": ("secret", nil)])
        }
        m.poll()
        XCTAssertTrue(events.isEmpty, "a result read across a change is dropped")
        m.poll()
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].changeCount, 2)
        XCTAssertTrue(events[0].concealed)
        XCTAssertNil(events[0].content)
    }

    func testNoChangeNoEvent() {
        let m = makeMonitor()
        for _ in 0..<5 { m.poll() }
        XCTAssertTrue(events.isEmpty)
        XCTAssertTrue(board.reads.isEmpty, "contents are never read without a change")
    }

    func testTextCopyIsReported() {
        let m = makeMonitor()
        clock = 42
        board.copy(["public.utf8-plain-text"], ["public.utf8-plain-text": ("abc", nil)])
        m.poll()
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].changeCount, 1)
        XCTAssertEqual(events[0].timestampMs, 42)
        XCTAssertEqual(events[0].contentType, .text)
        XCTAssertEqual(events[0].content, "abc")
        XCTAssertFalse(events[0].concealed)
        XCTAssertFalse(events[0].contentTruncated)
        m.poll()
        XCTAssertEqual(events.count, 1, "same changeCount is reported once")
    }

    func testMultipleChangesBetweenPollsCoalesce() {
        let m = makeMonitor()
        board.copy(["public.utf8-plain-text"], ["public.utf8-plain-text": ("1", nil)])
        board.copy(["public.html", "public.utf8-plain-text"], ["public.html": ("2", nil)])
        m.poll()
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].changeCount, 2)
        XCTAssertEqual(events[0].contentType, .html)
    }

    func testPriorityReadsOnlyTheWinningType() {
        let m = makeMonitor()
        board.copy(["public.utf8-plain-text", "public.rtf", "public.html", "public.url"],
                   ["public.url": ("https://example.com/x", nil)])
        m.poll()
        XCTAssertEqual(events.first?.contentType, .url)
        XCTAssertEqual(board.reads, ["public.url"])
    }

    func testConcealedPasteboardIsNeverRead() {
        let m = makeMonitor()
        board.copy(["public.utf8-plain-text", "org.nspasteboard.ConcealedType"],
                   ["public.utf8-plain-text": ("secret", nil)])
        m.poll()
        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].concealed)
        XCTAssertEqual(events[0].contentType, .text)
        XCTAssertNil(events[0].content)
        XCTAssertTrue(board.reads.isEmpty)
    }

    func testEveryBuiltInMarkerConceals() {
        let m = makeMonitor()
        for marker in ClipboardClassifier.concealedMarkers.sorted() {
            board.copy(["public.utf8-plain-text", marker], ["public.utf8-plain-text": ("s", nil)])
            m.poll()
        }
        XCTAssertEqual(events.count, ClipboardClassifier.concealedMarkers.count)
        XCTAssertTrue(events.allSatisfy { $0.concealed && $0.content == nil })
        XCTAssertTrue(board.reads.isEmpty)
    }

    func testAdditionalConcealedTypes() {
        let m = makeMonitor { $0.additionalConcealedTypes = ["com.example.secret"] }
        board.copy(["public.utf8-plain-text", "com.example.secret"], ["public.utf8-plain-text": ("s", nil)])
        m.poll()
        XCTAssertTrue(events[0].concealed)
        XCTAssertTrue(board.reads.isEmpty)
    }

    func testIncludeContentFalseNeverReads() {
        let m = makeMonitor { $0.includeContent = false }
        board.copy(["public.file-url"], ["public.file-url": ("/a", ["/a"])])
        m.poll()
        XCTAssertEqual(events[0].contentType, .file)
        XCTAssertNil(events[0].content)
        XCTAssertNil(events[0].contentPaths)
        XCTAssertTrue(board.reads.isEmpty)
    }

    func testFileCopyCarriesPaths() {
        let m = makeMonitor()
        board.copy(["public.file-url", "public.utf8-plain-text"], ["public.file-url": ("/a\n/b", ["/a", "/b"])])
        m.poll()
        XCTAssertEqual(events[0].contentType, .file)
        XCTAssertEqual(events[0].contentPaths, ["/a", "/b"])
        XCTAssertEqual(events[0].content, "/a\n/b")
    }

    func testImageHasTypeButNoContent() {
        let m = makeMonitor()
        board.copy(["public.tiff", "public.png"])
        m.poll()
        XCTAssertEqual(events[0].contentType, .image)
        XCTAssertNil(events[0].content)
    }

    func testUnknownTypesOnlyGiveNilContentType() {
        let m = makeMonitor()
        board.copy(["com.example.private"])
        m.poll()
        XCTAssertEqual(events.count, 1)
        XCTAssertNil(events[0].contentType)
        XCTAssertNil(events[0].wireObject["contentType"])
        XCTAssertTrue(board.reads.isEmpty)
    }

    func testEmptyPasteboardAfterClear() {
        let m = makeMonitor()
        board.copy([])
        m.poll()
        XCTAssertEqual(events.count, 1)
        XCTAssertNil(events[0].contentType)
    }

    func testTruncationAppliesInMonitor() {
        let m = makeMonitor { $0.maxContentBytes = 3 }
        board.copy(["public.utf8-plain-text"], ["public.utf8-plain-text": ("abcdef", nil)])
        m.poll()
        XCTAssertEqual(events[0].content, "abc")
        XCTAssertTrue(events[0].contentTruncated)
    }

    func testChangeCountGoingBackwardsIsStillAChange() {
        // A pasteboard server restart can reset changeCount.
        let m = makeMonitor()
        board.copy(["public.utf8-plain-text"])
        m.poll()
        board.changeCount = 0
        m.poll()
        XCTAssertEqual(events.map(\.changeCount), [1, 0])
    }

    func testStopThenStartRebaselines() {
        let m = makeMonitor()
        m.stop()
        XCTAssertFalse(m.isRunning)
        board.copy(["public.utf8-plain-text"])
        m.poll()
        XCTAssertTrue(events.isEmpty, "a stopped monitor does not report")
        m.startOnQueue(scheduleTimer: false)
        m.poll()
        XCTAssertTrue(events.isEmpty, "changes while stopped are not reported after restart")
        board.copy(["public.utf8-plain-text"])
        m.poll()
        XCTAssertEqual(events.count, 1)
    }

    func testStartAndStopAreIdempotent() {
        let m = makeMonitor()
        m.startOnQueue(scheduleTimer: false)
        XCTAssertTrue(m.isRunning)
        m.stop(); m.stop()
        XCTAssertFalse(m.isRunning)
        let fresh = ClipboardMonitor(options: .init(), pasteboard: board, now: { 0 })
        fresh.stop() // before start
        XCTAssertFalse(fresh.isRunning)
    }

    func testStopFromInsideCallbackDoesNotDeadlock() {
        var o = ClipboardMonitor.Options()
        o.pollInterval = 0.01
        let m = ClipboardMonitor(options: o, pasteboard: board, now: { 0 })
        let done = expectation(description: "stopped from callback")
        m.onEvent = { _ in
            m.stop()
            m.start() // re-entrant start from the callback is fine too
            m.stop()
            done.fulfill()
        }
        m.start()
        m.start()
        board.copy(["com.example.private"])
        wait(for: [done], timeout: 5)
        XCTAssertFalse(m.isRunning)
    }

    func testAccessProblemReportedOnceUntilCleared() {
        board.accessProblem = .accessDenied
        let m = makeMonitor { $0.accessCheckInterval = 1 }
        XCTAssertEqual(errors, [.accessDenied], "checked at start")
        clock += 5_000; m.poll()
        XCTAssertEqual(errors, [.accessDenied], "not repeated while unchanged")
        board.accessProblem = nil
        clock += 5_000; m.poll()
        board.accessProblem = .accessDenied
        clock += 5_000; m.poll()
        XCTAssertEqual(errors, [.accessDenied, .accessDenied], "reported again after clearing")
        board.accessProblem = .accessPrompts
        clock += 5_000; m.poll()
        XCTAssertEqual(errors.last, .accessPrompts)
    }

    func testAccessCheckIsRateLimited() {
        let m = makeMonitor { $0.accessCheckInterval = 5 }
        board.accessProblem = .accessDenied
        clock += 1_000; m.poll()
        XCTAssertTrue(errors.isEmpty)
        clock += 4_000; m.poll()
        XCTAssertEqual(errors, [.accessDenied])
    }

    func testAccessCheckDisabled() {
        let m = makeMonitor { $0.accessCheckInterval = 0 }
        board.accessProblem = .accessPrompts
        clock += 60_000; m.poll()
        XCTAssertTrue(errors.isEmpty, "only checked at start")
    }

    func testAccessBehaviorMapping() {
        XCTAssertNil(ClipboardMonitor.Problem(accessBehavior: 0))
        XCTAssertEqual(ClipboardMonitor.Problem(accessBehavior: 1), .accessPrompts)
        XCTAssertNil(ClipboardMonitor.Problem(accessBehavior: 2))
        XCTAssertEqual(ClipboardMonitor.Problem(accessBehavior: 3), .accessDenied)
        XCTAssertNil(ClipboardMonitor.Problem(accessBehavior: 99))
        XCTAssertEqual(ClipboardMonitor.Problem.accessDenied.rawValue, "pasteboard_access_denied")
    }
}

final class ProblemLatchTests: XCTestCase {
    func testLatch() {
        var l = ProblemLatch<String>()
        XCTAssertNil(l.update(nil))
        XCTAssertEqual(l.update("a"), "a")
        XCTAssertNil(l.update("a"))
        XCTAssertEqual(l.update("b"), "b")
        XCTAssertNil(l.update(nil))
        XCTAssertNil(l.current)
        XCTAssertEqual(l.update("b"), "b")
    }
}

final class ClipboardWireTests: XCTestCase {
    private func parse(_ line: String?) throws -> [String: Any] {
        let line = try XCTUnwrap(line)
        XCTAssertFalse(line.contains("\n"), "one JSON object per line")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
    }

    func testReadyLine() throws {
        XCTAssertEqual(try parse(ClipboardWire.line(ClipboardWire.readyObject)) as? [String: String], ["type": "ready"])
    }

    func testMinimalEventKeys() throws {
        let e = ClipboardEvent(changeCount: 3, timestampMs: 9, contentType: nil, concealed: false,
                               content: nil, contentPaths: nil, contentTruncated: false)
        let obj = try parse(e.wireLine)
        XCTAssertEqual(Set(obj.keys), ["type", "changeCount", "timestamp"])
        XCTAssertEqual(obj["type"] as? String, "clipboard_changed")
    }

    func testFullEventKeysAndNewlinesEscaped() throws {
        let e = ClipboardEvent(changeCount: 3, timestampMs: 1_700_000_000_123, contentType: .file, concealed: false,
                               content: "/a\n/b", contentPaths: ["/a", "/b"], contentTruncated: true)
        let obj = try parse(e.wireLine)
        XCTAssertEqual(Set(obj.keys), ["type", "changeCount", "timestamp", "contentType", "content",
                                       "contentPaths", "contentTruncated"])
        XCTAssertEqual(obj["timestamp"] as? Int64, 1_700_000_000_123, "integer milliseconds")
        XCTAssertEqual(obj["contentTruncated"] as? Bool, true)
        XCTAssertEqual(obj["content"] as? String, "/a\n/b")
    }

    func testEmptyPathsOmitted() {
        let e = ClipboardEvent(changeCount: 1, timestampMs: 1, contentType: .file, concealed: false,
                               content: nil, contentPaths: [], contentTruncated: false)
        XCTAssertNil(e.wireObject["contentPaths"])
    }

    func testContentTypeRawValuesMatchNode() {
        XCTAssertEqual(ClipboardContentType.allCases.map(\.rawValue).sorted(),
                       ["FILE", "HTML", "IMAGE", "RTF", "TEXT", "URL"])
    }

    func testTimestampDate() {
        let e = ClipboardEvent(changeCount: 1, timestampMs: 1_500, contentType: nil, concealed: false,
                               content: nil, contentPaths: nil, contentTruncated: false)
        XCTAssertEqual(e.timestamp.timeIntervalSince1970, 1.5, accuracy: 1e-9)
    }
}
