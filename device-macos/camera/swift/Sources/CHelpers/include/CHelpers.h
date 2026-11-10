#ifndef CHELPERS_H
#define CHELPERS_H

#include <sys/mman.h>
#include <fcntl.h>
#include <stdatomic.h>

/// Wrapper for shm_open (marked unavailable in Swift due to variadic signature)
static inline int ausm_shm_open(const char *name, int oflag, mode_t mode) {
    return shm_open(name, oflag, mode);
}

/// Full memory fence used to order SHM frame-header writes against the frame payload
/// (replaces the deprecated OSMemoryBarrier).
static inline void ausm_memory_barrier(void) {
    atomic_thread_fence(memory_order_seq_cst);
}

#endif
