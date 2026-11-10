import XCTest
@testable import ScreenCaptureHelper

final class ProtocolTests: XCTestCase {
    private func parse(_ s: String, eof: Bool = false) -> CommandFraming.Result {
        CommandFraming.parse(Data(s.utf8), eof: eof)
    }

    func testCompleteObjectWithAndWithoutNewline() {
        guard case .complete(let a) = parse(#"{"command":"status"}"#) else { return XCTFail() }
        XCTAssertEqual(a["command"] as? String, "status")
        guard case .complete(let b) = parse("{\"command\":\"stop\"}\n") else { return XCTFail() }
        XCTAssertEqual(b["command"] as? String, "stop")
    }

    func testIncompleteUntilEofOrNewline() {
        guard case .incomplete = parse(#"{"command":"sta"#) else { return XCTFail() }
        guard case .invalid = parse(#"{"command":"sta"#, eof: true) else { return XCTFail() }
        guard case .invalid = parse("{\"command\"\n") else { return XCTFail() }
        guard case .incomplete = parse("") else { return XCTFail() }
        guard case .invalid = parse("", eof: true) else { return XCTFail() }
    }

    func testRejectsNonObjectsAndOversize() {
        guard case .invalid = parse("[1,2,3]") else { return XCTFail() }
        guard case .invalid = parse("\"str\"\n") else { return XCTFail() }
        let huge = Data(repeating: 0x20, count: CommandFraming.maxRequestBytes + 1)
        guard case .invalid = CommandFraming.parse(huge, eof: false) else { return XCTFail() }
    }

    func testParamInt() {
        XCTAssertEqual(Param.int(NSNumber(value: 30), in: 1...120), 30)
        XCTAssertNil(Param.int(NSNumber(value: 0), in: 1...120))
        XCTAssertNil(Param.int(NSNumber(value: -5), in: 0...10))
        XCTAssertNil(Param.int(NSNumber(value: 29.97), in: 1...120))
        XCTAssertNil(Param.int(NSNumber(value: true), in: 0...10))
        XCTAssertNil(Param.int("30", in: 1...120))
        XCTAssertNil(Param.int(NSNumber(value: Double.infinity), in: 0...10))
        XCTAssertNil(Param.int(NSNumber(value: 1e30), in: ConfigLimits.windowId))
    }

    func testParamDoubleClamps() {
        XCTAssertEqual(Param.double(NSNumber(value: 1.7), clampedTo: 0...1), 1.0)
        XCTAssertEqual(Param.double(NSNumber(value: -1), clampedTo: 0...1), 0.0)
        XCTAssertNil(Param.double(NSNumber(value: Double.nan), clampedTo: 0...1))
        XCTAssertNil(Param.double(nil, clampedTo: 0...1))
    }

    func testStringArray() {
        XCTAssertEqual(Param.stringArray(["display-1", "display-2"]), ["display-1", "display-2"])
        XCTAssertNil(Param.stringArray(["display-1", 2]))
        XCTAssertNil(Param.stringArray("display-1"))
    }

    func testConfigUpdateFromJSON() throws {
        let json = #"""
        {"fps": 10, "targetHeight": 1080, "enableRecording": false, "outputDirectory": "",
         "sharedMemoryName": "/ausm-frames", "frameCount": 5, "socketPath": "/tmp/x", "debug": false}
        """#
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let u = CaptureConfigUpdate(obj)
        XCTAssertEqual(u.fps, 10)
        XCTAssertEqual(u.targetHeight, 1080)
        XCTAssertEqual(u.enableRecording, false)
        XCTAssertEqual(u.outputDirectory, "")
        XCTAssertEqual(u.sharedMemoryName, "/ausm-frames")
        XCTAssertEqual(u.frameCount, 5)
        XCTAssertEqual(u.rejected, [])  // unknown keys are ignored, not rejected
    }

    func testConfigUpdateRejectsInvalidValues() throws {
        let json = #"""
        {"fps": -1, "targetHeight": 99999, "enableRecording": 1, "frameCount": 0,
         "sharedMemoryName": "no-slash"}
        """#
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let u = CaptureConfigUpdate(obj)
        XCTAssertNil(u.fps)
        XCTAssertNil(u.targetHeight)
        XCTAssertNil(u.enableRecording)
        XCTAssertNil(u.frameCount)
        XCTAssertNil(u.sharedMemoryName)
        XCTAssertEqual(u.rejected, ["enableRecording", "fps", "frameCount", "sharedMemoryName", "targetHeight"])
    }

    func testSharedMemoryNameMustLeaveRoomForRegistrySuffix() {
        // "/" + 21 chars + "-registry" = 31 bytes: OK; one more is too long.
        XCTAssertEqual(CaptureConfigUpdate(["sharedMemoryName": "/" + String(repeating: "a", count: 21)]).rejected, [])
        XCTAssertEqual(CaptureConfigUpdate(["sharedMemoryName": "/" + String(repeating: "a", count: 22)]).rejected,
                       ["sharedMemoryName"])
        XCTAssertEqual(CaptureConfigUpdate(["sharedMemoryName": ""]).sharedMemoryName, "")
    }
}
