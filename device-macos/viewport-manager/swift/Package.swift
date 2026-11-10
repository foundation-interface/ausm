// swift-tools-version: 5.9
import PackageDescription
import Foundation

// Unit tests live in Tests/ in the git repo but are not shipped in the npm tarball;
// only declare the test target when the directory exists so the published sources still build.
let hasTests = FileManager.default.fileExists(atPath: Context.packageDirectory + "/Tests/ViewportHelperTests")

var targets: [Target] = [
    .executableTarget(
        name: "ViewportHelper",
        path: "Sources/ViewportHelper"
    ),
]
if hasTests {
    targets.append(.testTarget(
        name: "ViewportHelperTests",
        dependencies: ["ViewportHelper"],
        path: "Tests/ViewportHelperTests"
    ))
}

let package = Package(
    name: "ViewportHelper",
    platforms: [.macOS(.v12)],
    targets: targets
)
