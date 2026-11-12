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


class HashEdgeTests(unittest.TestCase):
    def test_uniform_images_hash_and_compare(self):
        black = np.zeros((50, 50, 3), np.uint8)
        white = np.full((50, 50, 3), 255, np.uint8)
        hb, hw = fr.compute_hash(black, 4), fr.compute_hash(white, 4)
        self.assertEqual(len(hb), 256)
        # flat images have no structure: they hash (nearly) identically —
        # a known pHash limit, so a blank→blank change is never "significant"
        self.assertLessEqual(fr.compute_distance(hb, hw, 4), 2)

    def test_grayscale_and_single_grid(self):
        gray = noise(40, 40)[:, :, 0]
        self.assertEqual(len(fr.compute_hash(gray, 1)), 16)
        self.assertEqual(len(fr.compute_hash(gray, 3)), 9 * 16)
        self.assertEqual(fr.compute_distance("0" * 16, "f" * 16, 1), 64)

    def test_distance_is_symmetric_and_bounded(self):
        a = fr.compute_hash(noise(64, 64, seed=1), 4)
        b = fr.compute_hash(noise(64, 64, seed=2), 4)
        d = fr.compute_distance(a, b, 4)
        self.assertEqual(d, fr.compute_distance(b, a, 4))
        self.assertTrue(0 <= d <= 64)

    def test_corrupt_prev_hash_is_treated_as_first_frame(self):
        a = fr.compute_hash(noise(64, 64), 4)
        corrupt = "z" * len(a)  # right length, not hex
        self.assertEqual(fr.compute_distance(a, corrupt, 4), -1)
        self.assertEqual(fr.compute_distance(a[:16], "zz" * 8, 1), -1)
        self.assertEqual(fr.compute_distance(a, "", 4), -1)

    def test_process_image_with_corrupt_prev_hash_still_succeeds(self):
        import base64
        import cv2
        ok, enc = cv2.imencode(".jpg", noise(32, 32))
        b64 = base64.b64encode(enc.tobytes()).decode()
        r = fr.handle_request(fr.FrameReader(), {"cmd": "process_image", "requestId": "z",
                                                 "imageData": b64, "prevHash": "not-hex!" * 32})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["hammingDistance"], -1)

    def test_parse_cg_id(self):
        self.assertEqual(fr.parse_cg_id("display-69734662"), 69734662)
        self.assertIsNone(fr.parse_cg_id("display-x"))
        self.assertIsNone(fr.parse_cg_id("display"))
        self.assertIsNone(fr.parse_cg_id(""))
        self.assertEqual(fr.parse_cg_id("display--3"), -3)

    def test_crop_rect_fractional_and_zero_scale(self):
        self.assertEqual(fr.crop_rect(0.4, 0.4, 10.2, 10.2, 1, 1, 100, 100), (0, 0, 11, 11))
        self.assertIsNone(fr.crop_rect(10, 10, 10, 10, 0, 0, 100, 100))
        self.assertIsNone(fr.crop_rect(10, 10, -5, 10, 1, 1, 100, 100))

    def test_sanitize_floats_and_strings(self):
        self.assertEqual(fr.sanitize_grid(2.9), 2)
        self.assertEqual(fr.sanitize_grid("3"), 3)
        self.assertEqual(fr.sanitize_quality("90"), 90)
        self.assertEqual(fr.sanitize_quality(-5), 1)
        self.assertEqual(fr.sanitize_grid(float("nan")), 4)
        self.assertEqual(fr.sanitize_quality(float("inf")), 85)
        self.assertEqual(fr.sanitize_grid(float("-inf")), 4)


class _Display:
    def __init__(self, display_id, w, h, lw, lh):
        self.display_id, self.width, self.height = display_id, w, h
        self.logical_width, self.logical_height = lw, lh


class _Frame:
    def __init__(self, data, ts):
        self.data, self.timestamp_ms = data, ts


class _Connector:
    """Synthetic ScreenStreamConnector: serves a generated BGRA frame."""

    def __init__(self, frame=None, displays=None, raise_on_read=None):
        self.displays = displays if displays is not None else [_Display("display-1", 200, 100, 100, 50)]
        self.frame = frame
        self.raise_on_read = raise_on_read
        self.reads = []
        self.disconnected = False

    def connect(self):
        return True

    def disconnect(self):
        self.disconnected = True

    def read_frame(self, display_id, skip_if_same=False):
        self.reads.append(display_id)
        if self.raise_on_read:
            raise self.raise_on_read
        return self.frame


def bgra(h, w, seed=0):
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8)


class ProcessCropTests(unittest.TestCase):
    def setUp(self):
        self._orig = fr.cg_display_bounds
        # Hermetic: never query real display geometry.
        fr.cg_display_bounds = lambda cg_id: {"x": 0.0, "y": 0.0, "width": 100.0, "height": 50.0}

    def tearDown(self):
        fr.cg_display_bounds = self._orig

    def reader_with(self, connector):
        r = fr.FrameReader()
        r.connector = connector
        r._connected = True
        r._cache_display_scales()
        r._cached_signature = r._display_signature()
        return r

    def crop(self, r, **over):
        req = {"cmd": "crop", "requestId": "c1", "displayId": "display-1",
               "bounds": {"x": 10, "y": 5, "width": 40, "height": 20},
               "scaleFactor": 2.0, "prevHash": None, "jpegQuality": 80, "hashGrid": 2}
        req.update(over)
        return fr.handle_request(r, req)

    def test_crop_uses_display_scale_and_returns_jpeg(self):
        import base64
        import cv2
        r = self.reader_with(_Connector(_Frame(bgra(100, 200), 1.0)))
        resp = self.crop(r)
        self.assertTrue(resp["ok"], resp)
        self.assertEqual((resp["width"], resp["height"]), (80, 40))  # scale 2 from display info
        self.assertEqual(resp["hammingDistance"], -1)
        img = cv2.imdecode(np.frombuffer(base64.b64decode(resp["frameData"]), np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(img.shape[:2], (40, 80))
        again = self.crop(r, prevHash=resp["hash"])
        self.assertEqual(again["hammingDistance"], 0)
        self.assertIsInstance(again["frameTimestamp"], int)

    def test_offscreen_window_and_missing_frame(self):
        r = self.reader_with(_Connector(_Frame(bgra(100, 200), 1.0)))
        resp = self.crop(r, bounds={"x": 5000, "y": 0, "width": 10, "height": 10})
        self.assertFalse(resp["ok"])
        self.assertIn("do not intersect", resp["error"])
        r2 = self.reader_with(_Connector(None))
        self.assertIn("No frame", self.crop(r2)["error"])

    def test_reader_exception_becomes_error_response(self):
        r = self.reader_with(_Connector(_Frame(bgra(10, 10), 1.0), raise_on_read=RuntimeError("shm gone")))
        resp = self.crop(r)
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"], "shm gone")
        self.assertEqual(resp["requestId"], "c1")

    def test_malformed_request_fields_are_coerced(self):
        r = self.reader_with(_Connector(_Frame(bgra(100, 200), 1.0)))
        resp = self.crop(r, bounds="nope", scaleFactor="x", jpegQuality=None, hashGrid="?", prevHash=123)
        # bounds coerced to {} → zero-size window → no intersection
        self.assertFalse(resp["ok"])
        resp = self.crop(r, bounds={"x": None, "y": None, "width": 10, "height": 10}, prevHash=["x"])
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(resp["hammingDistance"], -1)
        resp = self.crop(r, bounds={"x": "abc", "y": 0, "width": 10, "height": 10})
        self.assertFalse(resp["ok"])

    def test_unknown_display_uses_fallback_scale(self):
        conn = _Connector(_Frame(bgra(100, 200), 1.0), displays=[_Display("display-9", 0, 0, 0, 0)])
        r = self.reader_with(conn)
        resp = self.crop(r, displayId="display-9", scaleFactor=1.0)
        self.assertTrue(resp["ok"], resp)
        self.assertEqual((resp["width"], resp["height"]), (40, 20))

    def test_display_change_recaches_scales(self):
        conn = _Connector(_Frame(bgra(100, 200), 1.0))
        r = self.reader_with(conn)
        conn.displays = [_Display("display-1", 100, 50, 100, 50)]  # resolution changed
        resp = self.crop(r)
        self.assertEqual((resp["width"], resp["height"]), (40, 20))

    def test_not_connected(self):
        r = fr.FrameReader()
        r.connect = lambda: False
        resp = self.crop(r)
        self.assertFalse(resp["ok"])
        self.assertIn("Not connected", resp["error"])

    def test_disconnect_is_idempotent_and_tolerates_errors(self):
        conn = _Connector()
        conn.disconnect = lambda: (_ for _ in ()).throw(RuntimeError("x"))
        r = self.reader_with(conn)
        r.disconnect()
        r.disconnect()
        self.assertIsNone(r.connector)


class MainLoopTests(unittest.TestCase):
    def run_main(self, lines):
        import io
        out = io.StringIO()
        saved = (sys.stdin, sys.stdout, sys.stderr)
        sys.stdin = io.StringIO("".join(l + "\n" for l in lines))
        sys.stdout = out
        sys.stderr = io.StringIO()
        try:
            fr.main()
        finally:
            sys.stdin, sys.stdout, sys.stderr = saved
        import json
        return [json.loads(l) for l in out.getvalue().splitlines()]

    def test_protocol_survives_garbage(self):
        msgs = self.run_main([
            "",
            "{not json",
            "[1,2,3]",
            "null",
            '"str"',
            '{"cmd": "ping", "requestId": "p1"}',
            '{"cmd": "process_image", "requestId": "i1", "imageData": ""}',
            '{"requestId": "u1"}',
        ])
        self.assertEqual(msgs[0], {"type": "ready"})
        self.assertIn("Invalid JSON", msgs[1]["error"])
        self.assertFalse(msgs[2]["ok"])
        self.assertFalse(msgs[3]["ok"])
        self.assertFalse(msgs[4]["ok"])
        self.assertEqual(msgs[5], {"requestId": "p1", "ok": True, "pong": True})
        self.assertFalse(msgs[6]["ok"])
        self.assertIn("Unknown command", msgs[7]["error"])
        self.assertEqual(len(msgs), 8, "one response per non-empty line")


if __name__ == "__main__":
    unittest.main()
