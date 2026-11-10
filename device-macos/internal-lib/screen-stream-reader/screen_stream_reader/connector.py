#!/usr/bin/env python3
"""
Screen Stream Reader - Connector Module

Python client for connecting to the AUSM screen-stream producer.

This provides a clean API for:
- Connecting to the screen capture shared memory
- Receiving push notifications for state changes
- Reading frames from active displays
- Controlling the producer (FPS, resolution, start/stop)

Usage:
    from screen_stream_reader import ScreenStreamConnector, Frame

    connector = ScreenStreamConnector()
    connector.connect()
    
    # Control the producer
    connector.set_display_fps("display-1", 30)
    
    while True:
        events = connector.poll_events()
        for event in events:
            print(f"Event: {event.type}")
        
        frame = connector.read_frame()
        if frame:
            # frame.bgr is a numpy array for OpenCV
            process(frame.bgr)
    
    connector.disconnect()
"""

import ctypes
import ctypes.util
import json
import logging
import mmap
import os
import socket
import struct
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("screen_stream_reader")


# Protocol Constants (must match device-macos/screen-stream/swift/.../Types.swift)
REGISTRY_MAGIC = 0x41555352  # 'AUSR'
SHM_MAGIC = 0x41555346  # 'AUSF'
MAX_DISPLAYS = 8

# Frame segment header: magic, version, frameCount, frameSize, width, height,
# format, writeIndex (8 x u32) then frameNumber (u64), generation (u64), reserved.
SHM_HEADER_FORMAT = "<IIIIIIIIQQ"
SHM_HEADER_SIZE = 72
SHM_GENERATION_OFFSET = 40
# Frame slot header: timestamp, frameNumber (u64), displayId, width, height,
# byteLength, ready, reserved (u32).
FRAME_HEADER_FORMAT = "<QQIIIIII"
FRAME_HEADER_SIZE = 40
FRAME_READY_OFFSET = 32
REGISTRY_HEADER_SIZE = 48
REGISTRY_ENTRY_SIZE = 240

# Default shared memory and socket paths (must match the producer configuration).
DEFAULT_SHM_NAME = "/ausm-frames"
# The helper serves one-shot JSON commands on the command socket and pushes
# newline-delimited JSON notifications on "<command socket>.notify".
DEFAULT_COMMAND_SOCKET = "/tmp/ausm-frames.sock"
DEFAULT_NOTIFY_SOCKET = DEFAULT_COMMAND_SOCKET + ".notify"
NOTIFY_SUFFIX = ".notify"


def notify_path_for(socket_path: str) -> str:
    """Return the notification socket path for either socket path.

    Older callers pass the command socket path as ``notify_socket``; connecting
    to the command socket would never yield notifications (and would tie up a
    helper worker until its request timeout), so map it to ``<path>.notify``.
    """
    return socket_path if socket_path.endswith(NOTIFY_SUFFIX) else socket_path + NOTIFY_SUFFIX


class EventType(Enum):
    """Types of events from the screen-stream producer"""
    CAPTURE_STARTED = "capture_started"
    CAPTURE_STOPPED = "capture_stopped"
    DISPLAY_ADDED = "display_added"
    DISPLAY_REMOVED = "display_removed"
    DISPLAY_CHANGE = "display_change"
    CONFIG_CHANGED = "config_changed"
    #: Helper-reported error; ``details`` has ``code`` (e.g. "permission_denied") and ``error``.
    ERROR = "error"
    UNKNOWN = "unknown"


@dataclass
class StreamEvent:
    """An event from the screen-stream producer"""
    type: EventType
    display_id: Optional[str] = None
    details: Dict = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)


@dataclass
class DisplayInfo:
    """Information about a connected display"""
    display_id: str  # String ID like "display-2"
    shm_name: str
    width: int  # Frame/capture pixel width
    height: int  # Frame/capture pixel height
    numeric_id: int = 0  # Numeric display ID used in frame headers
    scale_factor: float = 1.0  # Retina scale factor (2.0 for Retina)
    _logical_width: int = 0  # Display logical/point width (from registry)
    _logical_height: int = 0  # Display logical/point height (from registry)
    
    @property
    def resolution(self) -> Tuple[int, int]:
        return (self.width, self.height)
    
    @property
    def logical_width(self) -> int:
        """Width in logical points (CSS pixels).
        Uses the logical width from the registry if available,
        otherwise falls back to width / scale_factor."""
        if self._logical_width > 0:
            return self._logical_width
        return int(self.width / self.scale_factor)
    
    @property
    def logical_height(self) -> int:
        """Height in logical points (CSS pixels).
        Uses the logical height from the registry if available,
        otherwise falls back to height / scale_factor."""
        if self._logical_height > 0:
            return self._logical_height
        return int(self.height / self.scale_factor)


@dataclass
class Frame:
    """A captured frame with metadata.

    ``data`` is a (height, width, 4) uint8 BGRA array. By default it is a
    private copy validated against concurrent overwrites; with
    ``copy=False`` it is a read-only view into shared memory that the
    producer may overwrite at any time.
    """
    display_id: str
    frame_number: int
    #: Presentation timestamp in **microseconds** on the host clock (seconds
    #: since boot x 1e6). The field name is historical; it is not nanoseconds.
    timestamp_ns: int
    width: int
    height: int
    data: np.ndarray  # Shape: (height, width, 4) in BGRA format

    @property
    def timestamp_us(self) -> int:
        """Presentation timestamp in microseconds (host clock, since boot)."""
        return self.timestamp_ns

    @property
    def timestamp_s(self) -> float:
        """Presentation timestamp in seconds (host clock, comparable to time.monotonic())."""
        return self.timestamp_ns / 1_000_000

    @property
    def timestamp_ms(self) -> float:
        """Historical name: returns **seconds** (``timestamp_ns / 1e6``), not
        milliseconds. Kept unchanged for existing callers; prefer ``timestamp_s``."""
        return self.timestamp_ns / 1_000_000
    
    @property
    def resolution(self) -> Tuple[int, int]:
        return (self.width, self.height)
    
    @property
    def bgr(self) -> np.ndarray:
        """Get frame as BGR (3 channels, compatible with OpenCV)"""
        return self.data[:, :, :3]
    
    @property
    def rgb(self) -> np.ndarray:
        """Get frame as RGB (3 channels)"""
        return self.data[:, :, [2, 1, 0]]


class NotificationClient:
    """
    Connects to the helper's notification socket to receive push events.
    Thread-safe event queue.
    
    Also parses the 'init' message to get display and config info.
    """

    # Maximum pending events before oldest are discarded.
    # Prevents unbounded memory growth if the consumer doesn't
    # poll events fast enough (e.g. blocked on slow inference).
    _MAX_PENDING_EVENTS = 1000
    
    def __init__(self, socket_path: str = DEFAULT_NOTIFY_SOCKET):
        self.socket_path = notify_path_for(socket_path)
        self._socket: Optional[socket.socket] = None
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._pending_events: List[StreamEvent] = []
        self._events_lock = threading.Lock()
        self._connected = False
        # Parsed from init message
        self._init_config: Optional[Dict] = None
        self._init_displays: List[Dict] = []
        self._init_received = False
    
    @property
    def connected(self) -> bool:
        return self._connected and self._running
    
    def connect(self) -> bool:
        """Connect to the notification socket and start receiving events"""
        if self._running:
            return True
        # Clean up after a previous connection that dropped.
        self.disconnect()

        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(2.0)
            sock.connect(self.socket_path)
            # Short timeout so the receive loop can notice disconnect().
            sock.settimeout(0.5)
        except OSError:
            sock.close()
            self._connected = False
            return False

        self._socket = sock
        self._connected = True
        self._running = True
        self._thread = threading.Thread(target=self._receive_loop, args=(sock,),
                                        name="screen-stream-notify", daemon=True)
        self._thread.start()
        return True

    def disconnect(self):
        """Stop receiving notifications and close the connection"""
        self._running = False
        self._connected = False
        thread, self._thread = self._thread, None
        if thread and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        if self._socket:
            try:
                self._socket.close()
            except OSError:
                pass
            self._socket = None
    
    def get_events(self) -> List[StreamEvent]:
        """Get and clear pending events (thread-safe)"""
        with self._events_lock:
            events = self._pending_events.copy()
            self._pending_events.clear()
            return events
    
    @property
    def init_received(self) -> bool:
        """Whether the init message has been received"""
        return self._init_received
    
    @property
    def init_config(self) -> Optional[Dict]:
        """The config from the init message (shm name, size, etc.)"""
        return self._init_config
    
    @property
    def init_displays(self) -> List[Dict]:
        """The displays from the init message"""
        return self._init_displays.copy()
    
    def _parse_event(self, data: dict) -> StreamEvent:
        """Parse a JSON event into a StreamEvent"""
        event_type_str = data.get('type', 'unknown')
        try:
            event_type = EventType(event_type_str)
        except ValueError:
            event_type = EventType.UNKNOWN
        
        return StreamEvent(
            type=event_type,
            display_id=data.get('displayId'),
            details=data
        )
    
    # Max buffer size before we discard and reset (1 MB).
    # Protects against malformed input without newlines causing
    # unbounded memory growth.
    _MAX_RECV_BUFFER = 1_000_000

    def _receive_loop(self, sock: socket.socket):
        """Background thread that receives notifications"""
        buffer = ""
        while self._running:
            try:
                data = sock.recv(4096)
                if not data:
                    break

                buffer += data.decode('utf-8', errors='ignore')
                
                # Guard against malformed data without newlines:
                # if the buffer exceeds the cap, discard everything
                # up to the last newline (preserving any partial
                # message at the tail), or reset entirely.
                if len(buffer) > self._MAX_RECV_BUFFER:
                    last_nl = buffer.rfind('\n')
                    if last_nl >= 0:
                        buffer = buffer[last_nl + 1:]
                    else:
                        buffer = ""
                
                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                    line = line.strip()
                    if not line:
                        continue
                    
                    # Fast-path: skip high-volume 'frame' messages without JSON parsing.
                    # These arrive at capture FPS (e.g. 30fps * N displays) and parsing
                    # them creates significant GC pressure / memory fragmentation.
                    if '"type":"frame"' in line or '"type": "frame"' in line:
                        continue
                    
                    try:
                        event_data = json.loads(line)
                        msg_type = event_data.get('type', '')
                        
                        # Handle init message specially
                        if msg_type == 'init':
                            self._init_config = event_data.get('config', {})
                            self._init_displays = event_data.get('displays', [])
                            self._init_received = True
                        elif msg_type == 'frame':
                            pass  # Already filtered above, but safety net
                        else:
                            # Regular event
                            event = self._parse_event(event_data)
                            with self._events_lock:
                                self._pending_events.append(event)
                                # Prevent unbounded growth if consumer is slow
                                if len(self._pending_events) > self._MAX_PENDING_EVENTS:
                                    self._pending_events = self._pending_events[-self._MAX_PENDING_EVENTS:]
                    except (json.JSONDecodeError, AttributeError):
                        pass  # malformed line / non-object JSON
            except socket.timeout:
                continue
            except OSError:
                break
        
        self._running = False
        self._connected = False


class CommandClient:
    """
    Sends commands to the screen-stream producer via Unix socket.
    
    This allows consumers to control the producer:
    - Start/stop capture
    - Change FPS (global or per-display)
    - Change resolution
    - Query status
    """
    
    def __init__(self, socket_path: str = DEFAULT_COMMAND_SOCKET):
        self.socket_path = socket_path
        self._timeout = 10.0

    _MAX_RESPONSE_BYTES = 256 * 1024 * 1024
    
    def _send_command(self, command: dict) -> dict:
        """Send a command and wait for response"""
        sock = None
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(self._timeout)
            sock.connect(self.socket_path)
            
            # One newline-terminated JSON request per connection.
            sock.sendall(json.dumps(command).encode('utf-8') + b"\n")

            # The helper writes one JSON response and closes the connection.
            chunks = []
            total = 0
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > self._MAX_RESPONSE_BYTES:
                    return {"error": "Response too large"}
                chunks.append(chunk)

            response = json.loads(b"".join(chunks).decode('utf-8'))
            if not isinstance(response, dict):
                return {"error": "Invalid response"}
            return response
        except socket.timeout:
            return {"error": "Command timeout"}
        except (ConnectionRefusedError, FileNotFoundError):
            return {"error": "Producer not running"}
        except Exception as e:
            return {"error": str(e)}
        finally:
            if sock:
                try:
                    sock.close()
                except OSError:
                    pass
    
    def is_producer_running(self) -> bool:
        """Check if the producer is running and accessible"""
        response = self._send_command({"command": "status"})
        return "error" not in response
    
    def get_status(self) -> dict:
        """Get producer status"""
        return self._send_command({"command": "status"})
    
    def get_displays(self) -> List[dict]:
        """Get list of available displays"""
        response = self._send_command({"command": "displays"})
        return response.get("displays", [])
    
    def start_capture(self, display_ids: Optional[List[str]] = None) -> bool:
        """Start capture (optionally for specific displays)"""
        cmd = {"command": "start"}
        if display_ids:
            cmd["displayIds"] = display_ids
        response = self._send_command(cmd)
        return response.get("success", False)
    
    def stop_capture(self) -> bool:
        """Stop capture"""
        response = self._send_command({"command": "stop"})
        return response.get("success", False)
    
    def is_capturing(self) -> bool:
        """Check if capture is active"""
        response = self._send_command({"command": "status"})
        return response.get("capturing", False)
    
    def configure(self, fps: Optional[int] = None, 
                  target_height: Optional[int] = None,
                  frame_count: Optional[int] = None) -> bool:
        """Configure global capture settings"""
        config = {}
        if fps is not None:
            config["fps"] = fps
        if target_height is not None:
            config["targetHeight"] = target_height
        if frame_count is not None:
            config["frameCount"] = frame_count
        
        if not config:
            return True
        
        response = self._send_command({
            "command": "configure",
            "config": config
        })
        return response.get("success", False)
    
    def set_fps(self, fps: int) -> bool:
        """Set global FPS for all displays (requires restart if capturing)"""
        response = self._send_command({
            "command": "update_config",
            "config": {"fps": fps}
        })
        return response.get("success", False)
    
    def set_display_fps(self, display_id: str, fps: int) -> bool:
        """
        Set FPS for a specific display.
        
        If capture is running, the display will be restarted with the new FPS.
        
        Args:
            display_id: Display ID (e.g., "display-1")
            fps: Target FPS (1-120)
        """
        response = self._send_command({
            "command": "configureDisplay",
            "displayId": display_id,
            "config": {"fps": fps}
        })
        return response.get("success", False)
    
    def set_display_resolution(self, display_id: str, target_height: int) -> bool:
        """
        Set resolution for a specific display.
        
        Args:
            display_id: Display ID (e.g., "display-1")
            target_height: Target height in pixels (0 for native resolution)
        """
        response = self._send_command({
            "command": "configureDisplay",
            "displayId": display_id,
            "config": {"targetHeight": target_height}
        })
        return response.get("success", False)
    
    def get_display_configs(self) -> Dict[str, dict]:
        """Get configuration for all displays"""
        response = self._send_command({"command": "getDisplayConfigs"})
        return response.get("displayConfigs", {})


class SharedMemoryReader:
    """Low-level POSIX shared memory reader"""

    def __init__(self, name: str):
        self.name = name
        self._fd = -1
        self._mm: Optional[mmap.mmap] = None
        self._size = 0

    @property
    def is_open(self) -> bool:
        return self._mm is not None

    @property
    def size(self) -> int:
        return self._size

    _LIBC = None

    def _get_libc(self):
        if SharedMemoryReader._LIBC is None:
            libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
            libc.shm_open.restype = ctypes.c_int
            # Declare only the fixed parameters: ctypes then passes the extra
            # `mode` argument using the variadic convention (required on arm64).
            libc.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
            SharedMemoryReader._LIBC = libc
        return SharedMemoryReader._LIBC

    def open(self) -> bool:
        """Open the shared memory region read-only"""
        if self.is_open:
            return True
        try:
            libc = self._get_libc()
            self._fd = libc.shm_open(self.name.encode(), os.O_RDONLY, ctypes.c_int(0))
            if self._fd < 0:
                self._fd = -1
                return False
            self._size = os.fstat(self._fd).st_size
            if self._size <= 0:
                self.close()
                return False
            self._mm = mmap.mmap(self._fd, self._size, mmap.MAP_SHARED, mmap.PROT_READ)
            # mmap holds its own reference; the descriptor is no longer needed.
            os.close(self._fd)
            self._fd = -1
            return True
        except Exception:
            self.close()
            return False

    def close(self):
        """Close the shared memory mapping (numpy views into it become invalid)"""
        if self._mm:
            try:
                self._mm.close()
            except (BufferError, ValueError):
                # Outstanding zero-copy numpy views keep the buffer exported;
                # drop our reference and let GC unmap it once they are gone.
                pass
            self._mm = None
        if self._fd >= 0:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = -1
        self._size = 0

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()

    def read(self, offset: int, size: int) -> bytes:
        """Read bytes from shared memory"""
        if not self._mm:
            return b''
        if offset < 0 or size < 0 or offset + size > self._size:
            return b''
        return self._mm[offset:offset + size]

    def unpack_from(self, fmt: str, offset: int) -> Optional[tuple]:
        """
        Unpack a struct directly from the mmap without copying.

        Uses struct.unpack_from on the mmap buffer, avoiding the
        intermediate bytes allocation that read() + struct.unpack() would
        create.  This matters in hot loops (e.g. frame-header scanning)
        where many small reads per second fragment pymalloc arenas.
        """
        if not self._mm:
            return None
        try:
            return struct.unpack_from(fmt, self._mm, offset)
        except Exception:
            return None

    def read_numpy(self, offset: int, count: int, dtype=np.uint8) -> Optional[np.ndarray]:
        """
        Return a zero-copy numpy view into the mmap.
        
        Unlike read(), this does NOT allocate a new bytes object.
        The returned array is only valid while the mmap is open and
        the underlying data has not been overwritten by the producer.
        Callers must copy the data if they need it beyond the current frame.
        """
        if not self._mm:
            return None
        try:
            return np.frombuffer(self._mm, dtype=dtype, count=count, offset=offset)
        except (ValueError, TypeError):
            return None


class Registry:
    """
    Reads the display registry from shared memory.
    The registry contains information about all active displays.
    """

    HEADER_SIZE = 48
    ENTRY_SIZE = 240

    def __init__(self, base_name: str):
        self._shm = SharedMemoryReader(f"{base_name}-registry")
        self._base_name = base_name

    @property
    def is_open(self) -> bool:
        return self._shm.is_open

    def open(self) -> bool:
        return self._shm.open()

    def close(self):
        self._shm.close()

    def reopen(self) -> bool:
        """Close and reopen the connection (for reconnecting after producer restart)"""
        self.close()
        return self.open()

    def read_displays(self) -> List[DisplayInfo]:
        """Read all active displays from the registry"""
        displays = []
        header = self._shm.read(0, self.HEADER_SIZE)
        if len(header) < 16:
            return displays

        magic, version, max_displays, active_count = struct.unpack('<IIII', header[:16])
        if magic != REGISTRY_MAGIC:
            return displays

        # Never trust the header to size our loop beyond the mapped region.
        max_displays = min(max_displays, MAX_DISPLAYS,
                           max(0, (self._shm.size - self.HEADER_SIZE) // self.ENTRY_SIZE))
        for i in range(max_displays):
            offset = self.HEADER_SIZE + i * self.ENTRY_SIZE
            entry = self._shm.read(offset, self.ENTRY_SIZE)
            if len(entry) < self.ENTRY_SIZE:
                continue

            display_id = entry[:64].rstrip(b'\x00').decode('utf-8', errors='ignore')
            shm_name = entry[64:192].rstrip(b'\x00').decode('utf-8', errors='ignore')
            width, height, active, logical_width = struct.unpack('<IIII', entry[192:208])
            # logicalHeight is at offset 224 in the entry
            logical_height = struct.unpack('<I', entry[224:228])[0] if len(entry) >= 228 else 0

            if active and display_id:
                # NOTE: numeric_id is left at 0 intentionally.
                # Each display has its own per-display SHM, and the
                # producer writes 0 as the displayId in frame headers
                # (since the SHM already identifies the display).
                # Setting numeric_id to anything other than 0 would
                # cause FrameReader.read_latest() to skip all frames.
                displays.append(DisplayInfo(
                    display_id=display_id,
                    shm_name=shm_name,
                    width=width,
                    height=height,
                    _logical_width=logical_width,
                    _logical_height=logical_height,
                ))

        return displays


class FrameReader:
    """
    Reads frames from one display's shared memory ring buffer.

    Each slot holds a 40-byte frame header followed by packed BGRA pixels.
    The newest frame is the ready slot with the highest frame number
    (per-display segments always carry displayId 0 in frame headers).
    """

    SHM_HEADER_SIZE = SHM_HEADER_SIZE
    FRAME_HEADER_SIZE = FRAME_HEADER_SIZE
    #: Re-read attempts when the producer overwrites a slot mid-copy.
    MAX_READ_ATTEMPTS = 3

    def __init__(self, display_info: DisplayInfo):
        self.display_info = display_info
        self._shm = SharedMemoryReader(display_info.shm_name)
        self._frame_count = 0
        self._frame_size = 0
        self._width = 0
        self._height = 0
        self._generation = 0
        self._last_frame_number = -1
        self._numeric_id = display_info.numeric_id  # Match frames by numeric ID

    @property
    def is_open(self) -> bool:
        return self._shm.is_open

    @property
    def display_id(self) -> str:
        return self.display_info.display_id

    @property
    def generation(self) -> int:
        """Segment generation stamp (0 if the producer does not write one)."""
        return self._generation

    def open(self) -> bool:
        if not self._shm.open():
            return False

        header = parse_shm_header(self._shm.read(0, SHM_HEADER_SIZE))
        if header is None or header["magic"] != SHM_MAGIC:
            self._shm.close()
            return False

        frame_count = header["frame_count"]
        frame_size = header["frame_size"]
        # The ring must fit inside the mapping.
        if frame_count == 0 or SHM_HEADER_SIZE + frame_count * (FRAME_HEADER_SIZE + frame_size) > self._shm.size:
            self._shm.close()
            return False

        self._frame_count = frame_count
        self._frame_size = frame_size
        self._width = header["width"]
        self._height = header["height"]
        self._generation = header["generation"]
        return True

    def close(self):
        self._shm.close()

    def is_stale(self) -> bool:
        """True if the named segment was unlinked or replaced since open().

        Detects a producer restart that recreated the segment under the same
        name (our mapping would otherwise keep showing the last frame forever).
        Producers that don't stamp a generation (0) are only checked for
        existence.
        """
        if not self.is_open:
            return True
        probe = SharedMemoryReader(self.display_info.shm_name)
        if not probe.open():
            return True
        try:
            header = parse_shm_header(probe.read(0, SHM_HEADER_SIZE))
            if header is None:
                return True
            return self._generation != 0 and header["generation"] != self._generation
        finally:
            probe.close()

    def _slot_offset(self, slot_idx: int) -> int:
        return SHM_HEADER_SIZE + slot_idx * (FRAME_HEADER_SIZE + self._frame_size)

    def _latest_slot(self) -> Optional[Tuple[int, tuple]]:
        """Return (slot_idx, header) of the newest ready, well-formed frame."""
        best: Optional[Tuple[int, tuple]] = None
        for slot_idx in range(self._frame_count):
            # unpack_from reads straight from the mmap (no temporary bytes).
            result = self._shm.unpack_from(FRAME_HEADER_FORMAT, self._slot_offset(slot_idx))
            if result is None:
                continue
            timestamp, frame_number, display_id, width, height, byte_length, ready, _ = result
            if not ready or display_id != self._numeric_id:
                continue
            if (width == 0 or height == 0 or byte_length != width * height * 4
                    or byte_length > self._frame_size):
                continue
            if best is None or frame_number > best[1][1]:
                best = (slot_idx, result)
        return best

    def _slot_unchanged(self, slot_idx: int, frame_number: int) -> bool:
        """Re-check a slot after copying: still ready and same frame number."""
        offset = self._slot_offset(slot_idx)
        fn = self._shm.unpack_from('<Q', offset + 8)
        ready = self._shm.unpack_from('<I', offset + FRAME_READY_OFFSET)
        return fn is not None and ready is not None and fn[0] == frame_number and ready[0] == 1

    def read_latest(self, skip_if_same: bool = True, copy: bool = True) -> Optional[Frame]:
        """
        Read the most recent frame for this display.

        Args:
            skip_if_same: If True, returns None if the frame hasn't changed since last read
            copy: If True (default), return a private copy that is verified not
                to have been overwritten while copying (torn-read safe). If
                False, return a zero-copy read-only view into shared memory;
                the producer may overwrite it at any time (ring of N slots).

        Returns:
            Frame object or None if no frame available or unchanged
        """
        if self._frame_count == 0 or not self._shm.is_open:
            return None

        for _ in range(self.MAX_READ_ATTEMPTS):
            found = self._latest_slot()
            if found is None:
                return None
            slot_idx, header = found
            timestamp, frame_number, _, width, height, byte_length, _, _ = header

            if skip_if_same and frame_number == self._last_frame_number:
                return None

            data_offset = self._slot_offset(slot_idx) + FRAME_HEADER_SIZE
            view = self._shm.read_numpy(data_offset, byte_length)
            if view is None:
                return None

            if copy:
                pixels = view.copy()
                if not self._slot_unchanged(slot_idx, frame_number):
                    continue  # overwritten mid-copy; pick the new latest
            else:
                pixels = view

            self._last_frame_number = frame_number
            return Frame(
                display_id=self.display_id,
                frame_number=frame_number,
                timestamp_ns=timestamp,
                width=width,
                height=height,
                data=pixels.reshape((height, width, 4)),
            )
        return None


def parse_shm_header(buf: bytes) -> Optional[Dict[str, int]]:
    """Parse a frame segment header (first 72 bytes). Returns None if short."""
    if len(buf) < struct.calcsize(SHM_HEADER_FORMAT):
        return None
    (magic, version, frame_count, frame_size, width, height, fmt, write_index,
     frame_number, generation) = struct.unpack_from(SHM_HEADER_FORMAT, buf, 0)
    return {
        "magic": magic,
        "version": version,
        "frame_count": frame_count,
        "frame_size": frame_size,
        "width": width,
        "height": height,
        "format": fmt,
        "write_index": write_index,
        "frame_number": frame_number,
        "generation": generation,
    }


def parse_frame_header(buf: bytes) -> Optional[Dict[str, int]]:
    """Parse a 40-byte frame slot header. Returns None if short."""
    if len(buf) < FRAME_HEADER_SIZE:
        return None
    timestamp, frame_number, display_id, width, height, byte_length, ready, _ = \
        struct.unpack_from(FRAME_HEADER_FORMAT, buf, 0)
    return {
        "timestamp": timestamp,
        "frame_number": frame_number,
        "display_id": display_id,
        "width": width,
        "height": height,
        "byte_length": byte_length,
        "ready": ready,
    }


class ScreenStreamConnector:
    """
    High-level connector for the screen-stream module.
    
    Manages:
    - Notification socket connection (for push events)
    - Registry connection (for display enumeration)
    - Frame readers (for reading frames from each display)
    - Command client (for controlling the producer)
    
    Example:
        connector = ScreenStreamConnector()
        connector.connect()
        
        # Control the producer
        connector.set_display_fps("display-1", 30)
        
        while running:
            # Check for events (non-blocking)
            for event in connector.poll_events():
                if event.type == EventType.CAPTURE_STARTED:
                    print("Capture started!")
            
            # Read frame from current display
            frame = connector.read_frame()
            if frame:
                process_frame(frame.bgr)
        
        connector.disconnect()
    """
    
    def __init__(
        self,
        shm_name: str = DEFAULT_SHM_NAME,
        notify_socket: str = DEFAULT_NOTIFY_SOCKET,
        command_socket: str = DEFAULT_COMMAND_SOCKET,
        auto_reconnect: bool = True
    ):
        """
        Initialize the connector.
        
        Args:
            shm_name: Base name for shared memory regions
            notify_socket: Notification socket path. Passing the command socket
                path is accepted; ".notify" is appended automatically.
            command_socket: Path to the command Unix socket
            auto_reconnect: Automatically reconnect on events
        """
        self._shm_name = shm_name
        self._notify_socket = notify_socket
        self._command_socket = command_socket
        self._auto_reconnect = auto_reconnect
        
        self._notifier: Optional[NotificationClient] = None
        self._command_client: Optional[CommandClient] = None
        self._registry: Optional[Registry] = None
        self._frame_readers: Dict[str, FrameReader] = {}
        self._displays: List[DisplayInfo] = []
        self._current_display_idx = 0
        
        self._connected = False
        self._last_refresh = 0.0
        self._refresh_interval = 5.0  # Fallback refresh interval
        self._last_auto_poll = 0.0
        self._auto_poll_interval = 1.0  # Auto-poll at most once per second
        self._last_notify_attempt = 0.0
        self._notify_retry_interval = 2.0
    
    @property
    def connected(self) -> bool:
        """Whether the connector is connected to the producer"""
        return self._connected
    
    @property
    def displays(self) -> List[DisplayInfo]:
        """List of currently active displays"""
        return self._displays.copy()
    
    @property
    def current_display(self) -> Optional[DisplayInfo]:
        """The currently selected display"""
        if not self._displays:
            return None
        self._current_display_idx = self._current_display_idx % len(self._displays)
        return self._displays[self._current_display_idx]
    
    @property
    def has_notifications(self) -> bool:
        """Whether notification socket is connected"""
        return self._notifier is not None and self._notifier.connected
    
    def connect(self) -> bool:
        """
        Connect to the screen-stream producer.
        
        Returns:
            True if connected successfully
        """
        # Initialize command client (may not be used if producer doesn't support commands)
        self._command_client = CommandClient(self._command_socket)
        
        # Notification socket: push events (capture started/stopped, display
        # changes, errors) that tell us when to reopen shared memory.
        self._notifier = NotificationClient(self._notify_socket)
        self._last_notify_attempt = time.time()
        if not self._notifier.connect():
            return False

        # Legacy producers sent an 'init' message on connect; the current
        # helper does not, so only wait briefly for one.
        deadline = time.time() + 0.3
        while not self._notifier.init_received and time.time() < deadline:
            time.sleep(0.05)

        # Display discovery is via the shared-memory registry.
        self._registry = Registry(self._shm_name)
        
        # Initial display refresh
        self._refresh_displays()
        
        self._connected = True
        return True
    
    def disconnect(self):
        """Disconnect from the producer and clean up resources"""
        self._connected = False
        
        # Close frame readers
        for reader in self._frame_readers.values():
            reader.close()
        self._frame_readers.clear()
        
        # Close registry
        if self._registry:
            self._registry.close()
            self._registry = None
        
        # Stop notifier
        if self._notifier:
            self._notifier.disconnect()
            self._notifier = None
        
        # Command client doesn't need cleanup (stateless)
        self._command_client = None
        
        self._displays = []
    
    # ==================== Producer Control Methods ====================
    
    def is_producer_running(self) -> bool:
        """Check if the producer is running and accessible"""
        if not self._command_client:
            return False
        return self._command_client.is_producer_running()
    
    def start_capture(self, display_ids: Optional[List[str]] = None) -> bool:
        """
        Start capture on the producer.
        
        Args:
            display_ids: Optional list of display IDs to capture (None = all)
        """
        if not self._command_client:
            return False
        return self._command_client.start_capture(display_ids)
    
    def stop_capture(self) -> bool:
        """Stop capture on the producer"""
        if not self._command_client:
            return False
        return self._command_client.stop_capture()
    
    def is_capturing(self) -> bool:
        """Check if producer is actively capturing"""
        if not self._command_client:
            return False
        return self._command_client.is_capturing()
    
    def set_fps(self, fps: int) -> bool:
        """
        Set global FPS for all displays.
        
        Note: If capturing, this will restart all displays.
        
        Args:
            fps: Target FPS (1-120)
        """
        if not self._command_client:
            return False
        return self._command_client.set_fps(fps)
    
    def set_display_fps(self, display_id: str, fps: int) -> bool:
        """
        Set FPS for a specific display.
        
        If capture is running, only this display will be restarted.
        
        Args:
            display_id: Display ID (e.g., "display-1")
            fps: Target FPS (1-120)
        """
        if not self._command_client:
            return False
        return self._command_client.set_display_fps(display_id, fps)
    
    def set_display_resolution(self, display_id: str, target_height: int) -> bool:
        """
        Set resolution for a specific display.
        
        Args:
            display_id: Display ID (e.g., "display-1")
            target_height: Target height in pixels (0 for native resolution)
        """
        if not self._command_client:
            return False
        return self._command_client.set_display_resolution(display_id, target_height)
    
    def get_display_configs(self) -> Dict[str, dict]:
        """Get configuration (FPS, resolution) for all displays"""
        if not self._command_client:
            return {}
        return self._command_client.get_display_configs()
    
    def get_producer_displays(self) -> List[dict]:
        """Get list of displays from the producer (not from SHM)"""
        if not self._command_client:
            return []
        return self._command_client.get_displays()
    
    def poll_events(self) -> List[StreamEvent]:
        """
        Poll for events from the producer.
        
        This should be called regularly in your main loop.
        Events include: capture started/stopped, display changes, etc.
        
        If auto_reconnect is enabled, this will automatically refresh
        displays when relevant events are received.
        
        Returns:
            List of events since last poll
        """
        events: List[StreamEvent] = []
        need_refresh = False
        force_reconnect = False

        # Re-establish the notification connection after a helper restart.
        now = time.time()
        if (self._notifier and not self._notifier.connected
                and now - self._last_notify_attempt > self._notify_retry_interval):
            self._last_notify_attempt = now
            if self._notifier.connect():
                logger.debug("notification socket reconnected")
                need_refresh = True
                force_reconnect = True

        # Get events from notifier
        if self._notifier:
            for event in self._notifier.get_events():
                events.append(event)
                if self._auto_reconnect and event.type in (
                    EventType.CAPTURE_STARTED,
                    EventType.CAPTURE_STOPPED,
                    EventType.DISPLAY_ADDED,
                    EventType.DISPLAY_REMOVED,
                    EventType.DISPLAY_CHANGE,
                    EventType.CONFIG_CHANGED,
                ):
                    need_refresh = True
                    # Force full reconnect (close all readers, reopen
                    # registry + frame SHMs) on any structural change.
                    # The producer may recreate SHM on config/resolution
                    # changes, display add/remove, or capture restart,
                    # so the old mmaps could be stale.
                    if event.type in (
                        EventType.CAPTURE_STARTED,
                        EventType.CONFIG_CHANGED,
                        EventType.DISPLAY_CHANGE,
                        EventType.DISPLAY_ADDED,
                        EventType.DISPLAY_REMOVED,
                    ):
                        force_reconnect = True
        
        # Fallback periodic refresh
        now = time.time()
        if now - self._last_refresh > self._refresh_interval:
            need_refresh = True
        
        if need_refresh:
            self._refresh_displays(force_reconnect=force_reconnect)
        
        return events
    
    def select_display(self, display_id: str) -> bool:
        """
        Select a display by ID.
        
        Args:
            display_id: The display ID to select
            
        Returns:
            True if the display was found and selected
        """
        for idx, d in enumerate(self._displays):
            if d.display_id == display_id:
                self._current_display_idx = idx
                return True
        return False
    
    def cycle_display(self) -> Optional[DisplayInfo]:
        """
        Cycle to the next display.
        
        Returns:
            The newly selected display, or None if no displays
        """
        if self._displays:
            self._current_display_idx = (self._current_display_idx + 1) % len(self._displays)
            return self.current_display
        return None
    
    def read_frame(self, display_id: Optional[str] = None, skip_if_same: bool = True,
                   copy: bool = True) -> Optional[Frame]:
        """
        Read the latest frame from a display.
        
        Automatically polls for producer events (display changes, config
        changes, etc.) at most once per second so that stale shared-memory
        readers are transparently replaced.  Callers that need to inspect
        the events themselves should still call ``poll_events()`` directly.
        
        Args:
            display_id: Specific display to read from, or None for current display
            skip_if_same: Skip if the frame hasn't changed since last read
            copy: Return a verified private copy (default). ``False`` returns a
                zero-copy view the producer may overwrite (see FrameReader).

        Returns:
            Frame object or None if no frame available
        """
        self._auto_poll_if_due()
        
        if display_id:
            reader = self._frame_readers.get(display_id)
        else:
            display = self.current_display
            if not display:
                return None
            reader = self._frame_readers.get(display.display_id)
        
        if not reader:
            return None
        
        return reader.read_latest(skip_if_same=skip_if_same, copy=copy)

    def read_all_frames(self, skip_if_same: bool = True, copy: bool = True) -> Dict[str, Frame]:
        """
        Read frames from all connected displays.
        
        Automatically polls for producer events before reading (see
        ``read_frame`` for details).
        
        Args:
            skip_if_same: Skip displays whose frame hasn't changed
            
        Returns:
            Dict mapping display_id to Frame
        """
        self._auto_poll_if_due()
        
        frames = {}
        for display_id, reader in self._frame_readers.items():
            frame = reader.read_latest(skip_if_same=skip_if_same, copy=copy)
            if frame:
                frames[display_id] = frame
        return frames
    
    def _auto_poll_if_due(self) -> None:
        """
        Poll for producer events if enough time has elapsed since the last
        poll.  This ensures that ``read_frame`` / ``read_all_frames`` always
        operate on up-to-date shared-memory readers without requiring the
        caller to remember to call ``poll_events()`` in their own loop.
        
        The throttle (default 1 s) prevents excessive polling when frames
        are read at high frequency.  Callers that already call
        ``poll_events()`` explicitly are unaffected — the events are simply
        drained earlier and this method becomes a no-op until the next
        interval.
        """
        if not self._auto_reconnect:
            return
        now = time.time()
        if now - self._last_auto_poll < self._auto_poll_interval:
            return
        self._last_auto_poll = now
        try:
            self.poll_events()
        except Exception:
            pass  # Non-critical; next call will retry
    
    def _refresh_displays(self, force_reconnect: bool = False):
        """
        Refresh the list of active displays and reconnect readers.
        
        Args:
            force_reconnect: If True, close and reopen ALL readers (needed when
                             shared memory is recreated, e.g., after config change)
        """
        self._last_refresh = time.time()
        
        # Force reconnect: close all readers first (SHM was recreated)
        if force_reconnect:
            for reader in self._frame_readers.values():
                reader.close()
            self._frame_readers.clear()
        else:
            # Periodic refresh: drop readers whose segment was unlinked or
            # recreated (e.g. producer restarted while we missed the event).
            for display_id in list(self._frame_readers.keys()):
                if self._frame_readers[display_id].is_stale():
                    self._frame_readers[display_id].close()
                    del self._frame_readers[display_id]

        # Always reopen the registry: if the producer restarted, our old
        # mapping refers to an unlinked segment that is never updated again.
        registry_displays = []
        if self._registry:
            self._registry.reopen()
            if self._registry.is_open:
                registry_displays = self._registry.read_displays()
        
        # If registry didn't work, use init_displays from notification client
        if not registry_displays and self._notifier and self._notifier.init_received:
            # Convert init_displays to DisplayInfo objects
            init_config = self._notifier.init_config or {}
            shm_name = init_config.get('name', self._shm_name)
            
            for d in self._notifier.init_displays:
                display_id = d.get('id', '')
                width = d.get('width', 0)
                height = d.get('height', 0)
                numeric_id = d.get('displayId', 0)  # Numeric ID from producer
                scale_factor = d.get('scaleFactor', 1.0)  # Retina scale factor
                if display_id and width and height:
                    registry_displays.append(DisplayInfo(
                        display_id=display_id,
                        shm_name=shm_name,
                        width=width,
                        height=height,
                        numeric_id=numeric_id,
                        scale_factor=scale_factor,
                    ))
        
        if not registry_displays:
            self._displays = []
            # Close all readers
            for reader in self._frame_readers.values():
                reader.close()
            self._frame_readers.clear()
            return
        
        self._displays = registry_displays
        active_ids = {d.display_id for d in self._displays}
        # Build a lookup of full display info for staleness comparison
        registry_info = {d.display_id: d for d in self._displays}
        
        # Close readers for removed displays
        for display_id in list(self._frame_readers.keys()):
            if display_id not in active_ids:
                self._frame_readers[display_id].close()
                del self._frame_readers[display_id]
        
        # Close readers whose configuration has changed.
        # Compare fields that affect how frames are read or interpreted.
        # If any mismatch is found, the old mmap / reader state may be
        # stale (e.g. SHM was destroyed and recreated with new size).
        # NOTE: numeric_id is NOT compared because per-display SHMs
        # always write 0 in frame headers; comparing it would cause
        # spurious reader recreation if the registry and init_displays
        # paths report different values.
        for display_id in list(self._frame_readers.keys()):
            new_info = registry_info.get(display_id)
            if new_info is None:
                continue
            old_info = self._frame_readers[display_id].display_info
            if (old_info.width != new_info.width
                    or old_info.height != new_info.height
                    or old_info.shm_name != new_info.shm_name
                    or old_info._logical_width != new_info._logical_width
                    or old_info._logical_height != new_info._logical_height):
                self._frame_readers[display_id].close()
                del self._frame_readers[display_id]
        
        # Open readers for new displays (or all displays if force_reconnect)
        for d in self._displays:
            if d.display_id not in self._frame_readers:
                reader = FrameReader(d)
                if reader.open():
                    self._frame_readers[d.display_id] = reader


# Convenience function for quick setup
def create_connector(
    shm_name: str = DEFAULT_SHM_NAME,
    notify_socket: str = DEFAULT_NOTIFY_SOCKET
) -> ScreenStreamConnector:
    """
    Create and connect a ScreenStreamConnector.
    
    Example:
        connector = create_connector()
        frame = connector.read_frame()
    """
    connector = ScreenStreamConnector(shm_name, notify_socket)
    connector.connect()
    return connector
