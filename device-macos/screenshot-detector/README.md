# @ausm/device-macos-screenshot-detector

Detects macOS screenshots (⌘⇧3, ⌘⇧4, ⌘⇧5, with or without ⌃ for clipboard, plus the
`screencapture` CLI) and reproduces the captured image. Reports `ScreenshotEvent`s from
`@ausm/core`. macOS 13+; ScreenCaptureKit is used on macOS 14+.

Two ways to use it:

- **Node** (this package): `ScreenshotDetectorService` spawns the bundled Swift helper
  (`build/screenshot-helper`) and maps its JSON lines to `ScreenshotEvent`s.
- **Native Swift**: link `ScreenshotMonitorKit` in-process via
  the repo-root `Package.swift` and receive `CGImage`s directly (see `../README-swift-kits.md`).

## How it works

Every screenshot hotkey spawns `/usr/sbin/screencapture` whose argv encodes the mode
(`-z keyboard.screen|selection|interactive[.clipboard]`). The helper polls the process table
(every 30 ms) and opens a session when one appears. Interactive `screencapture` processes exit at
an arbitrary moment, so the session ends on the user's gesture, followed with a listen-only
CGEventTap: mouse-up after a drag (⌘⇧4), Space + click on a window, Return or the Capture button
(⌘⇧5 panel), Esc to cancel. Non-interactive captures (⌘⇧3) complete when the process exits. The
image is then captured with ScreenCaptureKit, leaving out the Screenshot UI and the host app's
windows, at the display's real backing scale.

Limitations: ⌘⇧3 writes one file per display, but only the display under the cursor is
reproduced. A selection that spans displays is clipped to the display holding its center. The
⌘⇧5 Capture button is found by a heuristic (the right end of the toolbar). An interactive session
that never completes is abandoned after 180 s.

## Permissions

| Permission | Needed for | When missing |
| --- | --- | --- |
| Accessibility (or Input Monitoring) | event tap that follows ⌘⇧4/⌘⇧5 gestures | `error` (`accessibility_denied`); only ⌘⇧3 / CLI captures are reproduced. Retried every 5 s, so granting it later works without a restart |
| Screen Recording | the capture itself | `error` (`screen_recording_denied`); sessions end with `cancelled: true` and `screenshot_capture_failed` |

Permissions belong to the app that launches the helper (your Electron app, or Terminal in
development).

## Node API

```ts
import { createScreenshotDetector } from '@ausm/device-macos-screenshot-detector';

const detector = createScreenshotDetector({ debug: false });
detector.on('screenshot-event', (e) => {
  // e.status: SCREENSHOT_STARTED | SCREENSHOT_UPDATED (selection rect) | SCREENSHOT_FINISHED
  // FINISHED with an image: e.imagePath / imageWidth / imageHeight (pixels) / bounds (points)
  // FINISHED without imagePath: cancelled (Esc, timeout) or the capture failed
});
detector.on('error', (err) => console.warn(err.message)); // permissions, crashes, failed captures
detector.start();
// …
detector.stop();
```

Config: `debug` (console diagnostics, never image data), `autoRestart` (default `true`: restart a
crashed helper with exponential backoff, at most 5 times per minute), `helperPath` (override the
binary).

Events: `screenshot-event` (`ScreenshotEvent`), `status` (`'started' | 'stopped'`), `error`
(`Error`). If no `error` listener is attached, errors are printed with `console.warn` instead of
being thrown.

`type` is `WINDOW_SCREEN` for window captures, `PARTIAL_SCREEN` when a region was selected, and
`FULL_SCREEN` otherwise. Coordinates are global CoreGraphics points: origin at the top-left of
the main display, y grows down.

**Temp files.** `imagePath` points to a JPEG in the user's temporary directory, mode `0600`. The
consumer owns it and should delete it after reading (the AUSM Electron bridge copies and then
deletes it). Files older than an hour are swept when the helper starts.

## Helper wire protocol

`build/screenshot-helper [--debug]` writes one JSON object per line to stdout. Every object has
`type` and `timestamp` (ms since epoch):

| `type` | Fields |
| --- | --- |
| `ready` | |
| `screencapture_started` | `pid`, `mode` (`screen`/`selection`/`window`/`interactive`/`unknown`), `destination` (`file`/`clipboard`/`unknown`) |
| `selection_rect_changed` | `rect` `{x,y,width,height}` (points), `displayId` |
| `screencapture_ended` | `pid`, `mode`, `destination`, `cancelled`; with an image also `imagePath`, `imageWidth`, `imageHeight`, `imageMimeType`, `displayId`, `scale`, `rect?` |
| `screencaptureui_started` / `screencaptureui_ended` | `pid` (the Screenshot UI agent) |
| `screenshot_capture_failed` | `reason`, `displayId` |
| `error` | `code` (`accessibility_denied` / `screen_recording_denied` / `event_tap_disabled`), `message` |

stderr carries diagnostics: permission warnings always, everything else only with `--debug`.
The helper exits on SIGTERM/SIGINT, and also when its parent process exits.

## Build

```sh
npm run build          # universal (arm64 + x86_64) helper → build/, then TypeScript → dist/
npm run build:swift    # helper only; ad-hoc signed unless SIGN_IDENTITY is set
npm run test:swift     # XCTest (pure logic, no permissions needed)
npm run typecheck
```

Requires Xcode (or the Command Line Tools with Swift 5.9+). Set `SIGN_IDENTITY` to a Developer ID
for distribution so TCC grants persist across updates.
