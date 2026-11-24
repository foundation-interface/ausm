import XCTest
@testable import ScreenshotMonitorKit

final class ProcessScannerTests: XCTestCase {
    /// A fake process table: pid → name, with a clock and a count of how many names were asked for.
    private final class Table {
        var names: [pid_t: String] = [:]
        var time: TimeInterval = 100
        var lookups = 0

        func scanner() -> ProcessScanner {
            ProcessScanner(
                listPIDs: { [unowned self] in self.names.keys.sorted() },
                kindOf: { [unowned self] pid in
                    self.lookups += 1
                    switch self.names[pid] {
                    case "screencapture": return .screencapture
                    case "screencaptureui": return .screencaptureui
                    default: return .other
                    }
                },
                now: { [unowned self] in self.time })
        }

        /// One poll, 30 ms later.
        func poll(_ scanner: ProcessScanner) -> ScreenshotProcessScan {
            time += 0.03
            lookups = 0
            return scanner.scan()
        }
    }

    private func busyTable() -> Table {
        let table = Table()
        for pid in 1...600 { table.names[pid_t(pid)] = "daemon\(pid)" }
        table.names[77] = "screencaptureui"
        return table
    }

    func testFirstScanNamesEverything() {
        let table = busyTable()
        let scan = table.poll(table.scanner())
        XCTAssertEqual(table.lookups, 600)
        XCTAssertEqual(scan.screencaptureui, [77])
        XCTAssertEqual(scan.screencapture, [])
    }

    func testAQuietPollNamesNothing() {
        let table = busyTable()
        let scanner = table.scanner()
        _ = table.poll(scanner)
        table.time += 1.2          // everything has settled
        _ = table.poll(scanner)    // (this one may be a full scan)
        let scan = table.poll(scanner)
        XCTAssertEqual(table.lookups, 0)
        XCTAssertEqual(scan.screencaptureui, [77], "what it knew is carried over")
    }

    func testANewProcessIsSeenOnTheNextPoll() {
        let table = busyTable()
        let scanner = table.scanner()
        _ = table.poll(scanner)
        table.time += 1.2
        _ = table.poll(scanner)
        table.names[9001] = "screencapture"
        let scan = table.poll(scanner)
        XCTAssertEqual(scan.screencapture, [9001])
        XCTAssertEqual(table.lookups, 1, "only the new pid is named")
    }

    func testAProcessThatTakesItsNameAfterBeingCreatedIsStillFound() {
        let table = busyTable()
        let scanner = table.scanner()
        _ = table.poll(scanner)
        table.time += 1.2
        _ = table.poll(scanner)
        // fork: the child still has its parent's name…
        table.names[9001] = "SystemUIServer"
        XCTAssertEqual(table.poll(scanner).screencapture, [])
        // …exec: now it is screencapture.
        table.names[9001] = "screencapture"
        XCTAssertEqual(table.poll(scanner).screencapture, [9001])
    }

    func testAnExitedProcessIsGoneOnTheNextPoll() {
        let table = busyTable()
        let scanner = table.scanner()
        table.names[9001] = "screencapture"
        XCTAssertEqual(table.poll(scanner).screencapture, [9001])
        table.names[9001] = nil
        XCTAssertEqual(table.poll(scanner).screencapture, [])
    }

    func testAnOldProcessThatChangesNameIsCaughtByTheFullScan() {
        let table = busyTable()
        let scanner = table.scanner()
        _ = table.poll(scanner)
        table.time += 1.2
        _ = table.poll(scanner)
        table.names[5] = "screencapture"   // an old pid: reused, or it replaced itself
        var found = false
        var polls = 0
        while !found, polls < 100 {
            found = table.poll(scanner).screencapture == [5]
            polls += 1
        }
        XCTAssertTrue(found)
        XCTAssertLessThanOrEqual(Double(polls) * 0.03, scanner.fullScanInterval + 0.03)
    }

    func testEverythingIsNamedAgainAfterALongPause() {
        let table = busyTable()
        let scanner = table.scanner()
        _ = table.poll(scanner)
        table.time += 60               // the monitor was stopped
        table.names[5] = "screencapture"
        XCTAssertEqual(table.poll(scanner).screencapture, [5])
    }

    func testMatchesAPlainScanOfTheRealProcessTable() {
        let scanner = ProcessScanner()
        _ = scanner.scan()
        let incremental = scanner.scan()
        let plain = ScreenshotProcessScan.scan()
        XCTAssertEqual(incremental.screencaptureui, plain.screencaptureui)
        XCTAssertEqual(incremental.screencapture, plain.screencapture)
    }
}
