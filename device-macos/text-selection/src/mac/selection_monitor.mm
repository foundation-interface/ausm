/**
 * Selection Monitor for macOS
 *
 * A Node Native Module that captures text selection events across applications
 * on macOS using Accessibility APIs (AX API).
 *
 * Main components:
 * - SelectionMonitor class: Core implementation of the module
 * - Text selection detection: Uses Accessibility API
 * - Event monitoring: Mac event system for input monitoring
 * - Thread management: Background threads for hooks with thread-safe callbacks
 *
 * Features:
 * - Detect text selections via mouse drag, double-click, or keyboard
 * - Get selection coordinates and text content
 * - Monitor mouse and keyboard events
 * - Integration with Node.js via N-API
 *
 * Threading model:
 * - A dedicated event thread owns a CFRunLoop with two listen-only CGEventTaps
 *   (mouse, keyboard). Tap callbacks only copy a few scalars and hand them to
 *   the JS thread through Napi::ThreadSafeFunction (non-blocking; events are
 *   dropped if the queue is full).
 * - Selection detection (AX queries, optional clipboard fallback) runs on the
 *   JS thread when a mouse-up is processed. A process-wide AX messaging
 *   timeout (AX_MESSAGING_TIMEOUT_SEC) bounds how long an unresponsive app
 *   can block it.
 * - Every entry point that touches Cocoa runs inside an @autoreleasepool,
 *   since plain Node has no AppKit run loop to drain autoreleased objects.
 *
 * Based on selection-hook by 0xfullex (https://github.com/0xfullex/selection-hook)
 * Adapted for AUSM project
 */

#import <napi.h>

#import <algorithm>
#import <atomic>
#import <chrono>
#import <cmath>
#import <string>
#import <thread>
#import <vector>

#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <Cocoa/Cocoa.h>

#import "lib/clipboard.h"
#import "lib/keyboard.h"
#import "lib/utils.h"

// Mouse&Keyboard hook constants
constexpr int DEFAULT_MOUSE_EVENT_QUEUE_SIZE = 512;
constexpr int DEFAULT_KEYBOARD_EVENT_QUEUE_SIZE = 128;

// Mouse interaction constants
constexpr int MIN_DRAG_DISTANCE = 8;
constexpr uint64_t MAX_DRAG_TIME_MS = 15000;
constexpr int DOUBLE_CLICK_MAX_DISTANCE = 3;
static uint64_t DOUBLE_CLICK_TIME_MS = 500;

// Upper bound (seconds) for a single AX request to another process. The
// macOS default is ~6 s, which would freeze the Node event loop whenever the
// frontmost app is hung. Applied process-wide via the system-wide element.
constexpr float AX_MESSAGING_TIMEOUT_SEC = 1.0f;

// How often the event thread wakes to check for a stop request.
constexpr CFTimeInterval EVENT_LOOP_SLICE_SEC = 0.25;

static void EnsureAXMessagingTimeout()
{
    static std::atomic<bool> applied{false};
    if (applied.exchange(true))
        return;
    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    if (systemWide)
    {
        AXUIElementSetMessagingTimeout(systemWide, AX_MESSAGING_TIMEOUT_SEC);
        CFRelease(systemWide);
    }
}

/**
 * True if the rect lies (at least partly) on an active display. Used to
 * reject garbage AX geometry while still accepting displays arranged left of
 * or above the primary one (negative global coordinates).
 */
static bool IsRectOnAnyDisplay(CGRect rect)
{
    uint32_t count = 0;
    if (CGGetActiveDisplayList(0, nullptr, &count) != kCGErrorSuccess || count == 0)
        return true; // cannot tell; don't drop the data
    std::vector<CGDirectDisplayID> ids(count);
    if (CGGetActiveDisplayList(count, ids.data(), &count) != kCGErrorSuccess)
        return true;
    for (uint32_t i = 0; i < count; i++)
    {
        if (CGRectIntersectsRect(CGDisplayBounds(ids[i]), rect))
            return true;
    }
    return false;
}

// Text selection detection type enum
enum class SelectionDetectType
{
    None = 0,
    Drag = 1,
    DoubleClick = 2,
    ShiftClick = 3
};

// Text selection method enum
enum class SelectionMethod
{
    None = 0,
    AXAPI = 11,
    Clipboard = 99
};

/**
 * Position level enum for text selection tracking
 */
enum class SelectionPositionLevel
{
    None = 0,         // No position information available
    MouseSingle = 1,  // Only current mouse cursor position is known
    MouseDual = 2,    // Mouse start and end positions are known
    Full = 3,         // selection first paragraph's start and last paragraph's end coordinates are known
    Detailed = 4      // Detailed selection coordinates including all needed corner points
};

// Mouse button enum
enum class MouseButton
{
    None = -1,
    Unknown = 99,
    Left = 0,
    Middle = 1,
    Right = 2,
    Back = 3,
    Forward = 4,
    WheelVertical = 0,
    WheelHorizontal = 1
};

enum class FilterMode
{
    Default = 0,
    IncludeList = 1,
    ExcludeList = 2
};

/**
 * Structure to store text selection information
 */
struct TextSelectionInfo
{
    std::string text;
    std::string programName;      ///< Bundle identifier (e.g., "com.apple.Safari")
    std::string localizedName;    ///< Human-readable name (e.g., "Safari")

    CGPoint startTop;
    CGPoint startBottom;
    CGPoint endTop;
    CGPoint endBottom;

    CGPoint mousePosStart;
    CGPoint mousePosEnd;

    CGRect elementBounds;         ///< Screen bounds of the UI element containing the selection
    bool hasElementBounds;        ///< Whether elementBounds is valid

    SelectionMethod method;
    SelectionPositionLevel posLevel;
    SelectionDetectType detectType;

    bool isFullscreen;

    TextSelectionInfo()
        : hasElementBounds(false), method(SelectionMethod::None), posLevel(SelectionPositionLevel::None),
          detectType(SelectionDetectType::None), isFullscreen(false)
    {
        startTop = CGPointZero;
        startBottom = CGPointZero;
        endTop = CGPointZero;
        endBottom = CGPointZero;
        mousePosStart = CGPointZero;
        mousePosEnd = CGPointZero;
        elementBounds = CGRectZero;
    }

    void clear()
    {
        text.clear();
        programName.clear();
        localizedName.clear();
        startTop = CGPointZero;
        startBottom = CGPointZero;
        endTop = CGPointZero;
        endBottom = CGPointZero;
        mousePosStart = CGPointZero;
        mousePosEnd = CGPointZero;
        elementBounds = CGRectZero;
        hasElementBounds = false;
        method = SelectionMethod::None;
        posLevel = SelectionPositionLevel::None;
        detectType = SelectionDetectType::None;
        isFullscreen = false;
    }
};

/**
 * Structure to store mouse event information
 */
struct MouseEventContext
{
    CGEventType type;
    CGPoint pos;
    int64_t button;
    int64_t flag;
};

/**
 * Structure to store keyboard event information
 */
struct KeyboardEventContext
{
    CGEventType event;
    CGKeyCode keyCode;
    CGEventFlags flags;
};

//=============================================================================
// SelectionMonitor Class Declaration
//=============================================================================
class SelectionMonitor : public Napi::ObjectWrap<SelectionMonitor>
{
  public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    SelectionMonitor(const Napi::CallbackInfo &info);
    ~SelectionMonitor();

  private:
    // Node.js interface methods
    void Start(const Napi::CallbackInfo &info);
    void Stop(const Napi::CallbackInfo &info);
    void EnableMouseMoveEvent(const Napi::CallbackInfo &info);
    void DisableMouseMoveEvent(const Napi::CallbackInfo &info);
    void EnableClipboard(const Napi::CallbackInfo &info);
    void DisableClipboard(const Napi::CallbackInfo &info);
    void SetClipboardMode(const Napi::CallbackInfo &info);
    void SetGlobalFilterMode(const Napi::CallbackInfo &info);
    void SetSelectionPassiveMode(const Napi::CallbackInfo &info);
    Napi::Value GetCurrentSelection(const Napi::CallbackInfo &info);
    Napi::Value WriteToClipboard(const Napi::CallbackInfo &info);
    Napi::Value ReadFromClipboard(const Napi::CallbackInfo &info);
    Napi::Value IsProcessTrusted(const Napi::CallbackInfo &info);
    Napi::Value RequestProcessTrust(const Napi::CallbackInfo &info);
    Napi::Object CreateSelectionResultObject(Napi::Env env, const TextSelectionInfo &selectionInfo);

    // Core functionality methods
    bool GetSelectedText(NSRunningApplication *frontApp, TextSelectionInfo &selectionInfo);
    bool GetTextViaAXAPI(NSRunningApplication *frontApp, TextSelectionInfo &selectionInfo);
    bool GetTextViaClipboard(NSRunningApplication *frontApp, TextSelectionInfo &selectionInfo);
    bool ShouldProcessViaClipboard(const std::string &programName);
    bool GetSelectedTextFromElement(AXUIElementRef element, std::string &text);
    bool SetTextRangeCoordinates(AXUIElementRef element, TextSelectionInfo &selectionInfo);
    bool GetElementBounds(AXUIElementRef element, TextSelectionInfo &selectionInfo);

    bool IsInFilterList(const std::string &programName, const std::vector<std::string> &filterList);
    bool SendCopyKey(pid_t pid = 0);

    // Mouse and keyboard event handling methods
    void StartMouseKeyboardEventThread();
    void StopMouseKeyboardEventThread();
    void MouseKeyboardEventThreadProc();

    static CGEventRef MouseEventCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon);
    static CGEventRef KeyboardEventCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon);
    static void ProcessMouseEvent(Napi::Env env, Napi::Function function, MouseEventContext *mouseEvent);
    static void ProcessKeyboardEvent(Napi::Env env, Napi::Function function, KeyboardEventContext *keyboardEvent);
    static void ReenableTapIfNeeded(SelectionMonitor *monitor, CGEventType type);

    // Stop the event thread and release the thread-safe functions.
    void StopInternal();
    static void EnvCleanupHook(void *arg);
    napi_env cleanup_env = nullptr;

    // Thread communication
    Napi::ThreadSafeFunction tsfn;
    Napi::ThreadSafeFunction mouse_tsfn;
    Napi::ThreadSafeFunction keyboard_tsfn;

    std::atomic<bool> running{false};
    std::atomic<bool> mouse_keyboard_running{false};
    pid_t running_pid = 0;

    std::atomic<CFRunLoopRef> eventRunLoop{nullptr};

    CFMachPortRef mouseEventTap = nullptr;
    CFMachPortRef keyboardEventTap = nullptr;
    CFRunLoopSourceRef mouseRunLoopSource = nullptr;
    CFRunLoopSourceRef keyboardRunLoopSource = nullptr;

    std::thread event_thread;

    bool is_triggered_by_user = false;
    bool is_enabled_mouse_move_event = false;
    bool is_selection_passive_mode = false;
    bool is_enabled_clipboard = true;
    int64_t clipboard_sequence = 0;

    FilterMode clipboard_filter_mode = FilterMode::Default;
    std::vector<std::string> clipboard_filter_list;

    FilterMode global_filter_mode = FilterMode::Default;
    std::vector<std::string> global_filter_list;

    std::atomic<bool> is_processing{false};
};

// The most recently constructed instance. Used by the JS-thread side of the
// thread-safe-function callbacks; always null-checked because queued calls
// can still be delivered after the instance was destroyed.
static SelectionMonitor *currentInstance = nullptr;

// RAII helper: clears an atomic flag on scope exit.
struct AtomicFlagGuard
{
    std::atomic<bool> &flag;
    explicit AtomicFlagGuard(std::atomic<bool> &f) : flag(f) {}
    ~AtomicFlagGuard() { flag.store(false); }
};

/**
 * Constructor
 */
SelectionMonitor::SelectionMonitor(const Napi::CallbackInfo &info) : Napi::ObjectWrap<SelectionMonitor>(info)
{
    Napi::Env env = info.Env();
    Napi::HandleScope scope(env);

    running_pid = getpid();
    currentInstance = this;
}

/**
 * Destructor
 */
SelectionMonitor::~SelectionMonitor()
{
    StopInternal();

    if (currentInstance == this)
    {
        currentInstance = nullptr;
    }
}

/**
 * Stop the event thread (joins it) and release all thread-safe functions.
 * Idempotent; safe to call from Stop(), the destructor, or env teardown.
 */
void SelectionMonitor::StopInternal()
{
    running = false;
    mouse_keyboard_running = false;

    StopMouseKeyboardEventThread();

    if (tsfn)
    {
        tsfn.Release();
        tsfn = nullptr;
    }
    if (mouse_tsfn)
    {
        mouse_tsfn.Release();
        mouse_tsfn = nullptr;
    }
    if (keyboard_tsfn)
    {
        keyboard_tsfn.Release();
        keyboard_tsfn = nullptr;
    }

    if (cleanup_env)
    {
        napi_remove_env_cleanup_hook(cleanup_env, EnvCleanupHook, this);
        cleanup_env = nullptr;
    }
}

/**
 * Called when the Node environment (main thread, worker thread, or Electron
 * renderer) is torn down while the monitor is still running, so the event
 * thread never outlives the environment it posts into.
 */
void SelectionMonitor::EnvCleanupHook(void *arg)
{
    SelectionMonitor *self = static_cast<SelectionMonitor *>(arg);
    self->cleanup_env = nullptr; // hook is being consumed; don't remove it
    self->StopInternal();
}

/**
 * NAPI: Initialize and export the class to JavaScript
 */
Napi::Object SelectionMonitor::Init(Napi::Env env, Napi::Object exports)
{
    Napi::HandleScope scope(env);

    Napi::Function func =
        DefineClass(env, "SelectionMonitor",
                    {InstanceMethod("start", &SelectionMonitor::Start),
                     InstanceMethod("stop", &SelectionMonitor::Stop),
                     InstanceMethod("enableMouseMoveEvent", &SelectionMonitor::EnableMouseMoveEvent),
                     InstanceMethod("disableMouseMoveEvent", &SelectionMonitor::DisableMouseMoveEvent),
                     InstanceMethod("enableClipboard", &SelectionMonitor::EnableClipboard),
                     InstanceMethod("disableClipboard", &SelectionMonitor::DisableClipboard),
                     InstanceMethod("setClipboardMode", &SelectionMonitor::SetClipboardMode),
                     InstanceMethod("setGlobalFilterMode", &SelectionMonitor::SetGlobalFilterMode),
                     InstanceMethod("setSelectionPassiveMode", &SelectionMonitor::SetSelectionPassiveMode),
                     InstanceMethod("getCurrentSelection", &SelectionMonitor::GetCurrentSelection),
                     InstanceMethod("writeToClipboard", &SelectionMonitor::WriteToClipboard),
                     InstanceMethod("readFromClipboard", &SelectionMonitor::ReadFromClipboard),
                     InstanceMethod("isProcessTrusted", &SelectionMonitor::IsProcessTrusted),
                     InstanceMethod("requestProcessTrust", &SelectionMonitor::RequestProcessTrust)});

    exports.Set("SelectionMonitor", func);
    return exports;
}

/**
 * NAPI: Start monitoring text selections
 */
void SelectionMonitor::Start(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0u].IsFunction())
    {
        Napi::TypeError::New(env, "Function expected as first argument").ThrowAsJavaScriptException();
        return;
    }

    if (running || mouse_keyboard_running || event_thread.joinable())
    {
        Napi::Error::New(env, "Selection monitor is already running").ThrowAsJavaScriptException();
        return;
    }

    try
    {
        EnsureAXMessagingTimeout();

        Napi::Function callback = info[0u].As<Napi::Function>();

        // Finalizers intentionally do not capture `this`: they may run after
        // the instance is destroyed. Stop()/the destructor reset the flags.
        tsfn = Napi::ThreadSafeFunction::New(env, callback, "SelectionCallback", 0, 1);

        mouse_tsfn = Napi::ThreadSafeFunction::New(env, callback, "MouseEventCallback", DEFAULT_MOUSE_EVENT_QUEUE_SIZE, 1);

        keyboard_tsfn = Napi::ThreadSafeFunction::New(env, callback, "KeyboardEventCallback", DEFAULT_KEYBOARD_EVENT_QUEUE_SIZE, 1);

        mouse_keyboard_running = true;
        running = true;
        is_enabled_mouse_move_event = false;

        if (napi_add_env_cleanup_hook(env, EnvCleanupHook, this) == napi_ok)
        {
            cleanup_env = env;
        }

        StartMouseKeyboardEventThread();
    }
    catch (const std::exception &e)
    {
        running = false;
        mouse_keyboard_running = false;

        if (tsfn)
        {
            tsfn.Release();
        }
        if (mouse_tsfn)
        {
            mouse_tsfn.Release();
        }
        if (keyboard_tsfn)
        {
            keyboard_tsfn.Release();
        }

        Napi::Error::New(env, std::string("Failed to start selection monitor: ") + e.what())
            .ThrowAsJavaScriptException();
        return;
    }
}

/**
 * NAPI: Stop monitoring
 */
void SelectionMonitor::Stop(const Napi::CallbackInfo &info)
{
    if (!running && !mouse_keyboard_running && !event_thread.joinable() && !tsfn)
    {
        return;
    }

    StopInternal();
}

void SelectionMonitor::EnableMouseMoveEvent(const Napi::CallbackInfo &info)
{
    is_enabled_mouse_move_event = true;
}

void SelectionMonitor::DisableMouseMoveEvent(const Napi::CallbackInfo &info)
{
    is_enabled_mouse_move_event = false;
}

void SelectionMonitor::EnableClipboard(const Napi::CallbackInfo &info)
{
    is_enabled_clipboard = true;
}

void SelectionMonitor::DisableClipboard(const Napi::CallbackInfo &info)
{
    is_enabled_clipboard = false;
}

void SelectionMonitor::SetClipboardMode(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0u].IsNumber() || !info[1u].IsArray())
    {
        Napi::TypeError::New(env, "Number and Array expected as arguments").ThrowAsJavaScriptException();
        return;
    }

    int mode = info[0u].As<Napi::Number>().Int32Value();
    clipboard_filter_mode = static_cast<FilterMode>(mode);

    Napi::Array includeArray = info[1u].As<Napi::Array>();
    uint32_t length = includeArray.Length();

    clipboard_filter_list.clear();

    for (uint32_t i = 0; i < length; i++)
    {
        Napi::Value value = includeArray.Get(i);
        if (value.IsString())
        {
            std::string programName = value.As<Napi::String>().Utf8Value();
            std::transform(programName.begin(), programName.end(), programName.begin(),
                           [](unsigned char c) { return std::tolower(c); });
            clipboard_filter_list.push_back(programName);
        }
    }
}

void SelectionMonitor::SetGlobalFilterMode(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0u].IsNumber() || !info[1u].IsArray())
    {
        Napi::TypeError::New(env, "Number and Array expected as arguments").ThrowAsJavaScriptException();
        return;
    }

    int mode = info[0u].As<Napi::Number>().Int32Value();
    global_filter_mode = static_cast<FilterMode>(mode);

    Napi::Array includeArray = info[1u].As<Napi::Array>();
    uint32_t length = includeArray.Length();

    global_filter_list.clear();

    for (uint32_t i = 0; i < length; i++)
    {
        Napi::Value value = includeArray.Get(i);
        if (value.IsString())
        {
            std::string programName = value.As<Napi::String>().Utf8Value();
            std::transform(programName.begin(), programName.end(), programName.begin(),
                           [](unsigned char c) { return std::tolower(c); });
            global_filter_list.push_back(programName);
        }
    }
}

void SelectionMonitor::SetSelectionPassiveMode(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0u].IsBoolean())
    {
        Napi::TypeError::New(env, "Boolean expected as argument").ThrowAsJavaScriptException();
        return;
    }

    is_selection_passive_mode = info[0u].As<Napi::Boolean>().Value();
}

Napi::Value SelectionMonitor::WriteToClipboard(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString())
    {
        Napi::TypeError::New(env, "String expected as argument").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    try
    {
        std::string utf8Text = info[0].As<Napi::String>().Utf8Value();
        bool result = WriteClipboard(utf8Text);
        return Napi::Boolean::New(env, result);
    }
    catch (const std::exception &e)
    {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
}

Napi::Value SelectionMonitor::ReadFromClipboard(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    try
    {
        std::string clipboardContent;
        bool result = ReadClipboard(clipboardContent);

        if (!result)
        {
            return env.Null();
        }

        return Napi::String::New(env, clipboardContent);
    }
    catch (const std::exception &e)
    {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

Napi::Value SelectionMonitor::IsProcessTrusted(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    try
    {
        bool isTrusted = AXIsProcessTrusted();
        return Napi::Boolean::New(env, isTrusted);
    }
    catch (const std::exception &e)
    {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
}

Napi::Value SelectionMonitor::RequestProcessTrust(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    try
    {
        CFDictionaryRef options = CFDictionaryCreate(kCFAllocatorDefault, (const void **)&kAXTrustedCheckOptionPrompt,
                                                     (const void **)&kCFBooleanTrue, 1, &kCFTypeDictionaryKeyCallBacks,
                                                     &kCFTypeDictionaryValueCallBacks);
        bool isTrusted = AXIsProcessTrustedWithOptions(options);
        CFRelease(options);

        return Napi::Boolean::New(env, isTrusted);
    }
    catch (const std::exception &e)
    {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
}

bool SelectionMonitor::IsInFilterList(const std::string &programName, const std::vector<std::string> &filterList)
{
    if (filterList.empty())
        return false;

    std::string lowerProgramName = programName;
    std::transform(lowerProgramName.begin(), lowerProgramName.end(), lowerProgramName.begin(), ::tolower);

    for (const auto &filterItem : filterList)
    {
        if (lowerProgramName.find(filterItem) != std::string::npos)
        {
            return true;
        }
    }

    return false;
}

Napi::Value SelectionMonitor::GetCurrentSelection(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    EnsureAXMessagingTimeout();

    @autoreleasepool
    {
    try
    {
        NSRunningApplication *frontApp = GetFrontApp();
        if (!frontApp)
        {
            return env.Null();
        }

        TextSelectionInfo selectionInfo;
        is_triggered_by_user = true;
        if (!GetSelectedText(frontApp, selectionInfo) || IsTrimmedEmpty(selectionInfo.text))
        {
            is_triggered_by_user = false;
            return env.Null();
        }

        is_triggered_by_user = false;

        return CreateSelectionResultObject(env, selectionInfo);
    }
    catch (const std::exception &e)
    {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        is_triggered_by_user = false;
        return env.Null();
    }
    }
}

bool SelectionMonitor::GetSelectedText(NSRunningApplication *frontApp, TextSelectionInfo &selectionInfo)
{
    if (!frontApp)
        return false;

    // Re-entrancy guard (e.g. getCurrentSelection() racing a mouse-up).
    // The guard object clears the flag on every return path.
    bool expected = false;
    if (!is_processing.compare_exchange_strong(expected, true))
        return false;
    AtomicFlagGuard processingGuard(is_processing);

    selectionInfo.clear();

    if (!GetProgramNameFromFrontApp(frontApp, selectionInfo.programName))
    {
        return false;
    }

    // Get localized (human-readable) name
    GetLocalizedNameFromFrontApp(frontApp, selectionInfo.localizedName);
    
    if (global_filter_mode != FilterMode::Default)
    {
        bool isIn = IsInFilterList(selectionInfo.programName, global_filter_list);

        if ((global_filter_mode == FilterMode::IncludeList && !isIn) ||
            (global_filter_mode == FilterMode::ExcludeList && isIn))
        {
            return false;
        }
    }

    bool result = false;
    if (GetTextViaAXAPI(frontApp, selectionInfo))
    {
        selectionInfo.method = SelectionMethod::AXAPI;
        result = true;
    }

    if (!result && ShouldProcessViaClipboard(selectionInfo.programName) && GetTextViaClipboard(frontApp, selectionInfo))
    {
        selectionInfo.method = SelectionMethod::Clipboard;
        result = true;
    }

    if (result)
        selectionInfo.isFullscreen = IsWindowFullscreen(frontApp);

    return result;
}

bool SelectionMonitor::GetTextViaAXAPI(NSRunningApplication *frontApp, TextSelectionInfo &selectionInfo)
{
    if (!frontApp)
    {
        return false;
    }

    AXUIElementRef appElement = GetAppElementFromFrontApp(frontApp);
    if (!appElement)
    {
        return false;
    }
    AXUIElementRef focusedElement = GetFocusedElementFromAppElement(appElement);

    if (!focusedElement)
    {
        focusedElement = GetFrontWindowElementFromAppElement(appElement);

        if (!focusedElement)
        {
            CFRelease(appElement);
            return false;
        }
    }

    bool result = false;

    std::string selectedText;
    if (GetSelectedTextFromElement(focusedElement, selectedText))
    {
        if (!selectedText.empty() && !IsTrimmedEmpty(selectedText))
        {
            selectionInfo.text = selectedText;

            if (!SetTextRangeCoordinates(focusedElement, selectionInfo))
            {
                selectionInfo.posLevel = SelectionPositionLevel::None;
            }
            
            // Get element bounds (position and size of the UI element)
            GetElementBounds(focusedElement, selectionInfo);

            result = true;
        }
    }

    if (!result)
    {
        CFArrayRef children = nullptr;
        AXError error = AXUIElementCopyAttributeValue(focusedElement, kAXChildrenAttribute, (CFTypeRef *)&children);

        if (error == kAXErrorSuccess && children)
        {
            CFIndex childCount = CFArrayGetCount(children);

            for (CFIndex i = 0; i < childCount && !result; i++)
            {
                AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, i);
                if (child)
                {
                    std::string childText;
                    if (GetSelectedTextFromElement(child, childText))
                    {
                        if (!childText.empty() && !IsTrimmedEmpty(childText))
                        {
                            selectionInfo.text = childText;

                            if (!SetTextRangeCoordinates(child, selectionInfo))
                            {
                                selectionInfo.posLevel = SelectionPositionLevel::None;
                            }
                            
                            // Get element bounds from child
                            GetElementBounds(child, selectionInfo);

                            result = true;
                        }
                    }
                }
            }

            CFRelease(children);
        }
    }

    if (!result)
    {
        AXUIElementSetAttributeValue(appElement, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
        AXUIElementSetAttributeValue(appElement, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
    }

    CFRelease(focusedElement);
    CFRelease(appElement);

    return result;
}

bool SelectionMonitor::GetTextViaClipboard(NSRunningApplication *frontApp, TextSelectionInfo &selectionInfo)
{
    if (frontApp.processIdentifier == running_pid)
        return false;

    int64_t newClipboardSequence = GetClipboardSequence();

    if (newClipboardSequence != clipboard_sequence)
    {
        std::string newContent;
        if (ReadClipboard(newContent))
        {
            selectionInfo.text = newContent;
            return true;
        }
    }

    clipboard_sequence = newClipboardSequence;
    std::string originalContent;
    bool hasOriginalContent = ReadClipboard(originalContent);

    if (!SendCopyKey(frontApp.processIdentifier))
        return false;

    bool clipboardChanged = false;
    for (int i = 0; i < 10; i++)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));

        newClipboardSequence = GetClipboardSequence();
        if (newClipboardSequence != clipboard_sequence)
        {
            clipboardChanged = true;
            break;
        }
    }

    if (!clipboardChanged)
        return false;

    std::string newContent;
    if (!ReadClipboard(newContent) || IsTrimmedEmpty(newContent))
    {
        if (hasOriginalContent)
        {
            WriteClipboard(originalContent);
        }

        return false;
    }

    selectionInfo.text = newContent;

    if (hasOriginalContent && originalContent != newContent)
    {
        WriteClipboard(originalContent);
    }

    return true;
}

bool SelectionMonitor::ShouldProcessViaClipboard(const std::string &programName)
{
    if (!is_enabled_clipboard)
        return false;

    bool result = false;
    switch (clipboard_filter_mode)
    {
        case FilterMode::Default:
            result = true;
            break;
        case FilterMode::IncludeList:
            result = IsInFilterList(programName, clipboard_filter_list);
            break;
        case FilterMode::ExcludeList:
            result = !IsInFilterList(programName, clipboard_filter_list);
            break;
    }

    if (!result)
        return false;

    return true;
}

bool SelectionMonitor::SendCopyKey(pid_t pid)
{
    CGEventRef keyDownEvent = CGEventCreateKeyboardEvent(nullptr, kVK_ANSI_C, true);
    if (!keyDownEvent)
    {
        return false;
    }

    CGEventSetFlags(keyDownEvent, kCGEventFlagMaskCommand);

    CGEventRef keyUpEvent = CGEventCreateKeyboardEvent(nullptr, kVK_ANSI_C, false);
    if (!keyUpEvent)
    {
        CFRelease(keyDownEvent);
        return false;
    }

    CGEventSetFlags(keyUpEvent, kCGEventFlagMaskCommand);

    if (pid != 0)
    {
        CGEventPostToPid(pid, keyDownEvent);
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        CGEventPostToPid(pid, keyUpEvent);
    }
    else
    {
        CGEventPost(kCGHIDEventTap, keyDownEvent);
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        CGEventPost(kCGHIDEventTap, keyUpEvent);
    }

    CFRelease(keyDownEvent);
    CFRelease(keyUpEvent);

    return true;
}

bool SelectionMonitor::GetSelectedTextFromElement(AXUIElementRef element, std::string &text)
{
    if (!element)
    {
        return false;
    }

    CFTypeRef selectedTextRef = nullptr;
    AXError error = AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute, &selectedTextRef);

    if (error == kAXErrorSuccess && selectedTextRef)
    {
        CFTypeID typeID = CFGetTypeID(selectedTextRef);

        if (typeID == CFStringGetTypeID())
        {
            CFStringRef selectedText = (CFStringRef)selectedTextRef;
            CFIndex length = CFStringGetLength(selectedText);
            if (length > 0)
            {
                CFIndex maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
                char *buffer = new char[maxSize];

                if (CFStringGetCString(selectedText, buffer, maxSize, kCFStringEncodingUTF8))
                {
                    text = std::string(buffer);
                    delete[] buffer;
                    CFRelease(selectedTextRef);
                    return !text.empty();
                }

                delete[] buffer;
            }
        }
        else if (typeID == CFNumberGetTypeID())
        {
            CFNumberRef number = (CFNumberRef)selectedTextRef;

            if (CFNumberIsFloatType(number))
            {
                double doubleValue;
                if (CFNumberGetValue(number, kCFNumberDoubleType, &doubleValue))
                {
                    text = std::to_string(doubleValue);
                    CFRelease(selectedTextRef);
                    return !text.empty();
                }
            }
            else
            {
                long longValue;
                if (CFNumberGetValue(number, kCFNumberLongType, &longValue))
                {
                    text = std::to_string(longValue);
                    CFRelease(selectedTextRef);
                    return !text.empty();
                }
            }
        }
        CFRelease(selectedTextRef);
    }

    CFTypeRef valueRef = nullptr;
    error = AXUIElementCopyAttributeValue(element, kAXValueAttribute, &valueRef);

    if (error == kAXErrorSuccess && valueRef)
    {
        CFTypeID valueTypeID = CFGetTypeID(valueRef);

        if (valueTypeID == CFStringGetTypeID())
        {
            CFStringRef value = (CFStringRef)valueRef;
            CFRange selectedRange = {0, 0};
            AXValueRef rangeValue = nullptr;
            error = AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute, (CFTypeRef *)&rangeValue);

            if (error == kAXErrorSuccess && rangeValue)
            {
                if (AXValueGetValue(rangeValue, kAXValueTypeCFRange, &selectedRange))
                {
                    CFIndex valueLength = CFStringGetLength(value);

                    if (valueLength <= 0)
                    {
                        CFRelease(rangeValue);
                        CFRelease(valueRef);
                        return false;
                    }

                    if (selectedRange.location < 0)
                    {
                        selectedRange.location = 0;
                    }
                    else if (selectedRange.location >= valueLength)
                    {
                        selectedRange.location = valueLength - 1;
                    }

                    if (selectedRange.length <= 0)
                    {
                        CFRelease(rangeValue);
                        CFRelease(valueRef);
                        return false;
                    }

                    if (selectedRange.location + selectedRange.length > valueLength)
                    {
                        selectedRange.length = valueLength - selectedRange.location;
                    }

                    if (selectedRange.length <= 0)
                    {
                        CFRelease(rangeValue);
                        CFRelease(valueRef);
                        return false;
                    }

                    CFStringRef selectedSubstring =
                        CFStringCreateWithSubstring(kCFAllocatorDefault, value, selectedRange);
                    if (selectedSubstring)
                    {
                        CFIndex length = CFStringGetLength(selectedSubstring);
                        CFIndex maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
                        char *buffer = new char[maxSize];

                        if (CFStringGetCString(selectedSubstring, buffer, maxSize, kCFStringEncodingUTF8))
                        {
                            text = std::string(buffer);
                            delete[] buffer;
                            CFRelease(selectedSubstring);
                            CFRelease(rangeValue);
                            CFRelease(valueRef);
                            return !text.empty();
                        }

                        delete[] buffer;
                        CFRelease(selectedSubstring);
                    }
                }
                CFRelease(rangeValue);
            }

            CFRelease(valueRef);
        }
    }

    return false;
}

bool SelectionMonitor::SetTextRangeCoordinates(AXUIElementRef element, TextSelectionInfo &selectionInfo)
{
    if (!element)
        return false;

    AXValueRef selectedRangeValue = nullptr;

    AXError error =
        AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute, (CFTypeRef *)&selectedRangeValue);
    if (error == kAXErrorSuccess && selectedRangeValue)
    {
        CFRange selectedRange = {0, 0};
        if (AXValueGetValue(selectedRangeValue, kAXValueTypeCFRange, &selectedRange))
        {
            if (selectedRange.length > 0)
            {
                CFRange firstCharRange = {selectedRange.location, 1};
                CFRange lastCharRange = {selectedRange.location + selectedRange.length - 1, 1};

                AXValueRef firstCharRangeValue = AXValueCreate(kAXValueTypeCFRange, &firstCharRange);
                AXValueRef lastCharRangeValue = AXValueCreate(kAXValueTypeCFRange, &lastCharRange);

                if (firstCharRangeValue && lastCharRangeValue)
                {
                    AXValueRef firstCharBoundsValue = nullptr;
                    AXValueRef lastCharBoundsValue = nullptr;

                    AXError firstCharBoundsError = AXUIElementCopyParameterizedAttributeValue(
                        element, kAXBoundsForRangeParameterizedAttribute, firstCharRangeValue,
                        (CFTypeRef *)&firstCharBoundsValue);
                    AXError lastCharBoundsError = AXUIElementCopyParameterizedAttributeValue(
                        element, kAXBoundsForRangeParameterizedAttribute, lastCharRangeValue,
                        (CFTypeRef *)&lastCharBoundsValue);

                    if (firstCharBoundsError == kAXErrorSuccess && firstCharBoundsValue &&
                        lastCharBoundsError == kAXErrorSuccess && lastCharBoundsValue)
                    {
                        CGRect firstCharRect = CGRectZero;
                        CGRect lastCharRect = CGRectZero;

                        if (AXValueGetValue(firstCharBoundsValue, kAXValueTypeCGRect, &firstCharRect) &&
                            AXValueGetValue(lastCharBoundsValue, kAXValueTypeCGRect, &lastCharRect))
                        {
                            // Global coordinates can be negative on displays
                            // left of / above the primary, so validate against
                            // the actual display layout instead of x,y >= 0.
                            if (firstCharRect.size.width > 1.0 && firstCharRect.size.height > 0 &&
                                firstCharRect.size.height < 100.0 && lastCharRect.size.width > 1.0 &&
                                lastCharRect.size.height > 0 && lastCharRect.size.height < 100.0 &&
                                IsRectOnAnyDisplay(firstCharRect) && IsRectOnAnyDisplay(lastCharRect))
                            {
                                selectionInfo.startTop = CGPointMake(firstCharRect.origin.x, firstCharRect.origin.y);
                                selectionInfo.startBottom = CGPointMake(
                                    firstCharRect.origin.x, firstCharRect.origin.y + firstCharRect.size.height);
                                selectionInfo.endTop =
                                    CGPointMake(lastCharRect.origin.x + lastCharRect.size.width, lastCharRect.origin.y);
                                selectionInfo.endBottom = CGPointMake(lastCharRect.origin.x + lastCharRect.size.width,
                                                                      lastCharRect.origin.y + lastCharRect.size.height);

                                selectionInfo.posLevel = SelectionPositionLevel::Full;

                                CFRelease(firstCharBoundsValue);
                                CFRelease(lastCharBoundsValue);
                                CFRelease(firstCharRangeValue);
                                CFRelease(lastCharRangeValue);
                                CFRelease(selectedRangeValue);

                                return true;
                            }
                        }

                        if (firstCharBoundsValue)
                            CFRelease(firstCharBoundsValue);
                        if (lastCharBoundsValue)
                            CFRelease(lastCharBoundsValue);
                    }

                    if (firstCharRangeValue)
                        CFRelease(firstCharRangeValue);
                    if (lastCharRangeValue)
                        CFRelease(lastCharRangeValue);
                }
                else
                {
                    if (firstCharRangeValue)
                        CFRelease(firstCharRangeValue);
                    if (lastCharRangeValue)
                        CFRelease(lastCharRangeValue);
                }
            }
        }
        CFRelease(selectedRangeValue);
        selectedRangeValue = nullptr;
    }

    error = AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute, (CFTypeRef *)&selectedRangeValue);
    if (error == kAXErrorSuccess && selectedRangeValue)
    {
        CFRange selectedRange = {0, 0};
        if (AXValueGetValue(selectedRangeValue, kAXValueTypeCFRange, &selectedRange))
        {
            if (selectedRange.length > 0)
            {
                AXValueRef boundsValue = nullptr;
                error = AXUIElementCopyParameterizedAttributeValue(element, kAXBoundsForRangeParameterizedAttribute,
                                                                   selectedRangeValue, (CFTypeRef *)&boundsValue);
                if (error == kAXErrorSuccess && boundsValue)
                {
                    CGRect rect = CGRectZero;
                    if (AXValueGetValue(boundsValue, kAXValueTypeCGRect, &rect))
                    {
                        if (rect.size.width > 0 && rect.size.height > 0 && IsRectOnAnyDisplay(rect))
                        {
                            selectionInfo.startTop = CGPointMake(rect.origin.x, rect.origin.y);
                            selectionInfo.startBottom = CGPointMake(rect.origin.x, rect.origin.y + rect.size.height);
                            selectionInfo.endTop = CGPointMake(rect.origin.x + rect.size.width, rect.origin.y);
                            selectionInfo.endBottom =
                                CGPointMake(rect.origin.x + rect.size.width, rect.origin.y + rect.size.height);
                            selectionInfo.posLevel = SelectionPositionLevel::Full;

                            CFRelease(boundsValue);
                            CFRelease(selectedRangeValue);
                            return true;
                        }
                    }
                    CFRelease(boundsValue);
                }
            }
        }
        CFRelease(selectedRangeValue);
    }

    return false;
}

/**
 * Get the screen bounds of a UI element (position and size)
 */
bool SelectionMonitor::GetElementBounds(AXUIElementRef element, TextSelectionInfo &selectionInfo)
{
    if (!element)
        return false;

    // Get position
    CFTypeRef positionRef = nullptr;
    AXError posError = AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &positionRef);
    
    if (posError != kAXErrorSuccess || !positionRef)
    {
        return false;
    }

    CGPoint position = CGPointZero;
    if (!AXValueGetValue((AXValueRef)positionRef, kAXValueTypeCGPoint, &position))
    {
        CFRelease(positionRef);
        return false;
    }
    CFRelease(positionRef);

    // Get size
    CFTypeRef sizeRef = nullptr;
    AXError sizeError = AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &sizeRef);
    
    if (sizeError != kAXErrorSuccess || !sizeRef)
    {
        return false;
    }

    CGSize size = CGSizeZero;
    if (!AXValueGetValue((AXValueRef)sizeRef, kAXValueTypeCGSize, &size))
    {
        CFRelease(sizeRef);
        return false;
    }
    CFRelease(sizeRef);

    // Validate bounds (negative origins are valid on secondary displays)
    if (size.width <= 0 || size.height <= 0 || size.width > 20000 || size.height > 20000 ||
        !IsRectOnAnyDisplay(CGRectMake(position.x, position.y, size.width, size.height)))
    {
        return false;
    }

    selectionInfo.elementBounds = CGRectMake(position.x, position.y, size.width, size.height);
    selectionInfo.hasElementBounds = true;

    return true;
}

Napi::Object SelectionMonitor::CreateSelectionResultObject(Napi::Env env, const TextSelectionInfo &selectionInfo)
{
    Napi::Object resultObj = Napi::Object::New(env);

    resultObj.Set(Napi::String::New(env, "type"), Napi::String::New(env, "text-selection"));
    resultObj.Set(Napi::String::New(env, "text"), Napi::String::New(env, selectionInfo.text));
    resultObj.Set(Napi::String::New(env, "programName"), Napi::String::New(env, selectionInfo.programName));
    resultObj.Set(Napi::String::New(env, "localizedName"), Napi::String::New(env, selectionInfo.localizedName));
    resultObj.Set(Napi::String::New(env, "method"), Napi::Number::New(env, static_cast<int>(selectionInfo.method)));
    resultObj.Set(Napi::String::New(env, "posLevel"), Napi::Number::New(env, static_cast<int>(selectionInfo.posLevel)));
    resultObj.Set(Napi::String::New(env, "detectType"), Napi::Number::New(env, static_cast<int>(selectionInfo.detectType)));
    resultObj.Set(Napi::String::New(env, "isFullscreen"), Napi::Boolean::New(env, selectionInfo.isFullscreen));

    resultObj.Set(Napi::String::New(env, "startTopX"), Napi::Number::New(env, selectionInfo.startTop.x));
    resultObj.Set(Napi::String::New(env, "startTopY"), Napi::Number::New(env, selectionInfo.startTop.y));
    resultObj.Set(Napi::String::New(env, "endBottomX"), Napi::Number::New(env, selectionInfo.endBottom.x));
    resultObj.Set(Napi::String::New(env, "endBottomY"), Napi::Number::New(env, selectionInfo.endBottom.y));
    resultObj.Set(Napi::String::New(env, "startBottomX"), Napi::Number::New(env, selectionInfo.startBottom.x));
    resultObj.Set(Napi::String::New(env, "startBottomY"), Napi::Number::New(env, selectionInfo.startBottom.y));
    resultObj.Set(Napi::String::New(env, "endTopX"), Napi::Number::New(env, selectionInfo.endTop.x));
    resultObj.Set(Napi::String::New(env, "endTopY"), Napi::Number::New(env, selectionInfo.endTop.y));
    resultObj.Set(Napi::String::New(env, "mouseStartX"), Napi::Number::New(env, selectionInfo.mousePosStart.x));
    resultObj.Set(Napi::String::New(env, "mouseStartY"), Napi::Number::New(env, selectionInfo.mousePosStart.y));
    resultObj.Set(Napi::String::New(env, "mouseEndX"), Napi::Number::New(env, selectionInfo.mousePosEnd.x));
    resultObj.Set(Napi::String::New(env, "mouseEndY"), Napi::Number::New(env, selectionInfo.mousePosEnd.y));

    // Element bounds (position and size of the UI element)
    resultObj.Set(Napi::String::New(env, "hasElementBounds"), Napi::Boolean::New(env, selectionInfo.hasElementBounds));
    resultObj.Set(Napi::String::New(env, "elementX"), Napi::Number::New(env, selectionInfo.elementBounds.origin.x));
    resultObj.Set(Napi::String::New(env, "elementY"), Napi::Number::New(env, selectionInfo.elementBounds.origin.y));
    resultObj.Set(Napi::String::New(env, "elementWidth"), Napi::Number::New(env, selectionInfo.elementBounds.size.width));
    resultObj.Set(Napi::String::New(env, "elementHeight"), Napi::Number::New(env, selectionInfo.elementBounds.size.height));

    return resultObj;
}

void SelectionMonitor::StartMouseKeyboardEventThread()
{
    if (event_thread.joinable())
    {
        return;
    }

    event_thread = std::thread(&SelectionMonitor::MouseKeyboardEventThreadProc, this);
}

void SelectionMonitor::StopMouseKeyboardEventThread()
{
    if (!event_thread.joinable())
    {
        eventRunLoop = nullptr;
        mouseEventTap = nullptr;
        keyboardEventTap = nullptr;
        mouseRunLoopSource = nullptr;
        keyboardRunLoopSource = nullptr;
        return;
    }

    // The thread re-checks mouse_keyboard_running every EVENT_LOOP_SLICE_SEC,
    // so join() returns promptly even if the stop below races thread startup.
    mouse_keyboard_running = false;
    CFRunLoopRef loop = eventRunLoop.load();
    if (loop)
    {
        CFRunLoopStop(loop);
        CFRunLoopWakeUp(loop);
    }

    event_thread.join();
}

void SelectionMonitor::MouseKeyboardEventThreadProc()
{
    @autoreleasepool
    {
    CFRunLoopRef runLoop = CFRunLoopGetCurrent();
    eventRunLoop = runLoop;

    CGEventMask mouseMask = CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) |
                            CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseDown) |
                            CGEventMaskBit(kCGEventRightMouseUp) | CGEventMaskBit(kCGEventRightMouseDragged) |
                            CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp) |
                            CGEventMaskBit(kCGEventOtherMouseDragged) | CGEventMaskBit(kCGEventMouseMoved) |
                            CGEventMaskBit(kCGEventScrollWheel);

    mouseEventTap = CGEventTapCreate(kCGSessionEventTap, kCGTailAppendEventTap, kCGEventTapOptionListenOnly, mouseMask,
                                     MouseEventCallback, this);

    if (mouseEventTap)
    {
        mouseRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, mouseEventTap, 0);
        CFRunLoopAddSource(runLoop, mouseRunLoopSource, kCFRunLoopDefaultMode);
        CGEventTapEnable(mouseEventTap, true);
    }

    CGEventMask keyboardMask =
        CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged);

    keyboardEventTap = CGEventTapCreate(kCGSessionEventTap, kCGTailAppendEventTap, kCGEventTapOptionListenOnly,
                                        keyboardMask, KeyboardEventCallback, this);

    if (keyboardEventTap)
    {
        keyboardRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, keyboardEventTap, 0);
        CFRunLoopAddSource(runLoop, keyboardRunLoopSource, kCFRunLoopDefaultMode);
        CGEventTapEnable(keyboardEventTap, true);
    }

    // Without Accessibility/Input Monitoring permission both taps are null;
    // there is nothing to run, so exit instead of spinning.
    while (mouse_keyboard_running && (mouseEventTap || keyboardEventTap))
    {
        @autoreleasepool
        {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, EVENT_LOOP_SLICE_SEC, false);
        }
    }

    if (mouseEventTap)
    {
        CGEventTapEnable(mouseEventTap, false);
        CFRunLoopRemoveSource(runLoop, mouseRunLoopSource, kCFRunLoopDefaultMode);
        CFRelease(mouseEventTap);
        CFRelease(mouseRunLoopSource);
        mouseEventTap = nullptr;
        mouseRunLoopSource = nullptr;
    }

    if (keyboardEventTap)
    {
        CGEventTapEnable(keyboardEventTap, false);
        CFRunLoopRemoveSource(runLoop, keyboardRunLoopSource, kCFRunLoopDefaultMode);
        CFRelease(keyboardEventTap);
        CFRelease(keyboardRunLoopSource);
        keyboardEventTap = nullptr;
        keyboardRunLoopSource = nullptr;
    }

    eventRunLoop = nullptr;
    }
}

void SelectionMonitor::ProcessMouseEvent(Napi::Env env, Napi::Function function, MouseEventContext *pMouseEvent)
{
    if (!pMouseEvent)
    {
        return;
    }
    // env is null when the queue is drained during teardown; the instance
    // may already be gone.
    if (env == nullptr || function.IsEmpty() || !currentInstance || !currentInstance->mouse_keyboard_running)
    {
        delete pMouseEvent;
        return;
    }

    @autoreleasepool
    {

    auto currentTime =
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
            .count();

    CGPoint currentPos = pMouseEvent->pos;
    auto mouseType = pMouseEvent->type;
    MouseButton mouseButton = static_cast<MouseButton>(pMouseEvent->button);
    auto mouseFlag = pMouseEvent->flag;

    static CGPoint lastLastMouseUpPos = CGPointZero;
    static CGPoint lastMouseUpPos = CGPointZero;
    static uint64_t lastMouseUpTime = 0;
    static CGPoint lastMouseDownPos = CGPointZero;
    static uint64_t lastMouseDownTime = 0;
    static bool isLastValidClick = false;
    static bool isLastMouseDownValidCursor = false;

    bool shouldDetectSelection = false;

    auto detectionType = SelectionDetectType::None;
    std::string mouseTypeStr = "";
    int mouseFlagValue = 0;

    switch (mouseType)
    {
        case kCGEventLeftMouseDown:
        {
            mouseTypeStr = "mouse-down";

            lastMouseDownTime = currentTime;
            lastMouseDownPos = currentPos;
            isLastMouseDownValidCursor = isIBeamCursor([NSCursor currentSystemCursor]);
            currentInstance->clipboard_sequence = GetClipboardSequence();
            break;
        }
        case kCGEventLeftMouseUp:
        {
            mouseTypeStr = "mouse-up";

            if (!currentInstance->is_selection_passive_mode)
            {
                double dx = currentPos.x - lastMouseDownPos.x;
                double dy = currentPos.y - lastMouseDownPos.y;
                double distance = sqrt(dx * dx + dy * dy);

                bool isCurrentValidClick = (currentTime - lastMouseDownTime) <= DOUBLE_CLICK_TIME_MS;
                bool isValidCursor = isLastMouseDownValidCursor || isIBeamCursor([NSCursor currentSystemCursor]);

                if ((currentTime - lastMouseDownTime) > MAX_DRAG_TIME_MS)
                {
                    shouldDetectSelection = false;
                }
                else if (distance >= MIN_DRAG_DISTANCE)
                {
                    if (isValidCursor)
                    {
                        shouldDetectSelection = true;
                        detectionType = SelectionDetectType::Drag;
                    }
                }
                else if (isLastValidClick && isCurrentValidClick && distance <= DOUBLE_CLICK_MAX_DISTANCE)
                {
                    double dx2 = currentPos.x - lastMouseUpPos.x;
                    double dy2 = currentPos.y - lastMouseUpPos.y;
                    double distance2 = sqrt(dx2 * dx2 + dy2 * dy2);

                    if (distance2 <= DOUBLE_CLICK_MAX_DISTANCE &&
                        (lastMouseDownTime - lastMouseUpTime) <= DOUBLE_CLICK_TIME_MS)
                    {
                        if (isValidCursor)
                        {
                            shouldDetectSelection = true;
                            detectionType = SelectionDetectType::DoubleClick;
                        }
                    }
                }

                if (!shouldDetectSelection)
                {
                    CGEventRef currentEvent = CGEventCreate(nullptr);
                    if (currentEvent)
                    {
                        CGEventFlags flags = CGEventGetFlags(currentEvent);
                        bool isShiftPressed = (flags & kCGEventFlagMaskShift) != 0;
                        bool isCtrlPressed = (flags & kCGEventFlagMaskControl) != 0;
                        bool isCmdPressed = (flags & kCGEventFlagMaskCommand) != 0;
                        bool isOptionPressed = (flags & kCGEventFlagMaskAlternate) != 0;

                        if (isShiftPressed && !isCtrlPressed && !isCmdPressed && !isOptionPressed)
                        {
                            if (isValidCursor)
                            {
                                shouldDetectSelection = true;
                                detectionType = SelectionDetectType::ShiftClick;
                            }
                        }
                        CFRelease(currentEvent);
                    }
                }
                isLastValidClick = isCurrentValidClick;
            }

            lastLastMouseUpPos = lastMouseUpPos;
            lastMouseUpTime = currentTime;
            lastMouseUpPos = currentPos;
            break;
        }

        case kCGEventRightMouseDown:
        case kCGEventOtherMouseDown:
            mouseTypeStr = "mouse-down";
            break;

        case kCGEventRightMouseUp:
        case kCGEventOtherMouseUp:
            mouseTypeStr = "mouse-up";
            break;

        case kCGEventMouseMoved:
        case kCGEventLeftMouseDragged:
        case kCGEventRightMouseDragged:
        case kCGEventOtherMouseDragged:
            mouseTypeStr = "mouse-move";
            break;

        case kCGEventScrollWheel:
            mouseTypeStr = "mouse-wheel";
            mouseFlagValue = mouseFlag;
            break;

        default:
            mouseTypeStr = "unknown";
            break;
    }

    if (shouldDetectSelection)
    {
        TextSelectionInfo selectionInfo;
        NSRunningApplication *frontApp = GetFrontApp();

        if (currentInstance->GetSelectedText(frontApp, selectionInfo) && !IsTrimmedEmpty(selectionInfo.text))
        {
            selectionInfo.detectType = detectionType;
            
            switch (detectionType)
            {
                case SelectionDetectType::Drag:
                {
                    selectionInfo.mousePosStart = lastMouseDownPos;
                    selectionInfo.mousePosEnd = lastMouseUpPos;

                    if (selectionInfo.posLevel == SelectionPositionLevel::None)
                        selectionInfo.posLevel = SelectionPositionLevel::MouseDual;
                    break;
                }
                case SelectionDetectType::DoubleClick:
                {
                    selectionInfo.mousePosStart = lastMouseUpPos;
                    selectionInfo.mousePosEnd = lastMouseUpPos;

                    if (selectionInfo.posLevel == SelectionPositionLevel::None)
                        selectionInfo.posLevel = SelectionPositionLevel::MouseSingle;
                    break;
                }
                case SelectionDetectType::ShiftClick:
                {
                    selectionInfo.mousePosStart = lastLastMouseUpPos;
                    selectionInfo.mousePosEnd = lastMouseUpPos;

                    if (selectionInfo.posLevel == SelectionPositionLevel::None)
                        selectionInfo.posLevel = SelectionPositionLevel::MouseDual;
                    break;
                }
                default:
                    break;
            }

            auto callback = [selectionInfo](Napi::Env env, Napi::Function jsCallback)
            {
                if (env == nullptr || jsCallback.IsEmpty() || !currentInstance)
                    return;
                Napi::Object resultObj = currentInstance->CreateSelectionResultObject(env, selectionInfo);
                jsCallback.Call({resultObj});
            };

            if (currentInstance->tsfn)
                currentInstance->tsfn.NonBlockingCall(callback);
        }
    }

    if (!mouseTypeStr.empty())
    {
        Napi::Object resultObj = Napi::Object::New(env);
        resultObj.Set(Napi::String::New(env, "type"), Napi::String::New(env, "mouse-event"));
        resultObj.Set(Napi::String::New(env, "action"), Napi::String::New(env, mouseTypeStr));
        resultObj.Set(Napi::String::New(env, "x"), Napi::Number::New(env, currentPos.x));
        resultObj.Set(Napi::String::New(env, "y"), Napi::Number::New(env, currentPos.y));
        resultObj.Set(Napi::String::New(env, "button"), Napi::Number::New(env, static_cast<int>(mouseButton)));
        resultObj.Set(Napi::String::New(env, "flag"), Napi::Number::New(env, mouseFlagValue));
        function.Call({resultObj});
    }

    delete pMouseEvent;
    }
}

void SelectionMonitor::ProcessKeyboardEvent(Napi::Env env, Napi::Function function, KeyboardEventContext *pKeyboardEvent)
{
    if (!pKeyboardEvent)
    {
        return;
    }
    if (env == nullptr || function.IsEmpty())
    {
        delete pKeyboardEvent;
        return;
    }

    std::string eventTypeStr;
    CGKeyCode vkCode = pKeyboardEvent->keyCode;

    switch (pKeyboardEvent->event)
    {
        case kCGEventKeyDown:
            eventTypeStr = "key-down";
            break;
        case kCGEventKeyUp:
            eventTypeStr = "key-up";
            break;
        case kCGEventFlagsChanged:
        {
            static CGEventFlags previousFlags = 0;
            CGEventFlags currentFlags = pKeyboardEvent->flags;
            CGEventFlags changedFlags = currentFlags ^ previousFlags;

            if (changedFlags & kCGEventFlagMaskCommand)
            {
                eventTypeStr = (currentFlags & kCGEventFlagMaskCommand) ? "key-down" : "key-up";
            }
            else if (changedFlags & kCGEventFlagMaskShift)
            {
                eventTypeStr = (currentFlags & kCGEventFlagMaskShift) ? "key-down" : "key-up";
            }
            else if (changedFlags & kCGEventFlagMaskAlternate)
            {
                eventTypeStr = (currentFlags & kCGEventFlagMaskAlternate) ? "key-down" : "key-up";
            }
            else if (changedFlags & kCGEventFlagMaskControl)
            {
                eventTypeStr = (currentFlags & kCGEventFlagMaskControl) ? "key-down" : "key-up";
            }
            else if (changedFlags & kCGEventFlagMaskSecondaryFn)
            {
                vkCode = kVK_Function;
                eventTypeStr = (currentFlags & kCGEventFlagMaskSecondaryFn) ? "key-down" : "key-up";
            }
            else if (changedFlags & kCGEventFlagMaskAlphaShift)
            {
                vkCode = kVK_CapsLock;
                eventTypeStr = "key-down";
            }
            else
            {
                delete pKeyboardEvent;
                return;
            }

            previousFlags = currentFlags;
            break;
        }
        default:
            delete pKeyboardEvent;
            return;
    }

    bool isSysKey = (pKeyboardEvent->flags & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl |
                                              kCGEventFlagMaskAlternate | kCGEventFlagMaskSecondaryFn)) != 0;

    std::string uniKey = convertKeyCodeToUniKey(vkCode, pKeyboardEvent->flags);

    Napi::Object keyboardEventObj = Napi::Object::New(env);
    keyboardEventObj.Set(Napi::String::New(env, "type"), Napi::String::New(env, "keyboard-event"));
    keyboardEventObj.Set(Napi::String::New(env, "action"), Napi::String::New(env, eventTypeStr));
    keyboardEventObj.Set(Napi::String::New(env, "uniKey"), Napi::String::New(env, uniKey));
    keyboardEventObj.Set(Napi::String::New(env, "vkCode"), Napi::Number::New(env, vkCode));
    keyboardEventObj.Set(Napi::String::New(env, "sys"), Napi::Boolean::New(env, isSysKey));
    keyboardEventObj.Set(Napi::String::New(env, "flags"), Napi::Number::New(env, pKeyboardEvent->flags));
    function.Call({keyboardEventObj});

    delete pKeyboardEvent;
}

/**
 * macOS disables an event tap whose callback is too slow, or on certain user
 * input (secure text entry). Re-enable it, otherwise monitoring silently
 * stops for the rest of the session.
 */
void SelectionMonitor::ReenableTapIfNeeded(SelectionMonitor *monitor, CGEventType type)
{
    if (type != kCGEventTapDisabledByTimeout && type != kCGEventTapDisabledByUserInput)
        return;
    if (monitor && monitor->mouse_keyboard_running)
    {
        if (monitor->mouseEventTap)
            CGEventTapEnable(monitor->mouseEventTap, true);
        if (monitor->keyboardEventTap)
            CGEventTapEnable(monitor->keyboardEventTap, true);
    }
}

CGEventRef SelectionMonitor::MouseEventCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon)
{
    SelectionMonitor *monitor = static_cast<SelectionMonitor *>(refcon);
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput)
    {
        ReenableTapIfNeeded(monitor, type);
        return event;
    }
    if (!monitor || !monitor->mouse_keyboard_running || !monitor->mouse_tsfn)
        return event;

    if (type == kCGEventMouseMoved && !monitor->is_enabled_mouse_move_event)
        return event;

    int64_t button = -1;
    int64_t flag = 0;

    switch (type)
    {
        case kCGEventScrollWheel:
        {
            int64_t deltaY = CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis1);
            int64_t deltaX = CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis2);

            if (deltaY != 0)
            {
                button = 0;
                flag = (deltaY > 0) ? 1 : -1;
            }
            else if (deltaX != 0)
            {
                button = 1;
                flag = (deltaX > 0) ? 1 : -1;
            }
            else
            {
                return event;
            }
            break;
        }
        case kCGEventLeftMouseDown:
        case kCGEventRightMouseDown:
        case kCGEventOtherMouseDown:
        case kCGEventLeftMouseUp:
        case kCGEventRightMouseUp:
        case kCGEventOtherMouseUp:
            button = CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber);
            break;

        case kCGEventLeftMouseDragged:
        case kCGEventRightMouseDragged:
        case kCGEventOtherMouseDragged:
            button = CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber);
            break;

        default:
            break;
    }

    MouseEventContext *mouseEventCtx =
        new MouseEventContext{.type = type, .pos = CGEventGetLocation(event), .button = button, .flag = flag};

    // On failure (queue full / closing) the callback never runs, so free here.
    if (monitor->mouse_tsfn.NonBlockingCall(mouseEventCtx, ProcessMouseEvent) != napi_ok)
    {
        delete mouseEventCtx;
    }

    return event;
}

CGEventRef SelectionMonitor::KeyboardEventCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon)
{
    SelectionMonitor *monitor = static_cast<SelectionMonitor *>(refcon);
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput)
    {
        ReenableTapIfNeeded(monitor, type);
        return event;
    }
    if (!monitor || !monitor->mouse_keyboard_running || !monitor->keyboard_tsfn)
        return event;

    CGKeyCode keyCode = (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    CGEventFlags flags = CGEventGetFlags(event);

    KeyboardEventContext *keyboardEventCtx =
        new KeyboardEventContext{.event = type, .keyCode = keyCode, .flags = flags};

    if (monitor->keyboard_tsfn.NonBlockingCall(keyboardEventCtx, ProcessKeyboardEvent) != napi_ok)
    {
        delete keyboardEventCtx;
    }

    return event;
}

//=============================================================================
// Module Initialization
//=============================================================================

Napi::Object InitAll(Napi::Env env, Napi::Object exports)
{
    return SelectionMonitor::Init(env, exports);
}

NODE_API_MODULE(selection_monitor, InitAll)
