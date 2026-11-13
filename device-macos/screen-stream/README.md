# @ausm/device-macos-screen-stream

Continuous display capture for macOS. A small Swift helper
(`build/screen-capture-helper`) captures every display with ScreenCaptureKit
and publishes BGRA frames into POSIX shared memory, so local consumers
(Python CV code, the AUSM material manager) can read the latest frame
without copying it through a socket. The helper also serves JPEG snapshots
(`captureLatestFrame`, `captureWindow`) over a Unix socket.

- macOS 13+, Apple Silicon or Intel (universal binary), Node 18+.
- Screen contents never leave the machine. Shared memory segments and sockets
  are created owner-only (mode 0600). The helper never logs pixel data.

## Permissions

The helper needs **Screen Recording** permission (System Settings → Privacy &
Security → Screen & System Audio Recording). macOS attributes it to the
*responsible* app, i.e. the app that spawned Node (Terminal, your Electron
app, ...), not to the helper binary. Without it:

- `startStream()` rejects with `HelperCommandError` (`code: "permission_denied"`),
  and `ScreenStreamingService.start()` resolves `false`;
- if permission is revoked while capturing, the affected displays stop and the
  helper pushes an `error` notification (`onError` / `onHelperError`).

`status` reports `permission: boolean` without prompting.

## Usage (Node)

```ts
import { createScreenStreamer } from '@ausm/device-macos-screen-stream';

const streamer = createScreenStreamer({ fps: 10, targetHeight: 1080 }); // SHM "/ausm-frames"
streamer.onError((e) => console.warn(e.code, e.error));
streamer.onDisplayChange((e) => console.log(e.displayId, e.event));

if (await streamer.start()) {
  const frame = await streamer.captureLatestFrame('display-1');   // JPEG Buffer or null
  await streamer.updateConfiguration({ fps: 5 });                  // stop → configure → start
  await streamer.stop();
}
```

`HelperClient` (also exported) is the lower-level API: `start()`,
`connectToExisting()`, `configure()`, `startStream()`, `stopStream()`,
`isStreaming()`, `getDisplays()`, `configureDisplay()`, `getDisplayConfigs()`,
`captureWindow()`, `captureLatestFrame()`, `stop()`, and events
`displayChange`, `helperError`, `captureStarted`, `captureStopped`,
`exit` (`{ code, signal, expected }`). The client does not restart a crashed
helper on its own; listen for `exit` and call `start()` again if you need that.

The helper exits when its parent process dies (stdin EOF / parent PID watch),
on SIGTERM/SIGINT/SIGHUP, or on the `quit` command. On exit it stops all
streams, finalizes recordings and unlinks its shared memory and sockets.

## Usage (Python)

See [`../internal-lib/screen-stream-reader`](../internal-lib/screen-stream-reader/README.md).
The npm package ships a copy at `python/screen-stream-reader` (add it to
`PYTHONPATH`).

## Configuration

| Key | Range | Default (`createScreenStreamer`) | Meaning |
|---|---|---|---|
| `fps` | 1–120 | 10 | Max frames per second per display |
| `targetHeight` | 0–16384 | 1080 | Capture height in pixels (0 = native); width keeps aspect, both rounded up to even |
| `sharedMemoryName` | valid shm name, ≤ 22 bytes | `/ausm-frames` | Base name; `""` disables SHM output |
| `frameCount` | 1–120 | 5 | Ring slots per display |
| `enableRecording` / `outputDirectory` | | false / `""` | Also write `<dir>/<displayId>-<yyyyMMdd-HHmmss-SSS>.mp4` (H.264); a new file per segment, so a display change never overwrites one |
| `socketPath` | ≤ 96 bytes | `/tmp/ausm-frames.sock` | Command socket; notifications on `<socketPath>.notify` |

Invalid values are ignored (the response lists them in `rejected`).

## Command protocol

One JSON object per connection on `socketPath`, optionally terminated by
`\n`. The helper replies with one JSON object and closes the connection.
Requests over 1 MiB, malformed JSON, or clients idle for 10 s get
`{"success": false, "error": "...", "code": "invalid_request"}`.

| `command` | Parameters | Response |
|---|---|---|
| `status` | | `capturing`, `streaming` (alias), `permission` |
| `displays` | | `displays: [{id, displayId, width, height, scaleFactor, refreshRate, isMain, isBuiltIn, originX, originY, logicalWidth, logicalHeight}]` |
| `configure` | `config` (table above) | `success`, `rejected?` |
| `update_config` | `config` (fps, targetHeight, enableRecording, outputDirectory) | fails while capturing |
| `start` | `displayIds?: string[]` (empty = all) | `success`, or `error` + `code` |
| `stop` | | `success` |
| `configureDisplay` | `displayId`, `config: {fps?, targetHeight?}` | restarts that display if capturing |
| `getDisplayConfigs` | | `displayConfigs: {id: {fps, targetHeight}}` |
| `captureLatestFrame` | `displayId`, `jpegQuality?` (0–1, default 0.7) | `data` (base64 JPEG), `width`, `height`, `timestamp` (µs, host clock), `frameNumber` |
| `captureWindow` | `windowId` (CGWindowID), `jpegQuality?`, `displayId?` | `data`, `width`, `height`, `windowId` |
| `quit` | | helper exits |

Error `code`s: `permission_denied`, `no_displays`, `stream_failed`,
`shm_failed`, `invalid_request`.

Notifications (`<socketPath>.notify`, newline-delimited JSON):
`{"type":"capture_started"}`, `{"type":"capture_stopped"}`,
`{"type":"display_change","displayId":"display-2","event":"added"|"removed"|"reconfigured"}`,
`{"type":"error","code":"permission_denied","error":"...","displayId"?:...}`.
Clients that stop reading are disconnected.

## Shared memory layout

All integers are little-endian. For base name `B` (default `/ausm-frames`):

- `B-registry` — discovery table
- `B-display-<CGDirectDisplayID>` — one frame ring per display, e.g. `/ausm-frames-display-1`

Names follow the macOS POSIX limit of 31 bytes. Segments are created with
`O_EXCL` and mode 0600 after unlinking any stale segment of the same name;
on start the helper also unlinks per-display segments listed in a stale
registry left by a crashed helper.

**Registry** (48-byte header + 8 × 240-byte entries):

| Offset | Type | Field |
|---|---|---|
| 0 | u32 | magic `0x41555352` ('AUSR') |
| 4 | u32 | version (1) |
| 8 | u32 | maxDisplays (8) |
| 12 | u32 | activeCount |
| 16 | u64 | lastUpdateTime (µs since 1970) |
| 24 | u32[6] | reserved |

Entry `i` at `48 + i*240`:

| Offset | Type | Field |
|---|---|---|
| 0 | char[64] | displayId, NUL-terminated (`display-<id>`) |
| 64 | char[128] | shmName, NUL-terminated |
| 192 | u32 | width (frame pixels) |
| 196 | u32 | height (frame pixels) |
| 200 | u32 | active (written last when adding) |
| 204 | u32 | logicalWidth (points) |
| 208 | u64 | lastFrameTime (µs, host clock) |
| 216 | u64 | frameCount (frames written) |
| 224 | u32 | logicalHeight (points) |
| 228 | u32[3] | reserved |

Scale from frame pixels to screen points: `logicalWidth / width`.

**Frame segment** (72-byte header + `frameCount` slots):

| Offset | Type | Field |
|---|---|---|
| 0 | u32 | magic `0x41555346` ('AUSF') |
| 4 | u32 | version (1) |
| 8 | u32 | frameCount (slots) |
| 12 | u32 | frameSize (= width × height × 4) |
| 16 | u32 | width |
| 20 | u32 | height |
| 24 | u32 | format (0 = BGRA8888) |
| 28 | u32 | writeIndex (total writes; slot = writeIndex % frameCount) |
| 32 | u64 | frameNumber (next number to assign) |
| 40 | u64 | generation (creation time in µs, non-zero; 0 = producer doesn't stamp) |
| 48 | u64[3] | reserved |

Slot `i` starts at `72 + i × (40 + frameSize)`: a 40-byte header followed by
`frameSize` bytes of tightly packed BGRA rows (stride = width × 4).

| Offset | Type | Field |
|---|---|---|
| 0 | u64 | timestamp (presentation time, µs, host clock since boot) |
| 8 | u64 | frameNumber (unique, increasing) |
| 16 | u32 | displayId (always 0 for per-display segments) |
| 20 | u32 | width |
| 24 | u32 | height |
| 28 | u32 | byteLength (= width × height × 4) |
| 32 | u32 | ready |
| 36 | u32 | reserved |

**Reading without tearing.** The writer stores `ready = 0`, a full memory
barrier, the pixels and header (with a new `frameNumber`), another barrier,
then `ready = 1`. A reader picks the ready slot with the highest
`frameNumber`, copies the pixels, then re-reads `ready` and `frameNumber`;
if either changed, the copy is discarded and retried. To detect a helper
restart, compare `generation` in your mapping with a freshly opened segment
of the same name.

The camera helper (`device-macos/camera`) writes the same layout, without
the generation stamp.

## Build and test

```bash
npm run build          # sync Python copy + universal Swift helper + tsup
npm run build:helper   # Swift only: swift build -c release --arch arm64 --arch x86_64
npm test               # XCTest (swift/Tests) + Python unit tests; no TCC needed
npm run typecheck
```

The helper is ad-hoc signed by default; set `SIGN_IDENTITY` to sign with a
Developer ID. `dev/` contains manual tools that are not published:
`dev/interactive-producer.ts` (`npx tsx dev/interactive-producer.ts`) and
`dev/swift-helper-repl.sh`. See [TESTING.md](TESTING.md).

## License

MIT
