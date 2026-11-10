// swift-tools-version: 5.9
import PackageDescription

// Swift Package Manager entry point for AUSM's native macOS kits.
//
// SwiftPM only resolves a manifest at the repository root, so this file is what makes
//
//   .package(url: "https://github.com/foundation-interface/AUSM.git", from: "0.1.0")
//   .product(name: "ScreenshotMonitorKit", package: "AUSM")
//   .product(name: "CursorMonitorKit", package: "AUSM")
//   .product(name: "ClipboardMonitorKit", package: "AUSM")
//   .product(name: "WindowMonitorKit", package: "AUSM")
//   .product(name: "TextInputMonitorKit", package: "AUSM")
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
        .library(name: "ClipboardMonitorKit", targets: ["ClipboardMonitorKit"]),
        .library(name: "WindowMonitorKit", targets: ["WindowMonitorKit"]),
        .library(name: "TextInputMonitorKit", targets: ["TextInputMonitorKit"]),
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
        .target(
            name: "ClipboardMonitorKit",
            path: "device-macos/clipboard-monitor/swift/Sources/ClipboardMonitorKit"
        ),
        .target(
            name: "WindowMonitorKit",
            path: "device-macos/viewport-manager/swift/Sources/WindowMonitorKit"
        ),
        .target(
            name: "TextInputMonitorKit",
            path: "device-macos/text-input/swift/Sources/TextInputMonitorKit"
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
        .testTarget(
            name: "ClipboardMonitorKitTests",
            dependencies: ["ClipboardMonitorKit"],
            path: "device-macos/clipboard-monitor/swift/Tests/ClipboardMonitorKitTests"
        ),
        .testTarget(
            name: "WindowMonitorKitTests",
            dependencies: ["WindowMonitorKit"],
            path: "device-macos/viewport-manager/swift/Tests/WindowMonitorKitTests"
        ),
        .testTarget(
            name: "TextInputMonitorKitTests",
            dependencies: ["TextInputMonitorKit"],
            path: "device-macos/text-input/swift/Tests/TextInputMonitorKitTests"
        ),
    ]
)
