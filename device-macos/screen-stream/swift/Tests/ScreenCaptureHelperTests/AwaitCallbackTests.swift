import XCTest
@testable import ScreenCaptureHelper

/// CommandServer runs "start"/"stop" inside DispatchQueue.main.sync, so waits on
/// ScreenCaptureKit callbacks happen while the main queue is busy. These pin
/// down that such a wait still completes (it used to time out every time).
final class AwaitCallbackTests: XCTestCase {
    func testCompletesInsideAMainQueueBlock() {
        let finished = expectation(description: "main-queue block returned")
        var value: Int?
        DispatchQueue.global().async {
            DispatchQueue.main.sync {
                value = CaptureManager.awaitCallback(timeout: 2.0) { (done: @escaping (Int) -> Void) in
                    DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { done(42) }
                }
            }
            finished.fulfill()
        }
        wait(for: [finished], timeout: 5.0)
        XCTAssertEqual(value, 42)
    }

    func testTimesOutWhenTheCallbackNeverFires() {
        let started = Date()
        let value = CaptureManager.awaitCallback(timeout: 0.3) { (_: @escaping (Int) -> Void) in }
        XCTAssertNil(value)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2.0)
    }

    func testFirstValueWinsAndOptionalPayloadsSurvive() {
        let value = CaptureManager.awaitCallback(timeout: 1.0) { (done: @escaping (String?) -> Void) in
            done(nil)
            done("late")
        }
        XCTAssertNotNil(value, "a nil payload is still a completed callback")
        XCTAssertNil(value!)
    }
}
