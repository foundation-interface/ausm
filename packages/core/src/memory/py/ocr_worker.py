#!/usr/bin/env python3
"""
OCR worker — Apple Vision text recognition over a JSON-lines stdio protocol.

Spawned by the memory service (packages/core/src/memory/ocr-worker.ts). Stateless:
each request carries one JPEG, each response carries the recognized lines.
Line-level dedup/merging across frames happens on the TypeScript side.

Protocol (one JSON object per line):
  stdout on startup:  { "type": "ready" }
  stdin  request:     { "cmd": "ocr", "requestId": "...", "imageData": "<base64 jpeg>",
                        "accurate": true, "languages": ["en-US"] }
  stdout response:    { "requestId": "...", "ok": true, "lines": ["...", ...] }
                      { "requestId": "...", "ok": false, "error": "..." }

Requires (see py/requirements.txt):
  pip install pyobjc-framework-Vision pyobjc-framework-Quartz
"""

import base64
import json
import sys

from Vision import VNRecognizeTextRequest, VNImageRequestHandler
from Quartz import CIImage
from Foundation import NSData


def ocr(jpeg_bytes, accurate=True, language_correction=True, languages=("en-US",)):
    """Run Apple Vision OCR on JPEG bytes, return list of recognized line strings."""
    if not jpeg_bytes:
        return []
    nsdata = NSData.dataWithBytes_length_(jpeg_bytes, len(jpeg_bytes))
    image = CIImage.imageWithData_(nsdata)
    if image is None:
        return []
    handler = VNImageRequestHandler.alloc().initWithCIImage_options_(image, {})
    req = VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(0 if accurate else 1)   # 0 = accurate, 1 = fast
    req.setUsesLanguageCorrection_(language_correction)
    if languages:
        req.setRecognitionLanguages_(list(languages))
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        return []
    lines = []
    for obs in (req.results() or []):
        cands = obs.topCandidates_(1)
        if cands and len(cands) > 0:
            lines.append(str(cands[0].string()))
    return lines


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    send({"type": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"[ocr-worker] bad request line: {e}\n")
            continue
        if not isinstance(msg, dict):
            # e.g. a JSON array/number: reply instead of crashing the worker
            send({"requestId": None, "ok": False, "error": "request must be a JSON object"})
            continue

        request_id = msg.get("requestId")
        if msg.get("cmd") != "ocr":
            send({"requestId": request_id, "ok": False,
                  "error": f"unknown cmd: {msg.get('cmd')!r}"})
            continue

        try:
            jpeg = base64.b64decode(msg.get("imageData") or "")
            lines = ocr(
                jpeg,
                accurate=bool(msg.get("accurate", True)),
                languages=tuple(msg.get("languages") or ("en-US",)),
            )
            send({"requestId": request_id, "ok": True, "lines": lines})
        except Exception as e:  # noqa: BLE001 — worker must never die on a bad frame
            send({"requestId": request_id, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
