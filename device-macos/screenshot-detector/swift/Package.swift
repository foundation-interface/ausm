// swift-tools-version: 5.9
import Foundation
import PackageDescription

// Two products:
//   - ScreenshotMonitorKit: a library so native macOS hosts (SwiftUI/AppKit apps)
//     can run the monitor in-process and receive CGImages directly.
//   - ScreenshotHelper: the standalone JSON-lines subprocess used by the
//     @ausm/device-macos-screenshot-detector Node wrapper.
let package = Package(
    name: "ScreenshotHelper",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ScreenshotMonitorKit", targets: ["ScreenshotMonitorKit"]),
        .executable(name: "ScreenshotHelper", targets: ["ScreenshotHelper"]),
    ],
    targets: [
        .target(
            name: "ScreenshotMonitorKit",
            path: "Sources/ScreenshotMonitorKit"
        ),
        .executableTarget(
            name: "ScreenshotHelper",
            dependencies: ["ScreenshotMonitorKit"],
            path: "Sources/ScreenshotHelper"
        ),
    ]
)

// Pure-logic XCTests (no TCC permissions needed). Tests/ is not shipped in the npm tarball,
// so the target is only declared when the directory exists.
if FileManager.default.fileExists(atPath: Context.packageDirectory + "/Tests") {
    package.targets.append(.testTarget(
        name: "ScreenshotMonitorKitTests",
        dependencies: ["ScreenshotMonitorKit"],
        path: "Tests/ScreenshotMonitorKitTests"
    ))
}
