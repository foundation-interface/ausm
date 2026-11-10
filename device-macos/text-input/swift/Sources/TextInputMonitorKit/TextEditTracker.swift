import Foundation

/// Edit-session state machine for the focused text input (pure; unit-tested with fake
/// elements). `TextInputMonitor` feeds it resolved AX focus / value notifications and performs
/// the returned effects in order.
///
/// Rules:
///   - Focus into an editable element: STARTED (with its current value), and a value observer.
///   - Duplicate focus notifications for the tracked element are ignored.
///   - Editable → another editable: FINISHED for the old one, then STARTED for the new one.
///   - Focus to a non-editable / password element: FINISHED only after a debounce, and only if
///     the app's actual focused element is no longer editable (filters child/container bounce).
///   - Value changes: UPDATED, only when the value differs from the last reported one.
///   - App switch / app quit / permission revoked / stop: FINISHED immediately.
struct TextEditTracker<Element: Equatable> {
    enum Effect: Equatable {
        case started(Element, text: String?)
        case updated(Element, text: String?)
        case finished(Element, text: String?)
        case observeValue(Element)
        case stopObservingValue
        case scheduleFinish
        case cancelFinish
    }

    private(set) var focused: Element?
    private(set) var isEditing = false
    private(set) var lastText: String?
    private(set) var finishPending = false

    /// Focus moved. `editable` is the resolved editable element (nil for non-editable or
    /// password elements).
    mutating func focusChanged(to editable: Element?, readText: (Element) -> String?) -> [Effect] {
        guard let target = editable else {
            guard isEditing else { return [] }
            finishPending = true
            return [.scheduleFinish]
        }
        var effects: [Effect] = []
        if finishPending {
            finishPending = false
            effects.append(.cancelFinish)
        }
        if isEditing, focused == target { return effects }
        if isEditing { effects += finishCurrent() }
        focused = target
        isEditing = true
        let text = readText(target)
        lastText = text
        effects += [.observeValue(target), .started(target, text: text)]
        return effects
    }

    /// The tracked element's value changed. Password fields never produce an update.
    mutating func valueChanged(_ element: Element, isSecure: Bool, readText: (Element) -> String?) -> [Effect] {
        guard isEditing, !isSecure else { return [] }
        let text = readText(element)
        guard text != lastText else { return [] }
        lastText = text
        return [.updated(element, text: text)]
    }

    /// The finish debounce elapsed. `currentFocus` re-queries the app's focused element,
    /// resolved to an editable one (nil when not editable).
    mutating func finishDebounceElapsed(currentFocus: () -> Element?) -> [Effect] {
        guard finishPending else { return [] }
        finishPending = false
        guard isEditing else { return [] }
        if let resolved = currentFocus() {
            // Still in a text input: keep tracking. Re-create the value observer only when
            // the element reference actually changed.
            if focused == resolved { return [] }
            focused = resolved
            return [.observeValue(resolved)]
        }
        var effects = finishCurrent()
        reset()
        effects.append(.stopObservingValue)
        return effects
    }

    /// End the session now (app switch, app quit, permission revoked, stop).
    mutating func endSession() -> [Effect] {
        var effects: [Effect] = []
        if finishPending { effects.append(.cancelFinish) }
        if isEditing { effects += finishCurrent() }
        reset()
        return effects
    }

    /// Forget everything without emitting (observers torn down).
    mutating func reset() {
        focused = nil
        isEditing = false
        lastText = nil
        finishPending = false
    }

    private mutating func finishCurrent() -> [Effect] {
        guard let element = focused else { return [] }
        let text = lastText
        lastText = nil
        return [.finished(element, text: text)]
    }
}
