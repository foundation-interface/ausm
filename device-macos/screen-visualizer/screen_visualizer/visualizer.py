#!/usr/bin/env python3
"""
Screen Visualizer

Real-time visualization of frames from the screen-stream module.
Uses the ScreenStreamConnector for communication with the producer.

Usage:
    python -m screen_visualizer [--shm-name /ausm-frames] [--display DISPLAY_ID]

Development tool only (not used by the AUSM runtime).

Controls:
    q / ESC   - Quit
    s         - Save current frame as PNG (see --save-dir; files are 0600)
    d         - Cycle through displays
    f         - Toggle FPS overlay
    r         - Toggle resolution display
    SPACE     - Pause/Resume

Requirements:
    pip install -e device-macos/internal-lib/screen-stream-reader opencv-python numpy
"""

import argparse
import os
import sys
import tempfile
import time
from typing import List, Optional
from datetime import datetime

import numpy as np

try:
    import cv2
except ImportError:
    sys.exit("Error: OpenCV not installed. Run: pip install opencv-python")

from screen_stream_reader import (
    ScreenStreamConnector,
    Frame,
    DisplayInfo,
    EventType,
    DEFAULT_SHM_NAME,
)


def default_save_dir() -> str:
    """
    Per-user directory for saved frames.  tempfile.gettempdir() honours
    $TMPDIR, which on macOS is a per-user 0700 directory (unlike /tmp).
    """
    return os.path.join(tempfile.gettempdir(), "ausm-frames")


class Visualizer:
    """Real-time frame visualizer with OpenCV"""

    def __init__(self, shm_name: str = DEFAULT_SHM_NAME, save_dir: Optional[str] = None):
        self.connector = ScreenStreamConnector(shm_name)
        self.save_dir = save_dir or default_save_dir()

        # Display options
        self.show_fps = True
        self.show_resolution = True
        self.paused = False
        self.scale_factor = 1.0

        # FPS tracking
        self.fps_samples: List[float] = []
        self.last_frame_time = 0.0
        self.last_frame_number = 0

        self.window_name = "AUSM Frame Visualizer"

    def initialize(self) -> bool:
        """Initialize the visualizer"""
        if self.connector.connect():
            if self.connector.has_notifications:
                print("Connected to notification socket")
            else:
                print("Waiting for producer...")
            return True
        return False

    def cycle_display(self):
        """Switch to the next display"""
        display = self.connector.cycle_display()
        if display:
            self.fps_samples.clear()
            self.last_frame_number = 0
            print(f"Switched to: {display.display_id}")

    def calculate_fps(self, frame_number: int) -> float:
        """Calculate current FPS"""
        now = time.time()
        if self.last_frame_time > 0 and frame_number > self.last_frame_number:
            dt = now - self.last_frame_time
            if dt > 0:
                instant_fps = (frame_number - self.last_frame_number) / dt
                self.fps_samples.append(instant_fps)
                if len(self.fps_samples) > 30:
                    self.fps_samples.pop(0)

        self.last_frame_time = now
        self.last_frame_number = frame_number
        return sum(self.fps_samples) / len(self.fps_samples) if self.fps_samples else 0.0

    def draw_overlay(self, frame: np.ndarray, captured_frame: Frame, display: DisplayInfo, fps: float) -> np.ndarray:
        """Draw information overlay on the frame"""
        overlay = frame.copy()
        base_scale = min(captured_frame.width, captured_frame.height) / 1000.0
        font_scale = max(0.5, base_scale)
        thickness = max(1, int(base_scale * 2))
        y = 30
        line_height = int(35 * base_scale)

        def text(s: str, color=(0, 255, 0)):
            nonlocal y
            cv2.putText(overlay, s, (12, y + 2), cv2.FONT_HERSHEY_SIMPLEX, font_scale, (0, 0, 0), thickness + 1, cv2.LINE_AA)
            cv2.putText(overlay, s, (10, y), cv2.FONT_HERSHEY_SIMPLEX, font_scale, color, thickness, cv2.LINE_AA)
            y += line_height

        text(f"Display: {display.display_id}", (255, 255, 255))
        if self.show_fps:
            fps_color = (0, 255, 0) if fps >= 25 else (0, 255, 255) if fps >= 15 else (0, 0, 255)
            text(f"FPS: {fps:.1f}", fps_color)
        if self.show_resolution:
            text(f"Resolution: {captured_frame.width}x{captured_frame.height}", (255, 255, 255))
        text(f"Frame: #{captured_frame.frame_number}", (200, 200, 200))
        if self.paused:
            text("PAUSED", (0, 0, 255))

        hint_scale = max(0.4, base_scale * 0.6)
        cv2.putText(overlay, "q:quit  d:display  f:fps  r:res  s:save  SPACE:pause",
                    (10, overlay.shape[0] - 15), cv2.FONT_HERSHEY_SIMPLEX, hint_scale, (128, 128, 128), 1, cv2.LINE_AA)
        return overlay

    def save_frame(self, frame: Frame):
        """Save the current frame as PNG (owner-only permissions: it is a screenshot)."""
        os.makedirs(self.save_dir, mode=0o700, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        safe_display = "".join(c if c.isalnum() or c in "-_" else "_" for c in frame.display_id)
        filename = os.path.join(self.save_dir, f"{safe_display}_{timestamp}.png")
        ok, encoded = cv2.imencode(".png", frame.bgr)
        if not ok:
            print("Failed to encode frame")
            return
        fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(encoded.tobytes())
        print(f"Saved: {filename}")

    def run(self, target_display: Optional[str] = None):
        """Main visualization loop"""
        if not self.initialize():
            return

        print("\nStarting visualizer...")
        print("Controls: q:quit  d:display  f:fps  r:res  s:save  SPACE:pause\n")

        cv2.namedWindow(self.window_name, cv2.WINDOW_NORMAL)
        last_frame: Optional[Frame] = None

        # Select initial display if specified
        if target_display:
            self.connector.select_display(target_display)

        try:
            while True:
                # Process events from the connector (handles auto-refresh)
                for event in self.connector.poll_events():
                    if event.type == EventType.CAPTURE_STOPPED:
                        print("Producer: Capture stopped")
                        last_frame = None
                        self.fps_samples.clear()
                        self.last_frame_number = 0
                    elif event.type == EventType.CAPTURE_STARTED:
                        print("Producer: Capture started")
                    elif event.type == EventType.DISPLAY_CHANGE:
                        print(f"Producer: Display {event.details.get('event', '')}: {event.display_id or ''}")

                display = self.connector.current_display
                if not display:
                    # Show waiting message
                    wait_frame = np.zeros((480, 640, 3), dtype=np.uint8)
                    cv2.putText(wait_frame, "Waiting for display...", (100, 240),
                                cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
                    cv2.putText(wait_frame, "Start capture on the screen-stream producer", (60, 280),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (128, 128, 128), 1)
                    cv2.imshow(self.window_name, wait_frame)
                else:
                    if not self.paused:
                        frame = self.connector.read_frame()
                        if frame:
                            last_frame = frame

                    if last_frame:
                        fps = self.calculate_fps(last_frame.frame_number)
                        display_frame = self.draw_overlay(last_frame.bgr, last_frame, display, fps)
                        
                        if self.scale_factor != 1.0:
                            new_size = (int(display_frame.shape[1] * self.scale_factor),
                                        int(display_frame.shape[0] * self.scale_factor))
                            display_frame = cv2.resize(display_frame, new_size)
                        
                        cv2.imshow(self.window_name, display_frame)
                    else:
                        wait_frame = np.zeros((480, 640, 3), dtype=np.uint8)
                        cv2.putText(wait_frame, f"No frames from {display.display_id}",
                                    (50, 240), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
                        cv2.imshow(self.window_name, wait_frame)

                # Handle keyboard input - wait 16ms (~60 FPS max) to reduce CPU usage
                key = cv2.waitKey(16 if last_frame is not None else 100) & 0xFF
                if key == ord('q') or key == 27:
                    break
                elif key == ord('d'):
                    self.cycle_display()
                    last_frame = None
                elif key == ord('f'):
                    self.show_fps = not self.show_fps
                elif key == ord('r'):
                    self.show_resolution = not self.show_resolution
                elif key == ord('s') and last_frame is not None:
                    self.save_frame(last_frame)
                elif key == ord(' '):
                    self.paused = not self.paused
                    print('Paused' if self.paused else 'Resumed')

        except KeyboardInterrupt:
            print("\nInterrupted")
        finally:
            self.cleanup()

    def cleanup(self):
        """Clean up resources"""
        cv2.destroyAllWindows()
        self.connector.disconnect()
        print("Visualizer closed.")


def main():
    parser = argparse.ArgumentParser(description="Real-time visualization of AUSM captured frames")
    parser.add_argument('--shm-name', '-n', default=DEFAULT_SHM_NAME, help='Shared memory name')
    parser.add_argument('--display', '-d', help='Initial display (e.g., display-1)')
    parser.add_argument('--scale', '-s', type=float, default=1.0, help='Scale factor')
    parser.add_argument('--save-dir', default=None,
                        help=f'Directory for frames saved with "s" (default: {default_save_dir()})')
    args = parser.parse_args()
    if args.scale <= 0:
        parser.error("--scale must be > 0")

    visualizer = Visualizer(args.shm_name, save_dir=args.save_dir)
    visualizer.scale_factor = args.scale
    visualizer.run(args.display)


if __name__ == "__main__":
    main()
