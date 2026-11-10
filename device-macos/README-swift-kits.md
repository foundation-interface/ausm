# device-macos Swift kits

`screenshot-detector/swift` and `cursor-plus-plus/swift` each build two products:

| Product | Kind | Used by |
| --- | --- | --- |
| `ScreenshotHelper`, `CursorHelper` | executables (JSON lines on stdout) | the npm wrappers (`npm run build:swift` builds universal arm64+x86_64 binaries into `build/`) |
| `ScreenshotMonitorKit`, `CursorMonitorKit` | libraries | native hosts, via the repo-root `Package.swift` (package `AUSM`) |

## Using the kits from a Swift app

```swift
// Package.swift of your app
.package(url: "https://github.com/foundation-interface/AUSM.git", from: "0.1.0"),
// or, for a local checkout:
.package(name: "AUSM", path: "../AUSM"),

.product(name: "ScreenshotMonitorKit", package: "AUSM"),
.product(name: "CursorMonitorKit", package: "AUSM"),
```

The kits are compiled from source and statically linked into your executable. A shipped `.app`
contains no separate AUSM files and needs no Node runtime. Your app (not AUSM) is what the user
grants **Accessibility** (both kits) and **Screen Recording** (`ScreenshotMonitorKit`) to, and
it must be signed with a stable identity, or macOS drops those grants on every rebuild.

### Threading

| Kit | Callbacks delivered on | `start()` / `stop()` |
| --- | --- | --- |
| `ScreenshotMonitorKit` | the monitor's private serial queue. Hop to the main actor for UI work | any thread, including from inside a callback |
| `CursorMonitorKit` | the main thread (the event tap runs on the main run loop) | main thread |

### Errors and permissions

Both kits report permission and health problems instead of failing silently:

- `ScreenshotMonitor.onError(Problem, String)` with `Problem` = `accessibility_denied`,
  `screen_recording_denied`, `event_tap_disabled`. Each problem is reported once until it clears.
  A 5 s health check re-enables a disabled event tap and creates the tap once Accessibility is
  granted, so no relaunch is needed. `eventTapActive` exposes the current state.
- `CursorMonitor` emits a `CursorEvent` with `code`/`message` (`accessibility_denied`,
  `event_tap_disabled`). `CursorHelper` writes the same as an `error` line and exits with code 2
  when the tap can't be created.

The helper executables exit when their parent process dies (stdin EOF or parent-pid watch).

## ScreenshotMonitorKit — how macOS 26 screenshots actually behave

Verified on macOS 26.3 (Darwin 25.3):

1. Every hotkey spawns `/usr/sbin/screencapture` whose argv names the mode:
   `-z keyboard.screen` (⌘⇧3), `-z keyboard.selection` (⌘⇧4), `-z keyboard.interactive` (⌘⇧5),
   with a `.clipboard` suffix and `-c` when ⌃ is held.
2. Interactive modes hand off to the persistent `screencaptureui` agent and the `screencapture`
   process **exits at an arbitrary moment** — often before the user has dragged anything.
   The old helper captured at that exit, so ⌘⇧4 produced a full-display image taken before the
   selection existed and the selection rect was never applied.
3. The file lands on disk 4–10 s later (after the floating thumbnail); clipboard captures are
   immediate.

The monitor therefore opens a session when `screencapture` appears (reading its argv) and ends it
on the user's gesture: mouse-up with a dragged rect (⌘⇧4), Space + click for a window, Return or
the Capture button for the ⌘⇧5 panel, Esc to cancel, process exit only for non-interactive
captures. Images are taken with ScreenCaptureKit, excluding the Screenshot UI and the host app's
own windows, at the display's true backing scale.

Wire protocol (`screencapture_started` / `selection_rect_changed` / `screencapture_ended` with
`imagePath` etc.) is backward compatible. `screencapture_started` and `screencapture_ended` also
carry `mode` (`screen`, `selection`, `window` when Space was pressed in ⌘⇧4, `interactive`),
`destination` and `cancelled`. `screencapture_ended` carries `scale`. Problems arrive as
`{"type":"error","code":…,"message":…}`, and `screenshot_capture_failed` uses `displayId`
(String) like every other event. Calling `stop()` with a session open fires
`onSessionEnded(cancelled: true)`.

Temp files are created with `O_EXCL`, mode 0600, under unique names. Files older than
`staleTempFileAge` (default 1 h) are swept when the monitor starts. When Screen Recording is
denied, no capture is produced: the legacy CoreGraphics fallback would return only the
wallpaper, so it is used only when permission is granted.

`ScreenshotMonitor.Options`: `writeTempFile`, `tempFileFormat`, `excludedBundleIdentifiers`,
`excludeOwnProcess`, `captureDelay`, `sessionTimeout`, `staleTempFileAge`, `debugLogging`
(`ScreenshotHelper --debug`). Typed callbacks for hosts: `onSessionStarted`, `onSelectionChanged`,
`onCapture` (CGImage, rect, display, scale, mode, destination), `onSessionEnded(cancelled:)`,
`onError(Problem, String)`.

## CursorMonitorKit

Same CGEventTap monitor as before, plus:

- `onEvent(CursorEvent, CursorContext?)` — the context carries the live `AXUIElement` under the
  cursor and the resolved window for in-process hosts.
- `uiElementSubrole`, `uiElementIsEditableText` on interaction events (text roles, WebKit
  content-editable, Chromium `AXEditableAncestor`).
- Desktop-level elements (Finder's desktop) report `bundleId` even though no layer-0 window
  contains the point.
- Options: `moveThrottle` (0 = every move; `CursorHelper --move-throttle-ms N`), `enrichedActions`
  to limit AX round-trips to the actions a host cares about, `ignoreOwnWindows`.
- AX queries carry a 250 ms messaging timeout on every entry point, so an unresponsive app cannot
  get the tap disabled.
- `uiElementValue` (first 200 characters of the element under the cursor) is never read from
  secure (password) text fields.
- HOLD_START fires after the hold delay even when the mouse is perfectly still. HOLD_END is
  always emitted after a HOLD_START and never for a plain text-selection drag. DRAG is throttled
  by `moveThrottle` like MOVE.

## Tests

```bash
swift test                                   # repo root: both kits
(cd device-macos/<service>/swift && swift test)   # each helper
```

None of the tests need TCC permissions.
