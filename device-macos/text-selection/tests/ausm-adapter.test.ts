import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    AUSMSelectionMethod,
    AUSMTextElementType as T,
    inferTextElementType,
    mapDetectionTypeToSelectionMethod,
    toAUSMTextSelectionEventData,
    toExtendedAUSMEventData,
} from '../ausm-adapter';
import { DetectionType, PositionLevel, RetrievalMethod, type SelectionInfo } from '../types';

test('inferTextElementType classifies common apps', () => {
    assert.equal(inferTextElementType('com.microsoft.VSCode', 'Code'), T.CODE_EDITOR);
    assert.equal(inferTextElementType('com.todesktop.230313mzl4w4u92', 'Cursor'), T.CODE_EDITOR);
    assert.equal(inferTextElementType('com.sublimetext.4', 'Sublime Text'), T.CODE_EDITOR);
    assert.equal(inferTextElementType('com.apple.Notes', 'Notes'), T.DOCUMENT_EDITOR);
    assert.equal(inferTextElementType('com.microsoft.Word', 'Microsoft Word'), T.DOCUMENT_EDITOR);
    assert.equal(inferTextElementType('com.apple.mail', 'Mail'), T.EMAIL);
    assert.equal(inferTextElementType('com.tinyspeck.slackmacgap', 'Slack'), T.MESSAGE);
    assert.equal(inferTextElementType('com.apple.Preview', 'Preview'), T.PDF_TEXT);
    assert.equal(inferTextElementType('com.google.Chrome', 'Google Chrome'), T.WEB_NON_EDITABLE_TEXT);
    assert.equal(inferTextElementType('company.thebrowser.Browser', 'Arc'), T.WEB_NON_EDITABLE_TEXT);
    assert.equal(inferTextElementType('com.microsoft.edgemac', 'Microsoft Edge'), T.WEB_NON_EDITABLE_TEXT);
    assert.equal(inferTextElementType('com.apple.Terminal', 'Terminal'), T.OTHER);
    assert.equal(inferTextElementType('', undefined), T.OTHER);
});

test('inferTextElementType avoids substring false positives', () => {
    // previously "word" / "edge" / "arc" substrings matched these
    assert.equal(inferTextElementType('com.1password.1password', '1Password'), T.OTHER);
    assert.equal(inferTextElementType('com.example.knowledge', 'Knowledge Base'), T.OTHER);
    assert.equal(inferTextElementType('com.example.research', 'Research'), T.OTHER);
});

test('mapDetectionTypeToSelectionMethod', () => {
    assert.equal(mapDetectionTypeToSelectionMethod(DetectionType.DRAG), AUSMSelectionMethod.MOUSE);
    assert.equal(mapDetectionTypeToSelectionMethod(DetectionType.SHIFT_CLICK), AUSMSelectionMethod.MOUSE);
    assert.equal(mapDetectionTypeToSelectionMethod(DetectionType.DOUBLE_CLICK), AUSMSelectionMethod.DOUBLE_CLICK);
    assert.equal(mapDetectionTypeToSelectionMethod(DetectionType.NONE), AUSMSelectionMethod.OTHER);
});

test('toAUSM*EventData maps fields', () => {
    const info: SelectionInfo = {
        text: 'hello',
        programName: 'com.apple.Safari',
        localizedName: 'Safari',
        retrievalMethod: RetrievalMethod.CLIPBOARD,
        detectionType: DetectionType.DOUBLE_CLICK,
        positionLevel: PositionLevel.FULL,
        isFullscreen: false,
        bounds: { x: -100, y: 5, width: 50, height: 10 },
        elementBounds: null,
        startTop: { x: 0, y: 0 },
        startBottom: { x: 0, y: 0 },
        endTop: { x: 0, y: 0 },
        endBottom: { x: 0, y: 0 },
        mouseStart: { x: 1, y: 2 },
        mouseEnd: { x: 3, y: 4 },
    };
    const base = toAUSMTextSelectionEventData(info);
    assert.equal(base.selectedText, 'hello');
    assert.deepEqual(base.screenBound, info.bounds);
    assert.deepEqual(base.sourceElement?.position, { x: -100, y: 5 });
    assert.equal(base.sourceElement?.type, T.WEB_NON_EDITABLE_TEXT);
    assert.equal(base.selectionMethod, AUSMSelectionMethod.DOUBLE_CLICK);
    assert.match(base.eventID ?? '', /^sel_\d+_/);

    const ext = toExtendedAUSMEventData(info);
    assert.equal(ext.retrievalMethod, 'CLIPBOARD');
    assert.deepEqual(ext.mouseEnd, { x: 3, y: 4 });
});
