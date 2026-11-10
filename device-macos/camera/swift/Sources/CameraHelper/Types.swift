import Foundation

// MARK: - Shared Memory Layout Constants
// Must match screen-stream so screen_stream_reader can attach. All integers are
// little-endian (native on every supported Mac). Bump SHM_VERSION / REGISTRY_VERSION
// whenever an offset or field meaning changes.
//
// Torn-read protocol for readers of a frame slot:
//   1. read `ready` (must be 1) and `frameNumber`
//   2. copy `byteLength` bytes of payload
//   3. re-read `ready` and `frameNumber`; discard the copy unless ready == 1 and
//      frameNumber is unchanged. The writer clears `ready` before touching a slot
//      and sets it again (after a full fence) only once header and payload are done.

/// SharedMemoryHeader binary layout (72 bytes total)
enum ShmHeaderLayout {
    static let magic      = 0   // UInt32
    static let version    = 4   // UInt32
    static let frameCount = 8   // UInt32
    static let frameSize  = 12  // UInt32
    static let width      = 16  // UInt32
    static let height     = 20  // UInt32
    static let format     = 24  // UInt32
    static let writeIndex = 28  // UInt32 (atomic)
    static let frameNumber = 32 // UInt64 (atomic)
    static let reserved   = 40  // UInt64[4]
    static let totalSize  = 72
}

/// FrameHeader binary layout (40 bytes total)
enum FrameHeaderLayout {
    static let timestamp   = 0   // UInt64
    static let frameNumber = 8   // UInt64
    static let displayId   = 16  // UInt32
    static let width       = 20  // UInt32
    static let height      = 24  // UInt32
    static let byteLength  = 28  // UInt32
    static let ready       = 32  // UInt32 (atomic)
    static let reserved    = 36  // UInt32
    static let totalSize   = 40
}

/// Registry header binary layout (48 bytes total)
enum RegistryHeaderLayout {
    static let magic          = 0   // UInt32
    static let version        = 4   // UInt32
    static let maxDisplays    = 8   // UInt32
    static let activeCount    = 12  // UInt32
    static let lastUpdateTime = 16  // UInt64
    static let reserved       = 24  // UInt32[6]
    static let totalSize      = 48
}

/// DisplayShmEntry binary layout (240 bytes total)
enum DisplayEntryLayout {
    static let displayId     = 0    // char[64]
    static let shmName       = 64   // char[128]
    static let width         = 192  // UInt32
    static let height        = 196  // UInt32
    static let active        = 200  // UInt32
    static let logicalWidth  = 204  // UInt32
    static let lastFrameTime = 208  // UInt64
    static let frameCount    = 216  // UInt64
    static let logicalHeight = 224  // UInt32
    static let reserved      = 228  // UInt32[3]
    static let totalSize     = 240
}

let SHM_MAGIC: UInt32 = 0x41555346      // 'AUSF'
let SHM_VERSION: UInt32 = 1
let REGISTRY_MAGIC: UInt32 = 0x41555352  // 'AUSR'
let REGISTRY_VERSION: UInt32 = 1
let MAX_DISPLAYS: UInt32 = 8

/// SHM segment permissions. Camera frames are sensitive, so only the owning user may map them.
let SHM_MODE: mode_t = 0o600

/// Pure size/offset arithmetic for the frame ring buffer (unit-tested).
enum ShmMath {
    static let bytesPerPixel = 4  // BGRA

    /// Payload bytes for one packed BGRA frame, or nil if it does not fit the UInt32 header field.
    static func frameDataSize(width: UInt32, height: UInt32) -> Int? {
        let (px, o1) = Int(width).multipliedReportingOverflow(by: Int(height))
        let (bytes, o2) = px.multipliedReportingOverflow(by: bytesPerPixel)
        guard !o1, !o2, bytes > 0, bytes <= Int(UInt32.max) else { return nil }
        return bytes
    }

    /// Total segment size: header + frameCount * (frame header + payload). Nil on overflow / bad input.
    static func totalSize(frameCount: UInt32, width: UInt32, height: UInt32) -> Int? {
        guard frameCount > 0, let data = frameDataSize(width: width, height: height) else { return nil }
        let slot = FrameHeaderLayout.totalSize + data
        let (slots, o) = Int(frameCount).multipliedReportingOverflow(by: slot)
        guard !o else { return nil }
        return ShmHeaderLayout.totalSize + slots
    }

    /// Byte offset of frame slot `index` given the per-frame payload size.
    static func frameOffset(index: UInt32, frameDataSize: Int) -> Int {
        ShmHeaderLayout.totalSize + Int(index) * (FrameHeaderLayout.totalSize + frameDataSize)
    }

    /// Registry segment size (header + MAX_DISPLAYS entries).
    static var registrySize: Int {
        RegistryHeaderLayout.totalSize + Int(MAX_DISPLAYS) * DisplayEntryLayout.totalSize
    }
}

// MARK: - Command parameter parsing

/// Parses and clamps numeric command parameters. JSON numbers arrive as NSNumber/Int/Double;
/// negative or absurd values must never reach a UInt32 conversion (which would trap).
enum ConfigValue {
    static let fpsRange: ClosedRange<Int> = 1...60
    static let targetHeightRange: ClosedRange<Int> = 2...4320
    static let frameCountRange: ClosedRange<Int> = 2...32

    static func int(_ value: Any?) -> Int? {
        let d: Double
        switch value {
        case let v as Int: return v
        case let v as Double: d = v
        case let v as NSNumber: d = v.doubleValue
        default: return nil
        }
        guard d.isFinite, abs(d) < 1e9 else { return nil }
        return Int(d)
    }

    static func clamped(_ value: Any?, to range: ClosedRange<Int>) -> UInt32? {
        guard let v = int(value) else { return nil }
        return UInt32(min(max(v, range.lowerBound), range.upperBound))
    }

    static func jpegQuality(_ value: Any?) -> Double {
        let q: Double
        switch value {
        case let v as Double: q = v
        case let v as Int: q = Double(v)
        case let v as NSNumber: q = v.doubleValue
        default: q = 0.7
        }
        guard q.isFinite else { return 0.7 }
        return min(max(q, 0.05), 1.0)
    }
}

/// Copies a NUL-terminated string out of a fixed-size C buffer without reading past `maxLength`.
func readFixedCString(_ ptr: UnsafeRawPointer, maxLength: Int) -> String {
    let bytes = UnsafeRawBufferPointer(start: ptr, count: maxLength)
    let len = bytes.firstIndex(of: 0) ?? maxLength
    return String(decoding: bytes.prefix(len), as: UTF8.self)
}

/// Writes `string` into a fixed-size C buffer, truncating at a byte boundary
/// so that a terminating NUL always fits.
func writeFixedCString(_ string: String, to ptr: UnsafeMutableRawPointer, maxLength: Int) {
    memset(ptr, 0, maxLength)
    let utf8 = Array(string.utf8.prefix(maxLength - 1))
    utf8.withUnsafeBytes { src in
        if let base = src.baseAddress { memcpy(ptr, base, src.count) }
    }
}
