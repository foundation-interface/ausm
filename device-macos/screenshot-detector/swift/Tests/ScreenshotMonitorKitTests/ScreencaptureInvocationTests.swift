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

final class ScreencaptureInvocationEdgeTests: XCTestCase {
    func testInteractiveWindowOnlyIsWindowMode() {
        // Regression: -iw (window selection only) was classified as region selection.
        let inv = ScreencaptureInvocation(arguments: ["-iw", "/tmp/w.png"])
        XCTAssertEqual(inv.mode, .window)
        XCTAssertTrue(inv.interactive)
        let split = ScreencaptureInvocation(arguments: ["-i", "-w"])
        XCTAssertEqual(split.mode, .window)
    }

    func testWindowFlagWithExplicitReasonKeepsReason() {
        let inv = ScreencaptureInvocation(arguments: ["-pdinw", "-z", "keyboard.selection"])
        XCTAssertEqual(inv.mode, .selection)
    }

    func testNegativeRectForDisplayLeftOfMain() {
        let inv = ScreencaptureInvocation(arguments: ["-R", "-1920,-300,800.5,600", "/tmp/r.png"])
        XCTAssertEqual(inv.explicitRect, CGRect(x: -1920, y: -300, width: 800.5, height: 600))
        XCTAssertEqual(inv.mode, .selection)
        XCTAssertEqual(inv.destination, .file)
    }

    func testRectWithWrongArityIsIgnored() {
        XCTAssertNil(ScreencaptureInvocation(arguments: ["-R", "1,2,3,4,5"]).explicitRect)
        XCTAssertNil(ScreencaptureInvocation(arguments: ["-R", ""]).explicitRect)
        XCTAssertNil(ScreencaptureInvocation(arguments: ["-R", "1, 2, 3, 4"]).explicitRect)
    }

    func testRectValueIsNotParsedAsFlags() {
        // "-R" consumes its value even when the value starts with "-" (contains a 'c').
        let inv = ScreencaptureInvocation(arguments: ["-R", "-1,-2,3,4"])
        XCTAssertNotEqual(inv.destination, .clipboard)
    }

    func testWindowIdBounds() {
        XCTAssertEqual(ScreencaptureInvocation(arguments: ["-l", "4294967295"]).windowID, UInt32.max)
        XCTAssertNil(ScreencaptureInvocation(arguments: ["-l", "4294967296"]).windowID)
        XCTAssertNil(ScreencaptureInvocation(arguments: ["-l", "-5"]).windowID)
        XCTAssertNil(ScreencaptureInvocation(arguments: ["-l", ""]).windowID)
    }

    func testUnknownReasonFallsBackToFlags() {
        let inv = ScreencaptureInvocation(arguments: ["-i", "-z", "toolbar.something"])
        XCTAssertEqual(inv.mode, .selection)
        let screen = ScreencaptureInvocation(arguments: ["-z", "keyboard.weird"])
        XCTAssertEqual(screen.mode, .screen)
    }

    func testClipboardSuffixWithoutKeyboardPrefix() {
        let inv = ScreencaptureInvocation(arguments: ["-z", "other.clipboard"])
        XCTAssertEqual(inv.destination, .clipboard)
    }

    func testLastReasonWins() {
        let inv = ScreencaptureInvocation(arguments: ["-z", "keyboard.screen", "-z", "keyboard.selection"])
        XCTAssertEqual(inv.mode, .selection)
    }

    func testLongOptionsAndUnicodePathsAreNotFlags() {
        let inv = ScreencaptureInvocation(arguments: ["--clipboard", "/tmp/📸 Скриншот.png"])
        XCTAssertEqual(inv.destination, .file)
        XCTAssertEqual(inv.mode, .screen)
        XCTAssertFalse(inv.interactive)
    }

    func testDelayAndFormatValuesAreNotPaths() {
        let inv = ScreencaptureInvocation(arguments: ["-T", "5", "-t", "jpg"])
        XCTAssertEqual(inv.mode, .screen)
        XCTAssertEqual(inv.destination, .file)
    }

    func testCmdShift5WithClipboardFlag() {
        let inv = ScreencaptureInvocation(arguments: ["-pdiUc", "-z", "keyboard.interactive.clipboard"])
        XCTAssertEqual(inv.mode, .interactive)
        XCTAssertEqual(inv.destination, .clipboard)
        XCTAssertTrue(inv.interactive)
    }
}

final class ProcArgsParsingTests: XCTestCase {
    private func buffer(argc: Int32, exec: String, padding: Int = 3, args: [String], env: [String] = []) -> [UInt8] {
        var b = withUnsafeBytes(of: argc.littleEndian) { Array($0) }
        b += Array(exec.utf8) + [UInt8](repeating: 0, count: padding)
        for a in args + env { b += Array(a.utf8) + [0] }
        return b
    }

    func testDecodesArgvAndSkipsEnvironment() {
        let b = buffer(argc: 4, exec: "/usr/sbin/screencapture",
                       args: ["screencapture", "-pdin", "-z", "keyboard.selection"], env: ["HOME=/Users/x"])
        XCTAssertEqual(ScreenshotProcessScan.parseProcArgs(b), ["-pdin", "-z", "keyboard.selection"])
    }

    func testEmptyArgumentsArePreserved() {
        let b = buffer(argc: 3, exec: "/bin/x", padding: 1, args: ["x", "", "-c"])
        XCTAssertEqual(ScreenshotProcessScan.parseProcArgs(b), ["", "-c"])
    }

    func testUnicodeAndInvalidUTF8() {
        var b = buffer(argc: 2, exec: "/bin/x", args: ["x", "/tmp/スクショ.png"])
        XCTAssertEqual(ScreenshotProcessScan.parseProcArgs(b), ["/tmp/スクショ.png"])
        b = buffer(argc: 2, exec: "/bin/x", args: ["x"]) + [0xFF, 0xFE, 0]
        XCTAssertEqual(ScreenshotProcessScan.parseProcArgs(b)?.count, 1, "invalid UTF-8 is replaced, not dropped")
    }

    func testTooShortOrMalformedBuffers() {
        XCTAssertNil(ScreenshotProcessScan.parseProcArgs([]))
        XCTAssertNil(ScreenshotProcessScan.parseProcArgs([1, 0, 0, 0]))
        // argc larger than the strings present: returns what is there, never reads past the end.
        let truncated = buffer(argc: 50, exec: "/bin/x", args: ["x", "-a"])
        XCTAssertEqual(ScreenshotProcessScan.parseProcArgs(truncated), ["-a"])
        // Unterminated final string is not reported as an argument.
        var cut = buffer(argc: 3, exec: "/bin/x", args: ["x", "-a"])
        cut += Array("-partial".utf8)
        XCTAssertEqual(ScreenshotProcessScan.parseProcArgs(cut), ["-a"])
        // Zero / negative argc.
        XCTAssertEqual(ScreenshotProcessScan.parseProcArgs(buffer(argc: 0, exec: "/bin/x", args: ["x"])), [])
        XCTAssertEqual(ScreenshotProcessScan.parseProcArgs(buffer(argc: -1, exec: "/bin/x", args: ["x"])), [])
        // Only the exec path, no NUL at all.
        XCTAssertEqual(ScreenshotProcessScan.parseProcArgs(withUnsafeBytes(of: Int32(2)) { Array($0) } + Array("/bin/x".utf8)), [])
    }

    func testOriginFromArgv() {
        XCTAssertEqual(ScreencaptureInvocation(arguments: ["-pd", "-z", "keyboard.screen"]).origin, .hotkey)
        XCTAssertEqual(ScreencaptureInvocation(arguments: ["-pdinc", "-z", "keyboard.selection.clipboard"]).origin, .hotkey)
        XCTAssertEqual(ScreencaptureInvocation(arguments: ["-pdiU", "-z", "keyboard.interactive"]).origin, .hotkey)
        XCTAssertEqual(ScreencaptureInvocation(arguments: ["-x", "/tmp/a.png"]).origin, .cli)
        XCTAssertEqual(ScreencaptureInvocation(arguments: ["-i"]).origin, .cli)
        XCTAssertEqual(ScreencaptureInvocation(arguments: ["-z", "touchbar"]).origin, .cli)
        XCTAssertEqual(ScreencaptureInvocation(arguments: ["-z"]).origin, .cli)
        XCTAssertEqual(ScreencaptureInvocation(arguments: []).origin, .unknown)
    }
}
