import Foundation
import CoreGraphics

// MARK: - Display Types

struct DisplayInfo {
    let id: String
    let displayId: CGDirectDisplayID
    var width: UInt32
    var height: UInt32
    var isMain: Bool
    var isBuiltIn: Bool
    var scaleFactor: Double
    var refreshRate: Double

    static func makeId(_ displayId: CGDirectDisplayID) -> String {
        "display-\(displayId)"
    }
}

enum DisplayChangeType {
    case added, removed, reconfigured
}

struct DisplayChangeEvent {
    let type: DisplayChangeType
    let displayId: String
    var info: DisplayInfo?
}

// MARK: - Frame Types

struct FrameData {
    let displayId: UInt32
    let timestamp: UInt64
    let width: UInt32
    let height: UInt32
    let data: UnsafePointer<UInt8>
    let dataSize: Int
    let bytesPerRow: Int
    let frameNumber: UInt64
}

// MARK: - Video Types

enum VideoCodec {
    case h264, hevc
}

// MARK: - Shared Memory Layout Constants
//
// All multi-byte fields are little-endian (native on Apple Silicon and Intel).
// Readers (internal-lib/screen-stream-reader, camera helper) depend on these
// offsets — do not move fields; only claim bytes from the `reserved` areas.

/// SharedMemoryHeader binary layout (72 bytes total)
enum ShmHeaderLayout {
    static let magic      = 0   // UInt32
    static let version    = 4   // UInt32
    static let frameCount = 8   // UInt32  (ring slots)
    static let frameSize  = 12  // UInt32  (max pixel bytes per slot = width*height*4)
    static let width      = 16  // UInt32
    static let height     = 20  // UInt32
    static let format     = 24  // UInt32  (0 = BGRA8888)
    static let writeIndex = 28  // UInt32  (next slot to write, monotonically increasing)
    static let frameNumber = 32 // UInt64  (next frame number to assign)
    /// UInt64 segment generation (creation time in µs since 1970, never 0 for
    /// this producer). Lives in reserved[0]; 0 means "unknown/older producer".
    /// Readers compare it against a freshly opened segment of the same name to
    /// detect that the segment was unlinked and recreated (helper restart).
    static let generation = 40
    static let reserved   = 48  // UInt64[3]
    static let totalSize  = 72
}

/// FrameHeader binary layout (40 bytes total). Each ring slot is
/// FrameHeaderLayout.totalSize bytes of header followed by `frameSize` bytes
/// of tightly packed BGRA pixels (row stride = width*4).
///
/// Torn-read protocol: the writer stores ready=0, a full barrier, the pixels,
/// the header fields (incl. a new unique frameNumber), a full barrier, then
/// ready=1. A reader copies the pixels, then re-reads ready and frameNumber;
/// if ready is still 1 and frameNumber is unchanged the copy is consistent.
enum FrameHeaderLayout {
    static let timestamp   = 0   // UInt64  (presentation time, µs, host clock)
    static let frameNumber = 8   // UInt64
    static let displayId   = 16  // UInt32  (always 0 for per-display segments)
    static let width       = 20  // UInt32
    static let height      = 24  // UInt32
    static let byteLength  = 28  // UInt32
    static let ready       = 32  // UInt32
    static let reserved    = 36  // UInt32
    static let totalSize   = 40
}

/// Registry header binary layout (48 bytes total)
enum RegistryHeaderLayout {
    static let magic          = 0   // UInt32
    static let version        = 4   // UInt32
    static let maxDisplays    = 8   // UInt32
    static let activeCount    = 12  // UInt32
    static let lastUpdateTime = 16  // UInt64  (µs since 1970)
    static let reserved       = 24  // UInt32[6]
    static let totalSize      = 48
}

/// DisplayShmEntry binary layout (240 bytes total)
enum DisplayEntryLayout {
    static let displayId     = 0    // char[64], NUL-terminated
    static let displayIdSize = 64
    static let shmName       = 64   // char[128], NUL-terminated
    static let shmNameSize   = 128
    static let width         = 192  // UInt32  (frame/capture pixel width)
    static let height        = 196  // UInt32  (frame/capture pixel height)
    static let active        = 200  // UInt32
    static let logicalWidth  = 204  // UInt32  (display logical/point width, for scale calculation)
    static let lastFrameTime = 208  // UInt64
    static let frameCount    = 216  // UInt64
    static let logicalHeight = 224  // UInt32  (display logical/point height, for scale calculation)
    static let reserved      = 228  // UInt32[3]
    static let totalSize     = 240
}

// Shared memory magic numbers
let SHM_MAGIC: UInt32 = 0x41555346      // 'AUSF'
let SHM_VERSION: UInt32 = 1
let REGISTRY_MAGIC: UInt32 = 0x41555352  // 'AUSR'
let REGISTRY_VERSION: UInt32 = 1
let MAX_DISPLAYS: UInt32 = 8

/// macOS limits POSIX shared memory names to PSHMNAMLEN (31) bytes,
/// including the leading '/'. Longer names fail with ENAMETOOLONG.
let SHM_NAME_MAX_LENGTH = 31

// MARK: - Shared Memory Size Math (pure, unit-tested)

enum ShmMath {
    /// Bytes of pixel data for one BGRA frame, or nil if it doesn't fit the
    /// UInt32 `frameSize` header field.
    static func frameDataSize(width: UInt32, height: UInt32) -> Int? {
        let (wh, o1) = Int(width).multipliedReportingOverflow(by: Int(height))
        let (bytes, o2) = wh.multipliedReportingOverflow(by: 4)
        guard !o1, !o2, bytes <= Int(UInt32.max) else { return nil }
        return bytes
    }

    /// Size of one ring slot (frame header + pixel data).
    static func slotSize(frameDataSize: Int) -> Int {
        FrameHeaderLayout.totalSize + frameDataSize
    }

    /// Total segment size, or nil on invalid input / overflow.
    static func totalSize(frameCount: UInt32, width: UInt32, height: UInt32) -> Int? {
        guard frameCount > 0, width > 0, height > 0,
              let data = frameDataSize(width: width, height: height) else { return nil }
        let (ring, o) = Int(frameCount).multipliedReportingOverflow(by: slotSize(frameDataSize: data))
        guard !o else { return nil }
        return ShmHeaderLayout.totalSize + ring
    }

    /// Byte offset of slot `index` (its frame header).
    static func slotOffset(index: UInt32, frameDataSize: Int) -> Int {
        ShmHeaderLayout.totalSize + Int(index) * slotSize(frameDataSize: frameDataSize)
    }

    static var registrySize: Int {
        RegistryHeaderLayout.totalSize + Int(MAX_DISPLAYS) * DisplayEntryLayout.totalSize
    }

    /// Whether `name` is a valid POSIX shm name on macOS ("/x", no other '/').
    static func isValidShmName(_ name: String) -> Bool {
        guard name.hasPrefix("/"), name.utf8.count >= 2, name.utf8.count <= SHM_NAME_MAX_LENGTH else {
            return false
        }
        return !name.dropFirst().contains("/")
    }

    /// Capture dimensions for a display given its native pixel size and the
    /// requested target height (0 = native). Result is rounded up to even
    /// values (required by H.264) and never zero.
    static func captureSize(pixelWidth: Int, pixelHeight: Int, targetHeight: UInt32) -> (width: Int, height: Int) {
        let pw = max(pixelWidth, 2), ph = max(pixelHeight, 2)
        var w: Int, h: Int
        if targetHeight == 0 || Int(targetHeight) >= ph {
            w = pw; h = ph
        } else {
            let scale = Double(targetHeight) / Double(ph)
            w = max(2, Int(Double(pw) * scale))
            h = max(2, Int(targetHeight))
        }
        w = (w + 1) & ~1
        h = (h + 1) & ~1
        return (w, h)
    }
}

/// Microseconds since 1970 (used for registry timestamps and generations).
func currentEpochMicros() -> UInt64 {
    UInt64(max(0, Date().timeIntervalSince1970 * 1_000_000))
}
