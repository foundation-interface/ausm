import CoreGraphics
import Darwin
import Foundation

/// Snapshot of the screenshot-related processes currently alive.
struct ScreenshotProcessScan {
    var screencapture: Set<pid_t> = []
    var screencaptureui: Set<pid_t> = []

    /// Enumerate processes named `screencapture` (the CLI/agent that macOS spawns for every
    /// screenshot hotkey, the `screencapture` command and third-party callers) and
    /// `screencaptureui` (the persistent Screenshot.app agent that owns the selection overlay,
    /// the Cmd+Shift+5 toolbar and the floating thumbnail).
    ///
    /// Names every process on the machine, so it is expensive to call many times a second:
    /// polling goes through `ProcessScanner`, which only names what changed.
    static func scan() -> ScreenshotProcessScan {
        var result = ScreenshotProcessScan()
        for pid in listPIDs() { result.insert(pid, kind: kind(of: pid)) }
        return result
    }

    enum Kind: UInt8 { case other, screencapture, screencaptureui }

    mutating func insert(_ pid: pid_t, kind: Kind) {
        switch kind {
        case .screencapture: screencapture.insert(pid)
        case .screencaptureui: screencaptureui.insert(pid)
        case .other: break
        }
    }

    /// Every pid alive right now (one system call, unless the table outgrew the buffer).
    static func listPIDs() -> [pid_t] {
        var capacity = 4096
        while true {
            var pids = [pid_t](repeating: 0, count: capacity)
            let bytes = pids.withUnsafeMutableBytes { buf -> Int32 in
                proc_listpids(UInt32(PROC_ALL_PIDS), 0, buf.baseAddress, Int32(buf.count))
            }
            if bytes <= 0 { return [] }
            let count = Int(bytes) / MemoryLayout<pid_t>.stride
            // A full buffer may have been cut short: ask again with room to spare.
            if count >= capacity, capacity < 1 << 20 { capacity *= 4; continue }
            pids.removeLast(pids.count - min(pids.count, count))
            return pids.filter { $0 > 0 }
        }
    }

    /// What a pid is, by its process name (one system call).
    static func kind(of pid: pid_t) -> Kind {
        // proc_name returns at most 2 * MAXCOMLEN bytes.
        var nameBuf = [CChar](repeating: 0, count: 64)
        guard proc_name(pid, &nameBuf, UInt32(nameBuf.count)) > 0 else { return .other }
        return nameBuf.withUnsafeBufferPointer { buf -> Kind in
            guard let base = buf.baseAddress else { return .other }
            if strcmp(base, "screencapture") == 0 { return .screencapture }
            if strcmp(base, "screencaptureui") == 0 { return .screencaptureui }
            return .other
        }
    }

    /// Command-line arguments of a process (argv[1...]), or nil if unreadable.
    /// macOS launches `/usr/sbin/screencapture` with flags that encode the capture mode:
    ///   Cmd+Shift+3        → -pd   -z keyboard.screen
    ///   Cmd+Shift+4        → -pdin -z keyboard.selection
    ///   Cmd+Shift+5        → -pdiU -z keyboard.interactive
    ///   + Ctrl (clipboard) → adds -c and a ".clipboard" suffix on the -z reason
    static func arguments(of pid: pid_t) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }

        return parseProcArgs(Array(buf.prefix(size)))
    }

    /// Decode a KERN_PROCARGS2 buffer: Int32 argc, the executable path, NUL padding, then argc
    /// NUL-terminated strings. Returns argv[1...]; nil when the buffer is too short to hold argc.
    /// Truncated or malformed buffers yield the arguments that could be decoded.
    static func parseProcArgs(_ buf: [UInt8]) -> [String]? {
        let size = buf.count
        guard size > MemoryLayout<Int32>.size else { return nil }
        let argc = Int(buf.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) })
        var i = MemoryLayout<Int32>.size
        // Skip the executable path and its padding NULs.
        while i < size && buf[i] != 0 { i += 1 }
        while i < size && buf[i] == 0 { i += 1 }

        var args: [String] = []
        var current: [UInt8] = []
        while i < size && args.count < argc {
            if buf[i] == 0 {
                args.append(String(decoding: current, as: UTF8.self))
                current.removeAll(keepingCapacity: true)
            } else {
                current.append(buf[i])
            }
            i += 1
        }
        // args[0] is the program name; return the rest.
        return Array(args.dropFirst())
    }
}

/// What a `screencapture` invocation is going to do, parsed from its argv.
struct ScreencaptureInvocation {
    var mode: ScreenshotMonitor.Mode = .unknown
    var destination: ScreenshotMonitor.Destination = .unknown
    /// True when the process is interactive (-i / -U): the capture happens later, driven by the
    /// user's mouse/keyboard, not when the process exits.
    var interactive = false
    /// Explicit capture rectangle (-R x,y,w,h), global CG coordinates in points.
    var explicitRect: CGRect?
    /// Explicit window id (-l <id>).
    var windowID: CGWindowID?
    /// Who launched it: the system hotkey handler (argv carries `-z keyboard.*`), some other
    /// program running the CLI, or unknown (argv unreadable).
    var origin: ScreenshotMonitor.Origin = .unknown

    init(arguments: [String]) {
        var i = 0
        var flags = ""
        while i < arguments.count {
            let a = arguments[i]
            if a == "-z", i + 1 < arguments.count {
                let reason = arguments[i + 1]
                if reason.hasPrefix("keyboard.") { origin = .hotkey }
                if reason.hasPrefix("keyboard.screen") { mode = .screen }
                else if reason.hasPrefix("keyboard.selection") { mode = .selection }
                else if reason.hasPrefix("keyboard.interactive") { mode = .interactive }
                if reason.hasSuffix(".clipboard") { destination = .clipboard }
                i += 2
                continue
            }
            if a == "-R", i + 1 < arguments.count {
                let parts = arguments[i + 1].split(separator: ",").compactMap { Double($0) }
                if parts.count == 4 {
                    explicitRect = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
                }
                i += 2
                continue
            }
            if a == "-l", i + 1 < arguments.count {
                windowID = CGWindowID(arguments[i + 1]) ?? nil
                i += 2
                continue
            }
            if a.hasPrefix("-"), !a.hasPrefix("--") {
                flags += a.dropFirst()
            }
            i += 1
        }
        if origin == .unknown && !arguments.isEmpty { origin = .cli }
        if flags.contains("c") { destination = .clipboard }
        if flags.contains("U") { interactive = true; if mode == .unknown { mode = .interactive } }
        else if flags.contains("i") {
            // -iw restricts the interactive capture to window selection.
            interactive = true
            if mode == .unknown { mode = flags.contains("w") ? .window : .selection }
        }
        if flags.contains("w") && mode == .unknown { mode = .window }
        if explicitRect != nil && mode == .unknown { mode = .selection }
        if windowID != nil && mode == .unknown { mode = .window }
        if mode == .unknown && !interactive { mode = .screen }
        if destination == .unknown {
            // Non-interactive invocations with a positional output path write a file.
            destination = arguments.contains(where: { !$0.hasPrefix("-") && $0.contains("/") }) ? .file : (mode == .unknown ? .unknown : .file)
        }
    }
}


/// The same answer as `ScreenshotProcessScan.scan()`, cheap enough to ask many times a second.
///
/// The monitor polls the process table every few tens of milliseconds, and naming every process
/// each time costs one system call per process (several percent of a CPU core on a busy Mac,
/// around the clock). Between two polls almost nothing changes, so the scanner lists the pids
/// (one call) and only names:
///   - pids it has not seen before, and
///   - pids it first saw less than `settleTime` ago: a process is created as a copy of its
///     parent and takes its own name a moment later (fork, then exec), so a first look can be
///     too early.
/// Everything is named again every `fullScanInterval`, which covers what the rules above cannot
/// see: a pid reused within one poll, or a long-running process replacing itself with
/// `screencapture`.
///
/// Not thread-safe: use it from one queue.
final class ProcessScanner {
    var settleTime: TimeInterval = 1
    var fullScanInterval: TimeInterval = 2

    private let listPIDs: () -> [pid_t]
    private let kindOf: (pid_t) -> ScreenshotProcessScan.Kind
    private let now: () -> TimeInterval

    private struct Entry {
        var kind: ScreenshotProcessScan.Kind
        var firstSeen: TimeInterval
    }
    private var known: [pid_t: Entry] = [:]
    private var lastFullScan: TimeInterval = -.infinity

    init(listPIDs: @escaping () -> [pid_t] = { ScreenshotProcessScan.listPIDs() },
         kindOf: @escaping (pid_t) -> ScreenshotProcessScan.Kind = { ScreenshotProcessScan.kind(of: $0) },
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.listPIDs = listPIDs
        self.kindOf = kindOf
        self.now = now
    }

    func scan() -> ScreenshotProcessScan {
        let time = now()
        // Also true after the monitor was stopped for a while: what was remembered is stale.
        let full = time - lastFullScan >= fullScanInterval
        if full { lastFullScan = time }

        let pids = listPIDs()
        var next: [pid_t: Entry] = [:]
        next.reserveCapacity(pids.count)
        var result = ScreenshotProcessScan()
        for pid in pids {
            var entry: Entry
            if let seen = known[pid] {
                entry = seen
                if full || time - seen.firstSeen < settleTime { entry.kind = kindOf(pid) }
            } else {
                entry = Entry(kind: kindOf(pid), firstSeen: time)
            }
            next[pid] = entry
            result.insert(pid, kind: entry.kind)
        }
        known = next
        return result
    }
}
