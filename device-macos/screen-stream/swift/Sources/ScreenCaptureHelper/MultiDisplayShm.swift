import Foundation
import CHelpers

// MARK: - MultiDisplayShmManager

/// Manages multiple per-display shared memory regions with a discovery registry.
///
/// Architecture (for base name `/ausm-frames`):
///   /ausm-frames-registry           <- Lists all active displays and their SHM names
///   /ausm-frames-display-1          <- Frame ring buffer for display 1
///   /ausm-frames-display-4          <- Frame ring buffer for display 4
///
/// Thread-safe: all state is guarded by `lock` (frames are written from the
/// per-display ScreenCaptureKit queues, add/remove happen on the main queue).
final class MultiDisplayShmManager {
    private var baseName = ""
    private var registryName = ""
    private var framesPerDisplay: UInt32 = 30

    // Registry shared memory
    private var registry: MappedSegment?
    private var isOwner = false

    // Per-display shared memory managers
    private var displayShms: [String: SharedMemoryManager] = [:]
    /// Segments closed by `removeDisplay(_:destroyShm: false)` (e.g. during a display restart)
    /// and not re-created since. They still hold the last frame, so `shutdown()` unlinks them.
    private var retainedShmNames: Set<String> = []
    private let lock = NSLock()

    deinit { shutdown() }

    // MARK: - Initialize / Shutdown

    func initialize(baseName: String, framesPerDisplay: UInt32 = 30) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        // Reuse if already initialized with same base name
        if registry != nil && isOwner && self.baseName == baseName {
            NSLog("[MultiDisplayShm] Reusing existing registry '%@'", registryName)
            self.framesPerDisplay = framesPerDisplay
            return true
        }
        // Switching to another base name: release the previous registry and its segments
        // first, otherwise they stay mapped and linked (with screen contents) forever.
        if registry != nil { shutdownLocked() }

        let registryName = baseName + "-registry"
        guard ShmMath.isValidShmName(registryName) else {
            NSLog("[MultiDisplayShm] Invalid sharedMemoryName '%@' (registry name '%@' must be a valid shm name of <= %d bytes)",
                  baseName, registryName, SHM_NAME_MAX_LENGTH)
            return false
        }

        // Remove per-display segments left behind by a previous (crashed)
        // helper using the same base name, so stale screen contents don't
        // linger in shared memory.
        Self.unlinkStaleSegments(registryName: registryName, baseName: baseName)

        guard let seg = ShmSegment.create(name: registryName, size: ShmMath.registrySize, tag: "MultiDisplayShm") else {
            return false
        }

        self.baseName = baseName
        self.registryName = registryName
        self.framesPerDisplay = framesPerDisplay
        self.registry = seg

        // Initialize registry header (entries are already zeroed => inactive)
        let ptr = seg.memory
        ptr.storeBytes(of: REGISTRY_MAGIC, toByteOffset: RegistryHeaderLayout.magic, as: UInt32.self)
        ptr.storeBytes(of: REGISTRY_VERSION, toByteOffset: RegistryHeaderLayout.version, as: UInt32.self)
        ptr.storeBytes(of: MAX_DISPLAYS, toByteOffset: RegistryHeaderLayout.maxDisplays, as: UInt32.self)
        ptr.storeBytes(of: UInt32(0), toByteOffset: RegistryHeaderLayout.activeCount, as: UInt32.self)
        ptr.storeBytes(of: currentEpochMicros(), toByteOffset: RegistryHeaderLayout.lastUpdateTime, as: UInt64.self)

        isOwner = true
        NSLog("[MultiDisplayShm] Initialized registry '%@' for up to %u displays", registryName, MAX_DISPLAYS)
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
        if isOwner {
            for name in retainedShmNames { shm_unlink(name) }
        }
        retainedShmNames.removeAll()

        if let registry {
            munmap(registry.memory, registry.size)
            Darwin.close(registry.fd)
            self.registry = nil
        }
        if isOwner && !registryName.isEmpty {
            shm_unlink(registryName)
            NSLog("[MultiDisplayShm] Shutdown complete, unlinked registry")
        }
        isOwner = false
        baseName = ""
    }

    // MARK: - Add / Remove Displays

    func addDisplay(_ displayId: String, width: UInt32, height: UInt32,
                    logicalWidth: UInt32 = 0, logicalHeight: UInt32 = 0) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        guard let registry, isOwner else {
            NSLog("[MultiDisplayShm] Cannot add display - not initialized as owner")
            return false
        }

        if displayShms[displayId] != nil {
            NSLog("[MultiDisplayShm] Display '%@' already exists", displayId)
            return true
        }

        guard displayId.utf8.count < DisplayEntryLayout.displayIdSize else {
            NSLog("[MultiDisplayShm] Display id too long: '%@'", displayId)
            return false
        }

        // Find a slot: prefer one already holding this display ID, else the first inactive one.
        let entriesBase = registry.memory + RegistryHeaderLayout.totalSize
        var slot: Int = -1
        for i in 0..<Int(MAX_DISPLAYS) {
            let entryPtr = entriesBase + i * DisplayEntryLayout.totalSize
            let active = entryPtr.load(fromByteOffset: DisplayEntryLayout.active, as: UInt32.self)
            if Self.readString(entryPtr + DisplayEntryLayout.displayId, capacity: DisplayEntryLayout.displayIdSize) == displayId {
                slot = i
                break
            }
            if active == 0 && slot < 0 {
                slot = i
            }
        }
        guard slot >= 0 else {
            NSLog("[MultiDisplayShm] No free slots in registry (max %u displays)", MAX_DISPLAYS)
            return false
        }

        // Create shared memory for this display
        let shmName = makeDisplayShmName(displayId)
        let shm = SharedMemoryManager()
        guard shm.create(name: shmName, frameCount: framesPerDisplay, frameWidth: width, frameHeight: height) else {
            NSLog("[MultiDisplayShm] Failed to create SHM for display '%@'", displayId)
            return false
        }

        // Fill entry; `active` is published last.
        let entryPtr = entriesBase + slot * DisplayEntryLayout.totalSize
        entryPtr.storeBytes(of: UInt32(0), toByteOffset: DisplayEntryLayout.active, as: UInt32.self)
        ausm_memory_barrier()
        Self.writeString(displayId, to: entryPtr + DisplayEntryLayout.displayId, capacity: DisplayEntryLayout.displayIdSize)
        Self.writeString(shmName, to: entryPtr + DisplayEntryLayout.shmName, capacity: DisplayEntryLayout.shmNameSize)
        entryPtr.storeBytes(of: width, toByteOffset: DisplayEntryLayout.width, as: UInt32.self)
        entryPtr.storeBytes(of: height, toByteOffset: DisplayEntryLayout.height, as: UInt32.self)
        entryPtr.storeBytes(of: logicalWidth, toByteOffset: DisplayEntryLayout.logicalWidth, as: UInt32.self)
        entryPtr.storeBytes(of: UInt64(0), toByteOffset: DisplayEntryLayout.lastFrameTime, as: UInt64.self)
        entryPtr.storeBytes(of: UInt64(0), toByteOffset: DisplayEntryLayout.frameCount, as: UInt64.self)
        entryPtr.storeBytes(of: logicalHeight, toByteOffset: DisplayEntryLayout.logicalHeight, as: UInt32.self)
        ausm_memory_barrier()
        entryPtr.storeBytes(of: UInt32(1), toByteOffset: DisplayEntryLayout.active, as: UInt32.self)

        updateActiveCount(registry.memory)
        displayShms[displayId] = shm
        retainedShmNames.remove(shmName)

        NSLog("[MultiDisplayShm] Added display '%@' (%ux%u, logical=%ux%u) at slot %d",
              displayId, width, height, logicalWidth, logicalHeight, slot)
        return true
    }

    /// Mark a display inactive in the registry and close its segment.
    /// The segment is unlinked when `destroyShm` is true; otherwise it stays linked until the
    /// display is added again (which re-creates it) or `shutdown()`.
    func removeDisplay(_ displayId: String, destroyShm: Bool = false) {
        lock.lock()
        defer { lock.unlock() }

        guard let registry, isOwner else { return }

        let entriesBase = registry.memory + RegistryHeaderLayout.totalSize
        for i in 0..<Int(MAX_DISPLAYS) {
            let entryPtr = entriesBase + i * DisplayEntryLayout.totalSize
            let active = entryPtr.load(fromByteOffset: DisplayEntryLayout.active, as: UInt32.self)
            if active != 0 && Self.readString(entryPtr + DisplayEntryLayout.displayId,
                                              capacity: DisplayEntryLayout.displayIdSize) == displayId {
                entryPtr.storeBytes(of: UInt32(0), toByteOffset: DisplayEntryLayout.active, as: UInt32.self)
                break
            }
        }

        updateActiveCount(registry.memory)

        if let shm = displayShms.removeValue(forKey: displayId) {
            if !destroyShm { retainedShmNames.insert(shm.shmName) }
            shm.close(unlink: destroyShm)
        }

        NSLog("[MultiDisplayShm] Removed display '%@'", displayId)
    }

    // MARK: - Write Frame

    func writeFrame(displayId: String, timestamp: UInt64,
                    data: UnsafePointer<UInt8>, width: UInt32, height: UInt32,
                    bytesPerRow: Int) -> Int32 {
        lock.lock()
        defer { lock.unlock() }

        guard let shm = displayShms[displayId] else { return -1 }

        let result = shm.writeFrame(displayId: 0, timestamp: timestamp, data: data,
                                    width: width, height: height, bytesPerRow: bytesPerRow)

        // Update registry stats
        if result >= 0, let registry {
            let entriesBase = registry.memory + RegistryHeaderLayout.totalSize
            for i in 0..<Int(MAX_DISPLAYS) {
                let entryPtr = entriesBase + i * DisplayEntryLayout.totalSize
                let active = entryPtr.load(fromByteOffset: DisplayEntryLayout.active, as: UInt32.self)
                if active != 0 && Self.readString(entryPtr + DisplayEntryLayout.displayId,
                                                  capacity: DisplayEntryLayout.displayIdSize) == displayId {
                    entryPtr.storeBytes(of: timestamp, toByteOffset: DisplayEntryLayout.lastFrameTime, as: UInt64.self)
                    let count = entryPtr.load(fromByteOffset: DisplayEntryLayout.frameCount, as: UInt64.self)
                    entryPtr.storeBytes(of: count &+ 1, toByteOffset: DisplayEntryLayout.frameCount, as: UInt64.self)
                    break
                }
            }
        }

        return result
    }

    // MARK: - Query

    func getActiveDisplays() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        guard let registry else { return [] }

        var displays: [String] = []
        let entriesBase = registry.memory + RegistryHeaderLayout.totalSize
        for i in 0..<Int(MAX_DISPLAYS) {
            let entryPtr = entriesBase + i * DisplayEntryLayout.totalSize
            if entryPtr.load(fromByteOffset: DisplayEntryLayout.active, as: UInt32.self) != 0 {
                displays.append(Self.readString(entryPtr + DisplayEntryLayout.displayId,
                                                capacity: DisplayEntryLayout.displayIdSize))
            }
        }
        return displays
    }

    // MARK: - Private Helpers

    private func makeDisplayShmName(_ displayId: String) -> String {
        baseName + "-" + displayId
    }

    private func updateActiveCount(_ ptr: UnsafeMutableRawPointer) {
        let entriesBase = ptr + RegistryHeaderLayout.totalSize
        var count: UInt32 = 0
        for i in 0..<Int(MAX_DISPLAYS) {
            let entryPtr = entriesBase + i * DisplayEntryLayout.totalSize
            if entryPtr.load(fromByteOffset: DisplayEntryLayout.active, as: UInt32.self) != 0 {
                count += 1
            }
        }
        ptr.storeBytes(of: count, toByteOffset: RegistryHeaderLayout.activeCount, as: UInt32.self)
        ptr.storeBytes(of: currentEpochMicros(), toByteOffset: RegistryHeaderLayout.lastUpdateTime, as: UInt64.self)
    }

    /// Open an existing registry with this name (if any, and if it is ours)
    /// and unlink every per-display segment it lists under `baseName`.
    static func unlinkStaleSegments(registryName: String, baseName: String) {
        let fd = ausm_shm_open(registryName, O_RDONLY, 0)
        guard fd >= 0 else { return }
        defer { Darwin.close(fd) }

        var sb = stat()
        guard fstat(fd, &sb) == 0, sb.st_uid == getuid(), Int(sb.st_size) >= ShmMath.registrySize else { return }
        guard let ptr = mmap(nil, ShmMath.registrySize, PROT_READ, MAP_SHARED, fd, 0), ptr != MAP_FAILED else { return }
        defer { munmap(ptr, ShmMath.registrySize) }

        guard ptr.load(fromByteOffset: RegistryHeaderLayout.magic, as: UInt32.self) == REGISTRY_MAGIC else { return }

        let prefix = baseName + "-"
        let entriesBase = ptr + RegistryHeaderLayout.totalSize
        for i in 0..<Int(MAX_DISPLAYS) {
            let name = readString(entriesBase + i * DisplayEntryLayout.totalSize + DisplayEntryLayout.shmName,
                                  capacity: DisplayEntryLayout.shmNameSize)
            if name.hasPrefix(prefix) && ShmMath.isValidShmName(name) {
                if shm_unlink(name) == 0 {
                    NSLog("[MultiDisplayShm] Unlinked stale segment '%@'", name)
                }
            }
        }
    }

    /// Read a NUL-terminated string from a fixed-size field, never reading past `capacity`.
    static func readString(_ ptr: UnsafeRawPointer, capacity: Int) -> String {
        let bytes = UnsafeRawBufferPointer(start: ptr, count: capacity)
        let end = bytes.firstIndex(of: 0) ?? capacity
        return String(decoding: bytes[0..<end], as: UTF8.self)
    }

    /// Write `string` into a fixed-size field, truncating and always NUL-terminating.
    static func writeString(_ string: String, to ptr: UnsafeMutableRawPointer, capacity: Int) {
        memset(ptr, 0, capacity)
        let utf8 = Array(string.utf8.prefix(capacity - 1))
        utf8.withUnsafeBytes { src in
            if let base = src.baseAddress { memcpy(ptr, base, src.count) }
        }
    }
}
