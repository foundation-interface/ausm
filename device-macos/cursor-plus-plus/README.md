# @ausm/device-macos-cursor-plus-plus

Tracks the mouse on macOS (moves, clicks, double-clicks, right-clicks, scrolls, press-and-hold,
drags) and enriches each interaction with the window and the accessibility (AX) element under the
cursor, the AUSM material that window belongs to, and an optional small JPEG crop around the
cursor taken from the AUSM screen stream. macOS 13+.

Two ways to use it:

- **Node** (this package): `CursorPlusPlusService` spawns the bundled Swift helper
  (`build/cursor-helper`) and emits `cursor-event`s compatible with `CursorPlusPlusEvent` from
  `@ausm/core`.
- **Native Swift**: link `CursorMonitorKit` in-process via
  the repo-root `Package.swift`. `CursorMonitor.onEvent(CursorEvent, CursorContext?)` is delivered
  on the main thread; the context carries the live `AXUIElement` (see `../README-swift-kits.md`).

## Permissions

**Accessibility**, granted to the app that launches the helper. Without it the helper prints an
`error` line (`accessibility_denied`) and exits with code 2; the Node service reports an `error`
and does not restart. If the system disables the tap later (for example Accessibility is revoked
while running), an `error` with `event_tap_disabled` is reported.

The optional crop needs the AUSM screen stream (`@ausm/device-macos-screen-stream`, which needs
Screen Recording), Python 3 with `numpy` and `opencv-python`, and the `screen_stream_reader`
module from `device-macos/internal-lib`.

## Node API

```ts
import { createCursorPlusPlus, CropReader } from '@ausm/device-macos-cursor-plus-plus';

const crop = new CropReader({ pythonPath: 'python3', screenStreamReaderPath: '/path/to/internal-lib/screen-stream-reader' });
await crop.start().catch(() => {}); // optional

const cursor = createCursorPlusPlus({ displayStreamCrop: crop, moveThrottleMs: 100 });
cursor.on('cursor-event', (e) => { /* e.action, e.x, e.y, e.bundleId, e.uiElementRole, … */ });
cursor.on('cursor-move', (x, y) => {});
cursor.on('error', (err) => console.warn(err.message));
cursor.start();
// …
cursor.stop();
crop.stop();
```

Config (`CursorPlusPlusConfig`):

| Option | Default | |
| --- | --- | --- |
| `moveThrottleMs` | 100 | Minimum ms between MOVE events and, separately, DRAG events (applied in the helper). 0 = all |
| `enrichActions` | CLICK, DOUBLE_CLICK, RIGHT_CLICK, SCROLL, HOLD_END | Actions that get the material lookup and the screenshot crop |
| `cropWidth` / `cropHeight` | 200 / 40 | Crop size in points, centred on the cursor |
| `cropJpegQuality` | 75 | 1–100 |
| `defaultScaleFactor` | 2 | Fallback when the display scale cannot be derived |
| `materialLookup` | — | `{ getMaterialForWindow(windowId) }` to fill `materialId` |
| `displayStreamCrop` | — | A `CropReader` (or anything that implements `cropAtCursor`) |
| `autoRestart` | true | Restart a crashed helper with exponential backoff (at most 5 times per minute) |
| `helperPath` | bundled | Override the helper binary |
| `debug` | false | Console diagnostics |

Events: `cursor-event` (`CursorEventLike`), `cursor-move` (`x, y`), `status`
(`'started' | 'stopped'`), `error`. If no `error` listener is attached, errors are printed with
`console.warn` instead of being thrown.

Actions: `MOVE`, `CLICK` (left, or middle with `button: 1`), `DOUBLE_CLICK` (`clickCount ≥ 2`),
`RIGHT_CLICK`, `SCROLL` (`scrollDeltaX/Y`, in points), `HOLD_START` (the left button has been
held for 400 ms within 5 pt), `HOLD_END` (that hold was released; `holdDurationMs`), `DRAG`.
Coordinates are global CoreGraphics points: origin at the top-left of the main display, y grows
down.

**Privacy.** Enriched events include the AX `value` of the element under the cursor (truncated to
200 characters, never for password fields) and the window title. Drop these fields before storing
or sending events if that is not acceptable for your use.

## Helper wire protocol

`build/cursor-helper [--move-throttle-ms N]` writes one JSON object per line to stdout. Fields
that have no value are omitted:

- `{"type":"ready"}`
- `{"type":"cursor-event","action":…,"x":…,"y":…,"button"?,"clickCount"?,"scrollDeltaX"?,"scrollDeltaY"?,"holdDurationMs"?,"windowId"?,"windowTitle"?,"ownerName"?,"bundleId"?,"windowX"?,"windowY"?,"windowWidth"?,"windowHeight"?,"uiElementRole"?,"uiElementSubrole"?,"uiElementLabel"?,"uiElementDescription"?,"uiElementValue"?,"uiElementIsEditableText"?}`
- `{"type":"error","code":"accessibility_denied"|"event_tap_disabled","message":…}`

The helper exits on SIGTERM/SIGINT, and also when its parent process exits. `CropReader` talks to
`py/crop_reader.py` over stdin/stdout, and the script exits when its stdin closes.

## Build

```sh
npm run build          # universal (arm64 + x86_64) helper → build/, then TypeScript → dist/
npm run build:swift    # helper only; ad-hoc signed unless SIGN_IDENTITY is set
npm run test:swift     # XCTest (pure logic, no permissions needed)
npm run typecheck
```
