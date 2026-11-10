# @ausm/device-macos-material-manager

Per-window "material" tracking for AUSM on macOS. It turns window lifecycle
events plus screen-stream frames into a deduplicated history of window
screenshots, grouped by **material** (one material per distinct window
title, i.e. per tab/document within a window).

Most users get this through `ausm/runtime` (`materialManager: { enabled: true }`),
which runs it as a child process via `@ausm/core`'s `MaterialClient`. Use the
package directly only if you want the pieces in-process.

```
WindowStateEvent (viewport-manager) ──┐
                                      ├─► MaterialManager ─► material-* events
screen-stream frames (shared memory) ─┘        │
                                               ├─ WindowTracker per CGWindowID
                                               │    └─ Material per title
                                               ├─ FrameReader ─► py/frame_reader.py
                                               │    (crop, tiled pHash, JPEG)
                                               └─ FrameStore (SQLite, local mode)
```

## How capture works

| Window event | What happens |
|---|---|
| `APPEAR` | create tracker + first material, one capture |
| `FOCUSED` | reconcile material with title, capture, start periodic timer |
| `TITLE_CHANGED` | switch to (or create) the material for the new title, capture |
| `BOUNDS_CHANGED` | update bounds; pause periodic capture until bounds settle |
| `UNFOCUSED` | last capture (per-window helper only), stop periodic timer |
| `VANISHED` | deactivate; tracker kept (the 64 most recent vanished windows) |
| periodic (default 2 s) | display-stream crop while focused |

Captures come from one of two paths:

* **Per-window capture** (`screenStreamHelper` provided): the screen-stream
  helper's `captureWindow()` reads the window's own backing store, so it works
  for occluded/background windows. Used for APPEAR / FOCUSED / TITLE_CHANGED /
  UNFOCUSED.
* **Display-stream crop**: the Python worker reads the latest frame for the
  window's display from screen-stream shared memory, maps global logical
  window bounds to display-local pixels (using the display's real
  capture/logical scale, so Retina and mixed-DPI setups work, and the live
  display origin, so displays left/above the primary work) and crops. A window
  partially off-screen is clipped to its visible part; a window that does not
  intersect its display is skipped. Only the focused window is cropped this way
  (the stream shows whatever is on top).

Each capture gets a **tiled perceptual hash**: the image is split into
`hashGrid × hashGrid` tiles (default 4×4) and a 64-bit DCT pHash is computed
per tile. The distance between two frames is the maximum per-tile Hamming
distance, so a small local edit (typing in one corner) still counts. A frame
is kept when it is the material's first frame or its distance is
`>= hashDistanceThreshold` (default 8).

## Requirements

* macOS, Node >= 18.
* **Screen Recording** permission for the process that runs screen-stream
  (and therefore the per-window helper). Material-manager itself only reads
  shared memory.
* Python >= 3.9 with `numpy` and `opencv-python-headless` (or
  `opencv-python`): `python3 -m pip install -r py/requirements.txt`.
* The `screen_stream_reader` Python package, shipped in
  `@ausm/device-macos-screen-stream` under `python/screen-stream-reader`.
  Point `screenStreamReaderPath` at that directory (the runtime does this for
  you) or `pip install` it into the interpreter given by `pythonPath`.
* `@ausm/device-macos-screen-stream` (optional peer) is only needed by the
  service when the parent passes `screenStreamSocketPath`.

## API

```ts
import { MaterialManager } from '@ausm/device-macos-material-manager';

const mm = new MaterialManager({
  storageMode: 'local',              // 'local' (SQLite here) | 'remote' (emit storage events)
  dbPath: '/path/to/user-data/materials.db', // default ':memory:'
  pythonPath: 'python3',
  screenStreamReaderPath: '/path/to/screen-stream/python/screen-stream-reader',
  screenStreamHelper: helperClient,  // optional, enables per-window capture
});
mm.on('material-frame', (frame, hash) => { /* frame.data is a JPEG Buffer */ });
mm.on('error', (err) => { /* optional; errors are dropped silently without a listener */ });
await mm.start();
viewport.on('window-event', (e) => mm.handleWindowEvent(e)); // WindowStateEventLike
// ...
mm.stop(); // local mode: a stopped manager cannot be restarted; create a new one
```

Key config (`MaterialManagerConfig`, all optional):

| Option | Default | Notes |
|---|---|---|
| `storageMode` | `'local'` | `'remote'` = no SQLite; listen to `storage:*` + `material-frame` and persist yourself |
| `dbPath` | `':memory:'` | local mode only |
| `maxFramesPerMaterial` | 200 | per-material cap (oldest evicted) |
| `maxTotalFrames` | 5000 | local mode: global cap, 0 = unlimited |
| `maxFrameAgeMs` | 0 | local mode: age-based deletion, 0 = off |
| `hashDistanceThreshold` | 8 | 0–64 per tile |
| `hashGrid` | 4 | 1 = single whole-image hash, max 16 |
| `captureIntervalMs` | 2000 | periodic capture while focused |
| `captureDelayMs` | 150 | delay after content-changing events |
| `maxFreshnessRetries` / `freshnessRetryBaseMs` | 3 / 150 | display-stream crops older than the event are retried with back-off |
| `jpegQuality` | 85 | 1–100 |
| `materialBlacklist` | — | `{ apps, bundleIds, titleIncludes }` (case-insensitive); matching windows are never captured |
| `metadataExtractors` | browser URL + IDE file | see below; `[]` disables |
| `debug` | false | console logging (includes window titles) |

Events: `material-frame`, `material-created`, `material-focused`,
`material-unfocused`, `material-type-classified`, `tracker-created`,
`tracker-removed`, `storage:save-material`, `storage:update-material-type`,
`status`, `error`. Exactly one material is focused at a time; focus events are
deduplicated.

Query helpers: `getLatestFrameInfo`, `getFrames`, `getFramesMeta`,
`getCurrentMaterialFrames`, `getFrameById`, `getMaterials`,
`getAllMaterials`, `getTracker`, `getAllTrackers`, `getActiveWindows`.
`FrameStore`, `WindowTracker` and `FrameReader` are exported too.

### Metadata extractors

`Material.appMetadata` is filled by extractors run on APPEAR / FOCUSED /
TITLE_CHANGED: `BrowserMetadataExtractor` (`url`, `scheme`, `hostname`,
`path` from the AXDocument URL, query string included) and
`IDEMetadataExtractor` (`file`, `filename`, `extension`). Implement
`MaterialMetadataExtractor` (`matches()` + synchronous `extract()`) to add
your own; an extractor that throws is skipped.

## Child-process service (`dist/service.js`)

`MaterialClient` spawns `node dist/service.js` and talks JSON lines over
stdio. The first stdin line is `{ "type": "config", ...MaterialManagerConfig
fields, "screenStreamSocketPath"? }`; then `{ "type": "window-event", ... }`
per window event. stdout carries `ready`, `material-frame` (with
`dataBase64`, `hash`), `material-created`, `material-focused`,
`material-unfocused`, `material-type-classified`, `material-save`,
`material-type-update`, `error`. stderr is for logs. The service always uses
remote storage and exits on stdin EOF / SIGTERM, stopping its Python worker.

The Python worker (`py/frame_reader.py`) uses the same pattern: JSON lines
on stdin/stdout, `{ "type": "ready" }` first, commands `crop`,
`process_image`, `ping`. It exits on stdin EOF; if it crashes, FrameReader
restarts it with exponential back-off (up to 5 consecutive attempts).

## Privacy and storage

Frames are screenshots of user windows; titles, URLs and file paths are
user data.

* Local mode writes everything to `dbPath` (SQLite + `-wal`/`-shm`). The file
  is created `0600` and a newly created parent directory `0700`. Put it under
  the user's application-data directory. With the default `':memory:'`
  nothing touches disk.
* Remote mode (the runtime default) stores nothing; frames go to the parent.
* Nothing is logged unless `debug` is on; image data is never logged.
* Use `materialBlacklist` to exclude password managers, private browsing
  windows, etc.

## Development

```sh
npm run typecheck
npm test                          # node:test via tsx (needs better-sqlite3 built)
npm run test:py                   # Python worker unit tests (numpy + opencv)
npx tsx test-visual-dashboard.ts  # dev-only live dashboard on 127.0.0.1:3210
```

`test-visual-dashboard.ts` and `tests/` are not published.
