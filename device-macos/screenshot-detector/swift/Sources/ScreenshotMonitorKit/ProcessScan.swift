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
    static func scan() -> ScreenshotProcessScan {
        var result = ScreenshotProcessScan()
        // proc_listpids wants a byte count; size the buffer from the kernel's own estimate.
        let needed = proc_listpids(UInt32(PROC_ALL_PIDS), 0, nil, 0)
        let capacity = max(Int(needed) / MemoryLayout<pid_t>.stride + 256, 1024)
        var pids = [pid_t](repeating: 0, count: capacity)
        let bytes = pids.withUnsafeMutableBytes { buf -> Int32 in
            proc_listpids(UInt32(PROC_ALL_PIDS), 0, buf.baseAddress, Int32(buf.count))
        }
        if bytes <= 0 { return result }
        let count = Int(bytes) / MemoryLayout<pid_t>.stride

        var nameBuf = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        for i in 0..<count {
            let pid = pids[i]
            if pid <= 0 { continue }
            let n = proc_name(pid, &nameBuf, UInt32(nameBuf.count))
            if n <= 0 { continue }
            let name = String(cString: nameBuf)
            if name == "screencapture" {
                result.screencapture.insert(pid)
            } else if name == "screencaptureui" {
                result.screencaptureui.insert(pid)
            }
        }
        return result
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

        let argc = Int(buf.withUnsafeBytes { $0.load(as: Int32.self) })
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

    init(arguments: [String]) {
        var i = 0
        var flags = ""
        while i < arguments.count {
            let a = arguments[i]
            if a == "-z", i + 1 < arguments.count {
                let reason = arguments[i + 1]
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
        if flags.contains("c") { destination = .clipboard }
        if flags.contains("U") { interactive = true; if mode == .unknown { mode = .interactive } }
        else if flags.contains("i") { interactive = true; if mode == .unknown { mode = .selection } }
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
