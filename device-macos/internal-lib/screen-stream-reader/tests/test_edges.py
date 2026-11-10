"""Edge-case tests for screen_stream_reader (no screen capture / TCC needed).

Everything is fake-driven: scripted fake sockets for the notification parser,
throwaway AF_UNIX servers in a private temp directory for the socket clients,
and uniquely named POSIX shared memory segments built in the producer layout.
Nothing here touches the live helper's sockets or segments.

Run: python3 -m unittest discover -s tests   (from this package directory)
"""

import ctypes
import json
import mmap
import os
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_reader import HAVE_NUMPY, Segment, _libc  # noqa: E402

if HAVE_NUMPY:
    from screen_stream_reader import connector as c

_counter = [0]


def unique_name(tag):
    """A short, unique shm name (macOS limits names to 31 bytes)."""
    _counter[0] += 1
    return "/ausmT%d%s%d" % (os.getpid() % 100000, tag, _counter[0])


def make_raw_segment(name, size, payload=b""):
    """Create a segment of `size` bytes whose start is `payload`."""
    import mmap
    _libc.shm_unlink(name.encode())
    fd = _libc.shm_open(name.encode(), os.O_CREAT | os.O_EXCL | os.O_RDWR, ctypes.c_int(0o600))
    if fd < 0:
        raise OSError(ctypes.get_errno(), "shm_open failed")
    if size:
        os.ftruncate(fd, size)
    mm = mmap.mmap(fd, size, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE) if size else None
    os.close(fd)
    if mm is not None and payload:
        mm[:len(payload)] = payload
    return mm


class RegistrySegment:
    """A writable registry segment in the producer layout (Types.swift)."""

    def __init__(self, base_name, entries=8, max_displays=8, magic=None):
        self.name = base_name + "-registry"
        self.size = 48 + entries * 240
        self.mm = make_raw_segment(self.name, self.size)
        struct.pack_into("<IIII", self.mm, 0, magic if magic is not None else c.REGISTRY_MAGIC,
                         1, max_displays, 0)

    def set_entry(self, idx, display_id, shm_name, width, height, active=1,
                  logical_width=0, logical_height=0):
        off = 48 + idx * 240
        self.mm[off:off + 240] = b"\0" * 240
        did = display_id.encode("utf-8")[:63]
        sname = shm_name.encode("utf-8")[:127]
        self.mm[off:off + len(did)] = did
        self.mm[off + 64:off + 64 + len(sname)] = sname
        struct.pack_into("<IIII", self.mm, off + 192, width, height, active, logical_width)
        struct.pack_into("<I", self.mm, off + 224, logical_height)

    def close(self):
        self.mm.close()
        _libc.shm_unlink(self.name.encode())


class FakeSocket:
    """Scripted socket: each item is bytes, an exception instance, or b'' (EOF)."""

    def __init__(self, script):
        self.script = list(script)

    def recv(self, n):
        if not self.script:
            return b""
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def run_loop(chunks):
    """Feed `chunks` through NotificationClient._receive_loop synchronously."""
    client = c.NotificationClient("/nonexistent/test.sock")
    client._running = True
    client._connected = True
    client._receive_loop(FakeSocket(chunks))
    return client


def line(obj):
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


# --------------------------------------------------------------------------
# Notification stream parsing
# --------------------------------------------------------------------------

@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class NotificationParsingTests(unittest.TestCase):
    def test_partial_lines_are_reassembled(self):
        raw = line({"type": "capture_started"}) + line({"type": "display_change", "displayId": "display-2"})
        chunks = [raw[i:i + 3] for i in range(0, len(raw), 3)]
        client = run_loop(chunks)
        events = client.get_events()
        self.assertEqual([e.type for e in events],
                         [c.EventType.CAPTURE_STARTED, c.EventType.DISPLAY_CHANGE])
        self.assertEqual(events[1].display_id, "display-2")
        self.assertEqual(client.get_events(), [])  # drained

    def test_multibyte_utf8_split_across_chunks_is_preserved(self):
        msg = "Bildschirmaufnahme verweigert é中\U0001F600 שלום"
        raw = line({"type": "error", "code": "permission_denied", "error": msg})
        # Split inside every multi-byte sequence: one byte per chunk.
        client = run_loop([bytes([b]) for b in raw])
        events = client.get_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].type, c.EventType.ERROR)
        self.assertEqual(events[0].details["error"], msg)
        self.assertEqual(events[0].details["code"], "permission_denied")

    def test_invalid_utf8_does_not_break_the_stream(self):
        raw = b'{"type":"error","error":"\xff\xfe"}\n' + line({"type": "capture_stopped"})
        events = run_loop([raw]).get_events()
        self.assertEqual([e.type for e in events], [c.EventType.ERROR, c.EventType.CAPTURE_STOPPED])

    def test_malformed_and_non_object_lines_are_skipped(self):
        raw = (b"not json\n{\"type\":\n[1,2]\n42\n\"str\"\nnull\ntrue\n{}\n"
               + line({"type": "capture_stopped"}))
        events = run_loop([raw]).get_events()
        # `{}` is a valid object without a type -> UNKNOWN; everything else is dropped.
        self.assertEqual([e.type for e in events], [c.EventType.UNKNOWN, c.EventType.CAPTURE_STOPPED])

    def test_unknown_types_and_fields(self):
        raw = (line({"type": "brand_new_event", "displayId": "display-9", "extra": {"nested": [1]}})
               + line({"type": ["not", "a", "string"]})
               + line({"type": None})
               + line({"type": "config_changed", "future_field": 1, "displayId": None}))
        events = run_loop([raw]).get_events()
        self.assertEqual([e.type for e in events],
                         [c.EventType.UNKNOWN, c.EventType.UNKNOWN, c.EventType.UNKNOWN,
                          c.EventType.CONFIG_CHANGED])
        self.assertEqual(events[0].display_id, "display-9")
        self.assertEqual(events[0].details["extra"], {"nested": [1]})
        self.assertEqual(events[3].details["future_field"], 1)
        self.assertIsNone(events[3].display_id)

    def test_frame_messages_are_filtered(self):
        raw = (b'{"type":"frame","displayId":"display-1","frameNumber":1}\n'
               b'{"type": "frame", "frameNumber": 2}\n'
               + line({"type": "display_added", "displayId": "display-3"}))
        events = run_loop([raw]).get_events()
        self.assertEqual([e.type for e in events], [c.EventType.DISPLAY_ADDED])

    def test_blank_and_crlf_lines(self):
        raw = b"\n\r\n   \n" + b'{"type":"capture_started"}\r\n' + b"\n"
        events = run_loop([raw]).get_events()
        self.assertEqual([e.type for e in events], [c.EventType.CAPTURE_STARTED])

    def test_init_message_populates_config_and_displays(self):
        init = {"type": "init", "config": {"name": "/x"},
                "displays": [{"id": "display-1", "width": 10, "height": 5}]}
        client = run_loop([line(init)])
        self.assertTrue(client.init_received)
        self.assertEqual(client.init_config, {"name": "/x"})
        self.assertEqual(client.init_displays, init["displays"])
        self.assertEqual(client.get_events(), [])  # init is not an event
        # init_displays returns a copy.
        client.init_displays.clear()
        self.assertEqual(len(client.init_displays), 1)

    def test_init_message_with_null_or_wrong_typed_fields(self):
        for init in ({"type": "init", "config": None, "displays": None},
                     {"type": "init"},
                     {"type": "init", "config": [1], "displays": {"id": "x"}},
                     {"type": "init", "displays": ["display-1", 3, None]}):
            client = run_loop([line(init)])
            self.assertTrue(client.init_received)
            self.assertEqual(client.init_config, {})
            self.assertEqual(client.init_displays, [])

    def test_oversized_line_is_dropped_but_following_events_survive(self):
        client = c.NotificationClient("/nonexistent/test.sock")
        client._MAX_RECV_BUFFER = 1000
        client._running = True
        chunks = [b"x" * 900, b"y" * 200 + b"\n" + line({"type": "capture_started"}) + b'{"type":"capt',
                  b'ure_stopped"}\n']
        client._receive_loop(FakeSocket(chunks))
        self.assertEqual([e.type for e in client.get_events()],
                         [c.EventType.CAPTURE_STARTED, c.EventType.CAPTURE_STOPPED])

    def test_oversized_buffer_without_newline_is_reset(self):
        client = c.NotificationClient("/nonexistent/test.sock")
        client._MAX_RECV_BUFFER = 100
        client._running = True
        chunks = [b"z" * 80, b"z" * 80, b"tail-of-garbage\n" + line({"type": "capture_stopped"})]
        client._receive_loop(FakeSocket(chunks))
        self.assertEqual([e.type for e in client.get_events()], [c.EventType.CAPTURE_STOPPED])

    def test_pending_queue_keeps_newest_events(self):
        client = c.NotificationClient("/nonexistent/test.sock")
        client._MAX_PENDING_EVENTS = 5
        client._running = True
        raw = b"".join(line({"type": "display_change", "displayId": "d%d" % i}) for i in range(12))
        client._receive_loop(FakeSocket([raw]))
        self.assertEqual([e.display_id for e in client.get_events()], ["d7", "d8", "d9", "d10", "d11"])

    def test_eof_marks_disconnected(self):
        client = run_loop([line({"type": "capture_started"}), b""])
        self.assertFalse(client.connected)
        self.assertFalse(client._running)
        self.assertEqual(len(client.get_events()), 1)  # events before EOF are kept

    def test_timeouts_are_retried_and_oserror_ends_loop(self):
        client = run_loop([socket.timeout(), socket.timeout(), line({"type": "capture_started"}),
                           ConnectionResetError(), line({"type": "capture_stopped"})])
        self.assertEqual([e.type for e in client.get_events()], [c.EventType.CAPTURE_STARTED])
        self.assertFalse(client.connected)

    def test_loop_stops_when_running_cleared(self):
        client = c.NotificationClient("/nonexistent/test.sock")
        client._running = False
        client._receive_loop(FakeSocket([line({"type": "capture_started"})]))
        self.assertEqual(client.get_events(), [])

    def test_get_events_is_thread_safe(self):
        client = c.NotificationClient("/nonexistent/test.sock")
        client._running = True
        n = 500
        raw = b"".join(line({"type": "display_change", "displayId": str(i)}) for i in range(n))
        chunks = [raw[i:i + 97] for i in range(0, len(raw), 97)]
        t = threading.Thread(target=client._receive_loop, args=(FakeSocket(chunks),))
        got = []
        t.start()
        while t.is_alive():
            got.extend(client.get_events())
        t.join()
        got.extend(client.get_events())
        self.assertEqual([e.display_id for e in got], [str(i) for i in range(n)])

    def test_parse_event_details_is_the_raw_object(self):
        client = c.NotificationClient("/nonexistent/test.sock")
        data = {"type": "error", "code": "x", "displayId": "display-1"}
        ev = client._parse_event(data)
        self.assertIs(ev.details, data)
        self.assertEqual(ev.display_id, "display-1")
        self.assertIsInstance(ev.timestamp, float)


# --------------------------------------------------------------------------
# Real AF_UNIX sockets in a private temp directory
# --------------------------------------------------------------------------

class UnixServer:
    """Throwaway AF_UNIX server; `handler(conn)` runs per connection on a thread."""

    def __init__(self, path, handler):
        self.path = path
        self.handler = handler
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(path)
        self.sock.listen(8)
        self.sock.settimeout(0.1)
        self.running = True
        self.conns = []
        self.requests = []
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        while self.running:
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.conns.append(conn)
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        try:
            self.handler(self, conn)
        except OSError:
            pass

    def close(self):
        self.running = False
        self.thread.join(timeout=2)
        for conn in self.conns:
            try:
                conn.close()
            except OSError:
                pass
        self.sock.close()
        try:
            os.unlink(self.path)
        except OSError:
            pass


def read_request(conn):
    conn.settimeout(2)
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = conn.recv(4096)
        if not chunk:
            break
        buf += chunk
    return buf


@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class SocketTestBase(unittest.TestCase):
    def setUp(self):
        # Short path: AF_UNIX paths are limited to 104 bytes on macOS.
        self.dir = tempfile.mkdtemp(prefix="ssr", dir="/tmp" if os.path.isdir("/tmp") else None)
        self.servers = []

    def tearDown(self):
        for s in self.servers:
            s.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def serve(self, name, handler):
        s = UnixServer(os.path.join(self.dir, name), handler)
        self.servers.append(s)
        return s


class CommandClientTests(SocketTestBase):
    def client_for(self, handler):
        server = self.serve("cmd.sock", handler)
        client = c.CommandClient(server.path)
        client._timeout = 2.0
        return server, client

    def test_request_is_one_json_line_and_response_parsed(self):
        def handler(server, conn):
            server.requests.append(read_request(conn))
            conn.sendall(b'{"success": true, "capturing": true}')
            conn.close()

        server, client = self.client_for(handler)
        self.assertTrue(client.start_capture(["display-1", "display-é"]))
        req = server.requests[0]
        self.assertTrue(req.endswith(b"\n"))
        self.assertEqual(req.count(b"\n"), 1)
        self.assertEqual(json.loads(req), {"command": "start", "displayIds": ["display-1", "display-é"]})

    def test_empty_display_list_sends_no_display_ids(self):
        def handler(server, conn):
            server.requests.append(json.loads(read_request(conn)))
            conn.sendall(b'{"success": true}')
            conn.close()

        server, client = self.client_for(handler)
        self.assertTrue(client.start_capture([]))
        self.assertEqual(server.requests[0], {"command": "start"})

    def test_response_split_across_many_writes(self):
        body = json.dumps({"displays": [{"id": "display-%d" % i, "width": 1920} for i in range(200)]}).encode()

        def handler(server, conn):
            read_request(conn)
            for i in range(0, len(body), 7):
                conn.sendall(body[i:i + 7])
            conn.close()

        _, client = self.client_for(handler)
        displays = client.get_displays()
        self.assertEqual(len(displays), 200)
        self.assertEqual(displays[-1]["id"], "display-199")

    def test_empty_or_non_object_or_garbage_response(self):
        responses = [b"", b"[1, 2]", b"null", b"\xff\xfe{", b'{"success": tr']
        for body in responses:
            def handler(server, conn, body=body):
                read_request(conn)
                if body:
                    conn.sendall(body)
                conn.close()

            server, client = self.client_for(handler)
            r = client._send_command({"command": "status"})
            self.assertIn("error", r, body)
            self.assertFalse(client.is_producer_running())
            self.assertFalse(client.start_capture())
            server.close()
            self.servers.remove(server)

    def test_null_or_wrong_typed_collections_fall_back_to_empty(self):
        for body in (b'{"displays": null, "displayConfigs": null}',
                     b'{"displays": "x", "displayConfigs": [1]}',
                     b'{}'):
            def handler(server, conn, body=body):
                read_request(conn)
                conn.sendall(body)
                conn.close()

            server, client = self.client_for(handler)
            self.assertEqual(client.get_displays(), [])
            self.assertEqual(client.get_display_configs(), {})
            server.close()
            self.servers.remove(server)

    def test_timeout_when_producer_never_answers(self):
        release = threading.Event()

        def handler(server, conn):
            read_request(conn)
            release.wait(5)
            conn.close()

        _, client = self.client_for(handler)
        client._timeout = 0.2
        t0 = time.monotonic()
        self.assertEqual(client.get_status(), {"error": "Command timeout"})
        self.assertLess(time.monotonic() - t0, 2.0)
        release.set()

    def test_missing_socket_means_not_running(self):
        client = c.CommandClient(os.path.join(self.dir, "absent.sock"))
        self.assertEqual(client.get_status(), {"error": "Producer not running"})
        self.assertFalse(client.is_producer_running())
        self.assertFalse(client.is_capturing())
        self.assertEqual(client.get_displays(), [])

    def test_stale_socket_file_means_not_running(self):
        path = os.path.join(self.dir, "stale.sock")
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(path)
        s.close()  # file remains, nobody listens -> ECONNREFUSED
        self.assertEqual(c.CommandClient(path).get_status(), {"error": "Producer not running"})

    def test_oversized_response_is_rejected(self):
        def handler(server, conn):
            read_request(conn)
            try:
                conn.sendall(b'{"pad": "' + b"a" * 5000 + b'"}')
            except OSError:
                pass
            conn.close()

        _, client = self.client_for(handler)
        client._MAX_RESPONSE_BYTES = 1000
        self.assertEqual(client.get_status(), {"error": "Response too large"})

    def test_configure_builds_only_given_fields(self):
        def handler(server, conn):
            server.requests.append(json.loads(read_request(conn)))
            conn.sendall(b'{"success": true}')
            conn.close()

        server, client = self.client_for(handler)
        self.assertTrue(client.configure())  # nothing to send
        self.assertEqual(server.requests, [])
        self.assertTrue(client.configure(fps=0, target_height=0))
        self.assertEqual(server.requests[-1], {"command": "configure", "config": {"fps": 0, "targetHeight": 0}})
        self.assertTrue(client.set_display_fps("display-1", 120))
        self.assertEqual(server.requests[-1],
                         {"command": "configureDisplay", "displayId": "display-1", "config": {"fps": 120}})
        self.assertTrue(client.set_display_resolution("display-1", 0))
        self.assertEqual(server.requests[-1]["config"], {"targetHeight": 0})
        self.assertTrue(client.set_fps(30))
        self.assertEqual(server.requests[-1], {"command": "update_config", "config": {"fps": 30}})
        self.assertTrue(client.stop_capture())
        self.assertEqual(server.requests[-1], {"command": "stop"})


class NotificationClientSocketTests(SocketTestBase):
    def wait_for(self, cond, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if cond():
                return True
            time.sleep(0.01)
        return cond()

    def test_command_socket_path_is_mapped_to_notify(self):
        def handler(server, conn):
            conn.sendall(line({"type": "capture_started"}))
            time.sleep(1)

        server = self.serve("cmd.sock.notify", handler)
        client = c.NotificationClient(server.path[:-len(".notify")])
        self.assertTrue(client.connect())
        try:
            self.assertTrue(self.wait_for(lambda: client._pending_events))
            self.assertEqual(client.get_events()[0].type, c.EventType.CAPTURE_STARTED)
        finally:
            client.disconnect()

    def test_connect_to_missing_socket_fails(self):
        client = c.NotificationClient(os.path.join(self.dir, "nope.sock"))
        self.assertFalse(client.connect())
        self.assertFalse(client.connected)
        client.disconnect()  # idempotent on a never-connected client
        client.disconnect()

    def test_double_connect_is_a_no_op(self):
        server = self.serve("a.sock.notify", lambda s, conn: time.sleep(2))
        client = c.NotificationClient(server.path)
        self.assertTrue(client.connect())
        thread = client._thread
        self.assertTrue(client.connect())
        self.assertIs(client._thread, thread)
        client.disconnect()

    def test_disconnect_while_reading_returns_promptly(self):
        stop = threading.Event()

        def handler(server, conn):
            # Trickle partial data so the receive loop is mid-line when we disconnect.
            while not stop.is_set():
                try:
                    conn.sendall(b'{"type":"disp')
                except OSError:
                    return
                time.sleep(0.05)

        server = self.serve("b.sock.notify", handler)
        client = c.NotificationClient(server.path)
        self.assertTrue(client.connect())
        time.sleep(0.15)
        thread = client._thread
        t0 = time.monotonic()
        client.disconnect()
        self.assertLess(time.monotonic() - t0, 1.5)
        self.assertFalse(thread.is_alive())
        self.assertFalse(client.connected)
        self.assertIsNone(client._socket)
        stop.set()

    def test_server_close_then_reconnect(self):
        def handler(server, conn):
            conn.sendall(line({"type": "capture_started"}))
            conn.close()

        server = self.serve("c.sock.notify", handler)
        client = c.NotificationClient(server.path)
        self.assertTrue(client.connect())
        self.assertTrue(self.wait_for(lambda: not client.connected))
        self.assertEqual(len(client.get_events()), 1)
        # Helper restarted: reconnect works and delivers new events.
        self.assertTrue(client.connect())
        self.assertTrue(self.wait_for(lambda: client._pending_events))
        self.assertEqual(client.get_events()[0].type, c.EventType.CAPTURE_STARTED)
        client.disconnect()


# --------------------------------------------------------------------------
# Shared memory: low-level reader, registry, frame reader
# --------------------------------------------------------------------------

@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class SharedMemoryReaderTests(unittest.TestCase):
    def setUp(self):
        self.name = unique_name("r")
        self.mm = make_raw_segment(self.name, 64, bytes(range(64)))

    def tearDown(self):
        self.mm.close()
        _libc.shm_unlink(self.name.encode())

    def test_bounds_checked_reads(self):
        r = c.SharedMemoryReader(self.name)
        self.assertEqual(r.read(0, 4), b"")  # not open yet
        self.assertIsNone(r.unpack_from("<I", 0))
        self.assertIsNone(r.read_numpy(0, 4))
        self.assertTrue(r.open())
        self.assertTrue(r.open())  # idempotent
        # macOS rounds shm segments up to whole pages.
        size = r.size
        self.assertGreaterEqual(size, 64)
        self.assertEqual(size % mmap.PAGESIZE, 0)
        self.assertEqual(r.read(60, 4), bytes([60, 61, 62, 63]))
        self.assertEqual(r.read(size - 3, 4), b"")
        self.assertEqual(len(r.read(size - 4, 4)), 4)
        self.assertEqual(r.read(-1, 2), b"")
        self.assertEqual(r.read(0, -1), b"")
        self.assertEqual(r.read(size, 0), b"")
        self.assertEqual(r.unpack_from("<I", 0), (0x03020100,))
        self.assertIsNone(r.unpack_from("<Q", size - 4))
        self.assertIsNone(r.unpack_from("<I", -size - 1))
        self.assertIsNone(r.read_numpy(size - 4, 8))
        self.assertEqual(list(r.read_numpy(62, 2)), [62, 63])
        r.close()
        r.close()
        self.assertFalse(r.is_open)
        self.assertEqual(r.size, 0)

    def test_close_with_outstanding_view(self):
        r = c.SharedMemoryReader(self.name)
        self.assertTrue(r.open())
        view = r.read_numpy(0, 8)
        r.close()  # must not raise BufferError
        self.assertFalse(r.is_open)
        self.assertEqual(int(view[3]), 3)  # view keeps the mapping alive
        del view

    def test_context_manager_and_missing_segment(self):
        with c.SharedMemoryReader(self.name) as r:
            self.assertTrue(r.is_open)
        self.assertFalse(r.is_open)
        self.assertFalse(c.SharedMemoryReader(unique_name("missing")).open())

    def test_zero_size_segment_is_rejected(self):
        name = unique_name("z")
        make_raw_segment(name, 0)
        try:
            r = c.SharedMemoryReader(name)
            self.assertFalse(r.open())
            self.assertFalse(r.is_open)
            self.assertEqual(r._fd, -1)
        finally:
            _libc.shm_unlink(name.encode())


@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.base = unique_name("g")
        self.segs = []

    def tearDown(self):
        for s in self.segs:
            s.close()

    def registry(self, **kw):
        seg = RegistrySegment(self.base, **kw)
        self.segs.append(seg)
        return seg

    def read(self):
        reg = c.Registry(self.base)
        if not reg.open():
            return None
        try:
            return reg.read_displays()
        finally:
            reg.close()

    def test_reads_active_displays_with_retina_logical_sizes(self):
        seg = self.registry()
        seg.set_entry(0, "display-1", "/f-1", 2880, 1800, logical_width=1440, logical_height=900)
        seg.set_entry(1, "display-2", "/f-2", 1920, 1080, active=0)
        seg.set_entry(3, "display-3", "/f-3", 3840, 2160, logical_width=1920, logical_height=1080)
        displays = self.read()
        self.assertEqual([d.display_id for d in displays], ["display-1", "display-3"])
        d = displays[0]
        self.assertEqual(d.shm_name, "/f-1")
        self.assertEqual(d.resolution, (2880, 1800))
        self.assertEqual((d.logical_width, d.logical_height), (1440, 900))
        self.assertEqual(d.numeric_id, 0)  # frames always carry displayId 0

    def test_wrong_magic_or_missing_registry(self):
        self.assertIsNone(self.read())
        seg = self.registry(magic=0xDEADBEEF)
        seg.set_entry(0, "display-1", "/f-1", 10, 10)
        self.assertEqual(self.read(), [])

    def test_header_cannot_size_loop_past_mapping(self):
        seg = self.registry(entries=1, max_displays=1_000_000)
        seg.set_entry(0, "display-1", "/f-1", 10, 10)
        self.assertEqual([d.display_id for d in self.read()], ["display-1"])

    def test_header_max_displays_caps_and_zero(self):
        seg = self.registry(max_displays=1)
        seg.set_entry(0, "display-1", "/f-1", 10, 10)
        seg.set_entry(1, "display-2", "/f-2", 10, 10)
        self.assertEqual(len(self.read()), 1)
        struct.pack_into("<I", seg.mm, 8, 0)
        self.assertEqual(self.read(), [])

    def test_more_than_max_displays_entries_are_ignored(self):
        seg = self.registry(entries=10, max_displays=10)
        for i in range(10):
            seg.set_entry(i, "display-%d" % i, "/f-%d" % i, 10, 10)
        self.assertEqual(len(self.read()), c.MAX_DISPLAYS)

    def test_truncated_registry(self):
        name = self.base + "-registry"
        mm = make_raw_segment(name, 10, b"\x52\x53\x55\x41")
        try:
            self.assertEqual(self.read(), [])
        finally:
            mm.close()
            _libc.shm_unlink(name.encode())

    def test_empty_id_and_unicode_names(self):
        seg = self.registry()
        seg.set_entry(0, "", "/f-0", 10, 10)
        seg.set_entry(1, "屏幕-\U0001F5A5", "/f-1", 10, 10)
        displays = self.read()
        self.assertEqual([d.display_id for d in displays], ["屏幕-\U0001F5A5"])

    def test_max_length_fields_are_not_overrun(self):
        seg = self.registry()
        seg.set_entry(0, "d" * 100, "s" * 200, 10, 10)
        d = self.read()[0]
        self.assertEqual(d.display_id, "d" * 63)
        self.assertEqual(d.shm_name, "s" * 127)

    def test_reopen_after_producer_restart(self):
        seg = self.registry()
        seg.set_entry(0, "display-1", "/f-1", 10, 10)
        reg = c.Registry(self.base)
        self.assertTrue(reg.open())
        seg.close()
        self.segs.remove(seg)
        seg2 = self.registry()
        seg2.set_entry(0, "display-7", "/f-7", 20, 20)
        # The old mapping still shows the unlinked segment.
        self.assertEqual([d.display_id for d in reg.read_displays()], ["display-1"])
        self.assertTrue(reg.reopen())
        self.assertEqual([d.display_id for d in reg.read_displays()], ["display-7"])
        reg.close()
        self.assertFalse(reg.is_open)
        self.assertEqual(reg.read_displays(), [])


@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class DisplayInfoTests(unittest.TestCase):
    def test_logical_size_fallbacks(self):
        d = c.DisplayInfo("display-1", "/x", 2880, 1800, scale_factor=2.0)
        self.assertEqual((d.logical_width, d.logical_height), (1440, 900))
        d = c.DisplayInfo("display-1", "/x", 2880, 1800, scale_factor=2.0, _logical_width=1512,
                          _logical_height=982)
        self.assertEqual((d.logical_width, d.logical_height), (1512, 982))
        d = c.DisplayInfo("display-1", "/x", 1001, 501, scale_factor=1.5)
        self.assertEqual((d.logical_width, d.logical_height), (667, 334))

    def test_zero_or_negative_scale_does_not_crash(self):
        for scale in (0, 0.0, -2.0):
            d = c.DisplayInfo("display-1", "/x", 1920, 1080, scale_factor=scale)
            self.assertEqual((d.logical_width, d.logical_height), (1920, 1080))


def write_slot(seg, idx, fill, frame_number, width=None, height=None, byte_length=None,
               ready=1, display_id=0, timestamp=1_000_000):
    """Write an arbitrary slot (for out-of-order and malformed headers)."""
    width = seg.width if width is None else width
    height = seg.height if height is None else height
    byte_length = width * height * 4 if byte_length is None else byte_length
    off = seg.slot_offset(idx)
    struct.pack_into("<I", seg.mm, off + 32, 0)
    seg.mm[off + 40: off + 40 + seg.frame_size] = bytes([fill]) * seg.frame_size
    struct.pack_into("<QQIIIIII", seg.mm, off, timestamp, frame_number, display_id,
                     width, height, byte_length, ready, 0)


@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class FrameReaderEdgeTests(unittest.TestCase):
    def setUp(self):
        self.name = unique_name("f")
        self.seg = Segment(self.name, width=4, height=2, slots=3)
        self.reader = c.FrameReader(c.DisplayInfo("display-1", self.name, 4, 2))
        self.assertTrue(self.reader.open())

    def tearDown(self):
        self.reader.close()
        self.seg.close()

    def test_newest_frame_wins_regardless_of_slot_order(self):
        write_slot(self.seg, 0, 1, frame_number=12)
        write_slot(self.seg, 1, 2, frame_number=10)
        write_slot(self.seg, 2, 3, frame_number=11)
        f = self.reader.read_latest()
        self.assertEqual(f.frame_number, 12)
        self.assertTrue((f.data == 1).all())

    def test_huge_frame_numbers_and_timestamps(self):
        write_slot(self.seg, 0, 1, frame_number=2 ** 64 - 1, timestamp=2 ** 64 - 1)
        write_slot(self.seg, 1, 2, frame_number=2 ** 63)
        f = self.reader.read_latest()
        self.assertEqual(f.frame_number, 2 ** 64 - 1)
        self.assertEqual(f.timestamp_us, 2 ** 64 - 1)

    def test_malformed_slots_are_skipped(self):
        write_slot(self.seg, 0, 1, frame_number=50, width=0)            # zero width
        write_slot(self.seg, 1, 2, frame_number=51, byte_length=31)     # wrong byte length
        write_slot(self.seg, 2, 3, frame_number=52, display_id=7)       # other display
        self.assertIsNone(self.reader.read_latest())
        write_slot(self.seg, 0, 4, frame_number=1, width=8, height=2)   # larger than slot
        self.assertIsNone(self.reader.read_latest())
        write_slot(self.seg, 1, 5, frame_number=2, ready=0)             # not ready
        self.assertIsNone(self.reader.read_latest())
        write_slot(self.seg, 1, 6, frame_number=3, width=2, height=2)   # smaller frame is fine
        f = self.reader.read_latest()
        self.assertEqual(f.data.shape, (2, 2, 4))
        self.assertTrue((f.data == 6).all())

    def test_skip_if_same_false_returns_the_frame_again(self):
        self.seg.write(9)
        self.assertIsNotNone(self.reader.read_latest())
        self.assertIsNone(self.reader.read_latest())
        f = self.reader.read_latest(skip_if_same=False)
        self.assertEqual(f.frame_number, 0)

    def test_retry_returns_newer_frame_after_torn_read(self):
        self.seg.write(1)
        seg = self.seg
        original = c.FrameReader._slot_unchanged
        calls = []

        def overwrite_once(reader, slot_idx, frame_number):
            if not calls:
                seg.write(2)  # producer publishes a newer frame into the next slot
                struct.pack_into("<Q", seg.mm, seg.slot_offset(slot_idx) + 8, 999)  # and reuses ours
                struct.pack_into("<I", seg.mm, seg.slot_offset(slot_idx) + 32, 0)
            calls.append(slot_idx)
            return original(reader, slot_idx, frame_number)

        c.FrameReader._slot_unchanged = overwrite_once
        try:
            f = self.reader.read_latest()
        finally:
            c.FrameReader._slot_unchanged = original
        self.assertEqual(len(calls), 2)
        self.assertEqual(f.frame_number, 1)
        self.assertTrue((f.data == 2).all())

    def test_gives_up_after_max_attempts_when_always_torn(self):
        self.seg.write(1)
        original = c.FrameReader._slot_unchanged
        calls = []
        c.FrameReader._slot_unchanged = lambda reader, i, fn: calls.append(i) or False
        try:
            self.assertIsNone(self.reader.read_latest())
        finally:
            c.FrameReader._slot_unchanged = original
        self.assertEqual(len(calls), c.FrameReader.MAX_READ_ATTEMPTS)
        # A failed read does not mark the frame as seen.
        self.assertIsNotNone(self.reader.read_latest())

    def test_frame_views_and_channels(self):
        off = self.seg.slot_offset(self.seg.write(0)) + 40
        self.seg.mm[off:off + 4] = bytes([10, 20, 30, 255])  # B, G, R, A of pixel (0,0)
        f = self.reader.read_latest()
        self.assertEqual(list(f.bgr[0, 0]), [10, 20, 30])
        self.assertEqual(list(f.rgb[0, 0]), [30, 20, 10])
        self.assertEqual(f.resolution, (4, 2))
        self.assertTrue(f.data.flags.writeable)  # private copy

    def test_read_after_close_and_double_close(self):
        self.seg.write(1)
        self.reader.close()
        self.reader.close()
        self.assertIsNone(self.reader.read_latest())
        self.assertTrue(self.reader.is_stale())  # closed readers count as stale

    def test_stale_without_generation_only_checks_existence(self):
        self.seg.close()
        self.seg = Segment(self.name, width=4, height=2, slots=3, generation=0)
        reader = c.FrameReader(c.DisplayInfo("display-1", self.name, 4, 2))
        self.assertTrue(reader.open())
        self.assertEqual(reader.generation, 0)
        self.seg.close()
        self.assertTrue(reader.is_stale())
        self.seg = Segment(self.name, width=4, height=2, slots=3, generation=77)
        self.assertFalse(reader.is_stale())  # no generation: recreate is undetectable
        reader.close()


@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class FrameReaderOpenTests(unittest.TestCase):
    def open_with_header(self, size, header):
        name = unique_name("o")
        mm = make_raw_segment(name, size, header)
        try:
            return c.FrameReader(c.DisplayInfo("display-1", name, 4, 2)).open()
        finally:
            mm.close()
            _libc.shm_unlink(name.encode())

    def header(self, magic=None, frame_count=2, frame_size=32, width=4, height=2):
        return struct.pack("<IIIIIIIIQQ", c.SHM_MAGIC if magic is None else magic, 1, frame_count,
                           frame_size, width, height, 0, 0, 0, 1)

    def test_valid_header_opens(self):
        self.assertTrue(self.open_with_header(72 + 2 * 72, self.header()))

    def test_rejects_bad_headers(self):
        self.assertFalse(self.open_with_header(72 + 2 * 72, self.header(magic=c.REGISTRY_MAGIC)))
        self.assertFalse(self.open_with_header(72 + 2 * 72, self.header(frame_count=0)))
        # Ring larger than the (page-rounded) mapping.
        too_many = mmap.PAGESIZE // 72 + 1
        self.assertFalse(self.open_with_header(mmap.PAGESIZE, self.header(frame_count=too_many)))
        self.assertFalse(self.open_with_header(72 + 2 * 72, self.header(frame_size=2 ** 32 - 1)))
        self.assertFalse(self.open_with_header(72 + 2 * 72, self.header(frame_count=2 ** 32 - 1)))
        self.assertFalse(self.open_with_header(40, b""))                                      # truncated
        self.assertFalse(c.FrameReader(c.DisplayInfo("display-1", unique_name("none"), 4, 2)).open())

    def test_zero_frame_size_ring_opens_but_yields_nothing(self):
        name = unique_name("o")
        mm = make_raw_segment(name, 72 + 2 * 40, self.header(frame_size=0))
        try:
            r = c.FrameReader(c.DisplayInfo("display-1", name, 4, 2))
            self.assertTrue(r.open())
            struct.pack_into("<QQIIIIII", mm, 72, 1, 1, 0, 4, 2, 32, 1, 0)
            self.assertIsNone(r.read_latest())
            r.close()
        finally:
            mm.close()
            _libc.shm_unlink(name.encode())

    def test_header_parsers(self):
        self.assertIsNone(c.parse_frame_header(b"\0" * 39))
        h = c.parse_frame_header(struct.pack(c.FRAME_HEADER_FORMAT, 5, 6, 7, 8, 9, 10, 1, 0))
        self.assertEqual(h, {"timestamp": 5, "frame_number": 6, "display_id": 7, "width": 8,
                             "height": 9, "byte_length": 10, "ready": 1})
        h = c.parse_shm_header(self.header() + b"extra")
        self.assertEqual(h["frame_count"], 2)
        self.assertIsNone(c.parse_shm_header(b""))


# --------------------------------------------------------------------------
# High-level connector (no sockets: fake notifier, real test segments)
# --------------------------------------------------------------------------

class FakeNotifier:
    def __init__(self, events=(), connected=True, init=None, connect_result=False):
        self.events = list(events)
        self._connected = connected
        self.connect_calls = 0
        self.connect_result = connect_result
        self.init_received = init is not None
        self.init_config = (init or {}).get("config", {})
        self.init_displays = (init or {}).get("displays", [])

    @property
    def connected(self):
        return self._connected

    def connect(self):
        self.connect_calls += 1
        self._connected = self.connect_result
        return self.connect_result

    def get_events(self):
        events, self.events = self.events, []
        return events

    def disconnect(self):
        self._connected = False


@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.base = unique_name("c")
        self.registry = RegistrySegment(self.base)
        self.segments = {}
        self.conn = c.ScreenStreamConnector(shm_name=self.base, notify_socket="/nonexistent/n.sock",
                                            command_socket="/nonexistent/c.sock")
        self.conn._registry = c.Registry(self.base)
        self.conn._notifier = FakeNotifier()

    def tearDown(self):
        self.conn.disconnect()
        self.registry.close()
        for seg in self.segments.values():
            seg.close()

    def add_display(self, idx, display_id, width=4, height=2, logical=(0, 0)):
        shm = unique_name("d")
        self.segments[display_id] = Segment(shm, width=width, height=height, slots=2)
        self.registry.set_entry(idx, display_id, shm, width, height,
                                logical_width=logical[0], logical_height=logical[1])
        return self.segments[display_id]

    def test_display_add_remove_and_selection(self):
        self.add_display(0, "display-1")
        self.add_display(1, "display-2")
        self.conn._refresh_displays()
        self.assertEqual([d.display_id for d in self.conn.displays], ["display-1", "display-2"])
        self.assertEqual(set(self.conn._frame_readers), {"display-1", "display-2"})
        self.assertTrue(self.conn.select_display("display-2"))
        self.assertFalse(self.conn.select_display("display-404"))
        self.assertEqual(self.conn.current_display.display_id, "display-2")

        # display-2 removed: its reader is closed and the selection wraps safely.
        self.registry.set_entry(1, "display-2", "/gone", 4, 2, active=0)
        reader2 = self.conn._frame_readers["display-2"]
        self.conn._refresh_displays()
        self.assertEqual(list(self.conn._frame_readers), ["display-1"])
        self.assertFalse(reader2.is_open)
        self.assertEqual(self.conn.current_display.display_id, "display-1")
        self.assertEqual(self.conn.cycle_display().display_id, "display-1")

    def test_displays_property_is_a_copy(self):
        self.add_display(0, "display-1")
        self.conn._refresh_displays()
        self.conn.displays.clear()
        self.assertEqual(len(self.conn.displays), 1)

    def test_resolution_change_recreates_reader(self):
        self.add_display(0, "display-1")
        self.conn._refresh_displays()
        old = self.conn._frame_readers["display-1"]
        self.segments.pop("display-1").close()
        seg = self.add_display(0, "display-1", width=8, height=4)
        self.conn._refresh_displays()
        new = self.conn._frame_readers["display-1"]
        self.assertIsNot(old, new)
        self.assertFalse(old.is_open)
        seg.write(3)
        frame = self.conn.read_frame("display-1")
        self.assertEqual(frame.resolution, (8, 4))

    def test_logical_size_change_recreates_reader(self):
        self.add_display(0, "display-1", logical=(2, 1))
        self.conn._refresh_displays()
        old = self.conn._frame_readers["display-1"]
        self.registry.set_entry(0, "display-1", old.display_info.shm_name, 4, 2,
                                logical_width=4, logical_height=2)
        self.conn._refresh_displays()
        self.assertIsNot(self.conn._frame_readers["display-1"], old)

    def test_unchanged_display_keeps_reader(self):
        self.add_display(0, "display-1")
        self.conn._refresh_displays()
        old = self.conn._frame_readers["display-1"]
        self.conn._refresh_displays()
        self.assertIs(self.conn._frame_readers["display-1"], old)
        self.conn._refresh_displays(force_reconnect=True)
        self.assertIsNot(self.conn._frame_readers["display-1"], old)
        self.assertFalse(old.is_open)

    def test_recreated_segment_is_detected_on_periodic_refresh(self):
        self.add_display(0, "display-1")
        self.conn._refresh_displays()
        old = self.conn._frame_readers["display-1"]
        shm = old.display_info.shm_name
        self.segments.pop("display-1").close()
        self.segments["display-1"] = Segment(shm, width=4, height=2, slots=2, generation=4321)
        self.conn._refresh_displays()
        self.assertIsNot(self.conn._frame_readers["display-1"], old)
        self.assertEqual(self.conn._frame_readers["display-1"].generation, 4321)

    def test_registry_gone_closes_everything(self):
        self.add_display(0, "display-1")
        self.conn._refresh_displays()
        reader = self.conn._frame_readers["display-1"]
        self.registry.close()
        self.registry = RegistrySegment(self.base)  # empty registry after restart
        self.conn._refresh_displays()
        self.assertEqual(self.conn.displays, [])
        self.assertEqual(self.conn._frame_readers, {})
        self.assertFalse(reader.is_open)
        self.assertIsNone(self.conn.current_display)
        self.assertIsNone(self.conn.cycle_display())
        self.assertIsNone(self.conn.read_frame())

    def test_display_whose_segment_is_missing_is_listed_without_reader(self):
        self.registry.set_entry(0, "display-1", unique_name("absent"), 4, 2)
        self.conn._refresh_displays()
        self.assertEqual(len(self.conn.displays), 1)
        self.assertEqual(self.conn._frame_readers, {})
        self.assertIsNone(self.conn.read_frame())

    def test_init_displays_fallback_with_retina_and_bad_entries(self):
        self.registry.close()
        self.registry = RegistrySegment(unique_name("other"))  # our base has no registry
        shared = unique_name("i")
        self.segments["shared"] = Segment(shared, width=4, height=2, slots=2)
        self.conn._notifier = FakeNotifier(init={
            "config": {"name": shared},
            "displays": [
                {"id": "display-1", "width": 2880, "height": 1800, "displayId": 1, "scaleFactor": 2.0},
                {"id": "display-2", "width": 1920, "height": 1080, "scaleFactor": 0},
                {"id": "display-3", "width": 1920, "height": 1080, "scaleFactor": None},
                {"id": "display-4", "width": 1920, "height": 1080, "scaleFactor": float("nan")},
                {"id": "", "width": 100, "height": 100},
                {"id": "display-5", "width": 0, "height": 100},
                {"id": "display-6"},
            ],
        })
        self.conn._refresh_displays()
        ds = {d.display_id: d for d in self.conn.displays}
        self.assertEqual(sorted(ds), ["display-1", "display-2", "display-3", "display-4"])
        self.assertEqual(ds["display-1"].scale_factor, 2.0)
        self.assertEqual(ds["display-1"].numeric_id, 1)
        self.assertEqual((ds["display-1"].logical_width, ds["display-1"].logical_height), (1440, 900))
        for did in ("display-2", "display-3", "display-4"):
            self.assertEqual(ds[did].scale_factor, 1.0)
            self.assertEqual(ds[did].logical_width, 1920)
        self.assertTrue(all(d.shm_name == shared for d in ds.values()))

    def test_read_all_frames_and_unknown_display(self):
        self.add_display(0, "display-1").write(1)
        self.add_display(1, "display-2")  # no frame yet
        self.conn._refresh_displays()
        frames = self.conn.read_all_frames()
        self.assertEqual(list(frames), ["display-1"])
        self.assertEqual(self.conn.read_all_frames(), {})  # unchanged -> skipped
        self.assertEqual(list(self.conn.read_all_frames(skip_if_same=False)), ["display-1"])
        self.assertIsNone(self.conn.read_frame("display-404"))

    def test_structural_events_force_reconnect(self):
        self.add_display(0, "display-1")
        self.conn._refresh_displays()
        self.conn._last_refresh = time.time()
        for etype in (c.EventType.CAPTURE_STARTED, c.EventType.CONFIG_CHANGED, c.EventType.DISPLAY_CHANGE,
                      c.EventType.DISPLAY_ADDED, c.EventType.DISPLAY_REMOVED):
            old = self.conn._frame_readers["display-1"]
            self.conn._notifier.events = [c.StreamEvent(type=etype)]
            events = self.conn.poll_events()
            self.assertEqual([e.type for e in events], [etype])
            self.assertIsNot(self.conn._frame_readers["display-1"], old, etype)

    def test_non_structural_events_do_not_refresh(self):
        self.add_display(0, "display-1")
        self.conn._refresh_displays()
        self.conn._last_refresh = time.time()
        old = self.conn._frame_readers["display-1"]
        self.conn._notifier.events = [c.StreamEvent(type=c.EventType.ERROR), c.StreamEvent(type=c.EventType.UNKNOWN)]
        self.assertEqual(len(self.conn.poll_events()), 2)
        self.assertIs(self.conn._frame_readers["display-1"], old)
        # capture_stopped refreshes but keeps the existing (still valid) reader.
        self.conn._notifier.events = [c.StreamEvent(type=c.EventType.CAPTURE_STOPPED)]
        self.conn.poll_events()
        self.assertIs(self.conn._frame_readers["display-1"], old)

    def test_auto_reconnect_disabled_ignores_events(self):
        self.conn._auto_reconnect = False
        self.add_display(0, "display-1")
        self.conn._refresh_displays()
        self.conn._last_refresh = time.time()
        old = self.conn._frame_readers["display-1"]
        self.conn._notifier.events = [c.StreamEvent(type=c.EventType.CAPTURE_STARTED)]
        self.conn.poll_events()
        self.assertIs(self.conn._frame_readers["display-1"], old)

    def test_notifier_reconnect_is_throttled(self):
        self.conn._notifier = FakeNotifier(connected=False, connect_result=False)
        self.conn._last_notify_attempt = time.time()
        self.conn.poll_events()
        self.assertEqual(self.conn._notifier.connect_calls, 0)
        self.conn._last_notify_attempt = time.time() - 10
        self.conn.poll_events()
        self.conn.poll_events()
        self.assertEqual(self.conn._notifier.connect_calls, 1)

    def test_notifier_reconnect_forces_full_refresh(self):
        self.add_display(0, "display-1")
        self.conn._refresh_displays()
        self.conn._last_refresh = time.time()
        old = self.conn._frame_readers["display-1"]
        self.conn._notifier = FakeNotifier(connected=False, connect_result=True)
        self.conn._last_notify_attempt = 0
        self.conn.poll_events()
        self.assertIsNot(self.conn._frame_readers["display-1"], old)

    def test_read_frame_auto_poll_is_throttled_and_swallows_errors(self):
        calls = []

        def boom():
            calls.append(1)
            raise RuntimeError("poll failed")

        self.conn.poll_events = boom
        self.conn._last_auto_poll = 0
        self.assertIsNone(self.conn.read_frame())
        self.assertIsNone(self.conn.read_frame())
        self.assertEqual(len(calls), 1)
        self.conn._auto_reconnect = False
        self.conn._last_auto_poll = 0
        self.conn.read_frame()
        self.assertEqual(len(calls), 1)

    def test_control_methods_without_connection(self):
        conn = c.ScreenStreamConnector(shm_name=unique_name("u"))
        self.assertFalse(conn.connected)
        self.assertFalse(conn.is_producer_running())
        self.assertFalse(conn.start_capture())
        self.assertFalse(conn.stop_capture())
        self.assertFalse(conn.is_capturing())
        self.assertFalse(conn.set_fps(30))
        self.assertFalse(conn.set_display_fps("display-1", 30))
        self.assertFalse(conn.set_display_resolution("display-1", 0))
        self.assertEqual(conn.get_display_configs(), {})
        self.assertEqual(conn.get_producer_displays(), [])
        self.assertFalse(conn.has_notifications)
        self.assertEqual(conn.poll_events(), [])
        conn.disconnect()
        conn.disconnect()

    def test_disconnect_closes_readers_and_resets(self):
        self.add_display(0, "display-1")
        self.conn._refresh_displays()
        reader = self.conn._frame_readers["display-1"]
        self.conn.disconnect()
        self.assertFalse(reader.is_open)
        self.assertEqual(self.conn.displays, [])
        self.assertIsNone(self.conn._registry)
        self.assertIsNone(self.conn._notifier)
        self.assertFalse(self.conn.connected)


@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class ConnectorConnectTests(SocketTestBase):
    def test_connect_fails_without_notification_socket(self):
        conn = c.ScreenStreamConnector(shm_name=unique_name("n"),
                                       notify_socket=os.path.join(self.dir, "x.sock"),
                                       command_socket=os.path.join(self.dir, "x.sock"))
        self.assertFalse(conn.connect())
        self.assertFalse(conn.connected)
        self.assertEqual(conn.displays, [])
        conn.disconnect()

    def test_connect_discovers_displays_from_registry(self):
        base = unique_name("k")
        reg = RegistrySegment(base)
        shm = unique_name("s")
        seg = Segment(shm, width=4, height=2, slots=2)
        reg.set_entry(0, "display-1", shm, 4, 2)
        server = self.serve("h.sock.notify", lambda s, conn: time.sleep(3))
        conn = c.ScreenStreamConnector(shm_name=base, notify_socket=server.path[:-len(".notify")],
                                       command_socket=os.path.join(self.dir, "h.sock"))
        try:
            self.assertTrue(conn.connect())
            self.assertTrue(conn.connected)
            self.assertTrue(conn.has_notifications)
            self.assertEqual([d.display_id for d in conn.displays], ["display-1"])
            seg.write(5)
            self.assertTrue((conn.read_frame().data == 5).all())
            self.assertFalse(conn.is_producer_running())  # no command socket
        finally:
            conn.disconnect()
            reg.close()
            seg.close()


if __name__ == "__main__":
    unittest.main()
