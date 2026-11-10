---
name: ausm
description: Build context-aware apps and agents on macOS with AUSM (Activity Understanding and Scaffolding Medium). Use when code imports `ausm`, `ausm/runtime`, `ausm/bridge/*`, `@ausm/*`, `ScreenshotMonitorKit`, `CursorMonitorKit`, `ClipboardMonitorKit`, `WindowMonitorKit` or `TextInputMonitorKit`, or when the user wants an app to react to what they do on their Mac (text selection, typing, copy/paste, window focus, screenshots, cursor, screen frames, detected tasks).
---

# AUSM

AUSM turns low-level macOS activity into typed events, tracks the "materials" (documents, tabs,
threads) a user works with, and can classify the current task with a multimodal model.
Three layers, each optional on top of the one before:

1. **Sensors** (`device-macos/*`): native helpers that emit events. macOS only.
2. **Materials + memory**: window crops, perceptual hashes, OCR, SQLite store.
3. **Understanding**: `DETECTOR.md` specs evaluated by Vertex (Gemini) or Cerebras, producing
   `DetectorEvent` and `TaskEvent`.

## Pick the integration path first

| The host is | Use | Notes |
| --- | --- | --- |
| Node or Electron main process | `createRuntime()` from `ausm/runtime` | The full stack. Helpers run as child processes. |
| Electron renderer | `window.ausm` via the bridge preload | Events only. Memory queries are main-process only. |
| Native Swift / SwiftUI app | `ScreenshotMonitorKit`, `CursorMonitorKit`, `ClipboardMonitorKit`, `WindowMonitorKit`, `TextInputMonitorKit` (SwiftPM) | In-process, statically linked, no Node. Only these five sensors (no text selection, screen stream, camera, materials or detectors). |

Never mix paths for the same sensor in one app (for example the Swift kit and the Node
screenshot helper at once). Both install event taps or AX observers and report every event twice.

## Node / Electron

```bash
npm install ausm
```

Requirements: macOS 13+, Node >= 18, Xcode Command Line Tools, Python >= 3.10 (materials, OCR).

```ts
import { createRuntime } from 'ausm/runtime';     // runtime: only from 'ausm/runtime'
import type { MaterialEvent, TaskEvent } from 'ausm'; // types: from 'ausm'

const runtime = createRuntime({
  enableScreenStreaming: true,                      // needed for materials
  materialManager: { enabled: true, dbPath: '/path/to/ausm.db' },
  textInput: { enableNativeTextInput: true },       // opt-in, sensitive
  cursorPlusPlus: { enabled: true },                // opt-in
  detectorPipeline: { provider: 'cerebras' },       // or 'vertex' + projectId
});

runtime.onMaterialEvent((e: MaterialEvent) => {});
runtime.onTaskEvent((e: TaskEvent) => {});
await runtime.initialize();
// ...
runtime.shutdown();
```

### Subscriptions (exact names, they are not uniform)

| Method | Event `kind` | Payload highlights |
| --- | --- | --- |
| `onTextSelectionEvent` | `textSelection` | selected text, `SelectionMethod`, `SelectionStage` |
| `subscribeToTextInputEvent` | `textInput` | `text`, `TEXT_INPUT_STARTED / UPDATED / ENDED`. **Not** `onTextInputEvent`. |
| `onCopyPasteEvent` | `copyPaste` | `COPY` / `PASTE`, `contentType`, `content` |
| `onApplicationSwitchEvent` | `windowState` | every window state: `APPEAR FOCUSED UNFOCUSED VANISHED TITLE_CHANGED BOUNDS_CHANGED` |
| `onSpaceChangeEvent` | `spaceChange` | Mission Control space changed |
| `onScreenshotEvent` | `screenshot` | `SCREENSHOT_STARTED / UPDATED / FINISHED`; image only on FINISHED |
| `onCursorPlusPlusEvent` | `cursorPlusPlus` | `CLICK DOUBLE_CLICK RIGHT_CLICK SCROLL HOLD_START HOLD_END DRAG MOVE`, UI element role/label |
| `onMaterialEvent` | `material` | `MATERIAL_CREATED FOCUSED UNFOCUSED FRAME_CAPTURED CONTENT_UPDATED`, `appMetadata` |
| `onDetectorEvent` | `detector` | `detectorName`, `eventType`, `confidence`, `summary`, `evidence` |
| `onTaskEvent` | `task` | `TASK_DETECTED / UPDATED / COMPLETED`, `taskLabel`, `level` |

Every event has `kind`, `eventID`, `timestamp`, `displayID`; switch on `kind`. Enum values are
`UPPER_SNAKE`. Callbacks are additive and `shutdown()` does not remove them, so register once.

### Defaults

- On by default (darwin): text selection, screenshot, clipboard, viewport (window state),
  detector scan.
- Off unless configured: screen stream, camera, text input, material manager, cursor++, memory
  OCR, Material Chat HTTP host.
- The pipeline runs only when a Vertex `projectId` or `CEREBRAS_API_KEY` is set. Missing optional
  pieces log a warning and continue; they do not throw.
- `materialManager.dbPath` defaults to `:memory:`. Set a real path to persist.

### Queries (after `initialize()`, main process only)

`getMaterials(limit)`, `getMaterialLatestFrame(id)`, `getMaterialFrames(id, limit)`,
`getMaterialContent(id)` (OCR text), `getMaterialWeights(halfLifeDays)`,
`getScreenshots(limit, since)`, `getScreenshot(id)`, `getScreenDisplays()`,
`captureLatestScreenFrame()`, `getCameraDevices()`, `captureLatestCameraFrame()`,
`freezeMemory()` / `unfreezeMemory()`.

These are stubs that return empty values. Do not build on them: `getImmediateContext`,
`getRelevantMaterials`, `getScreenshotImageData`, `getCoveredMaterials`, `getBounds`,
`getActiveMaterialWindows`.

### Electron

```ts
// main.ts. Import the bridge BEFORE app.ready (it registers the ausm-screenshot:// scheme).
import { setupAUSMElectronBridge, getAUSMPreloadPath } from 'ausm/bridge/electron';

const win = new BrowserWindow({
  webPreferences: { preload: getAUSMPreloadPath(), contextIsolation: true },
});
const bridge = setupAUSMElectronBridge(win, runtime);
```

Renderer: `window.ausm.onTextSelection(cb)`, `onScreenshot`, `onWindowState`, `onTextInput`,
`onMaterialEvent`, `onCursorPlusPlusEvent`, `onCopyPasteEvent`, `onSpaceChange`, `onTaskEvent`,
`onDetectorEvent`, `getScreenDisplays()`, `subscribeScreenStream(cb)`. To add your own preload
API, use `exposeAUSM()` from `ausm/bridge/preload-api` and expose your namespace separately.

### Detectors

A detector is a folder with a `DETECTOR.md`. Put custom ones in a directory listed in
`detectors.extraDirs`. They are loaded on `initialize()`.

```markdown
---
name: stuck-on-error
description: Notices when the user keeps returning to the same error
event: stuck            # `task` is reserved for the TaskTracker
cooldown: 30000         # ms between firings
interval: 30000         # ms between evaluations (default = cooldown)
trigger: interval       # interval | screen
sources: [screen, events]
events: [window-state, text-input, copy-paste, screenshot]
isolated: false         # true = its own model call
enabled: true
---
Fire when the focused material shows the same error message for several evaluations and the
user has copied or searched for it. Summarise the error in under 12 words.
```

Results arrive on `onDetectorEvent` with `eventType: 'stuck'`. The shipped `rapid-task`
detector (`event: task`) drives `onTaskEvent`.

Provider setup: `TASK_DETECTOR_PROVIDER=cerebras` + `CEREBRAS_API_KEY`, or
`TASK_DETECTOR_PROVIDER=vertex` + `TASK_DETECTOR_PROJECT_ID` + `gcloud auth application-default login`.

### Material Chat (optional)

`materialChat: { enabled: true }` (or `http: { enabled: true, port: 8788 }`) starts a child process
with memory search and a Claude agent over the user's materials. Get its URL from
`runtime.getHttpUrl()`. Never start the `material-chat` bin yourself. It needs `ANTHROPIC_API_KEY`.

## Native Swift

```swift
// Package.swift
.package(url: "https://github.com/foundation-interface/AUSM.git", from: "0.1.0"),
// target dependencies: only the kits you use
.product(name: "ScreenshotMonitorKit", package: "AUSM"),
.product(name: "CursorMonitorKit", package: "AUSM"),
.product(name: "ClipboardMonitorKit", package: "AUSM"),
.product(name: "WindowMonitorKit", package: "AUSM"),
.product(name: "TextInputMonitorKit", package: "AUSM"),
```

```swift
import ScreenshotMonitorKit

var options = ScreenshotMonitor.Options()
options.writeTempFile = false
let shots = ScreenshotMonitor(options: options)
shots.onCapture = { capture in            // runs on the monitor's private queue
  Task { @MainActor in show(capture.image, scale: capture.scale) }
}
shots.onError = { problem, message in }   // accessibility_denied, screen_recording_denied, event_tap_disabled
shots.start()
```

```swift
import WindowMonitorKit

let windows = WindowMonitor()
windows.onEvent = { event in              // private queue
  switch event {
  case .window(let e): Task { @MainActor in update(e.type, e.bundleId, e.bounds.cgRect) }
  case .spaceChanged, .ready, .permissionsChanged: break
  }
}
windows.onError = { problem, message in } // accessibility_denied, screen_recording_denied
windows.start()
```

| Kit | Monitor | Events | Callbacks on |
| --- | --- | --- | --- |
| `ScreenshotMonitorKit` | `ScreenshotMonitor` | `onCapture(Capture)` (CGImage, rect, scale, mode), session callbacks | private queue |
| `CursorMonitorKit` | `CursorMonitor` | `onEvent(CursorEvent, CursorContext?)`, context has the live `AXUIElement` | main thread |
| `ClipboardMonitorKit` | `ClipboardMonitor` | `onEvent(ClipboardEvent)`: `contentType`, `content`, `contentPaths`, `concealed` | private queue |
| `WindowMonitorKit` | `WindowMonitor` | `onEvent(WindowMonitorEvent)`: `.window(WindowEvent)` opened/closed/focused/unfocused/boundsChanged/titleChanged, `.spaceChanged`, `.ready`/`.permissionsChanged` | private queue |
| `TextInputMonitorKit` | `TextInputMonitor` | `onEvent(TextInputMonitorEvent)`: `.textInput(TextInputEvent)` with `status` started/updated/finished and `text` | private queue |

- Private-queue kits: hop to the main actor for UI. `start()`/`stop()` are idempotent and safe
  from any thread, including inside a callback. `CursorMonitor` must be started and stopped on
  the main thread.
- `WindowMonitorKit` and `TextInputMonitorKit` need the main run loop running (any
  NSApplication does). `TextInputMonitor.stop()` delivers a final `finished` for an edit in
  progress.
- Each kit has `onError(Problem, String)` (cursor: an `error` `CursorEvent`). Show the user what
  to grant; the kits pick up a grant without a restart.
- Privacy is built in: password fields and concealed/transient clipboard entries never produce
  content. Text input is sensitive: turn it on only when the feature needs it.
- The kits are compiled into the host binary. The **host app** is what the user grants
  Accessibility and Screen Recording to, and it must be signed with a stable identity, or macOS
  drops the grants on every rebuild.

## Permissions

| Sensor | Permission | Default |
| --- | --- | --- |
| text selection, text input, window state, cursor++ | Accessibility | selection and window state on |
| screen stream, screenshot image, window titles | Screen Recording | screenshot on, stream off |
| camera | Camera | off |
| clipboard | none | on |

Permission problems arrive as error events. Check them and show the user what to grant. Do not
retry in a loop.

## Rules for agents working with AUSM

- **Ask before turning on a sensitive sensor.** Text input, camera, cursor++ and screen streaming
  are off by default for a reason. Enable only what the feature needs, and tell the user which
  macOS permissions it will ask for.
- **Never log user content.** Do not print `text`, clipboard `content`, window titles, URLs or
  frames in logs, test output or commit messages. Log kinds, counts and lengths instead.
- **Don't run sensors to test your code.** The helpers inherit your terminal's permissions and
  will capture real activity (for example, the terminal's scrollback through text input). Unit
  test against fake events built with the `create*Event` factories and the runtime's `emit*Event`
  methods.
- **Respect password fields and concealed clipboard entries.** AUSM skips them. Don't add
  workarounds that read them.
- Keep the memory database out of version control and out of shared folders.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| No events at all | Accessibility not granted to the host app (or the terminal in development) |
| Screenshot event but no image, or windows missing from frames | Screen Recording not granted |
| Window events with empty titles | Screen Recording not granted. macOS hides titles without it |
| No `TaskEvent` | No `CEREBRAS_API_KEY` or Vertex `projectId`, or `rapid-task` disabled |
| Grants vanish after each rebuild (Swift) | App signed ad hoc. Sign with a stable identity |
| `Cannot find module '@ausm/core'` in the monorepo | Run `npm run build` first. Packages resolve through `dist/` |
