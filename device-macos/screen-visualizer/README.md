# screen-visualizer (dev tool)

Shows the frames that the AUSM screen-stream producer writes to shared memory,
in an OpenCV window. Useful for checking capture resolution, FPS and
multi-display behaviour. Not published to npm/PyPI and not used by the
runtime.

## Run

Start a screen-stream producer first (needs Screen Recording permission),
e.g. `npx tsx device-macos/service-manager.ts --screen-stream`, then:

```sh
# from the repo root, without installing anything into site-packages
PYTHONPATH=device-macos/screen-visualizer:device-macos/internal-lib/screen-stream-reader \
  python3 -m screen_visualizer [--display display-1] [--scale 0.5] [--save-dir DIR]

# or
npx tsx device-macos/service-manager.ts --screen-stream --visualizer
```

Or install it: `pip install -r device-macos/screen-visualizer/requirements.txt`
(installs the local `screen-stream-reader` in editable mode plus numpy and
opencv-python), then `screen-visualizer` / `python3 -m screen_visualizer`.
Python >= 3.9.

Keys: `q`/Esc quit, `d` next display, `f` FPS overlay, `r` resolution overlay,
`s` save frame, Space pause.

## Saved frames

`s` writes a PNG screenshot to `--save-dir` (default
`$TMPDIR/ausm-frames`, which on macOS is inside your per-user temp
directory). The directory is created `0700` and files `0600`. Delete them when
done; they contain whatever was on screen.
