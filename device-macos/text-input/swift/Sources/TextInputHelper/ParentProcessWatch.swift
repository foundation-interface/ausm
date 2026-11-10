import Foundation

/// Calls `onParentGone` (on the main queue) when the spawning process goes away:
/// either stdin (if it is a pipe) reaches EOF, or we are re-parented (parent pid changes).
/// Prevents orphaned helpers from running forever after the Node host crashes.
final class ParentProcessWatch {
    private var stdinSource: DispatchSourceRead?
    private var timer: DispatchSourceTimer?
    private var fired = false

    init(onParentGone: @escaping () -> Void) {
        let fire: () -> Void = { [weak self] in
            guard let self, !self.fired else { return }
            self.fired = true
            onParentGone()
        }

        var st = stat()
        if fstat(STDIN_FILENO, &st) == 0,
           (st.st_mode & S_IFMT) == S_IFIFO || (st.st_mode & S_IFMT) == S_IFSOCK {
            let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
            source.setEventHandler {
                var buf = [UInt8](repeating: 0, count: 256)
                if read(STDIN_FILENO, &buf, buf.count) <= 0 {
                    source.cancel()
                    fire()
                }
            }
            source.resume()
            stdinSource = source
        }

        let parent = getppid()
        if parent > 1 {
            let t = DispatchSource.makeTimerSource(queue: .main)
            t.schedule(deadline: .now() + 1, repeating: 1)
            t.setEventHandler {
                if getppid() != parent { fire() }
            }
            t.resume()
            timer = t
        }
    }
}
