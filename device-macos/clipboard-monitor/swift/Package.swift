// swift-tools-version: 5.9
import Foundation
import PackageDescription

let package = Package(
    name: "ClipboardHelper",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "ClipboardHelper",
            path: "Sources/ClipboardHelper"
        ),
    ]
)

// Pure-logic XCTests (no TCC permissions needed). Tests/ is not shipped in the npm tarball,
// so the target is only declared when the directory exists.
if FileManager.default.fileExists(atPath: Context.packageDirectory + "/Tests") {
    package.targets.append(.testTarget(
        name: "ClipboardHelperTests",
        dependencies: ["ClipboardHelper"],
        path: "Tests/ClipboardHelperTests"
    ))
}
