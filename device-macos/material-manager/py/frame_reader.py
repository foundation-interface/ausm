#!/usr/bin/env python3
"""
Frame Reader — Python subprocess for the material-manager service.

Reads full-screen frames from AUSM screen-stream shared memory, crops to
the requested window bounds, computes a perceptual hash for deduplication,
JPEG-encodes the result, and returns it to the TypeScript parent process
via a JSON-line protocol over stdio.

Coordinate handling:
  Window bounds from the viewport (CGWindowList) are in macOS global screen
  coordinates (logical points, origin at top-left of primary display).
  Each display's frame buffer starts at local (0,0).  We use CGDisplayBounds
  to map global → display-local coords when cropping windows on non-primary
  displays.

Protocol (stdin → stdout, one JSON object per line):
  On start the process writes { "type": "ready" }.
  Request:  { "cmd": "crop", "requestId": "...", "displayId": "display-1",
              "bounds": { "x": 0, "y": 0, "width": 800, "height": 600 },
              "scaleFactor": 2.0, "prevHash": "abc123...", "jpegQuality": 85,
              "hashGrid": 4 }
  Response: { "requestId": "...", "ok": true, "frameData": "<base64>",
              "width": 800, "height": 600, "hash": "def456...",
              "hammingDistance": 12, "frameTimestamp": 1234567890 }
  Request:  { "cmd": "process_image", "requestId": "...",
              "imageData": "<base64 JPEG>", "prevHash": "...", "hashGrid": 4 }
  Response: { "requestId": "...", "ok": true, "width": W, "height": H,
              "hash": "...", "hammingDistance": N }
  Errors:   { "requestId": "...", "ok": false, "error": "..." }

  stdout carries ONLY protocol lines; all logging goes to stderr. Image data
  is never logged.

Dependencies:
  - screen-stream-reader (device-macos/internal-lib, provides ScreenStreamConnector)
  - numpy
  - opencv-python (cv2)
"""

import sys
import json
import base64
import time
import ctypes
import ctypes.util
from typing import Optional

import numpy as np
import cv2

from screen_stream_reader import ScreenStreamConnector


# ─── macOS CGDisplayBounds via ctypes ─────────────────────────────────────

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
    """Return {x, y, width, height} in global screen coordinates (logical points)."""
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


# ─── Perceptual hash (pHash) ─────────────────────────────────────────────

def phash(image: np.ndarray, hash_size: int = 8) -> str:
    """
    Compute a perceptual hash of an image.

    1. Convert to grayscale
    2. Resize to (hash_size * 4) x (hash_size * 4)
    3. Apply DCT
    4. Keep the top-left hash_size x hash_size coefficients
    5. Compute median and binarize

    Returns a hex string representing the hash.
    """
    # Convert to grayscale if needed
    if len(image.shape) == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image

    # Resize to a small square for DCT
    dct_size = hash_size * 4
    resized = cv2.resize(gray, (dct_size, dct_size), interpolation=cv2.INTER_AREA)
    resized = np.float32(resized)

    # Apply DCT
    dct = cv2.dct(resized)

    # Keep the top-left hash_size x hash_size block (low frequencies)
    dct_low = dct[:hash_size, :hash_size]

    # Median of the low-frequency block (DC term included — changing this
    # would change every stored hash, so it is kept for compatibility).
    med = np.median(dct_low)

    # Binarize
    bits = (dct_low > med).flatten()

    # Pack bits into hex string
    hash_int = 0
    for bit in bits:
        hash_int = (hash_int << 1) | int(bit)

    return format(hash_int, f'0{hash_size * hash_size // 4}x')


def hamming_distance(hash1: str, hash2: str) -> int:
    """Compute Hamming distance between two hex hash strings."""
    if len(hash1) != len(hash2):
        return 64  # max distance for 8x8 hash
    val1 = int(hash1, 16)
    val2 = int(hash2, 16)
    xor = val1 ^ val2
    return bin(xor).count('1')


# ─── Tiled perceptual hash ───────────────────────────────────────────────
#
# Divides the image into a grid×grid tile array and computes an independent
# pHash per tile.  This catches small localized changes (e.g. typing text
# in one region of a large window) that would be invisible to a single
# whole-image pHash because the 32×32 downsample averages them away.

def phash_tiled(image: np.ndarray, grid: int = 4, hash_size: int = 8) -> str:
    """
    Compute a tiled perceptual hash — one pHash per grid cell, concatenated.

    With grid=4 and hash_size=8: 16 tiles × 16 hex chars = 256-char hash.
    """
    if len(image.shape) == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image

    h, w = gray.shape[:2]
    # Guard against images smaller than the grid (e.g. a sliver of a window
    # that is mostly off-screen): upscale so every tile has >= 1 pixel and
    # the hash keeps its fixed grid*grid layout.
    if h < grid or w < grid:
        gray = cv2.resize(gray, (max(w, grid), max(h, grid)), interpolation=cv2.INTER_NEAREST)
        h, w = gray.shape[:2]
    tile_h = h // grid
    tile_w = w // grid

    hashes = []
    for row in range(grid):
        y0 = row * tile_h
        y1 = (row + 1) * tile_h if row < grid - 1 else h
        for col in range(grid):
            x0 = col * tile_w
            x1 = (col + 1) * tile_w if col < grid - 1 else w
            tile = gray[y0:y1, x0:x1]
            hashes.append(phash(tile, hash_size))

    return ''.join(hashes)


def hamming_distance_tiled(hash1: str, hash2: str, grid: int = 4, hash_size: int = 8) -> int:
    """
    Max Hamming distance across corresponding tiles.

    If ANY tile changes significantly, the frame is considered different.
    Returns -1 if hashes have incompatible lengths (treated as first frame).
    """
    chunk_len = hash_size * hash_size // 4  # hex chars per tile (16 for hash_size=8)
    expected_len = grid * grid * chunk_len

    if len(hash1) != expected_len or len(hash2) != expected_len:
        return -1

    max_dist = 0
    for i in range(grid * grid):
        h1 = hash1[i * chunk_len:(i + 1) * chunk_len]
        h2 = hash2[i * chunk_len:(i + 1) * chunk_len]
        max_dist = max(max_dist, hamming_distance(h1, h2))

    return max_dist


MAX_HASH_GRID = 16


def sanitize_grid(value) -> int:
    """Coerce a requested hashGrid to an int in [1, MAX_HASH_GRID]."""
    try:
        grid = int(value)
    except (TypeError, ValueError, OverflowError):
        return 4
    return max(1, min(grid, MAX_HASH_GRID))


def sanitize_quality(value) -> int:
    """Coerce a requested JPEG quality to an int in [1, 100]."""
    try:
        q = int(value)
    except (TypeError, ValueError, OverflowError):
        return 85
    return max(1, min(q, 100))


def crop_rect(local_x: float, local_y: float, width: float, height: float,
              scale_x: float, scale_y: float,
              frame_w: int, frame_h: int) -> Optional[tuple]:
    """
    Map a display-local logical rect to a pixel rect clipped to the frame.

    Returns (x, y, w, h) in frame pixels, or None if the rect does not
    intersect the frame (window entirely on another display / off-screen).
    A window partially off the left/top edge is clipped, not shifted, so
    the crop only ever contains pixels that belong to the window.
    """
    x0 = int(round(local_x * scale_x))
    y0 = int(round(local_y * scale_y))
    x1 = int(round((local_x + width) * scale_x))
    y1 = int(round((local_y + height) * scale_y))
    x0, x1 = max(0, x0), min(frame_w, x1)
    y0, y1 = max(0, y0), min(frame_h, y1)
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1 - x0, y1 - y0)


def producer_ts_to_epoch_ms(frame_ts_sec: float) -> int:
    """
    Convert a producer frame timestamp to epoch milliseconds.

    screen-stream stores CMSampleBuffer presentation time (host clock, i.e.
    mach_absolute_time, which does not advance during sleep) in microseconds;
    the reader exposes it as ``Frame.timestamp_ms`` which therefore holds
    *seconds*.  CLOCK_UPTIME_RAW is the same clock as mach_absolute_time, so
    we read it explicitly rather than relying on time.monotonic()'s
    platform-dependent clock choice.
    """
    clock = getattr(time, "CLOCK_UPTIME_RAW", None)
    mono_now = time.clock_gettime(clock) if clock is not None else time.monotonic()
    wall_now = time.time()
    return int((wall_now - (mono_now - frame_ts_sec)) * 1000)


def compute_hash(image: np.ndarray, grid: int, hash_size: int = 8) -> str:
    """Compute single or tiled pHash based on grid size."""
    if grid <= 1:
        return phash(image, hash_size)
    return phash_tiled(image, grid, hash_size)


def compute_distance(hash1: str, hash2: str, grid: int, hash_size: int = 8) -> int:
    """Compare hashes using single or tiled strategy based on grid size.

    A previous hash that is not valid hex (corrupted / foreign) is treated
    like a format mismatch (-1, i.e. "first frame") instead of failing the
    whole request.
    """
    try:
        if grid <= 1:
            return hamming_distance(hash1, hash2)
        return hamming_distance_tiled(hash1, hash2, grid, hash_size)
    except ValueError:
        return -1


# ─── Frame Reader ─────────────────────────────────────────────────────────

class FrameReader:
    """
    Reads frames from screen-stream shared memory and processes crop requests.
    """

    def __init__(self):
        self.connector: Optional[ScreenStreamConnector] = None
        self._connected = False
        # Cache display scale factors: display_id -> (scale_x, scale_y) | None
        # where scale = capture pixels / logical points.
        self._display_scales: dict = {}
        self._cached_signature: tuple = ()
        # Cache display bounds (global screen coords, logical points).
        # Used to convert window bounds from global to display-local.
        self._display_bounds: dict = {}

    def connect(self) -> bool:
        """Connect to the screen-stream shared memory."""
        try:
            self.connector = ScreenStreamConnector()
            if not self.connector.connect():
                self._log("Failed to connect: screen-stream producer not reachable")
                self.disconnect()
                return False
            self._connected = True
            self._cache_display_scales()
            self._cached_signature = self._display_signature()
            return True
        except Exception as e:
            self._log(f"Failed to connect: {e}")
            self.disconnect()
            return False

    def disconnect(self):
        """Release the shared-memory / socket connection (idempotent)."""
        self._connected = False
        if self.connector is not None:
            try:
                self.connector.disconnect()
            except Exception:
                pass
        self.connector = None

    def _cache_display_scales(self):
        """
        Cache the ratio between capture pixels and logical points for each display.
        Viewport-manager bounds are in logical (point) coordinates.
        Screen-stream frames are at the capture resolution (e.g., targetHeight=1080).
        Scale = capture_width / logical_width.

        Also caches display bounds (global screen coords) for converting window
        bounds from global to display-local when cropping on non-primary displays.
        """
        if not self.connector:
            return
        self._display_bounds.clear()
        self._display_scales.clear()
        for d in self.connector.displays:
            logical_w = d.logical_width
            logical_h = d.logical_height
            if logical_w > 0 and d.width > 0:
                scale_x = d.width / logical_w
                scale_y = d.height / logical_h if logical_h > 0 and d.height > 0 else scale_x
                self._display_scales[d.display_id] = (scale_x, scale_y)
                self._log(f"Display {d.display_id}: {d.width}x{d.height} capture, "
                          f"{logical_w}x{logical_h} logical, scale={scale_x:.3f}x{scale_y:.3f}")
            else:
                self._display_scales[d.display_id] = None
            cg_id = parse_cg_id(d.display_id)
            if cg_id is not None:
                try:
                    self._display_bounds[d.display_id] = cg_display_bounds(cg_id)
                except Exception:
                    pass

    def _get_scale(self, display_id: str, fallback: float) -> tuple:
        """Get the (x, y) capture/logical scale for a display, or use fallback."""
        scale = self._display_scales.get(display_id)
        if scale is None:
            return (fallback, fallback)
        return scale

    def _get_display_origin(self, display_id: str) -> Optional[dict]:
        """
        Current global origin of a display.  Queried live (a cheap CG call)
        so that rearranging displays in System Settings is picked up without
        a display add/remove; falls back to the cached value.
        """
        cg_id = parse_cg_id(display_id)
        if cg_id is not None:
            try:
                db = cg_display_bounds(cg_id)
                if db["width"] > 0 and db["height"] > 0:
                    self._display_bounds[display_id] = db
                    return db
            except Exception:
                pass
        return self._display_bounds.get(display_id)

    def ensure_connected(self) -> bool:
        """Ensure we have a working connection, reconnecting if needed.
        
        Note: The ScreenStreamConnector auto-polls for producer events
        (display changes, config changes) inside read_frame(), so stale
        shared-memory readers are transparently replaced.  We only need
        to re-cache display scales when the display list or a display's
        resolution changes.
        """
        if self._connected and self.connector:
            # Re-cache scales if the connector refreshed its displays
            # (e.g. after a display change detected by the auto-poll).
            signature = self._display_signature()
            if signature != self._cached_signature:
                self._cache_display_scales()
                self._cached_signature = signature
            return True
        return self.connect()

    def _display_signature(self) -> tuple:
        if not self.connector:
            return ()
        return tuple(sorted(
            (d.display_id, d.width, d.height, d.logical_width, d.logical_height)
            for d in self.connector.displays
        ))

    def process_crop(self, request: dict) -> dict:
        """
        Process a crop request.

        Args:
            request: JSON-parsed request object with keys:
                - requestId: str
                - displayId: str
                - bounds: { x, y, width, height } (logical points)
                - scaleFactor: float
                - prevHash: str | None
                - jpegQuality: int

        Returns:
            Response dict ready for JSON serialization.
        """
        request_id = request.get("requestId", "")
        display_id = request.get("displayId", "")
        bounds = request.get("bounds", {})
        bounds = bounds if isinstance(bounds, dict) else {}
        try:
            scale_factor = float(request.get("scaleFactor", 1.0)) or 1.0
        except (TypeError, ValueError):
            scale_factor = 1.0
        prev_hash = request.get("prevHash")
        prev_hash = prev_hash if isinstance(prev_hash, str) else None
        jpeg_quality = sanitize_quality(request.get("jpegQuality", 85))
        hash_grid = sanitize_grid(request.get("hashGrid", 4))

        # Ensure we have a connection
        if not self.ensure_connected():
            return {
                "requestId": request_id,
                "ok": False,
                "error": "Not connected to screen-stream shared memory",
            }

        try:
            # Read the latest frame from the specified display
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

            # Resolve actual (x, y) scale from display info (preferred) or the hint
            scale_x, scale_y = self._get_scale(display_id, scale_factor)

            # Convert window bounds from global screen coords to display-local.
            # Viewport-manager bounds are in global logical points; each display's
            # frame buffer starts at local (0,0).
            bound_x = float(bounds.get("x", 0) or 0)
            bound_y = float(bounds.get("y", 0) or 0)
            bound_w = float(bounds.get("width", 0) or 0)
            bound_h = float(bounds.get("height", 0) or 0)
            db = self._get_display_origin(display_id)
            if db:
                local_x = bound_x - db["x"]
                local_y = bound_y - db["y"]
            else:
                local_x = bound_x
                local_y = bound_y

            # Logical → capture pixels, clipped to the frame (windows partially
            # off-screen are clipped rather than shifted).
            frame_h, frame_w = frame.data.shape[:2]
            rect = crop_rect(local_x, local_y, bound_w, bound_h,
                             scale_x, scale_y, frame_w, frame_h)
            if rect is None:
                return {
                    "requestId": request_id,
                    "ok": False,
                    "error": f"Window bounds do not intersect display {display_id}",
                }
            bx, by, bw, bh = rect

            # Crop: frame.data is (height, width, 4) in BGRA.  Drop alpha and
            # make the view contiguous for OpenCV.
            cropped_bgr = np.ascontiguousarray(frame.data[by:by + bh, bx:bx + bw, :3])

            # Compute perceptual hash (tiled or single based on hashGrid)
            current_hash = compute_hash(cropped_bgr, hash_grid)

            # Compare with previous hash (-1 = first frame or hash-format mismatch)
            dist = compute_distance(current_hash, prev_hash, hash_grid) if prev_hash else -1

            # JPEG encode
            encode_params = [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality]
            success, encoded = cv2.imencode('.jpg', cropped_bgr, encode_params)

            if not success:
                return {
                    "requestId": request_id,
                    "ok": False,
                    "error": "JPEG encoding failed",
                }

            # Base64 encode for JSON transport
            frame_b64 = base64.b64encode(encoded.tobytes()).decode('ascii')

            # Producer timestamp → epoch ms, comparable with Date.now() in TS.
            frame_epoch_ms = producer_ts_to_epoch_ms(frame.timestamp_ms)

            return {
                "requestId": request_id,
                "ok": True,
                "frameData": frame_b64,
                "width": bw,
                "height": bh,
                "hash": current_hash,
                "hammingDistance": dist,
                "frameTimestamp": frame_epoch_ms,
            }

        except Exception as e:
            return {
                "requestId": request_id,
                "ok": False,
                "error": str(e),
            }

    def process_image(self, request: dict) -> dict:
        """
        Process an already-captured JPEG image (e.g., from CGWindowListCreateImage).

        Unlike process_crop which reads from shared memory, this receives the
        image data directly.  It decodes the JPEG, computes pHash, and compares
        with the previous hash.

        Args:
            request: JSON-parsed request object with keys:
                - requestId: str
                - imageData: str (base64-encoded JPEG)
                - prevHash: str | None

        Returns:
            Response dict with hash and hammingDistance.
        """
        request_id = request.get("requestId", "")
        image_b64 = request.get("imageData", "")
        prev_hash = request.get("prevHash")
        prev_hash = prev_hash if isinstance(prev_hash, str) else None
        hash_grid = sanitize_grid(request.get("hashGrid", 4))

        if not image_b64 or not isinstance(image_b64, str):
            return {
                "requestId": request_id,
                "ok": False,
                "error": "No imageData provided",
            }

        try:
            # Decode base64 JPEG → numpy array
            jpeg_bytes = base64.b64decode(image_b64)
            nparr = np.frombuffer(jpeg_bytes, np.uint8)
            image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if image is None:
                return {
                    "requestId": request_id,
                    "ok": False,
                    "error": "Failed to decode JPEG image",
                }

            height, width = image.shape[:2]

            # Compute perceptual hash (tiled or single based on hashGrid)
            current_hash = compute_hash(image, hash_grid)

            # Compare with previous hash (-1 = first frame or hash-format mismatch)
            dist = compute_distance(current_hash, prev_hash, hash_grid) if prev_hash else -1

            return {
                "requestId": request_id,
                "ok": True,
                "width": width,
                "height": height,
                "hash": current_hash,
                "hammingDistance": dist,
            }

        except Exception as e:
            return {
                "requestId": request_id,
                "ok": False,
                "error": str(e),
            }

    def _log(self, message: str):
        """Log to stderr (stdout is reserved for the JSON-line protocol)."""
        print(f"[frame-reader] {message}", file=sys.stderr, flush=True)


# ─── Main loop ────────────────────────────────────────────────────────────

def handle_request(reader: "FrameReader", request) -> dict:
    """Dispatch one parsed request.  Never raises."""
    if not isinstance(request, dict):
        return {"requestId": "", "ok": False, "error": "Request must be a JSON object"}
    request_id = request.get("requestId", "")
    try:
        cmd = request.get("cmd")
        if cmd == "crop":
            return reader.process_crop(request)
        if cmd == "process_image":
            return reader.process_image(request)
        if cmd == "ping":
            return {"requestId": request_id, "ok": True, "pong": True}
        return {"requestId": request_id, "ok": False, "error": f"Unknown command: {cmd}"}
    except Exception as e:  # defensive: one bad request must not kill the worker
        return {"requestId": request_id, "ok": False, "error": f"Internal error: {e}"}


def main():
    # Reserve the real stdout for the JSON-line protocol and send everything
    # else (including stray print() calls in dependencies) to stderr.
    proto_out = sys.stdout
    sys.stdout = sys.stderr

    def send(obj: dict) -> None:
        proto_out.write(json.dumps(obj) + "\n")
        proto_out.flush()

    reader = FrameReader()

    try:
        # Signal readiness to the parent process
        send({"type": "ready"})
        reader._log("Frame reader started, waiting for requests...")

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as e:
                send({"requestId": "", "ok": False, "error": f"Invalid JSON: {e}"})
                continue
            send(handle_request(reader, request))

        reader._log("Stdin closed, exiting.")
    except (BrokenPipeError, KeyboardInterrupt):
        # Parent went away or we were interrupted — exit quietly.
        pass
    finally:
        reader.disconnect()


if __name__ == "__main__":
    main()
