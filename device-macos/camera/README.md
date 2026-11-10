# @ausm/device-macos-camera

Captures webcams on macOS with AVFoundation and makes the frames available two ways:

- **On demand as JPEG** via `captureLatestFrame()` (what `@ausm/core` uses).
- **Continuously as raw BGRA** in POSIX shared memory (`/ausm-camera-frames-*`) for
  zero-copy readers such as `screen_stream_reader` (`device-macos/internal-lib`).

A small Swift helper (`build/camera-helper`) owns the capture sessions. The Node client
spawns it and talks to it over a Unix-domain socket.

macOS 13+, Node 18+. Universal binary (arm64 + x86_64).

## Permissions

- **Camera.** The first `start()` triggers the macOS prompt. macOS attributes the request
  to the *responsible* app (Terminal, iTerm, your Electron app, ...), not to the helper.
  The helper waits up to 25 s for an answer. If access is denied, `start()` resolves
  `false` and the helper reports
  `Camera permission not granted. Enable Camera ... in System Settings → Privacy & Security → Camera`.
  The helper embeds an `Info.plist` with `NSCameraUsageDescription`.
- If access is revoked or the camera is taken by another app while streaming, the session
  emits a `captureError` event and the helper tries one restart.

## Quick start

```ts
import { createCameraStreamer } from '@ausm/device-macos-camera';

const cam = createCameraStreamer({ fps: 10, targetHeight: 720 });
if (!(await cam.start())) throw new Error('camera unavailable (permission?)');

const [device] = await cam.getDevices();
const frame = await cam.captureLatestFrame(device.id, 0.7); // null until the first frame arrives
if (frame) fs.writeFileSync('frame.jpg', frame.data);

cam.onDeviceChange((e) => console.log(e.event, e.deviceId));   // 'added' | 'removed'
cam.onCaptureError((e) => console.warn(e.deviceId, e.error));

await cam.cleanup(); // stops capture, quits the helper, removes SHM + sockets
```

## API

### `createCameraStreamer(options?)` → `CameraStreamingService`

| Option | Default | Notes |
| --- | --- | --- |
| `fps` | `10` | Clamped to 1–60. |
| `targetHeight` | `720` | Output height. Width follows the camera's aspect ratio. Never upscales. Clamped to 2–4320. |
| `frameCount` | `5` | Ring-buffer slots per camera (2–32). |
| `sharedMemoryName` | `/ausm-camera-frames` | Must start with `/`, at most 22 characters. |
| `socketPath` | `/tmp/ausm-camera.sock` | Control socket. Notifications use `<socketPath>.notify`. At most 103 bytes. |
| `deviceId` | all cameras | `AVCaptureDevice.uniqueID` to capture instead of every camera. |
| `debug` | `false` | Forwards helper logs (device names, sizes; no image data). |

### `CameraStreamingService`

| Method | Description |
| --- | --- |
| `start(deviceIds?)` | Spawn the helper, configure it, and start capture. Resolves `false` on failure and never throws. |
| `stop()` / `cleanup()` | Stop capture and shut the helper down. Waits for it to exit, then sends SIGTERM and finally SIGKILL. |
| `getDevices()` | `CameraDeviceInfo[]`: `{ id, name, position, active, manufacturer }`. |
| `startDevices(deviceIds?)` | Add cameras to a running capture. |
| `captureLatestFrame(id, quality=0.7)` | `LatestFrameResult \| null`: `{ data: Buffer (JPEG), width, height, jpegSize, timestamp (µs), frameNumber }`. |
| `updateConfiguration(partial)` | Reconfigure. Restarts capture if it is streaming. |
| `isStreaming()` | Whether the helper is capturing. |
| `onDeviceChange(cb)` / `onCaptureError(cb)` | See Events. |
| `getHelper()` | The underlying `HelperClient`. |

If the helper crashes while streaming, the service restarts it with exponential backoff
(1 s, 2 s, … up to 30 s, 5 attempts).

### Events (`HelperClient` EventEmitter)

| Event | Payload |
| --- | --- |
| `deviceChange` | `{ type: 'device_change', deviceId, event: 'added' \| 'removed' }`. Cameras plugged in while streaming are started automatically. Unplugging the last camera keeps capture armed, so re-plugging it resumes. |
| `captureError` | `{ type: 'capture_error', deviceId, error }`. The session failed or was interrupted. |
| `exit` | `{ code, signal }`. The helper exited without `stop()` being called. |

## Helper protocol

**Control socket** (`socketPath`, mode 0600). One JSON request per connection, one JSON
response, then the server closes the connection.

| `command` | Params | Response |
| --- | --- | --- |
| `configure` | `config: { fps, targetHeight, frameCount, sharedMemoryName, deviceId }` | `{ success }` |
| `start` | `deviceIds: string[]` (empty = preferred device or all) | `{ success, error? }` |
| `stop` | | `{ success }` |
| `status` | | `{ success, streaming, capturing }` |
| `devices` | | `{ devices: CameraDeviceInfo[] }` |
| `configureDevice` | `deviceId, config: { fps, targetHeight }` | `{ success \| error }` |
| `getDeviceConfigs` | | `{ success, deviceConfigs }` |
| `captureLatestFrame` | `deviceId, jpegQuality` | `{ success, data (base64 JPEG), width, height, jpegSize, timestamp, frameNumber }` |
| `quit` | | `{ success }`, then the helper exits |

**Notification socket** (`<socketPath>.notify`, mode 0600). Newline-delimited JSON:
`device_change`, `capture_error`, `capture_started`, `capture_stopped`.

**Lifecycle.** The helper prints `Ready and waiting for commands...` to stderr when it is
ready. It exits and cleans up on SIGINT/SIGTERM, on `quit`, on stdin EOF, or when its
parent process dies.

## Shared memory layout

All segments are created with mode **0600**: camera frames are readable only by the user
who started the helper. They are unlinked on stop and exit. Segments left by a crashed
helper are removed the next time a helper starts. All integers are little-endian.

`<name>-registry` (48-byte header + 8 × 240-byte entries):

| Offset | Field |
| --- | --- |
| 0 | `magic` u32 = `0x41555352` ('AUSR') |
| 4 | `version` u32 = 1 |
| 8 | `maxDisplays` u32 = 8 |
| 12 | `activeCount` u32 |
| 16 | `lastUpdateTime` u64 (µs since epoch) |
| entry +0 | `displayId` char[64]: camera uniqueID |
| entry +64 | `shmName` char[128]: e.g. `/ausm-camera-frames-0` |
| entry +192 | `width`, `height`, `active`, `logicalWidth` u32 |
| entry +208 | `lastFrameTime` u64, `frameCount` u64 |
| entry +224 | `logicalHeight` u32 |

`<name>-<slot>` ring buffer: a 72-byte header, then `frameCount` slots. Each slot is a
40-byte frame header followed by `width*height*4` bytes of packed BGRA.

| Header offset | Field | Frame-header offset | Field |
| --- | --- | --- | --- |
| 0 | `magic` u32 = `0x41555346` ('AUSF') | 0 | `timestamp` u64 (µs) |
| 4 | `version` u32 = 1 | 8 | `frameNumber` u64 |
| 8 | `frameCount` u32 | 16 | `displayId` u32 (always 0) |
| 12 | `frameSize` u32 (payload bytes) | 20 | `width` u32 |
| 16 | `width`, `height` u32 | 24 | `height` u32 |
| 24 | `format` u32 (0 = BGRA) | 28 | `byteLength` u32 |
| 28 | `writeIndex` u32 | 32 | `ready` u32 |
| 32 | `frameNumber` u64 (next) | | |

Slot `i` starts at `72 + i * (40 + frameSize)`.

**Torn-read protocol.** The writer clears `ready`, issues a full fence, writes the payload
and header, issues another fence, then sets `ready = 1`. A reader should:

1. Read `ready` and `frameNumber`. Skip the slot unless `ready == 1`.
2. Copy the payload.
3. Read `ready` and `frameNumber` again. Discard the copy unless `ready` is still 1 and
   `frameNumber` is unchanged.

## Build

```bash
npm run build          # universal Swift helper → build/camera-helper (ad-hoc signed) + TS → dist/
npm run build:helper   # helper only; set SIGN_IDENTITY to sign with a real identity
npm run typecheck
npm run test:swift     # XCTest unit tests (layout/size math, parsing); no permissions needed
node examples/capture-test.js   # manual end-to-end test (needs Camera permission)
```

The universal build (`--arch arm64 --arch x86_64`) needs a full Xcode installation.
