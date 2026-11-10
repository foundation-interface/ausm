// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ScreenCaptureHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .target(
            name: "CHelpers",
            path: "Sources/CHelpers",
            publicHeadersPath: "include"
        ),
        .executableTarget(
            name: "ScreenCaptureHelper",
            dependencies: ["CHelpers"],
            path: "Sources/ScreenCaptureHelper",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Accelerate"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("AppKit"),
                .linkedFramework("IOKit"),
            ]
        ),
        // Pure-logic tests (layout math, SHM encoding, command parsing).
        // They create private POSIX shm segments but need no TCC permissions.
        .testTarget(
            name: "ScreenCaptureHelperTests",
            dependencies: ["ScreenCaptureHelper"],
            path: "Tests/ScreenCaptureHelperTests"
        ),
    ]
)
