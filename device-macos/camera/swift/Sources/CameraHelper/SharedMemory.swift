import Foundation
import CHelpers

// MARK: - SharedMemoryManager

/// Manages one POSIX shared-memory frame ring buffer.
/// Layout matches screen-stream so screen_stream_reader can attach (see Types.swift).
/// Not thread-safe on its own; MultiDisplayShmManager serialises access.
final class SharedMemoryManager {
    private var name = ""
    private var fd: Int32 = -1
    private var memory: UnsafeMutableRawPointer?
    private var totalSize: Int = 0
    private var frameDataSize: Int = 0
    private var frameCount: UInt32 = 0
    private var isOwner = false

    deinit {
        close(unlink: isOwner)
    }

    var shmName: String { name }
    var isOpen: Bool { memory != nil }

    // MARK: - Create / Close

    func create(name: String, frameCount: UInt32, frameWidth: UInt32, frameHeight: UInt32) -> Bool {
        if memory != nil { close(unlink: true) }

        guard let dataSize = ShmMath.frameDataSize(width: frameWidth, height: frameHeight),
              let size = ShmMath.totalSize(frameCount: frameCount, width: frameWidth, height: frameHeight)
        else {
            NSLog("[SharedMemory] Invalid geometry for '%@': %u frames of %ux%u", name, frameCount, frameWidth, frameHeight)
            return false
        }

        self.name = name
        self.frameDataSize = dataSize
        self.frameCount = frameCount
        self.totalSize = size

        // Remove any segment left behind by a crashed helper, then create a fresh private one.
        shm_unlink(name)
        fd = ausm_shm_open(name, O_CREAT | O_EXCL | O_RDWR, SHM_MODE)
        guard fd >= 0 else {
            NSLog("[SharedMemory] Failed to create '%@': %s", name, strerror(errno))
            return false
        }
        // shm_open honours the umask; enforce 0600 explicitly.
        _ = fchmod(fd, SHM_MODE)

        guard ftruncate(fd, off_t(totalSize)) >= 0 else {
            NSLog("[SharedMemory] Failed to set size: %s", strerror(errno))
            Darwin.close(fd); fd = -1; shm_unlink(name)
            return false
        }

        let mapped = mmap(nil, totalSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
        guard let mapped, mapped != MAP_FAILED else {
            NSLog("[SharedMemory] Failed to map memory: %s", strerror(errno))
            Darwin.close(fd); fd = -1; shm_unlink(name)
            return false
        }
        memory = mapped

        mapped.storeBytes(of: SHM_MAGIC, toByteOffset: ShmHeaderLayout.magic, as: UInt32.self)
        mapped.storeBytes(of: SHM_VERSION, toByteOffset: ShmHeaderLayout.version, as: UInt32.self)
        mapped.storeBytes(of: frameCount, toByteOffset: ShmHeaderLayout.frameCount, as: UInt32.self)
        mapped.storeBytes(of: UInt32(dataSize), toByteOffset: ShmHeaderLayout.frameSize, as: UInt32.self)
        mapped.storeBytes(of: frameWidth, toByteOffset: ShmHeaderLayout.width, as: UInt32.self)
        mapped.storeBytes(of: frameHeight, toByteOffset: ShmHeaderLayout.height, as: UInt32.self)
        mapped.storeBytes(of: UInt32(0), toByteOffset: ShmHeaderLayout.format, as: UInt32.self)  // BGRA
        mapped.storeBytes(of: UInt32(0), toByteOffset: ShmHeaderLayout.writeIndex, as: UInt32.self)
        mapped.storeBytes(of: UInt64(0), toByteOffset: ShmHeaderLayout.frameNumber, as: UInt64.self)
        memset(mapped + ShmHeaderLayout.reserved, 0, ShmHeaderLayout.totalSize - ShmHeaderLayout.reserved)

        for i in 0..<frameCount {
            memset(mapped + ShmMath.frameOffset(index: i, frameDataSize: dataSize), 0, FrameHeaderLayout.totalSize)
        }

        isOwner = true
        NSLog("[SharedMemory] Created '%@': %d bytes, %u frames of %ux%u",
              name, totalSize, frameCount, frameWidth, frameHeight)
        return true
    }

    func close(unlink shouldUnlink: Bool) {
        if let memory {
            munmap(memory, totalSize)
            self.memory = nil
        }
        if fd >= 0 {
            Darwin.close(fd)
            fd = -1
        }
        if shouldUnlink && isOwner && !name.isEmpty {
            shm_unlink(name)
            NSLog("[SharedMemory] Unlinked '%@'", name)
        }
        totalSize = 0
        frameDataSize = 0
        frameCount = 0
        isOwner = false
    }

    /// Write a frame to the ring buffer. Returns buffer index or -1 on error.
    func writeFrame(displayId: UInt32, timestamp: UInt64,
                    data: UnsafePointer<UInt8>, width: UInt32, height: UInt32,
                    bytesPerRow: Int) -> Int32 {
        guard let memory, isOwner, frameCount > 0 else { return -1 }

        let packedRowBytes = Int(width) * ShmMath.bytesPerPixel
        guard let byteLength = ShmMath.frameDataSize(width: width, height: height),
              byteLength <= frameDataSize, bytesPerRow >= packedRowBytes else {
            NSLog("[SharedMemory] Frame %ux%u does not fit slot of %d bytes", width, height, frameDataSize)
            return -1
        }

        let writeIndex = memory.load(fromByteOffset: ShmHeaderLayout.writeIndex, as: UInt32.self)
        let index = writeIndex % frameCount
        let offset = ShmMath.frameOffset(index: index, frameDataSize: frameDataSize)
        let framePtr = memory + offset
        let frameDataPtr = framePtr + FrameHeaderLayout.totalSize

        // Mark the slot as being written before touching header or payload.
        framePtr.storeBytes(of: UInt32(0), toByteOffset: FrameHeaderLayout.ready, as: UInt32.self)
        ausm_memory_barrier()

        if bytesPerRow == packedRowBytes {
            memcpy(frameDataPtr, data, byteLength)
        } else {
            for y in 0..<Int(height) {
                memcpy(frameDataPtr + y * packedRowBytes, data + y * bytesPerRow, packedRowBytes)
            }
        }

        let currentFrameNum = memory.load(fromByteOffset: ShmHeaderLayout.frameNumber, as: UInt64.self)
        framePtr.storeBytes(of: timestamp, toByteOffset: FrameHeaderLayout.timestamp, as: UInt64.self)
        framePtr.storeBytes(of: currentFrameNum, toByteOffset: FrameHeaderLayout.frameNumber, as: UInt64.self)
        framePtr.storeBytes(of: displayId, toByteOffset: FrameHeaderLayout.displayId, as: UInt32.self)
        framePtr.storeBytes(of: width, toByteOffset: FrameHeaderLayout.width, as: UInt32.self)
        framePtr.storeBytes(of: height, toByteOffset: FrameHeaderLayout.height, as: UInt32.self)
        framePtr.storeBytes(of: UInt32(byteLength), toByteOffset: FrameHeaderLayout.byteLength, as: UInt32.self)

        ausm_memory_barrier()
        framePtr.storeBytes(of: UInt32(1), toByteOffset: FrameHeaderLayout.ready, as: UInt32.self)
        memory.storeBytes(of: currentFrameNum &+ 1, toByteOffset: ShmHeaderLayout.frameNumber, as: UInt64.self)
        memory.storeBytes(of: writeIndex &+ 1, toByteOffset: ShmHeaderLayout.writeIndex, as: UInt32.self)

        return Int32(index)
    }
}
