// swift-tools-version: 5.9
import Foundation
import PackageDescription

// Two products:
//   - ClipboardMonitorKit: a library so native macOS hosts can run the clipboard monitor
//     in-process and receive typed events.
//   - ClipboardHelper: the standalone JSON-lines subprocess used by the
//     @ausm/device-macos-clipboard-monitor Node wrapper.
let package = Package(
    name: "ClipboardHelper",
    platforms: [.macOS(.v12)],
    products: [
        .library(name: "ClipboardMonitorKit", targets: ["ClipboardMonitorKit"]),
        .executable(name: "ClipboardHelper", targets: ["ClipboardHelper"]),
    ],
    targets: [
        .target(
            name: "ClipboardMonitorKit",
            path: "Sources/ClipboardMonitorKit"
        ),
        .executableTarget(
            name: "ClipboardHelper",
            dependencies: ["ClipboardMonitorKit"],
            path: "Sources/ClipboardHelper"
        ),
    ]
)

// Pure-logic XCTests (no TCC permissions needed). Tests/ is not shipped in the npm tarball,
// so the target is only declared when the directory exists.
if FileManager.default.fileExists(atPath: Context.packageDirectory + "/Tests") {
    package.targets.append(.testTarget(
        name: "ClipboardMonitorKitTests",
        dependencies: ["ClipboardMonitorKit"],
        path: "Tests/ClipboardMonitorKitTests"
    ))
}
