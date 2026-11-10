# @ausm/device-macos-clipboard-monitor

Reports macOS clipboard changes (copy/cut in any app) as `CopyPasteEvent`s from `@ausm/core`.
A small Swift helper (`build/clipboard-helper`) checks `NSPasteboard.changeCount` every 200 ms
and, when it changes, reports the content type and (optionally) the content. macOS 12+. No
permissions are needed.

Only copies are detected. macOS has no paste notification, so `action` is always `COPY`.

## Node API

```ts
import { createClipboardMonitor } from '@ausm/device-macos-clipboard-monitor';

const clipboard = createClipboardMonitor({ includeContent: true });
clipboard.on('copy-paste-event', (e) => {
  // e.contentType: TEXT | HTML | RTF | IMAGE | FILE | URL | null
  // e.content: the string (HTML/RTF as markup; FILE as newline-joined paths); null for images
  // e.contentPaths: file paths for FILE
});
clipboard.on('error', (err) => console.warn(err.message));
clipboard.start();
// …
clipboard.stop();
```

Config:

| Option | Default | |
| --- | --- | --- |
| `includeContent` | true | `false`: the helper never reads the clipboard's contents, it only reports the type |
| `maxContentBytes` | 1 MiB | Longer content is cut at a character boundary |
| `autoRestart` | true | Restart a crashed helper with exponential backoff (at most 5 times per minute) |
| `helperPath` | bundled | Override the helper binary |
| `debug` | false | Console diagnostics (lengths and types only, never contents) |

Events: `copy-paste-event` (`CopyPasteEvent`), `status` (`'started' | 'stopped'`), `error`.
If no `error` listener is attached, errors are printed with `console.warn` instead of being
thrown.

Content type priority when several are on the clipboard: FILE > URL > IMAGE > HTML > RTF > TEXT.

**Privacy.** Clipboard content can be sensitive. Copies that password managers mark as concealed
or transient ([nspasteboard.org](http://nspasteboard.org) markers) are reported without content.
Image data is never read. Use `includeContent: false` when you only need the activity signal; on
recent macOS versions this also avoids reading another app's pasteboard data at all.

## Helper wire protocol

`build/clipboard-helper [--no-content] [--max-content-bytes N]` writes one JSON object per line:

- `{"type":"ready"}`
- `{"type":"clipboard_changed","changeCount":N,"timestamp":ms,"contentType"?,"content"?,"contentPaths"?,"contentTruncated"?:true,"concealed"?:true}`

The helper exits on SIGTERM/SIGINT, and also when its parent process exits.

## Build

```sh
npm run build          # universal (arm64 + x86_64) helper → build/, then TypeScript → dist/
npm run build:swift    # helper only; ad-hoc signed unless SIGN_IDENTITY is set
npm run test:swift     # XCTest (pure logic, never touches the real pasteboard)
npm run typecheck
npm run demo           # after build: logs events while you copy things
```
