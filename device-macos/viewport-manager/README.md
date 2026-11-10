# @ausm/device-macos-viewport-manager

Tracks every user-visible window on macOS and reports when windows appear, gain or lose
focus, vanish, are renamed, or move/resize. It also reports Mission Control Space
switches. A Swift helper (`build/viewport-helper`) does the work and streams JSON lines
to this Node wrapper.

macOS 12+, Node 18+. Universal binary (arm64 + x86_64).

## Permissions

| Permission | Without it |
| --- | --- |
| **Screen Recording** | macOS hides other apps' window titles. Untitled windows are skipped, so **most windows are not reported**. |
| **Accessibility** | Focus is still detected by polling (≤ 16 ms latency), but instant AX focus changes and `documentPath` are unavailable. |

macOS grants both to the *responsible* app (your terminal or Electron app). The helper
never prompts. It reports the current state in a `permission` event at startup and again
whenever it changes, so you can guide the user. Accessibility granted while running
takes effect immediately. A Screen Recording grant may only take effect after the
responsible app is relaunched (a macOS limitation).

## Usage

```ts
import { createViewportMonitor } from '@ausm/device-macos-viewport-manager';

const monitor = createViewportMonitor();
monitor.on('permission', (p) => {
  if (!p.screenRecordingGranted) console.warn('Grant Screen Recording to see window titles');
});
monitor.on('window-focused', (e) => console.log('focus', e.bundleId, e.windowId));
monitor.on('space-changed', () => console.log('space switched'));
monitor.on('error', (err) => console.error(err));

monitor.start({ debug: false, autoRestart: true }); // returns false if the helper is missing / not macOS
// ...
monitor.cleanup(); // stop + remove listeners
```

`start(config)`:

- `debug` (default `false`): log events, including window titles.
- `autoRestart` (default `true`): respawn a crashed helper with exponential backoff
  (1 s … 30 s, 5 attempts; the counter resets after 60 s of healthy running). If it gives
  up, it emits `error` and then `status: 'stopped'`.

If there is no `error` listener, errors are logged with `console.warn` instead of throwing.

## Events

| Event | Payload |
| --- | --- |
| `window-event` | Every window event below |
| `window-opened` | A window became visible: created, un-minimized, app unhidden, or Space switched to it |
| `window-closed` | A window disappeared: closed, minimized, app hidden/quit, or left the current Space |
| `window-focused` / `window-unfocused` | Focus moved. The unfocus of a closing window comes before its close. |
| `bounds-changed` | Position or size changed (`oldBounds` set). Dropped when several windows move in the same tick (Space swipes, display reconfiguration). |
| `title-changed` | Title changed (`oldTitle` set) |
| `space-changed` | `{ type: 'space-changed', timestamp }` |
| `permission` | `{ accessibilityTrusted, screenRecordingGranted }` |
| `status` | `'started' \| 'stopped'` |
| `error` | `Error` |

`WindowEvent` fields: `type`, `windowId` (CGWindowID), `title`, `ownerName`, `bundleId`,
`pid`, `bounds {x, y, width, height}`, `displayId`, `documentPath?` (`file://` URL from
AXDocument), `oldTitle?`, `oldBounds?`, `timestamp` (ms, set on receipt in Node).

- **Coordinates** are global CoreGraphics points. The origin is the top-left of the main
  display, y grows downward, and displays left of or above the main display have negative
  coordinates.
- **`displayId`** is the `CGDirectDisplayID` with the largest overlap with the window. The
  display list is re-read on every tick, so hot-plugging is handled.
- **Tracked windows** are layer-0, on-screen, at least 100×100 pt, titled, and not owned by
  system UI (Dock, Control Center, Spotlight, …). Full-screen apps are tracked like any
  other window on their Space.

## Helper protocol (stdout, one JSON object per line)

1. `{"type":"ready","accessibilityTrusted":bool,"screenRecordingGranted":bool, ...zeroed window fields}`
2. Window events, using the field names above (no `timestamp`).
3. `{"type":"space-changed","timestamp":ms}`
4. `{"type":"permission","accessibilityTrusted":bool,"screenRecordingGranted":bool}` on change.

stderr carries diagnostics only. The helper never writes window titles or paths there.
The helper exits on SIGTERM/SIGINT, on stdin EOF (the wrapper keeps stdin open as a
pipe), or when its parent process dies.

## Performance notes

The helper polls `CGWindowListCopyWindowInfo` at about 60 Hz. AXDocument lookups are cached
per window and title (including misses). Every AX call has a 250 ms timeout so a hung app
cannot stall the monitor.

## Build

```bash
npm run build         # universal Swift helper → build/viewport-helper (ad-hoc signed) + TS → dist/
npm run build:swift   # helper only; set SIGN_IDENTITY to sign with a real identity
npm run typecheck
npm run test:swift    # XCTest: diffing, display assignment, JSON shape; no permissions needed
node test-live.js     # manual live viewer (prints window titles)
```

The universal build needs a full Xcode installation.
