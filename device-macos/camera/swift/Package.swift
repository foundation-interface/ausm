// swift-tools-version: 5.9
import PackageDescription
import Foundation

// Unit tests live in Tests/ in the git repo but are not shipped in the npm tarball;
// only declare the test target when the directory exists so the published sources still build.
let hasTests = FileManager.default.fileExists(atPath: Context.packageDirectory + "/Tests/CameraHelperTests")

var targets: [Target] = [
    .target(
        name: "CHelpers",
        path: "Sources/CHelpers",
        publicHeadersPath: "include"
    ),
    .executableTarget(
        name: "CameraHelper",
        dependencies: ["CHelpers"],
        path: "Sources/CameraHelper",
        exclude: ["Info.plist"],
        linkerSettings: [
            .linkedFramework("AVFoundation"),
            .linkedFramework("CoreMedia"),
            .linkedFramework("CoreVideo"),
            .linkedFramework("CoreGraphics"),
            .linkedFramework("Accelerate"),
            .linkedFramework("ImageIO"),
        ]
    ),
]
if hasTests {
    targets.append(.testTarget(
        name: "CameraHelperTests",
        dependencies: ["CameraHelper"],
        path: "Tests/CameraHelperTests"
    ))
}

let package = Package(
    name: "CameraHelper",
    platforms: [.macOS(.v13)],
    targets: targets
)
