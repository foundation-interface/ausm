# @ausm/device-macos-text-input

Reports when the user starts editing, types in, and leaves an editable text element in any
macOS app (text fields, text areas, combo boxes, web inputs). It uses the Accessibility
API. A Swift helper (`build/text-input-helper`) streams JSON lines to this Node wrapper.

macOS 12+, Node 18+. Universal binary (arm64 + x86_64).

> **Privacy.** Events contain the full text of the focused field, which can include
> sensitive content. AUSM runs this sensor only when the host opts in
> (`textInput.enableNativeTextInput`).
>
> - **Password fields (`AXSecureTextField`) are never reported.** The helper emits no events
>   for them, never reads their values, and does not observe their value changes, so even
>   typing cadence does not leak.
> - Typed text is never logged, by the helper (stderr) or by this wrapper (debug logs show
>   only `<N chars>`).

## Permissions

**Accessibility** is required. macOS grants it to the *responsible* app (your terminal
or Electron app). The helper never prompts. Without the permission it emits no text
events. It reports `permission { accessibilityTrusted }` at startup and whenever the
state changes. If the permission is granted while running, monitoring starts without a
restart. If it is revoked, an in-progress edit is closed with a `TEXT_EDITING_FINISHED`
event.

## Usage

```ts
import { createTextInputMonitor } from '@ausm/device-macos-text-input';

const monitor = createTextInputMonitor();
monitor.on('permission', ({ accessibilityTrusted }) => { if (!accessibilityTrusted) promptUser(); });
monitor.on('text-input', (e) => {
  // e.status: TEXT_EDITING_STARTED | TEXT_EDITING_UPDATED | TEXT_EDITING_FINISHED
  handle(e.text, e.sourceElement?.applicationID, e.caretScreenPosition);
});
monitor.on('error', (err) => console.error(err));

monitor.start({ debug: false, autoRestart: true });
// ...
monitor.cleanup();
```

`start()` always returns `true`. On non-macOS platforms, or if the helper binary is
missing, the monitor runs in stub mode: an `error` is emitted for the missing binary,
and events can be injected with `reportEvent(data)`. With `autoRestart` (default
`true`), a crashed helper is respawned with exponential backoff (1 s … 30 s, 5 attempts).
If there is no `error` listener, errors are logged with `console.warn` instead of
throwing.

## Events

| Event | Payload |
| --- | --- |
| `text-input` | `TextInputEventLike` (below) |
| `permission` | `{ accessibilityTrusted: boolean }` |
| `status` | `'started' \| 'stopped'` |
| `error` | `Error` |

`TextInputEventLike`:

| Field | Description |
| --- | --- |
| `eventID` | `txt_<ms>_<random>` |
| `timestamp` | ms since epoch (from the helper) |
| `status` | `TEXT_EDITING_STARTED` on focus into a field. `TEXT_EDITING_UPDATED` when the value changes, only if it differs from the last value sent. `TEXT_EDITING_FINISHED` on focus out (debounced 200 ms), app switch, or app quit. |
| `text` | Full current value, or `null` when the app does not expose it. `FINISHED` carries the last value sent. |
| `sourceElement` | `{ type (AX role), application, applicationID (bundle id), applicationLocalizedName, screenBounds, content: null }` |
| `caretScreenPosition` | Top-left of the selection bounds in global screen points, or `null` |
| `displayID` | Not set by the helper |

Coordinates are global CoreGraphics points (origin at the top-left of the main display, y
grows downward).

## Helper protocol (stdout, one JSON object per line)

- `{"type":"ready","accessibilityTrusted":bool}`, sent once.
- `{"type":"permission","accessibilityTrusted":bool}`, sent on change.
- `{"status":"TEXT_EDITING_…","text":…,"sourceElement":{…},"caretScreenPosition":{…},"timestamp":ms}`.
  `nil` fields are omitted.

Lines without a `status` are not text-input events. stderr carries diagnostics only. The
helper exits on SIGTERM/SIGINT (after emitting a final `FINISHED` for an open edit), on
stdin EOF, or when its parent process dies. Every AX call has a 500 ms timeout.

## Build

```bash
npm run build         # universal Swift helper → build/text-input-helper (ad-hoc signed) + TS → dist/
npm run build:swift   # helper only; set SIGN_IDENTITY to sign with a real identity
npm run typecheck
npm run test:swift    # XCTest: password-field policy, JSON shape; no permissions needed
```

The universal build needs a full Xcode installation.
