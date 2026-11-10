# device-macos Swift kits

Five helper packages each build two products: a JSON-lines executable for the npm wrapper and
an in-process library kit with all of the logic.

| Package (`device-macos/…/swift`) | Kit (library) | Helper (executable) |
| --- | --- | --- |
| `screenshot-detector` | `ScreenshotMonitorKit` | `ScreenshotHelper` |
| `cursor-plus-plus` | `CursorMonitorKit` | `CursorHelper` |
| `clipboard-monitor` | `ClipboardMonitorKit` | `ClipboardHelper` |
| `viewport-manager` | `WindowMonitorKit` | `ViewportHelper` |
| `text-input` | `TextInputMonitorKit` | `TextInputHelper` |

The helpers are thin wrappers that print the kit's events as JSON lines on stdout; the npm
wrappers (`npm run build:swift` builds universal arm64+x86_64 binaries into `build/`) parse them.
Native hosts link the kits through the repo-root `Package.swift` (package `AUSM`).

## Using the kits from a Swift app

```swift
// Package.swift of your app
.package(url: "https://github.com/foundation-interface/AUSM.git", from: "0.1.0"),
// or, for a local checkout:
.package(name: "AUSM", path: "../AUSM"),

.product(name: "ScreenshotMonitorKit", package: "AUSM"),
.product(name: "CursorMonitorKit", package: "AUSM"),
.product(name: "ClipboardMonitorKit", package: "AUSM"),
.product(name: "WindowMonitorKit", package: "AUSM"),
.product(name: "TextInputMonitorKit", package: "AUSM"),
```

The kits are compiled from source and statically linked into your executable. A shipped `.app`
contains no separate AUSM files and needs no Node runtime. Your app (not AUSM) is what the user
grants **Accessibility** (cursor, screenshot, window, text input) and **Screen Recording**
(screenshot images, other apps' window titles) to, and it must be signed with a stable identity,
or macOS drops those grants on every rebuild. The clipboard kit needs no permission.

```swift
import ClipboardMonitorKit
import TextInputMonitorKit
import WindowMonitorKit

let clipboard = ClipboardMonitor()                 // Options: includeContent, maxContentBytes, …
clipboard.onEvent = { change in                    // private queue
    Task { @MainActor in handle(change.contentType, concealed: change.concealed) }
}
clipboard.start()

let windows = WindowMonitor()
windows.onEvent = { event in                       // private queue
    switch event {
    case .window(let e) where e.type == .focused: Task { @MainActor in focus(e.bundleId, e.bounds.cgRect) }
    case .spaceChanged: break
    default: break
    }
}
windows.onError = { problem, message in }          // accessibility_denied, screen_recording_denied
windows.start()

let typing = TextInputMonitor()
typing.onEvent = { event in
    if case .textInput(let e) = event, e.status == .finished { /* e.text, e.sourceElement */ }
}
typing.onError = { problem, message in }           // accessibility_denied
typing.start()
```

### Threading

| Kit | Callbacks delivered on | `start()` / `stop()` |
| --- | --- | --- |
| `ScreenshotMonitorKit` | the monitor's private serial queue. Hop to the main actor for UI work | any thread, including from inside a callback |
| `CursorMonitorKit` | the main thread (the event tap runs on the main run loop) | main thread |
| `ClipboardMonitorKit` | the monitor's private serial queue | any thread, including from inside a callback; idempotent |
| `WindowMonitorKit` | the monitor's private serial queue | any thread, including from inside a callback; idempotent. `start()` is asynchronous (`.ready` is the first event), `stop()` is synchronous |
| `TextInputMonitorKit` | the monitor's private serial queue | same as `WindowMonitorKit`; `stop()` delivers a final `TEXT_EDITING_FINISHED` for an edit in progress before it returns |

Never block a kit's private queue waiting on the main thread (for example `DispatchQueue.main.sync`
inside a callback while the main thread calls `stop()`). `WindowMonitorKit` and
`TextInputMonitorKit` attach their AXObservers to the **main run loop**, so it must be running
(any NSApplication does; a command-line tool calls `RunLoop.main.run()`). Assign callbacks before
`start()`.

`WindowMonitor.Options.axMessagingTimeout` (default 0.25 s) and
`TextInputMonitor.Options.axMessagingTimeout` (default 0.5 s) are applied to the system-wide AX
element, which macOS treats as the timeout for **every** AX call in the process. Set them to `nil`
if your app manages that itself.

### Errors and permissions

The kits report permission and health problems instead of failing silently:

- `ScreenshotMonitor.onError(Problem, String)` with `Problem` = `accessibility_denied`,
  `screen_recording_denied`, `event_tap_disabled`. Each problem is reported once until it clears.
  A 5 s health check re-enables a disabled event tap and creates the tap once Accessibility is
  granted, so no relaunch is needed. `eventTapActive` exposes the current state.
- `CursorMonitor` emits a `CursorEvent` with `code`/`message` (`accessibility_denied`,
  `event_tap_disabled`). `CursorHelper` writes the same as an `error` line and exits with code 2
  when the tap can't be created.
- `WindowMonitor.onError(Problem, String)` with `accessibility_denied` (focus falls back to
  polling, no `documentPath`) and `screen_recording_denied` (other apps' titles are hidden, so
  their windows are not reported). Reported at start and again whenever a permission is revoked;
  every change also arrives as `.permissionsChanged(WindowPermissions)`. Granting Accessibility
  attaches the AX observer without a restart.
- `TextInputMonitor.onError(.accessibilityDenied, String)`: no events until granted; the monitor
  re-checks every 2 s, attaches by itself, and delivers `.permissionChanged(accessibilityTrusted:)`.
- `ClipboardMonitor.onError(Problem, String)` with `pasteboard_access_denied` /
  `pasteboard_access_prompts` when the user set this app's paste access to Deny / Ask (macOS 15.4+
  `NSPasteboard.accessBehavior`). Polling `changeCount` and the type list never prompts.

The helpers write these messages to stderr (never user content) and keep the wire format
unchanged. They exit when their parent process dies (stdin EOF or parent-pid watch).

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

## ClipboardMonitorKit

`ClipboardMonitor` polls `NSPasteboard.general.changeCount` (`Options.pollInterval`, default
200 ms) and reports each change once as a `ClipboardEvent`: `changeCount`, `timestampMs`,
`contentType` (`ClipboardContentType`: FILE > URL > IMAGE > HTML > RTF > TEXT priority, nil when
none of these types is present), `concealed`, `content`, `contentPaths`, `contentTruncated`.
Changes made before `start()` or while stopped are not reported; several copies between two polls
coalesce into one event.

Privacy: a pasteboard carrying `org.nspasteboard.ConcealedType`, `org.nspasteboard.TransientType`,
`com.agilebits.onepassword` or `de.petermaurer.TransientPasteboardType` (plus
`Options.additionalConcealedTypes`) is reported with `concealed: true` and its content is never
read. `includeContent = false` never reads any content. Image data is never read. `content` is
capped at `maxContentBytes` (default 1 MiB) on a character boundary.

Wire format (`ClipboardHelper [--no-content] [--max-content-bytes N]`), unchanged:
`{"type":"ready"}` then `{"type":"clipboard_changed","changeCount":N,"timestamp":ms,
"contentType"?,"content"?,"contentPaths"?,"contentTruncated"?,"concealed"?}`. `ClipboardEvent.wireObject`
/ `wireLine` produce exactly these objects.

## WindowMonitorKit

`WindowMonitor` scans `CGWindowList` every 16 ms, follows the frontmost app through NSWorkspace
and an AXObserver for instant focus changes, and delivers `WindowMonitorEvent`:

- `.ready(WindowPermissions)` first, then
- `.window(WindowEvent)`: `type` (`WindowEventType`: `opened`, `closed`, `focused`, `unfocused`,
  `boundsChanged`, `titleChanged`), `windowId`, `title`, `ownerName`, `bundleId`, `pid`, `bounds`
  (global top-left-origin points), `displayId` (largest overlap), `documentPath` (AXDocument),
  `oldTitle`, `oldBounds`.
- `.spaceChanged(Date)` on a Mission Control Space switch.
- `.permissionsChanged(WindowPermissions)`.

Ordering guarantees: closes before opens in one tick; `unfocused` before the next `focused`, and
right before `closed` when the focused window goes away. Ticks in which several windows change
bounds at once (Space swipes, Mission Control, display changes) drop all `boundsChanged` events.
Untitled windows, windows of 100 pt or less, non-layer-0 windows and system UI
(`Options.blockedBundleIdentifiers`) are skipped. `excludeOwnProcess` leaves the host's own
windows out; `resolveDocumentPaths = false` skips the AXDocument lookups.

Wire format (ViewportHelper), unchanged: the `ready` line keeps zeroed window fields for older
readers, then window events, `{"type":"space-changed","timestamp":ms}` and
`{"type":"permission",…}`. `WindowMonitorEvent.wireLine` produces exactly these lines.

## TextInputMonitorKit

`TextInputMonitor` observes kAXFocusedUIElementChanged for the frontmost app and
kAXValueChanged for the focused text field, text area or combo box, and delivers
`TextInputMonitorEvent`: `.ready(accessibilityTrusted:)`, `.textInput(TextInputEvent)`,
`.permissionChanged(accessibilityTrusted:)`. `TextInputEvent` has `status`
(`TextInputStatus.started` / `.updated` / `.finished`, raw `TEXT_EDITING_*`), `text` (the
element's full value), `sourceElement` (role, app name, bundle id, frame), `caretScreenPosition`
and `timestamp` (ms).

Session rules (`TextEditTracker`, unit-tested): STARTED on focus into an editable element (focus
landing on a child resolves to the nearest editable ancestor within 8 levels); duplicate focus
notifications are ignored; switching fields gives FINISHED then STARTED; leaving to a
non-editable element gives FINISHED only after `Options.finishDebounce` (200 ms) and only if the
app's focused element is really no longer editable; UPDATED only when the value differs from the
last reported one; app switch, app quit, permission revocation and `stop()` finish immediately.

Privacy: password fields (`AXSecureTextField` subrole, native and web) produce no events, no
value reads and no value observer, so not even typing cadence leaks. A password field nested in
an editable ancestor is not tracked through that ancestor. The host's own fields are skipped.

Wire format (TextInputHelper), unchanged: `{"type":"ready","accessibilityTrusted":…}`, text-input
objects without a `type` field, and `{"type":"permission","accessibilityTrusted":…}`.

## Tests

```bash
swift test                                   # repo root: all five kits
(cd device-macos/<service>/swift && swift test)   # each helper
```

None of the tests need TCC permissions, install event taps or AX observers, or touch the real
pasteboard: the clipboard tests use a fake pasteboard, the window and text-input tests drive the
pure state machines (`WindowDiff`, `FocusTracker`, `DocumentPathCache`, `TextEditTracker`,
`TextInputPolicy.resolveEditable`) with synthetic snapshots and elements.
