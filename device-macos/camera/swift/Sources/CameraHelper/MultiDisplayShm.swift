import Foundation
import CHelpers

// MARK: - MultiDisplayShmManager

/// Manages per-device shared memory regions with a discovery registry.
/// Same layout as screen-stream so screen_stream_reader can attach.
///
/// Architecture:
///   /ausm-camera-frames-registry  <- Lists active cameras and their SHM names
///   /ausm-camera-frames-0         <- Frame ring buffer for camera slot 0 (… up to MAX_DISPLAYS-1)
///
/// Thread-safe: every public method takes `lock`.
final class MultiDisplayShmManager {
    private var baseName = ""
    private var registryName = ""
    private var framesPerDisplay: UInt32 = 5

    private var registryFd: Int32 = -1
    private var registryMemory: UnsafeMutableRawPointer?
    private var registrySize: Int = 0
    private var isOwner = false

    private var displayShms: [String: SharedMemoryManager] = [:]
    private var slotById: [String: Int] = [:]
    private let lock = NSLock()

    deinit { shutdown() }

    var registryShmName: String { registryName }

    /// Remove the registry and every per-slot segment for `baseName`. Used at startup so frames
    /// left behind by a crashed helper are not readable after it has gone.
    static func unlinkAll(baseName: String) {
        shm_unlink(baseName + "-registry")
        for slot in 0..<Int(MAX_DISPLAYS) {
            shm_unlink("\(baseName)-\(slot)")
        }
    }

    func initialize(baseName: String, framesPerDisplay: UInt32 = 5) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        if registryMemory != nil && isOwner && self.baseName == baseName {
            NSLog("[MultiDisplayShm] Reusing existing registry '%@'", registryName)
            self.framesPerDisplay = framesPerDisplay
            return true
        }
        if registryMemory != nil { shutdownLocked() }

        self.baseName = baseName
        self.registryName = baseName + "-registry"
        self.framesPerDisplay = framesPerDisplay

        Self.unlinkAll(baseName: baseName)
        registrySize = ShmMath.registrySize

        registryFd = ausm_shm_open(registryName, O_CREAT | O_EXCL | O_RDWR, SHM_MODE)
        guard registryFd >= 0 else {
            NSLog("[MultiDisplayShm] Failed to create registry '%@': %s", registryName, strerror(errno))
            return false
        }
        _ = fchmod(registryFd, SHM_MODE)

        guard ftruncate(registryFd, off_t(registrySize)) >= 0 else {
            NSLog("[MultiDisplayShm] Failed to set registry size: %s", strerror(errno))
            Darwin.close(registryFd); registryFd = -1; shm_unlink(registryName)
            return false
        }

        let mapped = mmap(nil, registrySize, PROT_READ | PROT_WRITE, MAP_SHARED, registryFd, 0)
        guard let mapped, mapped != MAP_FAILED else {
            NSLog("[MultiDisplayShm] Failed to map registry: %s", strerror(errno))
            Darwin.close(registryFd); registryFd = -1; shm_unlink(registryName)
            return false
        }
        registryMemory = mapped

        memset(mapped, 0, registrySize)
        mapped.storeBytes(of: REGISTRY_MAGIC, toByteOffset: RegistryHeaderLayout.magic, as: UInt32.self)
        mapped.storeBytes(of: REGISTRY_VERSION, toByteOffset: RegistryHeaderLayout.version, as: UInt32.self)
        mapped.storeBytes(of: MAX_DISPLAYS, toByteOffset: RegistryHeaderLayout.maxDisplays, as: UInt32.self)

        isOwner = true
        NSLog("[MultiDisplayShm] Initialized registry '%@' for up to %u devices", registryName, MAX_DISPLAYS)
        return true
    }

    func shutdown() {
        lock.lock()
        defer { lock.unlock() }
        shutdownLocked()
    }

    private func shutdownLocked() {
        for (_, shm) in displayShms {
            shm.close(unlink: isOwner)
        }
        displayShms.removeAll()
        slotById.removeAll()

        if let registryMemory {
            munmap(registryMemory, registrySize)
            self.registryMemory = nil
        }
        if registryFd >= 0 {
            Darwin.close(registryFd)
            registryFd = -1
        }
        if isOwner && !registryName.isEmpty {
            shm_unlink(registryName)
            NSLog("[MultiDisplayShm] Shutdown complete, unlinked registry")
        }
        isOwner = false
    }

    func addDisplay(_ displayId: String, width: UInt32, height: UInt32,
                    logicalWidth: UInt32 = 0, logicalHeight: UInt32 = 0) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        guard let ptr = registryMemory, isOwner else {
            NSLog("[MultiDisplayShm] Cannot add device - not initialized as owner")
            return false
        }

        if displayShms[displayId] != nil {
            return true
        }

        let entriesBase = ptr + RegistryHeaderLayout.totalSize
        var slot: Int = -1

        for i in 0..<Int(MAX_DISPLAYS) {
            let entryPtr = entriesBase + i * DisplayEntryLayout.totalSize
            let active = entryPtr.load(fromByteOffset: DisplayEntryLayout.active, as: UInt32.self)
            let existingId = readFixedCString(entryPtr + DisplayEntryLayout.displayId, maxLength: 64)
            if existingId == displayId {
                slot = i
                break
            }
            if active == 0 && slot < 0 {
                slot = i
            }
        }

        guard slot >= 0 else {
            NSLog("[MultiDisplayShm] No free slots in registry")
            return false
        }

        // Short SHM name — macOS shm_open names are limited to PSHMNAMLEN (31) chars.
        let shmName = "\(baseName)-\(slot)"
        let shm = SharedMemoryManager()

        guard shm.create(name: shmName, frameCount: framesPerDisplay, frameWidth: width, frameHeight: height) else {
            NSLog("[MultiDisplayShm] Failed to create SHM for device slot %d", slot)
            return false
        }

        let entryPtr = entriesBase + slot * DisplayEntryLayout.totalSize
        // Deactivate while rewriting so readers never see a half-updated entry.
        entryPtr.storeBytes(of: UInt32(0), toByteOffset: DisplayEntryLayout.active, as: UInt32.self)
        ausm_memory_barrier()
        writeFixedCString(displayId, to: entryPtr + DisplayEntryLayout.displayId, maxLength: 64)
        writeFixedCString(shmName, to: entryPtr + DisplayEntryLayout.shmName, maxLength: 128)
        entryPtr.storeBytes(of: width, toByteOffset: DisplayEntryLayout.width, as: UInt32.self)
        entryPtr.storeBytes(of: height, toByteOffset: DisplayEntryLayout.height, as: UInt32.self)
        entryPtr.storeBytes(of: logicalWidth, toByteOffset: DisplayEntryLayout.logicalWidth, as: UInt32.self)
        entryPtr.storeBytes(of: UInt64(0), toByteOffset: DisplayEntryLayout.lastFrameTime, as: UInt64.self)
        entryPtr.storeBytes(of: UInt64(0), toByteOffset: DisplayEntryLayout.frameCount, as: UInt64.self)
        entryPtr.storeBytes(of: logicalHeight, toByteOffset: DisplayEntryLayout.logicalHeight, as: UInt32.self)
        ausm_memory_barrier()
        entryPtr.storeBytes(of: UInt32(1), toByteOffset: DisplayEntryLayout.active, as: UInt32.self)

        updateActiveCount()

        displayShms[displayId] = shm
        slotById[displayId] = slot

        NSLog("[MultiDisplayShm] Added device slot %d (%ux%u) shm=%@", slot, width, height, shmName)
        return true
    }

    func removeDisplay(_ displayId: String, destroyShm: Bool = false) {
        lock.lock()
        defer { lock.unlock() }

        guard let ptr = registryMemory, isOwner else { return }

        if let slot = slotById[displayId] {
            let entryPtr = ptr + RegistryHeaderLayout.totalSize + slot * DisplayEntryLayout.totalSize
            entryPtr.storeBytes(of: UInt32(0), toByteOffset: DisplayEntryLayout.active, as: UInt32.self)
        }
        updateActiveCount()

        if let shm = displayShms.removeValue(forKey: displayId) {
            shm.close(unlink: destroyShm)
        }
        slotById.removeValue(forKey: displayId)
    }

    func writeFrame(displayId: String, timestamp: UInt64,
                    data: UnsafePointer<UInt8>, width: UInt32, height: UInt32,
                    bytesPerRow: Int) -> Int32 {
        lock.lock()
        defer { lock.unlock() }

        guard let shm = displayShms[displayId] else { return -1 }

        let result = shm.writeFrame(displayId: 0, timestamp: timestamp, data: data,
                                    width: width, height: height, bytesPerRow: bytesPerRow)

        if result >= 0, let registryMemory, let slot = slotById[displayId] {
            let entryPtr = registryMemory + RegistryHeaderLayout.totalSize + slot * DisplayEntryLayout.totalSize
            entryPtr.storeBytes(of: timestamp, toByteOffset: DisplayEntryLayout.lastFrameTime, as: UInt64.self)
            let count = entryPtr.load(fromByteOffset: DisplayEntryLayout.frameCount, as: UInt64.self)
            entryPtr.storeBytes(of: count &+ 1, toByteOffset: DisplayEntryLayout.frameCount, as: UInt64.self)
        }

        return result
    }

    func getActiveDisplays() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(displayShms.keys)
    }

    func isDisplayActive(_ displayId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return displayShms[displayId] != nil
    }

    private func updateActiveCount() {
        guard let ptr = registryMemory else { return }
        let entriesBase = ptr + RegistryHeaderLayout.totalSize
        var count: UInt32 = 0
        for i in 0..<Int(MAX_DISPLAYS) {
            let entryPtr = entriesBase + i * DisplayEntryLayout.totalSize
            if entryPtr.load(fromByteOffset: DisplayEntryLayout.active, as: UInt32.self) != 0 {
                count += 1
            }
        }
        ptr.storeBytes(of: count, toByteOffset: RegistryHeaderLayout.activeCount, as: UInt32.self)
        let now = UInt64(Date().timeIntervalSince1970 * 1_000_000)
        ptr.storeBytes(of: now, toByteOffset: RegistryHeaderLayout.lastUpdateTime, as: UInt64.self)
    }
}
