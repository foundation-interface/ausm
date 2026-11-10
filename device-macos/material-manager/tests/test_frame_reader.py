"""
Unit tests for py/frame_reader.py pure logic (pHash tiling, crop math,
request validation).  Needs numpy + opencv; screen_stream_reader is
resolved from the repo's internal-lib checkout.

Run:  python3 -m unittest discover -s tests -p 'test_*.py'
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "py"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "internal-lib", "screen-stream-reader"))

import numpy as np  # noqa: E402

import frame_reader as fr  # noqa: E402


def noise(h, w, seed=0):
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8)


class PHashTests(unittest.TestCase):
    def test_single_hash_shape_and_identity(self):
        img = noise(120, 200)
        h = fr.phash(img)
        self.assertEqual(len(h), 16)
        self.assertEqual(fr.hamming_distance(h, fr.phash(img.copy())), 0)

    def test_tiled_hash_length(self):
        img = noise(400, 300)
        for grid in (2, 4, 5):
            self.assertEqual(len(fr.phash_tiled(img, grid)), grid * grid * 16)

    def test_tiled_hash_handles_images_smaller_than_grid(self):
        for shape in ((1, 1), (3, 50), (50, 2)):
            h = fr.compute_hash(noise(*shape), 4)
            self.assertEqual(len(h), 4 * 4 * 16)

    def test_non_divisible_dimensions_cover_whole_image(self):
        # A change confined to the last (remainder) row/column must be seen.
        img = noise(403, 401, seed=1)
        base = fr.compute_hash(img, 4)
        changed = img.copy()
        changed[-3:, -3:] = 0
        changed[300:, 300:] = 255 - changed[300:, 300:]
        self.assertGreater(fr.compute_distance(base, fr.compute_hash(changed, 4), 4), 0)

    def test_local_change_detected_by_tiles(self):
        img = np.full((800, 800, 3), 255, np.uint8)
        base = fr.compute_hash(img, 4)
        edited = img.copy()
        edited[20:180, 20:180] = noise(160, 160, seed=3)
        self.assertGreaterEqual(fr.compute_distance(base, fr.compute_hash(edited, 4), 4), 8)

    def test_distance_mismatch(self):
        a = fr.compute_hash(noise(64, 64), 4)
        self.assertEqual(fr.hamming_distance_tiled(a, a[:-16], 4), -1)
        self.assertEqual(fr.compute_distance(a, fr.compute_hash(noise(64, 64), 2), 4), -1)
        self.assertEqual(fr.hamming_distance("ab", "abc"), 64)


class CropRectTests(unittest.TestCase):
    def test_inside(self):
        self.assertEqual(fr.crop_rect(10, 20, 100, 50, 2, 2, 1000, 1000), (20, 40, 200, 100))

    def test_partially_off_left_top_is_clipped_not_shifted(self):
        # Window x=-50,w=200 → only the visible 150pt (300px) remain.
        self.assertEqual(fr.crop_rect(-50, -10, 200, 100, 2, 2, 1000, 1000), (0, 0, 300, 180))

    def test_partially_off_right_bottom(self):
        self.assertEqual(fr.crop_rect(900, 900, 200, 200, 1, 1, 1000, 1000), (900, 900, 100, 100))

    def test_fully_off_screen(self):
        self.assertIsNone(fr.crop_rect(2000, 0, 100, 100, 1, 1, 1000, 1000))
        self.assertIsNone(fr.crop_rect(-300, 0, 100, 100, 1, 1, 1000, 1000))
        self.assertIsNone(fr.crop_rect(0, 0, 0, 0, 2, 2, 1000, 1000))

    def test_anisotropic_scale(self):
        self.assertEqual(fr.crop_rect(10, 10, 10, 10, 1.5, 2, 100, 100), (15, 20, 15, 20))


class SanitizeTests(unittest.TestCase):
    def test_grid(self):
        self.assertEqual(fr.sanitize_grid(4), 4)
        self.assertEqual(fr.sanitize_grid(0), 1)
        self.assertEqual(fr.sanitize_grid(999), fr.MAX_HASH_GRID)
        self.assertEqual(fr.sanitize_grid("x"), 4)
        self.assertEqual(fr.sanitize_grid(None), 4)

    def test_quality(self):
        self.assertEqual(fr.sanitize_quality(85), 85)
        self.assertEqual(fr.sanitize_quality(0), 1)
        self.assertEqual(fr.sanitize_quality(500), 100)
        self.assertEqual(fr.sanitize_quality(None), 85)


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.reader = fr.FrameReader()

    def test_non_object_request(self):
        self.assertFalse(fr.handle_request(self.reader, [1, 2])["ok"])

    def test_unknown_and_ping(self):
        self.assertEqual(fr.handle_request(self.reader, {"cmd": "nope", "requestId": "r"})["requestId"], "r")
        self.assertTrue(fr.handle_request(self.reader, {"cmd": "ping", "requestId": "p"})["pong"])

    def test_process_image_roundtrip(self):
        import base64
        import cv2
        ok, enc = cv2.imencode(".jpg", noise(64, 80))
        self.assertTrue(ok)
        b64 = base64.b64encode(enc.tobytes()).decode()
        r1 = fr.handle_request(self.reader, {"cmd": "process_image", "requestId": "a", "imageData": b64})
        self.assertTrue(r1["ok"])
        self.assertEqual((r1["width"], r1["height"]), (80, 64))
        self.assertEqual(r1["hammingDistance"], -1)
        r2 = fr.handle_request(self.reader, {"cmd": "process_image", "requestId": "b",
                                             "imageData": b64, "prevHash": r1["hash"]})
        self.assertEqual(r2["hammingDistance"], 0)

    def test_process_image_bad_input(self):
        r = fr.handle_request(self.reader, {"cmd": "process_image", "requestId": "c", "imageData": "!!!"})
        self.assertFalse(r["ok"])
        r = fr.handle_request(self.reader, {"cmd": "process_image", "requestId": "d", "imageData": 5})
        self.assertFalse(r["ok"])


class TimestampTests(unittest.TestCase):
    def test_now_maps_to_now(self):
        import time
        clock = getattr(time, "CLOCK_UPTIME_RAW", None)
        mono = time.clock_gettime(clock) if clock is not None else time.monotonic()
        self.assertLess(abs(fr.producer_ts_to_epoch_ms(mono) - time.time() * 1000), 50)


if __name__ == "__main__":
    unittest.main()
