# Testing

## Automated (no Screen Recording permission needed)

```bash
cd device-macos/screen-stream
npm run test:swift      # XCTest: layout math, SHM encoding, registry, command parsing
npm run test:python     # screen-stream-reader: header parsing, torn-read check, stale detection
npm run typecheck
```

## Manual, end to end

These need Screen Recording permission for your terminal app and a built
helper (`npm run build:helper`).

### Terminal 1: producer (Node)

```bash
cd device-macos/screen-stream
npx tsx dev/interactive-producer.ts
```

| Command | Description |
|---------|-------------|
| `s` | Start capture |
| `x` | Stop capture |
| `d` | List displays |
| `f <fps>` | Change default FPS (restarts capture) |
| `fd <id> <fps>` | Change FPS for one display |
| `h <height>` | Change target height (`0` = native) |
| `r` | Toggle video recording (to `/tmp/ausm-frames-test/`) |
| `i` | Show current status |
| `m` | Show helper CPU / memory |
| `q` | Quit |

The producer uses shared memory base name `/ausm-frames`, i.e.
`/ausm-frames-registry` and `/ausm-frames-display-<id>`.

### Terminal 2: consumer (Python)

```bash
cd device-macos
pip install numpy opencv-python
PYTHONPATH=internal-lib/screen-stream-reader:screen-visualizer python3 -m screen_visualizer
```

Or, minimal:

```python
from screen_stream_reader import ScreenStreamConnector
c = ScreenStreamConnector(); c.connect()
print([d.display_id for d in c.displays])
f = c.read_frame(); print(f and (f.width, f.height, f.frame_number))
```

### Raw helper REPL (no Node)

```bash
./dev/swift-helper-repl.sh      # starts the helper on /tmp/ausm-test-helper.sock
```

Type `d`, `s`, `x`, `i`, or `raw {"command":"status"}`.

## Scenarios

1. **Basic capture**: start in the producer, list displays and read frames in the consumer, stop.
2. **FPS change**: watch frame numbers in the consumer while running `f 30` / `f 5`; the consumer
   reconnects after `capture_stopped` / `capture_started`.
3. **Hot-plug**: plug or unplug a monitor while capturing; a `display_change` event is printed and
   the consumer picks up the new display.
4. **Recording**: `r`, `s`, wait, `x`; check `/tmp/ausm-frames-test/display-*.mp4`.
5. **Permission denied**: revoke Screen Recording for the terminal, restart it, press `s`; the start
   fails with `permission_denied` instead of hanging.
6. **Parent death**: `kill -9` the producer; the helper sees stdin EOF, exits within a second and
   unlinks its shared memory and sockets.

## Troubleshooting

- *Consumer finds no displays*: capture must be started; check `i` in the producer.
- *`start` fails with `permission_denied`*: grant Screen Recording to the app that launched Node
  (Terminal, iTerm, your Electron app) and restart that app.
- *`Failed to create ... (segment owned by another user?)`*: another user is running a helper
  with the same `sharedMemoryName`; pick a different name.
