#ifndef CHELPERS_H
#define CHELPERS_H

#include <sys/mman.h>
#include <sys/types.h>
#include <fcntl.h>

/// Wrapper for shm_open (marked unavailable in Swift due to variadic signature)
static inline int ausm_shm_open(const char *name, int oflag, mode_t mode) {
    return shm_open(name, oflag, mode);
}

/// Full (sequentially consistent) memory fence. Used to order the frame-slot
/// `ready` flag against pixel/header stores for cross-process readers.
static inline void ausm_memory_barrier(void) {
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
}

#endif
