// swift-tools-version: 5.9
import Foundation
import PackageDescription

// Two products:
//   - CursorMonitorKit: a library so native macOS hosts can run the cursor monitor
//     in-process and receive typed events (plus the live AXUIElement under the cursor).
//   - CursorHelper: the standalone JSON-lines subprocess used by the
//     @ausm/device-macos-cursor-plus-plus Node wrapper.
let package = Package(
    name: "CursorHelper",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "CursorMonitorKit", targets: ["CursorMonitorKit"]),
        .executable(name: "CursorHelper", targets: ["CursorHelper"]),
    ],
    targets: [
        .target(
            name: "CursorMonitorKit",
            path: "Sources/CursorMonitorKit"
        ),
        .executableTarget(
            name: "CursorHelper",
            dependencies: ["CursorMonitorKit"],
            path: "Sources/CursorHelper"
        ),
    ]
)

// Pure-logic XCTests (no TCC permissions needed). Tests/ is not shipped in the npm tarball,
// so the target is only declared when the directory exists.
if FileManager.default.fileExists(atPath: Context.packageDirectory + "/Tests") {
    package.targets.append(.testTarget(
        name: "CursorMonitorKitTests",
        dependencies: ["CursorMonitorKit"],
        path: "Tests/CursorMonitorKitTests"
    ))
}
