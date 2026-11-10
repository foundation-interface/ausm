// swift-tools-version: 5.9
import PackageDescription
import Foundation

// Unit tests live in Tests/ in the git repo but are not shipped in the npm tarball;
// only declare the test target when the directory exists so the published sources still build.
let hasTests = FileManager.default.fileExists(atPath: Context.packageDirectory + "/Tests/TextInputHelperTests")

var targets: [Target] = [
    .executableTarget(
        name: "TextInputHelper",
        path: "Sources/TextInputHelper"
    ),
]
if hasTests {
    targets.append(.testTarget(
        name: "TextInputHelperTests",
        dependencies: ["TextInputHelper"],
        path: "Tests/TextInputHelperTests"
    ))
}

let package = Package(
    name: "TextInputHelper",
    platforms: [.macOS(.v12)],
    targets: targets
)
