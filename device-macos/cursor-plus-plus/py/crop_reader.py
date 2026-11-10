#!/usr/bin/env python3
"""
Crop Reader — Lightweight Python subprocess for cursor-plus-plus.

Reads display frames from AUSM screen-stream shared memory via the
screen_stream_reader library, crops a requested rect, JPEG-encodes it,
and returns the result over a JSON-line protocol on stdio.

Unlike the material-manager's frame_reader.py this does NOT compute
perceptual hashes or hamming distances — it only crops and encodes.

Coordinate handling:
  The cursor position from the Swift helper is in macOS global screen
  coordinates (logical points, origin at top-left of primary display).
  Each display's frame buffer starts at local (0,0).  We use
  CGDisplayBounds (via ctypes) to map global → display-local coords
  and select the correct display automatically.

Protocol (stdin → stdout, one JSON object per line):

  Ready:    { "type": "ready" }

  Request:  { "cmd": "crop", "requestId": "...",
              "cursorX": 500, "cursorY": 300,
              "cropWidth": 200, "cropHeight": 40,
              "scaleFactor": 2.0, "jpegQuality": 75 }

  Response: { "requestId": "...", "ok": true, "data": "<base64>",
              "width": 160, "height": 160, "displayId": "display-..." }
           or
            { "requestId": "...", "ok": false, "error": "..." }

Dependencies:
  - screen-stream-reader  (device-macos/internal-lib, provides ScreenStreamConnector)
  - numpy
  - opencv-python (cv2)

Lifecycle: exits when stdin closes (the parent process exited or closed the pipe).
"""

from __future__ import annotations

import sys
import json
import base64
import ctypes
import ctypes.util
from typing import Optional

import numpy as np
import cv2

from screen_stream_reader import ScreenStreamConnector


# ── macOS CGDisplayBounds via ctypes ─────────────────────────────────────

class _CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

class _CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]

class _CGRect(ctypes.Structure):
    _fields_ = [("origin", _CGPoint), ("size", _CGSize)]

_cg_lib = None

def _get_cg():
    global _cg_lib
    if _cg_lib is None:
        _cg_lib = ctypes.CDLL(
            "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
        )
        _cg_lib.CGDisplayBounds.restype = _CGRect
        _cg_lib.CGDisplayBounds.argtypes = [ctypes.c_uint32]
    return _cg_lib


def cg_display_bounds(cg_display_id: int) -> dict:
    """Return {x, y, width, height} in global screen coordinates."""
    cg = _get_cg()
    rect = cg.CGDisplayBounds(cg_display_id)
    return {
        "x": rect.origin.x,
        "y": rect.origin.y,
        "width": rect.size.width,
        "height": rect.size.height,
    }


def parse_cg_id(display_id: str) -> Optional[int]:
    """Extract numeric CGDirectDisplayID from 'display-{id}'."""
    parts = display_id.split("-", 1)
    if len(parts) == 2:
        try:
            return int(parts[1])
        except ValueError:
            pass
    return None


# ── CropReader ───────────────────────────────────────────────────────────

class CropReader:
    def __init__(self, socket_path: str = "/tmp/ausm-frames.sock"):
        self.connector = ScreenStreamConnector(
            notify_socket=socket_path,
            command_socket=socket_path,
        )
        self._connected = False
        self._display_scales: dict[str, float] = {}
        # Cached display bounds (global screen coords, logical points).
        # Refreshed whenever displays change.
        self._display_bounds: dict[str, dict] = {}

    def connect(self) -> bool:
        if self._connected:
            return True
        try:
            if self.connector.connect():
                self._connected = True
                self._refresh_display_info()
                return True
        except Exception:
            pass
        return False

    def ensure_connected(self) -> bool:
        if self._connected:
            events = self.connector.poll_events()
            if events:
                self._refresh_display_info()
            return True
        return self.connect()

    def _refresh_display_info(self) -> None:
        self._display_scales.clear()
        self._display_bounds.clear()
        for d in self.connector.displays:
            if d.scale_factor > 0:
                self._display_scales[d.display_id] = d.scale_factor
            cg_id = parse_cg_id(d.display_id)
            if cg_id is not None:
                try:
                    self._display_bounds[d.display_id] = cg_display_bounds(cg_id)
                except Exception:
                    pass

    def _find_display_at(self, x: float, y: float) -> Optional[str]:
        """Find the display whose global bounds contain (x, y)."""
        for did, db in self._display_bounds.items():
            if (db["x"] <= x < db["x"] + db["width"]
                    and db["y"] <= y < db["y"] + db["height"]):
                return did
        return None

    def process_crop(self, request: dict) -> dict:
        request_id = str(request.get("requestId", ""))
        try:
            cursor_x = float(request.get("cursorX", 0.0))
            cursor_y = float(request.get("cursorY", 0.0))
            crop_width = max(1.0, float(request.get("cropWidth", 200)))
            crop_height = max(1.0, float(request.get("cropHeight", 40)))
            scale_factor_hint = float(request.get("scaleFactor", 2.0)) or 2.0
            jpeg_quality = min(100, max(1, int(request.get("jpegQuality", 75))))
        except (TypeError, ValueError, OverflowError):
            # OverflowError: int(float('inf')), e.g. "jpegQuality": Infinity or 1e999.
            return {"requestId": request_id, "ok": False, "error": "Invalid crop request parameters"}

        if not self.ensure_connected():
            return {
                "requestId": request_id,
                "ok": False,
                "error": "Not connected to screen-stream shared memory",
            }

        # Determine which display the cursor is on
        display_id = self._find_display_at(cursor_x, cursor_y)
        if not display_id:
            displays = self.connector.displays
            display_id = displays[0].display_id if displays else None
        if not display_id:
            return {
                "requestId": request_id,
                "ok": False,
                "error": "No displays available",
            }

        try:
            frame = self.connector.read_frame(
                display_id=display_id,
                skip_if_same=False,
            )

            if frame is None:
                return {
                    "requestId": request_id,
                    "ok": False,
                    "error": f"No frame available for display {display_id}",
                }

            # Convert global cursor position to display-local logical points
            db = self._display_bounds.get(display_id)
            if db:
                local_x = cursor_x - db["x"]
                local_y = cursor_y - db["y"]
            else:
                local_x = cursor_x
                local_y = cursor_y

            frame_h, frame_w = frame.data.shape[:2]

            # Derive the actual logical→pixel scale from the frame buffer
            # dimensions and the display's logical size (from CGDisplayBounds).
            # This is correct regardless of whether the screen-stream captures
            # at native resolution (2x Retina) or downscaled (targetHeight).
            if db and db["width"] > 0 and db["height"] > 0:
                scale_x = frame_w / db["width"]
                scale_y = frame_h / db["height"]
            else:
                fallback = self._display_scales.get(display_id, scale_factor_hint)
                scale_x = fallback
                scale_y = fallback

            px_x = local_x * scale_x
            px_y = local_y * scale_y
            px_crop_w = max(1, int(crop_width * scale_x))
            px_crop_h = max(1, int(crop_height * scale_y))

            half_w = px_crop_w / 2.0
            half_h = px_crop_h / 2.0

            # Center crop rect on cursor, clamped to frame bounds
            cx = max(half_w, min(px_x, frame_w - half_w))
            cy = max(half_h, min(px_y, frame_h - half_h))

            left = max(0, int(cx - half_w))
            top = max(0, int(cy - half_h))
            right = min(frame_w, left + px_crop_w)
            bottom = min(frame_h, top + px_crop_h)
            bw = right - left
            bh = bottom - top

            if bw <= 0 or bh <= 0:
                return {
                    "requestId": request_id,
                    "ok": False,
                    "error": "Crop region out of bounds",
                }

            cropped_bgra = frame.data[top:bottom, left:right]
            cropped_bgr = cropped_bgra[:, :, :3]

            encode_params = [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality]
            success, encoded = cv2.imencode(".jpg", cropped_bgr, encode_params)

            if not success:
                return {
                    "requestId": request_id,
                    "ok": False,
                    "error": "JPEG encoding failed",
                }

            data_b64 = base64.b64encode(encoded.tobytes()).decode("ascii")

            return {
                "requestId": request_id,
                "ok": True,
                "data": data_b64,
                "width": bw,
                "height": bh,
                "displayId": display_id,
            }

        except Exception as e:
            return {
                "requestId": request_id,
                "ok": False,
                "error": str(e),
            }


def main():
    socket_path = "/tmp/ausm-frames.sock"

    for arg in sys.argv[1:]:
        if arg.startswith("--socket="):
            socket_path = arg.split("=", 1)[1]

    reader = CropReader(socket_path=socket_path)

    sys.stdout.write(json.dumps({"type": "ready"}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(request, dict):
            continue

        cmd = request.get("cmd", "")
        if cmd == "crop":
            response = reader.process_crop(request)
        else:
            response = {
                "requestId": request.get("requestId", ""),
                "ok": False,
                "error": f"Unknown command: {cmd}",
            }

        try:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
        except BrokenPipeError:
            return  # parent went away


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
