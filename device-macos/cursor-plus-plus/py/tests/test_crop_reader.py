"""Unit tests for crop_reader.py (cursor-plus-plus crop subprocess).

Fake-driven: the screen-stream connector is replaced with an in-memory fake
and display bounds are injected, so nothing touches shared memory, sockets,
or CoreGraphics.

Run: python3 -m unittest discover -s tests   (from device-macos/cursor-plus-plus/py)
Requires numpy and opencv (cv2); skipped otherwise.
"""

import base64
import io
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "internal-lib", "screen-stream-reader"))

try:
    import numpy as np
    import cv2  # noqa: F401
    import crop_reader as cr
    from screen_stream_reader.connector import DisplayInfo, Frame
    HAVE_DEPS = True
except ImportError:  # pragma: no cover
    HAVE_DEPS = False


class FakeConnector:
    def __init__(self, displays=(), frames=None, connect_ok=True, events=()):
        self.displays = list(displays)
        self.frames = frames or {}
        self.connect_ok = connect_ok
        self.events = list(events)
        self.reads = []

    def connect(self):
        return self.connect_ok

    def poll_events(self):
        events, self.events = self.events, []
        return events

    def read_frame(self, display_id=None, skip_if_same=True, copy=True):
        self.reads.append((display_id, skip_if_same))
        f = self.frames.get(display_id)
        if isinstance(f, BaseException):
            raise f
        return f


def make_frame(display_id, width, height):
    # Horizontal gradient so crops at different x positions differ.
    data = np.zeros((height, width, 4), dtype=np.uint8)
    data[:, :, 0] = (np.arange(width) % 256).astype(np.uint8)
    data[:, :, 3] = 255
    return Frame(display_id=display_id, frame_number=1, timestamp_ns=0, width=width, height=height,
                 data=data)


def decode_jpeg(b64):
    raw = base64.b64decode(b64)
    img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    return raw, img


@unittest.skipUnless(HAVE_DEPS, "numpy/opencv not installed")
class CropReaderTests(unittest.TestCase):
    def reader(self, connector, bounds=None, scales=None):
        with mock.patch.object(cr, "ScreenStreamConnector", lambda **kw: connector):
            r = cr.CropReader(socket_path="/nonexistent/test.sock")
        r._connected = True
        r._display_bounds = dict(bounds or {})
        r._display_scales = dict(scales or {})
        return r

    def req(self, **kw):
        base = {"cmd": "crop", "requestId": "r1", "cursorX": 100, "cursorY": 100,
                "cropWidth": 200, "cropHeight": 40, "scaleFactor": 2.0, "jpegQuality": 75}
        base.update(kw)
        return base

    def test_retina_crop_is_scaled_from_frame_dimensions(self):
        conn = FakeConnector([DisplayInfo("display-1", "/x", 2880, 1800)],
                             {"display-1": make_frame("display-1", 2880, 1800)})
        r = self.reader(conn, {"display-1": {"x": 0, "y": 0, "width": 1440, "height": 900}})
        res = r.process_crop(self.req(cursorX=720, cursorY=450))
        self.assertTrue(res["ok"], res)
        self.assertEqual((res["width"], res["height"]), (400, 80))
        self.assertEqual(res["displayId"], "display-1")
        raw, img = decode_jpeg(res["data"])
        self.assertEqual(raw[:2], b"\xff\xd8")
        self.assertEqual(img.shape[:2], (80, 400))
        self.assertEqual(conn.reads, [("display-1", False)])

    def test_negative_origin_secondary_display_is_selected_and_localized(self):
        frames = {"display-1": make_frame("display-1", 1440, 900),
                  "display-2": make_frame("display-2", 1920, 1080)}
        conn = FakeConnector([DisplayInfo("display-1", "/a", 1440, 900),
                              DisplayInfo("display-2", "/b", 1920, 1080)], frames)
        bounds = {"display-1": {"x": 0, "y": 0, "width": 1440, "height": 900},
                  "display-2": {"x": -1920, "y": -200, "width": 1920, "height": 1080}}
        r = self.reader(conn, bounds)
        res = r.process_crop(self.req(cursorX=-1000, cursorY=100, cropWidth=10, cropHeight=10))
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["displayId"], "display-2")
        _, img = decode_jpeg(res["data"])
        # Local x = -1000 - (-1920) = 920; crop spans 915..925 -> blue channel ~ 915..925 % 256.
        self.assertAlmostEqual(float(img[:, :, 0].mean()), (915 + 924) / 2 % 256, delta=3)

    def test_display_boundaries_are_half_open(self):
        r = self.reader(FakeConnector(), {
            "display-1": {"x": 0, "y": 0, "width": 100, "height": 100},
            "display-2": {"x": 100, "y": 0, "width": 100, "height": 100},
            "display-3": {"x": 0, "y": -50, "width": 100, "height": 50},
        })
        self.assertEqual(r._find_display_at(99.999, 0), "display-1")
        self.assertEqual(r._find_display_at(100, 0), "display-2")
        self.assertEqual(r._find_display_at(0, -0.5), "display-3")
        self.assertIsNone(r._find_display_at(200, 0))
        self.assertIsNone(r._find_display_at(-1, 10))

    def test_crop_is_clamped_at_frame_edges(self):
        conn = FakeConnector([DisplayInfo("display-1", "/x", 200, 100)],
                             {"display-1": make_frame("display-1", 200, 100)})
        r = self.reader(conn, {"display-1": {"x": 0, "y": 0, "width": 200, "height": 100}})
        for cx, cy in ((0, 0), (199.9, 99.9), (-50, -50), (10_000, 10_000)):
            res = r.process_crop(self.req(cursorX=cx, cursorY=cy, cropWidth=40, cropHeight=20))
            self.assertTrue(res["ok"], (cx, cy, res))
            self.assertEqual((res["width"], res["height"]), (40, 20))

    def test_crop_larger_than_frame_returns_whole_frame(self):
        conn = FakeConnector([DisplayInfo("display-1", "/x", 30, 20)],
                             {"display-1": make_frame("display-1", 30, 20)})
        r = self.reader(conn, {"display-1": {"x": 0, "y": 0, "width": 30, "height": 20}})
        res = r.process_crop(self.req(cursorX=15, cursorY=10, cropWidth=1000, cropHeight=1000))
        self.assertTrue(res["ok"], res)
        self.assertEqual((res["width"], res["height"]), (30, 20))

    def test_cursor_outside_known_displays_falls_back_to_first(self):
        conn = FakeConnector([DisplayInfo("display-9", "/x", 100, 100)],
                             {"display-9": make_frame("display-9", 100, 100)})
        r = self.reader(conn, scales={"display-9": 1.0})
        res = r.process_crop(self.req(cursorX=50, cursorY=50, cropWidth=10, cropHeight=10))
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["displayId"], "display-9")
        self.assertEqual((res["width"], res["height"]), (10, 10))  # known scale 1.0, not hint 2.0

    def test_scale_hint_used_without_bounds_or_known_scale(self):
        conn = FakeConnector([DisplayInfo("display-9", "/x", 100, 100)],
                             {"display-9": make_frame("display-9", 100, 100)})
        r = self.reader(conn)
        res = r.process_crop(self.req(cursorX=10, cursorY=10, cropWidth=10, cropHeight=10, scaleFactor=3))
        self.assertEqual((res["width"], res["height"]), (30, 30))
        res = r.process_crop(self.req(cursorX=10, cursorY=10, cropWidth=10, cropHeight=10, scaleFactor=0))
        self.assertEqual((res["width"], res["height"]), (20, 20))  # 0 -> default 2.0

    def test_invalid_parameters(self):
        r = self.reader(FakeConnector())
        for bad in ({"cursorX": "left"}, {"cursorY": None}, {"cropWidth": [1]},
                    {"jpegQuality": "high"}, {"jpegQuality": float("nan")},
                    {"jpegQuality": float("inf")}, {"jpegQuality": 1e999}, {"scaleFactor": {}}):
            res = r.process_crop(self.req(**bad))
            self.assertEqual(res, {"requestId": "r1", "ok": False,
                                   "error": "Invalid crop request parameters"}, bad)

    def test_infinite_or_nan_cursor_is_an_error_not_a_crash(self):
        conn = FakeConnector([DisplayInfo("display-1", "/x", 100, 100)],
                             {"display-1": make_frame("display-1", 100, 100)})
        r = self.reader(conn)
        for bad in ({"cursorX": float("inf")}, {"cursorY": float("nan")}, {"cropWidth": float("inf")}):
            res = r.process_crop(self.req(**bad))
            self.assertEqual(res["requestId"], "r1")
            self.assertIn("ok", res)

    def test_quality_is_clamped(self):
        conn = FakeConnector([DisplayInfo("display-1", "/x", 100, 100)],
                             {"display-1": make_frame("display-1", 100, 100)})
        r = self.reader(conn)
        for q in (-5, 0, 1000, 75.9):
            self.assertTrue(r.process_crop(self.req(jpegQuality=q))["ok"], q)

    def test_error_paths(self):
        r = self.reader(FakeConnector(connect_ok=False))
        r._connected = False
        self.assertEqual(r.process_crop(self.req())["error"],
                         "Not connected to screen-stream shared memory")

        r = self.reader(FakeConnector([]))
        self.assertEqual(r.process_crop(self.req())["error"], "No displays available")

        r = self.reader(FakeConnector([DisplayInfo("display-1", "/x", 10, 10)], {}))
        self.assertEqual(r.process_crop(self.req())["error"], "No frame available for display display-1")

        r = self.reader(FakeConnector([DisplayInfo("display-1", "/x", 10, 10)],
                                      {"display-1": RuntimeError("mmap gone")}))
        res = r.process_crop(self.req())
        self.assertEqual((res["ok"], res["error"]), (False, "mmap gone"))

    def test_request_id_is_stringified(self):
        r = self.reader(FakeConnector([]))
        self.assertEqual(r.process_crop(self.req(requestId=42))["requestId"], "42")
        self.assertEqual(r.process_crop({"cmd": "crop"})["requestId"], "")

    def test_events_refresh_display_info(self):
        conn = FakeConnector([DisplayInfo("display-5", "/x", 2880, 1800, scale_factor=2.0),
                              DisplayInfo("odd", "/y", 10, 10, scale_factor=0)],
                             events=["display_change"])
        r = self.reader(conn)
        with mock.patch.object(cr, "cg_display_bounds",
                               lambda cg_id: {"x": -cg_id, "y": 0, "width": 1440, "height": 900}):
            self.assertTrue(r.ensure_connected())
        self.assertEqual(r._display_scales, {"display-5": 2.0})
        self.assertEqual(r._display_bounds, {"display-5": {"x": -5, "y": 0, "width": 1440, "height": 900}})

    def test_bounds_lookup_failure_is_tolerated(self):
        conn = FakeConnector([DisplayInfo("display-5", "/x", 10, 10)])
        r = self.reader(conn)
        r._connected = False

        def boom(_):
            raise OSError("no CoreGraphics")

        with mock.patch.object(cr, "cg_display_bounds", boom):
            self.assertTrue(r.connect())
        self.assertEqual(r._display_bounds, {})

    def test_connect_exception_is_not_connected(self):
        conn = FakeConnector()
        conn.connect = mock.Mock(side_effect=OSError("boom"))
        r = self.reader(conn)
        r._connected = False
        self.assertFalse(r.connect())
        self.assertFalse(r._connected)

    def test_parse_cg_id(self):
        self.assertEqual(cr.parse_cg_id("display-69734662"), 69734662)
        self.assertIsNone(cr.parse_cg_id("display-abc"))
        self.assertIsNone(cr.parse_cg_id("display"))
        self.assertIsNone(cr.parse_cg_id(""))
        self.assertEqual(cr.parse_cg_id("display-1-x"), None)


@unittest.skipUnless(HAVE_DEPS, "numpy/opencv not installed")
class MainLoopTests(unittest.TestCase):
    def run_main(self, lines, argv=("crop_reader.py",), process=None):
        created = []

        class FakeReader:
            def __init__(self, socket_path):
                created.append(socket_path)

            def process_crop(self, request):
                if process:
                    return process(request)
                return {"requestId": request.get("requestId"), "ok": True}

        out = io.StringIO()
        with mock.patch.object(cr, "CropReader", FakeReader), \
                mock.patch.object(sys, "argv", list(argv)), \
                mock.patch.object(sys, "stdin", io.StringIO("".join(lines))), \
                mock.patch.object(sys, "stdout", out):
            cr.main()
        return [json.loads(l) for l in out.getvalue().splitlines()], created

    def test_protocol(self):
        msgs, created = self.run_main([
            "\n", "   \n", "not json\n", "[1,2]\n", "null\n",
            '{"cmd": "crop", "requestId": "a"}\n',
            '{"cmd": "zoom", "requestId": "b"}\n',
            '{"requestId": "c"}\n',
            '{"cmd": "crop", "requestId": "d"}',  # final line without newline
        ], argv=("crop_reader.py", "--socket=/nonexistent/s.sock", "--unknown"))
        self.assertEqual(created, ["/nonexistent/s.sock"])
        self.assertEqual(msgs[0], {"type": "ready"})
        self.assertEqual(msgs[1], {"requestId": "a", "ok": True})
        self.assertEqual(msgs[2], {"requestId": "b", "ok": False, "error": "Unknown command: zoom"})
        self.assertEqual(msgs[3], {"requestId": "c", "ok": False, "error": "Unknown command: "})
        self.assertEqual(msgs[4], {"requestId": "d", "ok": True})
        self.assertEqual(len(msgs), 5)

    def test_default_socket(self):
        _, created = self.run_main([])
        self.assertEqual(created, ["/tmp/ausm-frames.sock"])

    def test_broken_pipe_ends_loop(self):
        calls = []

        class BrokenOut(io.StringIO):
            def write(self, s):
                if calls:
                    raise BrokenPipeError()
                calls.append(s)
                return len(s)

        class FakeReader:
            def __init__(self, socket_path):
                pass

            def process_crop(self, request):
                calls.append(request)
                return {"ok": True}

        with mock.patch.object(cr, "CropReader", FakeReader), \
                mock.patch.object(sys, "argv", ["crop_reader.py"]), \
                mock.patch.object(sys, "stdin", io.StringIO('{"cmd":"crop"}\n{"cmd":"crop"}\n')), \
                mock.patch.object(sys, "stdout", BrokenOut()):
            cr.main()  # must return, not raise
        self.assertEqual(len(calls), 2)  # ready line + one request, then stop


if __name__ == "__main__":
    unittest.main()
