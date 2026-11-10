"""
Screen Stream Reader

Python client for connecting to the AUSM screen-stream module.

This package provides:
- ScreenStreamConnector: High-level API for reading frames and controlling the producer
- CommandClient: Low-level API for sending commands to the producer
- Frame, DisplayInfo, EventType: Data structures

Quick Start:
    from screen_stream_reader import ScreenStreamConnector, EventType

    connector = ScreenStreamConnector()
    connector.connect()
    
    # Control the producer
    connector.set_display_fps("display-1", 30)
    
    # Read frames
    while True:
        for event in connector.poll_events():
            print(f"Event: {event.type}")
        
        frame = connector.read_frame()
        if frame:
            # frame.bgr is a numpy array for OpenCV
            process(frame.bgr)
    
    connector.disconnect()
"""

__version__ = "0.1.0"

from .connector import (
    # Main classes
    ScreenStreamConnector,
    CommandClient,
    
    # Data structures
    Frame,
    DisplayInfo,
    EventType,
    StreamEvent,
    
    # Helper function
    create_connector,
    
    # Constants
    DEFAULT_SHM_NAME,
    DEFAULT_COMMAND_SOCKET,
    DEFAULT_NOTIFY_SOCKET,
)

__all__ = [
    "ScreenStreamConnector",
    "CommandClient",
    "Frame",
    "DisplayInfo",
    "EventType",
    "StreamEvent",
    "create_connector",
    "DEFAULT_SHM_NAME",
    "DEFAULT_COMMAND_SOCKET",
    "DEFAULT_NOTIFY_SOCKET",
]
