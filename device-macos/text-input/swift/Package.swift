// swift-tools-version: 5.9
import Foundation
import PackageDescription

// Two products:
//   - TextInputMonitorKit: a library so native macOS hosts can run the text-input monitor
//     in-process and receive typed events.
//   - TextInputHelper: the standalone JSON-lines subprocess used by the
//     @ausm/device-macos-text-input Node wrapper.
let package = Package(
    name: "TextInputHelper",
    platforms: [.macOS(.v12)],
    products: [
        .library(name: "TextInputMonitorKit", targets: ["TextInputMonitorKit"]),
        .executable(name: "TextInputHelper", targets: ["TextInputHelper"]),
    ],
    targets: [
        .target(
            name: "TextInputMonitorKit",
            path: "Sources/TextInputMonitorKit"
        ),
        .executableTarget(
            name: "TextInputHelper",
            dependencies: ["TextInputMonitorKit"],
            path: "Sources/TextInputHelper"
        ),
    ]
)

// Pure-logic XCTests (no TCC permissions needed). Tests/ is not shipped in the npm tarball,
// so the target is only declared when the directory exists.
if FileManager.default.fileExists(atPath: Context.packageDirectory + "/Tests") {
    package.targets.append(.testTarget(
        name: "TextInputMonitorKitTests",
        dependencies: ["TextInputMonitorKit"],
        path: "Tests/TextInputMonitorKitTests"
    ))
}
