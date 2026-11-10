import Foundation

// MARK: - Command request framing (pure, unit-tested)

/// One request per connection: a single JSON object, optionally terminated by
/// "\n". The client may half-close or keep the connection open; the server
/// responds as soon as a complete object has been received.
enum CommandFraming {
    /// Requests larger than this are rejected.
    static let maxRequestBytes = 1 << 20

    enum Result {
        /// More bytes are needed.
        case incomplete
        /// A complete, valid JSON object.
        case complete([String: Any])
        /// Malformed (not JSON, not an object, or too large).
        case invalid(String)
    }

    /// Classify the bytes received so far. `eof` is true once the peer closed
    /// its write side (no more bytes will arrive).
    static func parse(_ data: Data, eof: Bool) -> Result {
        if data.count > maxRequestBytes {
            return .invalid("Request too large")
        }
        var body = data
        let newline = UInt8(ascii: "\n")
        let hasNewline: Bool
        if let nl = body.firstIndex(of: newline) {
            body = body[body.startIndex..<nl]
            hasNewline = true
        } else {
            hasNewline = false
        }
        if body.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) {
            return (eof || hasNewline) ? .invalid("Empty request") : .incomplete
        }
        do {
            let obj = try JSONSerialization.jsonObject(with: body)
            guard let dict = obj as? [String: Any] else {
                return .invalid("Request must be a JSON object")
            }
            return .complete(dict)
        } catch {
            // Without a terminator the object may simply be incomplete.
            return (eof || hasNewline) ? .invalid("Invalid JSON") : .incomplete
        }
    }
}

// MARK: - Parameter validation (pure, unit-tested)

enum Param {
    /// Integer in `range`, accepting JSON integers only (no strings, no
    /// fractional values, no booleans). Returns nil if absent or invalid.
    static func int(_ value: Any?, in range: ClosedRange<Int>) -> Int? {
        guard let n = value as? NSNumber, !isBool(n) else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d.rounded() == d, d >= Double(range.lowerBound), d <= Double(range.upperBound) else {
            return nil
        }
        return Int(d)
    }

    /// Finite number clamped into `range`; nil if absent or not a number.
    static func double(_ value: Any?, clampedTo range: ClosedRange<Double>) -> Double? {
        guard let n = value as? NSNumber, !isBool(n) else { return nil }
        let d = n.doubleValue
        guard d.isFinite else { return nil }
        return min(max(d, range.lowerBound), range.upperBound)
    }

    static func bool(_ value: Any?) -> Bool? {
        guard let n = value as? NSNumber, isBool(n) else { return nil }
        return n.boolValue
    }

    static func string(_ value: Any?, maxLength: Int = 4096) -> String? {
        guard let s = value as? String, s.utf8.count <= maxLength else { return nil }
        return s
    }

    static func stringArray(_ value: Any?, maxCount: Int = 64) -> [String]? {
        guard let arr = value as? [Any], arr.count <= maxCount else { return nil }
        var out: [String] = []
        for v in arr {
            guard let s = string(v, maxLength: 256) else { return nil }
            out.append(s)
        }
        return out
    }

    private static func isBool(_ n: NSNumber) -> Bool {
        CFGetTypeID(n) == CFBooleanGetTypeID()
    }
}

// MARK: - Capture configuration

/// Validated ranges for configuration values received over the socket.
enum ConfigLimits {
    static let fps = 1...120
    static let targetHeight = 0...16_384      // 0 = native resolution
    static let frameCount = 1...120           // ring slots per display
    static let jpegQuality = 0.0...1.0
    static let windowId = 1...Int(UInt32.max)
}

/// The subset of a "configure"/"update_config" payload that was valid.
/// Unknown keys are ignored; invalid values are reported in `rejected`.
struct CaptureConfigUpdate: Equatable {
    var fps: UInt32?
    var targetHeight: UInt32?
    var enableRecording: Bool?
    var outputDirectory: String?
    var sharedMemoryName: String?
    var frameCount: UInt32?
    var rejected: [String] = []

    init(_ config: [String: Any]) {
        func take<T>(_ key: String, _ parse: (Any?) -> T?) -> T? {
            guard config[key] != nil, !(config[key] is NSNull) else { return nil }
            if let v = parse(config[key]) { return v }
            rejected.append(key)
            return nil
        }
        fps = take("fps") { Param.int($0, in: ConfigLimits.fps).map(UInt32.init) }
        targetHeight = take("targetHeight") { Param.int($0, in: ConfigLimits.targetHeight).map(UInt32.init) }
        enableRecording = take("enableRecording", Param.bool)
        outputDirectory = take("outputDirectory") { Param.string($0, maxLength: 1024) }
        sharedMemoryName = take("sharedMemoryName") { v -> String? in
            guard let s = Param.string(v, maxLength: SHM_NAME_MAX_LENGTH) else { return nil }
            // Empty string disables shared memory output. Otherwise the
            // derived registry name must itself be a valid shm name.
            return s.isEmpty || ShmMath.isValidShmName(s + "-registry") ? s : nil
        }
        frameCount = take("frameCount") { Param.int($0, in: ConfigLimits.frameCount).map(UInt32.init) }
        rejected.sort()
    }
}

/// Machine-readable error codes returned in `{"success": false, "code": ...}`
/// and in `{"type": "error"}` notifications.
enum HelperErrorCode: String {
    case permissionDenied = "permission_denied"
    case noDisplays = "no_displays"
    case streamFailed = "stream_failed"
    case shmFailed = "shm_failed"
    case invalidRequest = "invalid_request"
    case busy = "busy"
}
