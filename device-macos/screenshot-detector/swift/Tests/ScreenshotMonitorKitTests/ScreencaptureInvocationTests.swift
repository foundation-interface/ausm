import CoreGraphics
import Darwin
import XCTest
@testable import ScreenshotMonitorKit

final class ScreencaptureInvocationTests: XCTestCase {
    // argv observed on macOS 26 for the system hotkeys (argv[0] stripped).

    func testCmdShift3() {
        let inv = ScreencaptureInvocation(arguments: ["-pd", "-z", "keyboard.screen"])
        XCTAssertEqual(inv.mode, .screen)
        XCTAssertEqual(inv.destination, .file)
        XCTAssertFalse(inv.interactive)
    }

    func testCmdShift4() {
        let inv = ScreencaptureInvocation(arguments: ["-pdin", "-z", "keyboard.selection"])
        XCTAssertEqual(inv.mode, .selection)
        XCTAssertEqual(inv.destination, .file)
        XCTAssertTrue(inv.interactive)
    }

    func testCmdShift5() {
        let inv = ScreencaptureInvocation(arguments: ["-pdiU", "-z", "keyboard.interactive"])
        XCTAssertEqual(inv.mode, .interactive)
        XCTAssertTrue(inv.interactive)
    }

    func testClipboardVariants() {
        let shot = ScreencaptureInvocation(arguments: ["-pdc", "-z", "keyboard.screen.clipboard"])
        XCTAssertEqual(shot.mode, .screen)
        XCTAssertEqual(shot.destination, .clipboard)

        let sel = ScreencaptureInvocation(arguments: ["-pdinc", "-z", "keyboard.selection.clipboard"])
        XCTAssertEqual(sel.mode, .selection)
        XCTAssertEqual(sel.destination, .clipboard)
        XCTAssertTrue(sel.interactive)
    }

    func testCLIInvocations() {
        let plain = ScreencaptureInvocation(arguments: ["/tmp/out.png"])
        XCTAssertEqual(plain.mode, .screen)
        XCTAssertEqual(plain.destination, .file)
        XCTAssertFalse(plain.interactive)

        let interactive = ScreencaptureInvocation(arguments: ["-i", "/tmp/out.png"])
        XCTAssertEqual(interactive.mode, .selection)
        XCTAssertTrue(interactive.interactive)

        let clipboard = ScreencaptureInvocation(arguments: ["-c"])
        XCTAssertEqual(clipboard.destination, .clipboard)

        let windowSel = ScreencaptureInvocation(arguments: ["-iw", "/tmp/w.png"])
        XCTAssertTrue(windowSel.interactive)
    }

    func testExplicitRectAndWindow() {
        let rect = ScreencaptureInvocation(arguments: ["-R", "10,20,300,200", "/tmp/r.png"])
        XCTAssertEqual(rect.explicitRect, CGRect(x: 10, y: 20, width: 300, height: 200))
        XCTAssertEqual(rect.mode, .selection)
        XCTAssertFalse(rect.interactive)

        let badRect = ScreencaptureInvocation(arguments: ["-R", "10,20,abc", "/tmp/r.png"])
        XCTAssertNil(badRect.explicitRect)

        let window = ScreencaptureInvocation(arguments: ["-l", "1234", "/tmp/w.png"])
        XCTAssertEqual(window.windowID, 1234)
        XCTAssertEqual(window.mode, .window)

        let badWindow = ScreencaptureInvocation(arguments: ["-l", "notanumber"])
        XCTAssertNil(badWindow.windowID)
    }

    func testTrailingFlagWithoutValueDoesNotCrash() {
        for args in [["-z"], ["-R"], ["-l"], []] {
            _ = ScreencaptureInvocation(arguments: args)
        }
    }

    func testProcessArgumentsOfSelf() throws {
        // KERN_PROCARGS2 on our own pid works without any TCC permission.
        let args = try XCTUnwrap(ScreenshotProcessScan.arguments(of: getpid()))
        XCTAssertEqual(args, Array(CommandLine.arguments.dropFirst()))
        XCTAssertNil(ScreenshotProcessScan.arguments(of: -1))
    }

    func testProcessScanDoesNotCrash() {
        _ = ScreenshotProcessScan.scan()
    }
}
