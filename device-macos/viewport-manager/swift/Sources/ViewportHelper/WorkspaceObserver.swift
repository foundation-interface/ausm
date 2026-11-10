/// NSWorkspace notification observer — app activate/deactivate/terminate and Space changes.
/// Notifications are delivered on the monitor's serial queue (via an OperationQueue whose
/// underlying queue is that queue), so the delegate may touch monitor state directly.

import AppKit
import Foundation

protocol WorkspaceObserverDelegate: AnyObject {
    func workspaceDidActivateApp(pid: pid_t, bundleId: String, name: String)
    func workspaceDidDeactivateApp(pid: pid_t)
    func workspaceDidTerminateApp(pid: pid_t)
    func workspaceDidChangeActiveSpace()
}

final class WorkspaceObserver {
    weak var delegate: WorkspaceObserverDelegate?

    private let queue: DispatchQueue
    private var observers: [NSObjectProtocol] = []

    init(queue: DispatchQueue) {
        self.queue = queue
    }

    func register() {
        let nc = NSWorkspace.shared.notificationCenter
        let opQueue = OperationQueue()
        opQueue.underlyingQueue = queue
        opQueue.maxConcurrentOperationCount = 1

        func app(_ n: Notification) -> NSRunningApplication? {
            n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        }

        observers.append(nc.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: opQueue
        ) { [weak self] n in
            guard let a = app(n), let bundleId = a.bundleIdentifier else { return }
            self?.delegate?.workspaceDidActivateApp(
                pid: a.processIdentifier, bundleId: bundleId, name: a.localizedName ?? "")
        })

        observers.append(nc.addObserver(
            forName: NSWorkspace.didDeactivateApplicationNotification, object: nil, queue: opQueue
        ) { [weak self] n in
            guard let a = app(n) else { return }
            self?.delegate?.workspaceDidDeactivateApp(pid: a.processIdentifier)
        })

        observers.append(nc.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: opQueue
        ) { [weak self] n in
            guard let a = app(n) else { return }
            self?.delegate?.workspaceDidTerminateApp(pid: a.processIdentifier)
        })

        observers.append(nc.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: opQueue
        ) { [weak self] _ in
            self?.delegate?.workspaceDidChangeActiveSpace()
        })
    }

    func terminate() {
        let nc = NSWorkspace.shared.notificationCenter
        for observer in observers {
            nc.removeObserver(observer)
        }
        observers.removeAll()
    }
}
