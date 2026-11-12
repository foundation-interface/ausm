// swift-tools-version: 5.9
import Foundation
import PackageDescription

// Two products:
//   - WindowMonitorKit: a library so native macOS hosts can run the window monitor
//     in-process and receive typed window / Space / permission events.
//   - ViewportHelper: the standalone JSON-lines subprocess used by the
//     @ausm/device-macos-viewport-manager Node wrapper.
let package = Package(
    name: "ViewportHelper",
    platforms: [.macOS(.v12)],
    products: [
        .library(name: "WindowMonitorKit", targets: ["WindowMonitorKit"]),
        .executable(name: "ViewportHelper", targets: ["ViewportHelper"]),
    ],
    targets: [
        .target(
            name: "WindowMonitorKit",
            path: "Sources/WindowMonitorKit"
        ),
        .executableTarget(
            name: "ViewportHelper",
            dependencies: ["WindowMonitorKit"],
            path: "Sources/ViewportHelper"
        ),
    ]
)

// Pure-logic XCTests (no TCC permissions needed). Tests/ is not shipped in the npm tarball,
// so the target is only declared when the directory exists.
if FileManager.default.fileExists(atPath: Context.packageDirectory + "/Tests") {
    package.targets.append(.testTarget(
        name: "WindowMonitorKitTests",
        dependencies: ["WindowMonitorKit"],
        path: "Tests/WindowMonitorKitTests"
    ))
}
