"""
Screen Visualizer

Real-time visualization of frames from the screen-stream module.

Usage:
    python -m screen_visualizer [--shm-name /ausm-frames] [--display DISPLAY_ID]

Or programmatically:
    from screen_visualizer import Visualizer
    
    visualizer = Visualizer()
    visualizer.run()
"""

__version__ = "0.1.0"

from .visualizer import Visualizer, main

__all__ = ["Visualizer", "main"]
