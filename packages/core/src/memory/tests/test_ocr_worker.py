"""
Protocol tests for py/ocr_worker.py.  Apple Vision / Quartz / Foundation are
replaced by stub modules, so no OCR runs and no image is ever analysed.

Run:  python3 -m unittest discover -s src/memory/tests -p 'test_*.py'
"""

import io
import json
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "py"))


def _install_stubs():
    vision = types.ModuleType("Vision")
    quartz = types.ModuleType("Quartz")
    foundation = types.ModuleType("Foundation")

    class NSData:
        @staticmethod
        def dataWithBytes_length_(b, n):
            return bytes(b[:n])

    class CIImage:
        @staticmethod
        def imageWithData_(data):
            # "images" are UTF-8 text in these tests; b"BAD" is undecodable
            return None if data == b"BAD" else data

    class _Cand:
        def __init__(self, s):
            self._s = s

        def string(self):
            return self._s

    class _Obs:
        def __init__(self, s):
            self._s = s

        def topCandidates_(self, n):
            return [_Cand(self._s)] if self._s else []

    class VNRecognizeTextRequest:
        @classmethod
        def alloc(cls):
            return cls()

        def init(self):
            self._results = []
            return self

        def setRecognitionLevel_(self, v):
            self.level = v

        def setUsesLanguageCorrection_(self, v):
            pass

        def setRecognitionLanguages_(self, v):
            self.languages = v

        def results(self):
            return self._results

    class VNImageRequestHandler:
        @classmethod
        def alloc(cls):
            return cls()

        def initWithCIImage_options_(self, image, opts):
            self.image = image
            return self

        def performRequests_error_(self, reqs, err):
            text = self.image.decode("utf-8")
            if text == "VISION_FAIL":
                return False, "err"
            for r in reqs:
                r._results = [_Obs(line) for line in text.split("\n")]
            return True, None

    vision.VNRecognizeTextRequest = VNRecognizeTextRequest
    vision.VNImageRequestHandler = VNImageRequestHandler
    quartz.CIImage = CIImage
    foundation.NSData = NSData
    sys.modules.update({"Vision": vision, "Quartz": quartz, "Foundation": foundation})


_install_stubs()
import ocr_worker  # noqa: E402


def b64(s):
    import base64
    return base64.b64encode(s if isinstance(s, bytes) else s.encode()).decode()


class OcrFunctionTests(unittest.TestCase):
    def test_lines_in_order_and_empty_candidates_skipped(self):
        self.assertEqual(ocr_worker.ocr(b"one\n\ntwo"), ["one", "two"])

    def test_empty_bad_and_failed_images(self):
        self.assertEqual(ocr_worker.ocr(b""), [])
        self.assertEqual(ocr_worker.ocr(b"BAD"), [])
        self.assertEqual(ocr_worker.ocr(b"VISION_FAIL"), [])


class MainLoopTests(unittest.TestCase):
    def run_main(self, lines):
        out = io.StringIO()
        saved = (sys.stdin, sys.stdout, sys.stderr)
        sys.stdin = io.StringIO("".join(l + "\n" for l in lines))
        sys.stdout, sys.stderr = out, io.StringIO()
        try:
            ocr_worker.main()
        finally:
            sys.stdin, sys.stdout, sys.stderr = saved
        return [json.loads(l) for l in out.getvalue().splitlines()]

    def test_round_trip_and_errors(self):
        msgs = self.run_main([
            json.dumps({"cmd": "ocr", "requestId": "a", "imageData": b64("hello\nworld")}),
            json.dumps({"cmd": "ocr", "requestId": "b", "imageData": "%%%not base64"}),
            json.dumps({"cmd": "ocr", "requestId": "c"}),
            json.dumps({"cmd": "nope", "requestId": "d"}),
            "{broken json",
            "",
        ])
        self.assertEqual(msgs[0], {"type": "ready"})
        self.assertEqual(msgs[1], {"requestId": "a", "ok": True, "lines": ["hello", "world"]})
        self.assertFalse(msgs[2]["ok"])
        self.assertEqual(msgs[3], {"requestId": "c", "ok": True, "lines": []})
        self.assertFalse(msgs[4]["ok"])
        self.assertEqual(len(msgs), 5, "bad JSON is skipped without a reply")

    def test_non_object_requests_do_not_kill_the_worker(self):
        msgs = self.run_main([
            "[1, 2]",
            "42",
            "null",
            json.dumps({"cmd": "ocr", "requestId": "after", "imageData": b64("still alive")}),
        ])
        self.assertEqual(msgs[-1], {"requestId": "after", "ok": True, "lines": ["still alive"]})

    def test_bad_languages_field_reports_error(self):
        msgs = self.run_main([
            json.dumps({"cmd": "ocr", "requestId": "l", "imageData": b64("x"), "languages": 5}),
        ])
        self.assertFalse(msgs[1]["ok"])
        self.assertEqual(msgs[1]["requestId"], "l")


if __name__ == "__main__":
    unittest.main()
