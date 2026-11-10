# @ausm/device-macos-text-selection

System-wide text selection monitoring for macOS, as a Node-API native addon
(works in Node >= 18 and Electron without rebuilding per ABI). Based on
[selection-hook](https://github.com/0xfullex/selection-hook).

In AUSM this is used by `@ausm/core`'s `SelectionClient` (the runtime's
`onTextSelectionEvent`). You can also use it on its own.

## How it works

* A background thread installs two **listen-only** `CGEventTap`s (mouse and
  keyboard) and forwards events to JS through thread-safe functions.
* On mouse-up after a drag, a double-click or a shift-click (with an I-beam
  cursor), the addon asks the frontmost app's focused accessibility element
  for its selected text and the on-screen bounds of the selection.
* If AX returns nothing and the **clipboard fallback** is enabled (the
  native default), it posts a synthetic Cmd+C to the frontmost app, reads the
  clipboard and restores the previous plain-text clipboard contents. Disable
  this with `enableClipboard: false` if synthetic key events or clipboard
  churn are unacceptable (non-text clipboard contents are not restored).
* If AX returns nothing, the addon also sets `AXEnhancedUserInterface` /
  `AXManualAccessibility` on the target app so Chromium/Electron apps expose
  their accessibility tree on the next attempt.
* Each AX request is bounded by a 1 s messaging timeout (applied process-wide)
  so a hung app cannot stall the Node event loop for long. AX queries run on
  the JS thread.

Coordinates are global screen points (origin top-left of the primary
display; negative on displays placed left of / above it).

## Permissions

* **Accessibility** (System Settings → Privacy & Security → Accessibility)
  for the host process (your terminal, Electron app, …). Without it no
  selections are reported.
* Keyboard event taps may also require **Input Monitoring** on recent macOS.
* `isProcessTrusted()` checks Accessibility; `requestProcessTrust()` shows the
  system prompt.

## API

```ts
import { SelectionMonitorService } from '@ausm/device-macos-text-selection';

const monitor = new SelectionMonitorService(); // throws if the addon can't load
monitor.on('selection', (info) => {
  // info.text, info.programName (bundle id), info.localizedName,
  // info.bounds (Rect | null), info.elementBounds, info.detectionType,
  // info.retrievalMethod (AXAPI | CLIPBOARD), info.isFullscreen, ...
});
monitor.on('error', (err) => console.error(err)); // optional
monitor.start({ enableClipboard: false, globalFilterMode: 2, globalFilterList: ['com.agilebits.onepassword7'] });
// ...
monitor.cleanup(); // stop + remove listeners
```

Events: `selection`, `mouse-down`, `mouse-up`, `mouse-move` (only after
`enableMouseMoveEvent()`), `mouse-wheel`, `key-down`, `key-up`, `status`,
`error`. Keyboard events carry the key (`uniKey`, `vkCode`, modifier flags)
of every keystroke system-wide; treat them as sensitive.

Methods: `start(config?)`, `stop()`, `getCurrentSelection()`,
`isProcessTrusted()`, `requestProcessTrust()`, `enableMouseMoveEvent()`,
`disableMouseMoveEvent()`, `enableClipboard()`, `disableClipboard()`,
`setClipboardMode(mode, list)`, `setGlobalFilterMode(mode, list)`,
`setSelectionPassiveMode(bool)`, `writeToClipboard(text)`,
`readFromClipboard()`, `isRunning()`, `cleanup()`.

`FilterMode`: `DEFAULT` (all apps), `INCLUDE_LIST`, `EXCLUDE_LIST`; list
entries are matched case-insensitively as substrings of the bundle id.

`@ausm/device-macos-text-selection/ausm-adapter` converts `SelectionInfo`
to AUSM's `TextSelectionEvent` shape (`toAUSMTextSelectionEventData`,
`toExtendedAUSMEventData`, `inferTextElementType`).

## Privacy

Selected text, clipboard contents and keystrokes are only handed to your
listeners; the module never logs or stores them (debug logging only prints
error messages). Use `setGlobalFilterMode(EXCLUDE_LIST, [...])` to skip apps
such as password managers.

## Building

Installation runs `node-gyp-build`, which uses a prebuilt binary from
`prebuilds/` when present and otherwise compiles `src/` with node-gyp (needs
Xcode Command Line Tools and Python 3).

```sh
npm run rebuild           # node-gyp rebuild → build/Release/selection_monitor.node
npm run build             # TypeScript → dist/
npm run build:prebuilds   # N-API prebuilds for darwin-arm64 and darwin-x64
npm test                  # unit tests for the pure-TS adapter
npm run demo              # examples/demo.js (needs Accessibility permission)
```

Prebuilds are Node-API (`--napi`), so the same binary loads in Node and
Electron. The addon targets macOS 10.15+.
