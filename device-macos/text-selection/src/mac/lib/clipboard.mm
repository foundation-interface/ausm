/**
 * Clipboard utility functions for selection monitor on macOS
 */

#import "clipboard.h"

/**
 * Reads text from clipboard
 * @param content [out] The string to store clipboard content
 * @return true if successful, false otherwise
 */
bool ReadClipboard(std::string &content)
{
    content.clear();

    @autoreleasepool
    {
        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        NSString *string = [pasteboard stringForType:NSPasteboardTypeString];
        // UTF8String returns NULL for strings that cannot be converted
        // (e.g. lone surrogates); constructing std::string from NULL crashes.
        const char *utf8 = string != nil ? [string UTF8String] : nullptr;

        if (utf8)
        {
            content = std::string(utf8);
            return true;
        }

        return false;
    }
}

/**
 * Writes text to clipboard
 * @param content The string to write to clipboard
 * @return true if successful, false otherwise
 */
bool WriteClipboard(const std::string &content)
{
    if (content.empty())
        return false;

    @autoreleasepool
    {
        NSString *contentString = [NSString stringWithUTF8String:content.c_str()];
        if (contentString == nil)
            return false; // invalid UTF-8; leave the clipboard untouched

        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        // have to clearContents first.
        [pasteboard clearContents];

        BOOL success = [pasteboard setString:contentString forType:NSPasteboardTypeString];

        return success == YES;
    }
}

/**
 * Gets the current change count of clipboard
 * @return The change count of NSPasteboard
 *
 * Cost: ~2 us
 */
int64_t GetClipboardSequence()
{
    @autoreleasepool
    {
        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        return static_cast<int64_t>([pasteboard changeCount]);
    }
}
