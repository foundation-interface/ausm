/**
 * Clipboard utility functions for selection monitor on macOS
 * 
 * Provides functions to read/write clipboard content and track changes.
 */

#pragma once

#import <Cocoa/Cocoa.h>
#import <string>

/**
 * Reads text from clipboard
 * @param content [out] The string to store clipboard content
 * @return true if successful, false otherwise
 */
bool ReadClipboard(std::string &content);

/**
 * Writes text to clipboard
 * @param content The string to write to clipboard
 * @return true if successful, false otherwise
 */
bool WriteClipboard(const std::string &content);

/**
 * Gets the current change count of clipboard
 * @return The change count of NSPasteboard
 */
int64_t GetClipboardSequence();

/**
 * Deep-copies every item on the general pasteboard (all types -> data), so a
 * synthetic Cmd+C can be undone without losing images, files or rich text.
 * @return The copied items (empty array if the pasteboard was empty)
 */
NSArray<NSPasteboardItem *> *SnapshotClipboard();

/**
 * Replaces the general pasteboard with a snapshot from SnapshotClipboard()
 * (an empty snapshot leaves the pasteboard empty).
 * @return true if successful, false otherwise
 */
bool RestoreClipboard(NSArray<NSPasteboardItem *> *snapshot);
