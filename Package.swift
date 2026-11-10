// swift-tools-version: 5.9
import PackageDescription

// Swift Package Manager entry point for AUSM's native macOS kits.
//
// SwiftPM only resolves a manifest at the repository root, so this file is what makes
//
//   .package(url: "https://github.com/foundation-interface/AUSM.git", from: "0.1.0")
//   .product(name: "ScreenshotMonitorKit", package: "AUSM")
//   .product(name: "CursorMonitorKit", package: "AUSM")
//
// work for native (SwiftUI/AppKit) hosts that want to run the monitors in-process. The kits are
// compiled from source and statically linked into the host app; nothing from AUSM is needed at
// run time. The per-service packages under device-macos/*/swift remain the build units for the
// JSON-lines helper executables used by the npm packages.
let package = Package(
    name: "AUSM",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ScreenshotMonitorKit", targets: ["ScreenshotMonitorKit"]),
        .library(name: "CursorMonitorKit", targets: ["CursorMonitorKit"]),
    ],
    targets: [
        .target(
            name: "ScreenshotMonitorKit",
            path: "device-macos/screenshot-detector/swift/Sources/ScreenshotMonitorKit"
        ),
        .target(
            name: "CursorMonitorKit",
            path: "device-macos/cursor-plus-plus/swift/Sources/CursorMonitorKit"
        ),
        .testTarget(
            name: "ScreenshotMonitorKitTests",
            dependencies: ["ScreenshotMonitorKit"],
            path: "device-macos/screenshot-detector/swift/Tests/ScreenshotMonitorKitTests"
        ),
        .testTarget(
            name: "CursorMonitorKitTests",
            dependencies: ["CursorMonitorKit"],
            path: "device-macos/cursor-plus-plus/swift/Tests/CursorMonitorKitTests"
        ),
    ]
)
