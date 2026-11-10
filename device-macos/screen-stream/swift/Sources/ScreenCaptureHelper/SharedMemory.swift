import Foundation
import CHelpers

// MARK: - Segment creation helper

/// A mapped POSIX shared memory segment.
struct MappedSegment {
    let fd: Int32
    let memory: UnsafeMutableRawPointer
    let size: Int
}

enum ShmSegment {
    /// Owner-only permissions: segments contain screen pixels.
    static let mode: mode_t = 0o600

    /// Create (or replace) a named segment of `size` bytes, mapped read/write.
    ///
    /// Any stale segment with the same name (e.g. left behind by a crashed
    /// helper) is unlinked first. The new segment is created with O_EXCL and
    /// mode 0600 so it is never shared with another user and never silently
    /// re-used if someone else re-created the name in between.
    static func create(name: String, size: Int, tag: String) -> MappedSegment? {
        guard ShmMath.isValidShmName(name) else {
            NSLog("[%@] Invalid shm name '%@' (must start with '/', no other '/', <= %d bytes)",
                  tag, name, SHM_NAME_MAX_LENGTH)
            return nil
        }
        guard size > 0 else { return nil }

        shm_unlink(name)

        let fd = ausm_shm_open(name, O_CREAT | O_EXCL | O_RDWR, mode)
        guard fd >= 0 else {
            let err = errno
            NSLog("[%@] Failed to create '%@': %s%@", tag, name, strerror(err),
                  err == EEXIST || err == EACCES ? " (segment owned by another user?)" : "")
            return nil
        }
        // shm_open honours the umask; enforce 0600 explicitly.
        _ = fchmod(fd, mode)

        guard ftruncate(fd, off_t(size)) == 0 else {
            NSLog("[%@] Failed to size '%@' to %d bytes: %s", tag, name, size, strerror(errno))
            Darwin.close(fd); shm_unlink(name)
            return nil
        }

        let ptr = mmap(nil, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
        guard let ptr, ptr != MAP_FAILED else {
            NSLog("[%@] Failed to map '%@': %s", tag, name, strerror(errno))
            Darwin.close(fd); shm_unlink(name)
            return nil
        }
        memset(ptr, 0, size)
        return MappedSegment(fd: fd, memory: ptr, size: size)
    }
}

// MARK: - SharedMemoryManager

/// Owns one per-display POSIX shared memory ring buffer of BGRA frames.
/// See README.md ("Shared memory layout") for the binary format.
///
/// Not thread-safe on its own; MultiDisplayShmManager serialises access.
final class SharedMemoryManager {
    private var name = ""
    private var segment: MappedSegment?
    private var frameDataSize = 0
    private var frameCount: UInt32 = 0
    private var isOwner = false

    deinit {
        close(unlink: isOwner)
    }

    var shmName: String { name }
    var isOpen: Bool { segment != nil }

    // MARK: - Create / Open / Close

    /// Create a new shared memory ring buffer.
    func create(name: String, frameCount: UInt32, frameWidth: UInt32, frameHeight: UInt32) -> Bool {
        if segment != nil { close(unlink: true) }

        guard let dataSize = ShmMath.frameDataSize(width: frameWidth, height: frameHeight),
              let total = ShmMath.totalSize(frameCount: frameCount, width: frameWidth, height: frameHeight) else {
            NSLog("[SharedMemory] Invalid geometry for '%@': %u frames of %ux%u", name, frameCount, frameWidth, frameHeight)
            return false
        }

        guard let seg = ShmSegment.create(name: name, size: total, tag: "SharedMemory") else {
            return false
        }

        self.name = name
        self.segment = seg
        self.frameDataSize = dataSize
        self.frameCount = frameCount
        self.isOwner = true

        // Header (frame slots are already zeroed => ready == 0).
        let ptr = seg.memory
        ptr.storeBytes(of: SHM_MAGIC, toByteOffset: ShmHeaderLayout.magic, as: UInt32.self)
        ptr.storeBytes(of: SHM_VERSION, toByteOffset: ShmHeaderLayout.version, as: UInt32.self)
        ptr.storeBytes(of: frameCount, toByteOffset: ShmHeaderLayout.frameCount, as: UInt32.self)
        ptr.storeBytes(of: UInt32(dataSize), toByteOffset: ShmHeaderLayout.frameSize, as: UInt32.self)
        ptr.storeBytes(of: frameWidth, toByteOffset: ShmHeaderLayout.width, as: UInt32.self)
        ptr.storeBytes(of: frameHeight, toByteOffset: ShmHeaderLayout.height, as: UInt32.self)
        ptr.storeBytes(of: UInt32(0), toByteOffset: ShmHeaderLayout.format, as: UInt32.self)  // BGRA
        ptr.storeBytes(of: UInt32(0), toByteOffset: ShmHeaderLayout.writeIndex, as: UInt32.self)
        ptr.storeBytes(of: UInt64(0), toByteOffset: ShmHeaderLayout.frameNumber, as: UInt64.self)
        ptr.storeBytes(of: max(1, currentEpochMicros()), toByteOffset: ShmHeaderLayout.generation, as: UInt64.self)

        NSLog("[SharedMemory] Created '%@': %d bytes, %u frames of %ux%u",
              name, total, frameCount, frameWidth, frameHeight)
        return true
    }

    /// Open an existing shared memory region read-only (consumer side; used by tests).
    func open(name: String) -> Bool {
        if segment != nil { close(unlink: false) }

        let fd = ausm_shm_open(name, O_RDONLY, 0)
        guard fd >= 0 else { return false }

        var sb = stat()
        guard fstat(fd, &sb) == 0, sb.st_size >= ShmHeaderLayout.totalSize else {
            Darwin.close(fd)
            return false
        }
        let size = Int(sb.st_size)
        guard let ptr = mmap(nil, size, PROT_READ, MAP_SHARED, fd, 0), ptr != MAP_FAILED else {
            Darwin.close(fd)
            return false
        }

        let magic = ptr.load(fromByteOffset: ShmHeaderLayout.magic, as: UInt32.self)
        let version = ptr.load(fromByteOffset: ShmHeaderLayout.version, as: UInt32.self)
        guard magic == SHM_MAGIC, version == SHM_VERSION else {
            munmap(ptr, size); Darwin.close(fd)
            return false
        }

        self.name = name
        self.segment = MappedSegment(fd: fd, memory: ptr, size: size)
        self.frameDataSize = Int(ptr.load(fromByteOffset: ShmHeaderLayout.frameSize, as: UInt32.self))
        self.frameCount = ptr.load(fromByteOffset: ShmHeaderLayout.frameCount, as: UInt32.self)
        self.isOwner = false
        return true
    }

    func close(unlink shouldUnlink: Bool) {
        if let segment {
            munmap(segment.memory, segment.size)
            Darwin.close(segment.fd)
            self.segment = nil
        }
        if shouldUnlink && isOwner && !name.isEmpty {
            shm_unlink(name)
            NSLog("[SharedMemory] Unlinked '%@'", name)
        }
        frameDataSize = 0
        frameCount = 0
        isOwner = false
    }

    /// Read-only view of the mapped bytes (tests / diagnostics).
    var rawMemory: UnsafeRawPointer? { segment.map { UnsafeRawPointer($0.memory) } }

    // MARK: - Write

    /// Write a frame to the ring buffer. Returns the slot index or -1 on error.
    /// `data` must contain `height` rows of at least `width*4` bytes spaced
    /// `bytesPerRow` apart.
    func writeFrame(displayId: UInt32, timestamp: UInt64,
                    data: UnsafePointer<UInt8>, width: UInt32, height: UInt32,
                    bytesPerRow: Int) -> Int32 {
        guard let segment, isOwner, frameCount > 0 else { return -1 }
        let memory = segment.memory

        let packedRowBytes = Int(width) * 4
        let byteLength = packedRowBytes * Int(height)
        guard width > 0, height > 0, bytesPerRow >= packedRowBytes, byteLength <= frameDataSize else {
            NSLog("[SharedMemory] Rejecting frame %ux%u (bpr=%d) for slot size %d",
                  width, height, bytesPerRow, frameDataSize)
            return -1
        }

        let writeIndex = memory.load(fromByteOffset: ShmHeaderLayout.writeIndex, as: UInt32.self)
        let index = writeIndex % frameCount
        let offset = ShmMath.slotOffset(index: index, frameDataSize: frameDataSize)
        let framePtr = memory + offset
        let frameDataPtr = framePtr + FrameHeaderLayout.totalSize

        // 1. Invalidate the slot before touching pixels.
        framePtr.storeBytes(of: UInt32(0), toByteOffset: FrameHeaderLayout.ready, as: UInt32.self)
        ausm_memory_barrier()

        // 2. Copy pixels, removing stride padding.
        if bytesPerRow == packedRowBytes {
            memcpy(frameDataPtr, data, byteLength)
        } else {
            for y in 0..<Int(height) {
                memcpy(frameDataPtr + y * packedRowBytes, data + y * bytesPerRow, packedRowBytes)
            }
        }

        // 3. Header fields; frameNumber is unique per write.
        let currentFrameNum = memory.load(fromByteOffset: ShmHeaderLayout.frameNumber, as: UInt64.self)
        framePtr.storeBytes(of: timestamp, toByteOffset: FrameHeaderLayout.timestamp, as: UInt64.self)
        framePtr.storeBytes(of: currentFrameNum, toByteOffset: FrameHeaderLayout.frameNumber, as: UInt64.self)
        framePtr.storeBytes(of: displayId, toByteOffset: FrameHeaderLayout.displayId, as: UInt32.self)
        framePtr.storeBytes(of: width, toByteOffset: FrameHeaderLayout.width, as: UInt32.self)
        framePtr.storeBytes(of: height, toByteOffset: FrameHeaderLayout.height, as: UInt32.self)
        framePtr.storeBytes(of: UInt32(byteLength), toByteOffset: FrameHeaderLayout.byteLength, as: UInt32.self)

        // 4. Publish.
        ausm_memory_barrier()
        framePtr.storeBytes(of: UInt32(1), toByteOffset: FrameHeaderLayout.ready, as: UInt32.self)
        memory.storeBytes(of: currentFrameNum &+ 1, toByteOffset: ShmHeaderLayout.frameNumber, as: UInt64.self)
        memory.storeBytes(of: writeIndex &+ 1, toByteOffset: ShmHeaderLayout.writeIndex, as: UInt32.self)

        return Int32(index)
    }
}
