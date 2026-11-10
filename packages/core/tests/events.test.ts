import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createAUSMEvent,
    createAUSMUIElement,
    createScreenshotEvent, ScreenshotStatus, ScreenshotType,
    createWindowStateEvent, WindowState,
    createTextInputEvent, EditableTextElementType, TextInputStatus,
    createTextSelectionEvent, TextElementType, SelectionMethod, SelectionStage, DetectionSource,
    createMaterialEvent, MaterialEventType,
    createCursorPlusPlusEvent, MouseAction,
    createCopyPasteEvent, CopyPasteAction, CopyPasteContentType,
    createSpaceChangeEvent,
} from '../src/index';
import { createTaskEvent, TaskStatus } from '../src/events/TaskEvent';

const factories = {
    screenshot: createScreenshotEvent,
    windowState: createWindowStateEvent,
    textInput: createTextInputEvent,
    textSelection: createTextSelectionEvent,
    material: createMaterialEvent,
    cursorPlusPlus: createCursorPlusPlusEvent,
    copyPaste: createCopyPasteEvent,
    spaceChange: createSpaceChangeEvent,
    task: createTaskEvent,
} as const;

test('every factory sets its kind and base fields, with no argument at all', () => {
    for (const [kind, make] of Object.entries(factories)) {
        const before = Date.now();
        const e = (make as () => Record<string, unknown>)();
        assert.equal(e.kind, kind);
        assert.equal(e.eventID, null, kind);
        assert.equal(e.displayID, null, kind);
        assert.ok((e.timestamp as number) >= before && (e.timestamp as number) <= Date.now(), kind);
    }
});

test('defaults: every optional field is null (never undefined), except documented non-null defaults', () => {
    const nonNull: Record<string, Record<string, unknown>> = {
        textSelection: { selectedText: '' },
        material: { isNew: false },
    };
    for (const [kind, make] of Object.entries(factories)) {
        const e = (make as () => Record<string, unknown>)();
        for (const [key, value] of Object.entries(e)) {
            if (['kind', 'timestamp'].includes(key)) continue;
            const expected = nonNull[kind]?.[key] ?? null;
            assert.equal(value, expected, `${kind}.${key}`);
        }
    }
});

test('explicit nulls are kept and undefined fields fall back to defaults', () => {
    const e = createScreenshotEvent({ bounds: null, status: undefined, eventID: undefined, timestamp: undefined });
    assert.equal(e.bounds, null);
    assert.equal(e.status, null);
    assert.equal(e.eventID, null);
    assert.equal(typeof e.timestamp, 'number');
});

test('falsy-but-valid values survive (0, empty string, false, negative coordinates)', () => {
    const c = createCursorPlusPlusEvent({
        timestamp: 0, eventID: '', displayID: '', x: 0, y: -0, button: 0, clickCount: 0, scrollDeltaX: 0,
        scrollDeltaY: -0.5, holdDurationMs: 0, windowId: 0, windowTitle: '', uiElementValue: '',
    });
    assert.equal(c.timestamp, 0);
    assert.equal(c.eventID, '');
    assert.equal(c.displayID, '');
    assert.equal(c.x, 0);
    assert.equal(c.button, 0);
    assert.equal(c.clickCount, 0);
    assert.equal(c.scrollDeltaY, -0.5);
    assert.equal(c.windowId, 0);
    assert.equal(c.windowTitle, '');
    assert.equal(c.uiElementValue, '');

    const m = createMaterialEvent({ isNew: false, focusWeight: 0, contentLength: 0, contentPreview: '' });
    assert.equal(m.isNew, false);
    assert.equal(m.focusWeight, 0);
    assert.equal(m.contentPreview, '');
    assert.equal(createTextSelectionEvent({ selectedText: '' }).selectedText, '');
    assert.equal(createCopyPasteEvent({ changeCount: 0, content: '' }).changeCount, 0);
    const w = createWindowStateEvent({ bounds: { x: -2560, y: -1440, width: 0, height: 0 }, displayId: 0, pid: 0 });
    assert.deepEqual(w.bounds, { x: -2560, y: -1440, width: 0, height: 0 });
    assert.equal(w.displayId, 0);
});

test('all fields are carried through unchanged (screenshot, window, copy/paste, material, task)', () => {
    const rect = { x: -100.5, y: 20, width: 300, height: 0.5 };
    const s = createScreenshotEvent({
        eventID: 'ss1', timestamp: 5, displayID: 'd2', bounds: rect, status: ScreenshotStatus.FINISHED,
        type: ScreenshotType.SELECTED_WINDOW, imageData: { dataBase64: 'AAA=', width: 1, height: 2, mimeType: 'image/png' },
        imagePath: '/tmp/スクリーンショット 👍.png', imageWidth: 600, imageHeight: 400,
    });
    assert.deepEqual(s, {
        kind: 'screenshot', eventID: 'ss1', timestamp: 5, displayID: 'd2', bounds: rect,
        status: 'SCREENSHOT_FINISHED', type: 'WINDOW_SCREEN',
        imageData: { dataBase64: 'AAA=', width: 1, height: 2, mimeType: 'image/png' },
        imagePath: '/tmp/スクリーンショット 👍.png', imageWidth: 600, imageHeight: 400,
    });

    const w = createWindowStateEvent({
        application: 'Mail', state: WindowState.TITLE_CHANGED, bounds: rect, windowId: 7, title: 'שלום — 受信',
        bundleId: 'com.apple.mail', pid: 9, oldBounds: rect, oldTitle: 'old', displayId: 3, documentPath: '/a b/c.txt',
    });
    assert.equal(w.title, 'שלום — 受信');
    assert.equal(w.state, 'TITLE_CHANGED');
    assert.equal(w.documentPath, '/a b/c.txt');

    const cp = createCopyPasteEvent({
        action: CopyPasteAction.PASTE, contentType: CopyPasteContentType.FILE, content: '/a\n/b', contentPaths: ['/a', '/b'], changeCount: 12,
    });
    assert.deepEqual(cp.contentPaths, ['/a', '/b']);
    assert.equal(cp.action, 'PASTE');

    const t = createTaskEvent({ status: TaskStatus.UPDATED, taskId: 't', level: 'goal', confidence: 0, modelLatencyMs: 0 });
    assert.equal(t.status, 'TASK_UPDATED');
    assert.equal(t.confidence, 0);
    assert.equal(t.level, 'goal');
});

test('unknown fields on the input are not copied onto the event', () => {
    const e = createCopyPasteEvent({ action: CopyPasteAction.COPY, ...({ secretExtra: 'x', kind: 'textInput' } as object) });
    assert.equal((e as unknown as Record<string, unknown>).secretExtra, undefined);
    assert.equal(e.kind, 'copyPaste', 'kind cannot be overridden through data');
    const c = createCursorPlusPlusEvent({ ...({ uiElementSubrole: 'AXCloseButton' } as object) });
    assert.equal((c as unknown as Record<string, unknown>).uiElementSubrole, undefined);
});

test('factories never mutate their input', () => {
    const data = Object.freeze({ selectedText: 'x', screenBound: Object.freeze({ x: 1, y: 2, width: 3, height: 4 }) });
    const e = createTextSelectionEvent(data);
    assert.equal(e.screenBound, data.screenBound, 'nested objects are shared, not cloned');
    assert.deepEqual(Object.keys(data), ['selectedText', 'screenBound']);
});

test('text survives unchanged: emoji, RTL, CJK, combining marks, control characters, 1 MB', () => {
    const samples = ['👨‍👩‍👧‍👦🇯🇵', 'مرحبا שלום', '日本語', 'é', 'a\u0000b\r\n\t"\\', 'z'.repeat(1 << 20)];
    for (const s of samples) {
        assert.equal(createTextInputEvent({ text: s }).text, s);
        assert.equal(createTextSelectionEvent({ selectedText: s }).selectedText, s);
        assert.equal(createCopyPasteEvent({ content: s }).content, s);
    }
});

test('events are JSON round-trippable', () => {
    const e = createCursorPlusPlusEvent({
        action: MouseAction.DRAG, x: 1.5, y: -2, interactionScreenshot: { dataBase64: 'AA==', width: 1, height: 1, mimeType: 'image/jpeg' },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(e)), e);
});

test('enum string values are a stable wire contract', () => {
    assert.deepEqual({ ...ScreenshotStatus }, { STARTED: 'SCREENSHOT_STARTED', UPDATED: 'SCREENSHOT_UPDATED', FINISHED: 'SCREENSHOT_FINISHED' });
    assert.deepEqual({ ...ScreenshotType }, { FULL_SCREEN: 'FULL_SCREEN', SELECTED_REGION: 'PARTIAL_SCREEN', SELECTED_WINDOW: 'WINDOW_SCREEN' });
    assert.deepEqual({ ...TextInputStatus }, { STARTED: 'TEXT_INPUT_STARTED', UPDATED: 'TEXT_INPUT_UPDATED', ENDED: 'TEXT_INPUT_ENDED' });
    assert.deepEqual(Object.values(WindowState), ['APPEAR', 'UNFOCUSED', 'FOCUSED', 'VANISHED', 'BOUNDS_CHANGED', 'TITLE_CHANGED']);
    assert.deepEqual(Object.values(MouseAction), ['MOVE', 'CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'SCROLL', 'HOLD_START', 'HOLD_END', 'DRAG']);
    assert.deepEqual(Object.values(CopyPasteAction), ['COPY', 'PASTE']);
    assert.deepEqual(Object.values(CopyPasteContentType), ['TEXT', 'HTML', 'RTF', 'IMAGE', 'FILE', 'URL']);
    assert.deepEqual(Object.values(SelectionMethod), ['MOUSE', 'KEYBOARD', 'DOUBLE_CLICK', 'TRIPLE_CLICK', 'OTHER']);
    assert.deepEqual(Object.values(SelectionStage), ['START', 'UPDATE', 'END']);
    assert.deepEqual(Object.values(DetectionSource), ['NATIVE', 'CV', 'CLIPBOARD', 'UNKNOWN']);
    assert.equal(Object.values(TextElementType).length, 14);
    assert.ok(Object.values(EditableTextElementType).includes('TERMINAL' as EditableTextElementType));
    assert.deepEqual(Object.values(MaterialEventType), [
        'FRAME_CAPTURED', 'MATERIAL_CREATED', 'MATERIAL_TYPE_CLASSIFIED', 'MATERIAL_FOCUSED', 'MATERIAL_UNFOCUSED', 'MATERIAL_CONTENT_UPDATED',
    ]);
    assert.deepEqual(Object.values(TaskStatus), ['TASK_DETECTED', 'TASK_UPDATED', 'TASK_COMPLETED']);
});

test('createAUSMUIElement maps content to screenContent and defaults to nulls', () => {
    assert.deepEqual(createAUSMUIElement(), {
        type: null, application: null, applicationID: null, applicationLocalizedName: null, screenBounds: null, screenContent: null,
    });
    const el = createAUSMUIElement({ type: 'AXTextArea', application: 'com.apple.Notes', applicationLocalizedName: 'メモ', content: '' });
    assert.equal(el.screenContent, '');
    assert.equal(el.applicationLocalizedName, 'メモ');
});

test('createAUSMEvent keeps a zero timestamp and an empty id', () => {
    const e = createAUSMEvent('detector', { timestamp: 0, eventID: '' });
    assert.equal(e.timestamp, 0);
    assert.equal(e.eventID, '');
    assert.equal(e.kind, 'detector');
});
