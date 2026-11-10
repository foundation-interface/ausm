"""Unit tests for screen_stream_reader (no screen capture / TCC needed).

Builds real POSIX shared memory segments in the producer's binary layout
(device-macos/screen-stream/README.md) and reads them back.

Run: python3 -m unittest discover -s tests   (from this package directory)
"""

import ctypes
import ctypes.util
import mmap
import os
import struct
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

try:
    import numpy  # noqa: F401
    HAVE_NUMPY = True
except ImportError:  # pragma: no cover
    HAVE_NUMPY = False

if HAVE_NUMPY:
    from screen_stream_reader import connector as c

_libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
_libc.shm_open.restype = ctypes.c_int
_libc.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int]  # mode is variadic


class Segment:
    """A writable test segment in the producer layout."""

    def __init__(self, name, width, height, slots, generation=1234):
        self.name = name
        self.width, self.height, self.slots = width, height, slots
        self.frame_size = width * height * 4
        self.size = 72 + slots * (40 + self.frame_size)
        _libc.shm_unlink(name.encode())
        fd = _libc.shm_open(name.encode(), os.O_CREAT | os.O_EXCL | os.O_RDWR, ctypes.c_int(0o600))
        if fd < 0:
            raise OSError(ctypes.get_errno(), "shm_open failed")
        os.ftruncate(fd, self.size)
        self.mm = mmap.mmap(fd, self.size, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE)
        os.close(fd)
        struct.pack_into("<IIIIIIIIQQ", self.mm, 0, 0x41555346, 1, slots, self.frame_size,
                         width, height, 0, 0, 0, generation)
        self.next_frame = 0

    def slot_offset(self, idx):
        return 72 + idx * (40 + self.frame_size)

    def write(self, fill, timestamp=1_000_000):
        idx = self.next_frame % self.slots
        off = self.slot_offset(idx)
        struct.pack_into("<I", self.mm, off + 32, 0)  # ready = 0
        self.mm[off + 40: off + 40 + self.frame_size] = bytes([fill]) * self.frame_size
        struct.pack_into("<QQIIIIII", self.mm, off, timestamp, self.next_frame, 0,
                         self.width, self.height, self.frame_size, 1, 0)
        self.next_frame += 1
        return idx

    def close(self):
        self.mm.close()
        _libc.shm_unlink(self.name.encode())


@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.name = "/ausmpy%d" % (os.getpid() % 100000)
        self.seg = Segment(self.name, width=4, height=2, slots=3)
        info = c.DisplayInfo(display_id="display-1", shm_name=self.name, width=4, height=2)
        self.reader = c.FrameReader(info)
        self.assertTrue(self.reader.open())

    def tearDown(self):
        self.reader.close()
        self.seg.close()

    def test_header_parsing_matches_swift_layout(self):
        h = c.parse_shm_header(bytes(self.seg.mm[:72]))
        self.assertEqual(h["magic"], c.SHM_MAGIC)
        self.assertEqual(h["frame_count"], 3)
        self.assertEqual(h["frame_size"], 32)
        self.assertEqual((h["width"], h["height"]), (4, 2))
        self.assertEqual(h["generation"], 1234)
        self.assertIsNone(c.parse_shm_header(b"\0" * 10))
        self.assertEqual(struct.calcsize(c.FRAME_HEADER_FORMAT), c.FRAME_HEADER_SIZE)

    def test_reads_latest_frame_as_private_copy(self):
        self.assertIsNone(self.reader.read_latest())
        self.seg.write(7)
        self.seg.write(9, timestamp=2_500_000)
        f = self.reader.read_latest()
        self.assertIsNotNone(f)
        self.assertEqual(f.frame_number, 1)
        self.assertEqual(f.data.shape, (2, 4, 4))
        self.assertTrue((f.data == 9).all())
        self.assertAlmostEqual(f.timestamp_s, 2.5)
        self.assertEqual(f.timestamp_ms, f.timestamp_s)  # historical name, seconds
        self.assertIsNone(self.reader.read_latest())  # skip_if_same
        # Copy is detached from shared memory.
        self.seg.write(1)
        self.seg.write(1)
        self.seg.write(1)
        self.assertTrue((f.data == 9).all())

    def test_zero_copy_view(self):
        self.seg.write(5)
        f = self.reader.read_latest(copy=False)
        self.assertFalse(f.data.flags.writeable)
        del f

    def test_detects_overwrite_during_copy(self):
        self.seg.write(3)
        seg = self.seg
        original = c.FrameReader._slot_unchanged
        calls = []

        def overwrite_then_check(reader, slot_idx, frame_number):
            if not calls:
                # Producer starts rewriting this slot while we copy.
                struct.pack_into("<I", seg.mm, seg.slot_offset(slot_idx) + 32, 0)
            calls.append(slot_idx)
            return original(reader, slot_idx, frame_number)

        c.FrameReader._slot_unchanged = overwrite_then_check
        try:
            self.assertIsNone(self.reader.read_latest())  # only slot is now not ready
        finally:
            c.FrameReader._slot_unchanged = original
        self.assertEqual(len(calls), 1)

    def test_rejects_inconsistent_headers(self):
        idx = self.seg.write(4)
        # byteLength larger than the slot: must be ignored, not read out of bounds.
        struct.pack_into("<I", self.seg.mm, self.seg.slot_offset(idx) + 28, 10_000)
        self.assertIsNone(self.reader.read_latest())

    def test_stale_detection_on_recreate(self):
        self.assertFalse(self.reader.is_stale())
        self.seg.close()
        self.assertTrue(self.reader.is_stale())  # unlinked
        self.seg = Segment(self.name, width=4, height=2, slots=3, generation=999)
        self.assertTrue(self.reader.is_stale())  # recreated, new generation


@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class SocketPathTests(unittest.TestCase):
    def test_notify_path_mapping(self):
        self.assertEqual(c.notify_path_for("/tmp/x.sock"), "/tmp/x.sock.notify")
        self.assertEqual(c.notify_path_for("/tmp/x.sock.notify"), "/tmp/x.sock.notify")
        self.assertEqual(c.DEFAULT_NOTIFY_SOCKET, c.DEFAULT_COMMAND_SOCKET + ".notify")
        self.assertEqual(c.NotificationClient("/tmp/y.sock").socket_path, "/tmp/y.sock.notify")


if __name__ == "__main__":
    unittest.main()
