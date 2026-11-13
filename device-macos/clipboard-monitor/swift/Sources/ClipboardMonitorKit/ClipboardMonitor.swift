import AppKit
import Foundation

/// Monitors the general pasteboard by polling `NSPasteboard.changeCount` and reports each copy
/// or cut as a `ClipboardEvent` with its content type and (optionally) its text.
///
/// Threading: all state lives on a private serial queue and every callback (`onEvent`,
/// `onError`) is invoked on that queue. Hop to the main actor yourself for UI work. Assign
/// callbacks before `start()`. `start()` and `stop()` are idempotent and may be called from any
/// thread, including from inside a callback. No run loop is required.
///
/// Privacy: pasteboards carrying a concealed/transient marker (password managers, see
/// nspasteboard.org) are reported with `concealed == true` and their content is never read.
/// With `Options.includeContent == false` the content is never read at all. Image data is never
/// read. Changes that happened before `start()` (or while stopped) are not reported.
///
/// Permissions: none by default. On macOS 15.4+ the user can set this app's paste access to
/// "Ask" or "Deny" in System Settings; that is reported once through `onError`.
public final class ClipboardMonitor: @unchecked Sendable {
    public struct Options: Sendable {
        /// Read and report pasteboard content. When false only the content type is reported and
        /// the pasteboard's contents are never read.
        public var includeContent = true
        /// Cap on `content`, in bytes of UTF-8 (cut on a character boundary, flagged with
        /// `contentTruncated`). Default 1 MiB.
        public var maxContentBytes = 1_048_576
        /// How often `changeCount` is polled (seconds). Default 0.2.
        public var pollInterval: TimeInterval = 0.2
        /// Extra pasteboard types that mark a pasteboard as concealed, on top of
        /// `ClipboardClassifier.concealedMarkers`.
        public var additionalConcealedTypes: Set<String> = []
        /// How often the paste-privacy setting is re-checked (seconds). 0 checks only at start.
        public var accessCheckInterval: TimeInterval = 5

        public init() {}
    }

    /// Problems reported through `onError`, each once until it clears.
    public enum Problem: String, Sendable {
        /// The user set this app's paste access to "Deny" (macOS 15.4+): content reads return
        /// nothing, so events carry only the content type.
        case accessDenied = "pasteboard_access_denied"
        /// The user set this app's paste access to "Ask" (macOS 15.4+): every content read
        /// shows a system alert. Consider `includeContent = false`.
        case accessPrompts = "pasteboard_access_prompts"
    }

    /// Called on the monitor's private queue for every pasteboard change.
    public var onEvent: ((ClipboardEvent) -> Void)?
    /// Called on the monitor's private queue when a `Problem` appears.
    public var onError: ((Problem, String) -> Void)?

    public let options: Options

    private let pasteboard: PasteboardReading
    private let now: () -> Int64
    private let queue = DispatchQueue(label: "ausm.clipboard-monitor", qos: .utility)
    private let queueKey = DispatchSpecificKey<Void>()
    private var timer: DispatchSourceTimer?
    private var running = false
    private var lastChangeCount = 0
    private var lastAccessCheck: Int64 = .min
    private var problems = ProblemLatch<Problem>()

    public convenience init(options: Options = Options()) {
        self.init(options: options, pasteboard: SystemPasteboard(),
                  now: { Int64(Date().timeIntervalSince1970 * 1000) })
    }

    /// Test seam: inject a fake pasteboard and clock.
    init(options: Options, pasteboard: PasteboardReading, now: @escaping () -> Int64) {
        self.options = options
        self.pasteboard = pasteboard
        self.now = now
        queue.setSpecific(key: queueKey, value: ())
    }

    deinit {
        timer?.cancel()
    }

    public var isRunning: Bool { onQueue { running } }

    /// Start polling. Takes the current `changeCount` as the baseline (not reported).
    public func start() {
        onQueue { startOnQueue(scheduleTimer: true) }
    }

    /// Stop polling. Safe to call repeatedly or before `start()`.
    public func stop() {
        onQueue {
            running = false
            timer?.cancel()
            timer = nil
        }
    }

    // MARK: - Internals (internal for tests)

    /// `scheduleTimer: false` lets tests drive `poll()` by hand.
    func startOnQueue(scheduleTimer: Bool) {
        guard !running else { return }
        running = true
        lastChangeCount = pasteboard.changeCount
        lastAccessCheck = .min
        problems = ProblemLatch()
        checkAccess(force: true)
        guard scheduleTimer else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        let interval = max(options.pollInterval, 0.01)
        t.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(20))
        t.setEventHandler { [weak self] in self?.poll() }
        timer = t
        t.resume()
    }

    /// One poll: emits at most one event (intermediate changes between polls coalesce).
    func poll() {
        guard running else { return }
        let count = pasteboard.changeCount
        checkAccess(force: false)
        guard count != lastChangeCount else { return }
        let event = readEvent(changeCount: count)
        // Types and content are separate reads: if the pasteboard changed in between (e.g. a
        // concealed item written after the concealed check), drop this result; the next poll
        // sees the new changeCount and reads the new item.
        guard pasteboard.changeCount == count else { return }
        lastChangeCount = count
        onEvent?(event)
    }

    func readEvent(changeCount count: Int) -> ClipboardEvent {
        let types = pasteboard.typeIdentifiers
        let concealed = ClipboardClassifier.isConcealed(types: types, additional: options.additionalConcealedTypes)
        let available = pasteboard.availableType(from: ClipboardClassifier.typeOrder)
        var content: String?
        var paths: [String]?
        if let available, options.includeContent, !concealed {
            (content, paths) = pasteboard.readContent(ofType: available)
        }
        return ClipboardClassifier.makeEvent(
            changeCount: count,
            timestampMs: now(),
            contentType: available.map { ClipboardClassifier.contentType(for: $0) },
            concealed: concealed,
            content: content,
            contentPaths: paths,
            options: options
        )
    }

    private func checkAccess(force: Bool) {
        let t = now()
        if !force {
            guard options.accessCheckInterval > 0,
                  t - lastAccessCheck >= Int64(options.accessCheckInterval * 1000) else { return }
        }
        lastAccessCheck = t
        guard let problem = problems.update(pasteboard.accessProblem) else { return }
        onError?(problem, Self.message(for: problem))
    }

    static func message(for problem: Problem) -> String {
        switch problem {
        case .accessDenied:
            return "Paste access is set to Deny for this app (System Settings > Privacy & Security); clipboard content cannot be read."
        case .accessPrompts:
            return "Paste access is set to Ask for this app (System Settings > Privacy & Security); every content read shows a system alert."
        }
    }

    /// Run `body` on the queue, synchronously; re-entrant when already on it.
    private func onQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil { return body() }
        return queue.sync(execute: body)
    }
}
