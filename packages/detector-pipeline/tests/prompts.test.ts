import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    DETECTOR_PIPELINE_SYSTEM_PROMPT,
    buildDetectorEvaluationPrompt,
    parseDetectorResponse,
} from '../prompts';
import { spec, event } from './helpers';

const T = Date.UTC(2026, 0, 2, 3, 4, 5);
const ISO = new Date(T).toISOString();

describe('buildDetectorEvaluationPrompt', () => {
    test('lists each detector with name, description and rules', () => {
        const p = buildDetectorEvaluationPrompt(
            [spec({ name: 'a', description: 'desc a', body: 'rule a' }), spec({ name: 'b', description: 'desc b', body: 'rule b' })],
            [],
            false,
        );
        assert.match(p, /## Active Detectors/);
        assert.match(p, /\[a\]\nDescription: desc a\nRules:\nrule a/);
        assert.match(p, /\[b\]\nDescription: desc b\nRules:\nrule b/);
        assert.ok(p.indexOf('[a]') < p.indexOf('[b]'), 'detectors keep input order');
    });

    test('zero detectors and zero events still yields a well-formed prompt', () => {
        const p = buildDetectorEvaluationPrompt([], [], false);
        assert.match(p, /## Active Detectors/);
        assert.doesNotMatch(p, /Recent Activity/);
        assert.match(p, /Analyze the activity events above/);
    });

    test('screenshot flag switches the closing instruction', () => {
        assert.match(buildDetectorEvaluationPrompt([spec()], [], true), /Analyze the screenshot and activity events above/);
        assert.match(buildDetectorEvaluationPrompt([spec()], [], false), /Analyze the activity events above\. Which/);
    });

    test('evaluation context is rendered first, and omitted when null or empty', () => {
        const withCtx = buildDetectorEvaluationPrompt([spec()], [], false, 40, 'Current task: "X"');
        assert.ok(withCtx.startsWith('## Current Task State\n\nCurrent task: "X"'));
        assert.doesNotMatch(buildDetectorEvaluationPrompt([spec()], [], false, 40, null), /Current Task State/);
        assert.doesNotMatch(buildDetectorEvaluationPrompt([spec()], [], false, 40, ''), /Current Task State/);
    });

    test('caps events at 40 by default, keeping the newest', () => {
        const events = Array.from({ length: 55 }, (_, i) => event('custom', { n: i }, T + i));
        const p = buildDetectorEvaluationPrompt([spec()], events, false);
        const lines = p.split('\n').filter((l) => l.startsWith('  ['));
        assert.equal(lines.length, 40);
        assert.match(lines[0], /"n":15/);
        assert.match(lines[39], /"n":54/);
    });

    test('honours an explicit maxEvents cap', () => {
        const events = Array.from({ length: 30 }, (_, i) => event('custom', { n: i }, T + i));
        const p = buildDetectorEvaluationPrompt([spec()], events, true, 20);
        assert.equal(p.split('\n').filter((l) => l.startsWith('  [')).length, 20);
    });

    test('maxEvents of zero (or negative) includes no events rather than all of them', () => {
        const events = Array.from({ length: 5 }, (_, i) => event('custom', { n: i }, T + i));
        for (const cap of [0, -3]) {
            const p = buildDetectorEvaluationPrompt([spec()], events, false, cap);
            assert.equal(p.split('\n').filter((l) => l.startsWith('  [')).length, 0, `cap=${cap}`);
        }
    });

    test('an event with an invalid timestamp does not throw', () => {
        const p = buildDetectorEvaluationPrompt([spec()], [event('custom', {}, Number.NaN)], false);
        assert.match(p, /custom/);
    });

    describe('event formatting', () => {
        const fmt = (e: ReturnType<typeof event>) =>
            buildDetectorEvaluationPrompt([spec()], [e], false).split('\n').find((l) => l.startsWith('  ['))!.trim();

        test('material with metadata and focus weight', () => {
            assert.equal(
                fmt(event('material', { type: 'FRAME_CAPTURED', title: 'Doc', application: 'Editor', appMetadata: { url: 'u', tab: null }, focusWeight: 0.456 }, T)),
                `[${ISO}] FRAME_CAPTURED: "Doc" in Editor [url: u] {weight: 0.46}`,
            );
        });

        test('material without title, app, metadata or weight', () => {
            assert.equal(fmt(event('material', { type: 'MATERIAL_FOCUSED' }, T)), `[${ISO}] MATERIAL_FOCUSED: "untitled" in unknown`);
        });

        test('material with all-null metadata omits the bracket', () => {
            assert.equal(fmt(event('material', { type: 'X', title: 't', application: 'a', appMetadata: { a: null } }, T)), `[${ISO}] X: "t" in a`);
        });

        test('text-input truncates to 120 chars', () => {
            const line = fmt(event('text-input', { status: 'TYPING', text: 'x'.repeat(500), application: 'App' }, T));
            assert.equal(line, `[${ISO}] text-input/TYPING: "${'x'.repeat(120)}" in App`);
        });

        test('text-input with no text', () => {
            assert.equal(fmt(event('text-input', { status: 'DONE' }, T)), `[${ISO}] text-input/DONE: "" in unknown`);
        });

        test('window-state with and without bundle id', () => {
            assert.equal(
                fmt(event('window-state', { state: 'FOCUSED', title: 'W', application: 'App', bundleId: 'com.x' }, T)),
                `[${ISO}] window/FOCUSED: "W" in App (com.x)`,
            );
            assert.equal(fmt(event('window-state', { state: 'APPEAR' }, T)), `[${ISO}] window/APPEAR: "untitled" in unknown`);
        });

        test('cursor with element role and label', () => {
            assert.equal(
                fmt(event('cursor', { action: 'CLICK', x: 1, y: 2, application: 'App', uiElementRole: 'AXButton', uiElementLabel: 'OK' }, T)),
                `[${ISO}] cursor/CLICK: CLICK at (1, 2) on AXButton "OK" in App`,
            );
        });

        test('cursor with label only and missing coordinates', () => {
            assert.equal(
                fmt(event('cursor', { uiElementLabel: 'L' }, T)),
                `[${ISO}] cursor/unknown: unknown at (?, ?) on element "L" in unknown`,
            );
        });

        test('text-selection with method and element type, truncated to 100', () => {
            assert.equal(
                fmt(event('text-selection', { selectedText: 'y'.repeat(300), selectionMethod: 'MOUSE', elementType: 'TEXT', application: 'A' }, T)),
                `[${ISO}] text-selection via MOUSE: "${'y'.repeat(100)}" in A (TEXT)`,
            );
        });

        test('copy-paste truncates to 80 and tolerates null text', () => {
            assert.equal(fmt(event('copy-paste', { action: 'COPY', text: 'z'.repeat(90) }, T)), `[${ISO}] copy-paste/COPY: "${'z'.repeat(80)}"`);
            assert.equal(fmt(event('copy-paste', { action: 'PASTE', text: null }, T)), `[${ISO}] copy-paste/PASTE: ""`);
        });

        test('screenshot and text-highlight', () => {
            assert.equal(fmt(event('screenshot', { status: 'FINISHED', type: 'REGION' }, T)), `[${ISO}] screenshot/FINISHED: type=REGION`);
            assert.equal(fmt(event('screenshot', { status: 'STARTED' }, T)), `[${ISO}] screenshot/STARTED: type=unknown`);
            assert.equal(fmt(event('text-highlight', { stage: 'END', highlightCount: 3 }, T)), `[${ISO}] text-highlight/END: count=3`);
            assert.equal(fmt(event('text-highlight', { stage: 'START' }, T)), `[${ISO}] text-highlight/START: count=?`);
        });

        test('unknown event types fall back to JSON of the remaining fields', () => {
            assert.equal(fmt(event('weird', { a: 1, b: 'two' }, T)), `[${ISO}] weird: {"a":1,"b":"two"}`);
        });
    });
});

describe('parseDetectorResponse', () => {
    test('parses a normal response', () => {
        const out = parseDetectorResponse('{"triggered":[{"name":"a","confidence":0.9,"summary":"s","evidence":"e"}]}');
        assert.deepEqual(out, [{
            name: 'a', confidence: 0.9, summary: 's', evidence: 'e', suggestedDetectors: [],
            taskAction: undefined, taskLabel: undefined, taskDescription: undefined,
        }]);
    });

    test('empty triggered array yields no results', () => {
        assert.deepEqual(parseDetectorResponse('{"triggered":[]}'), []);
    });

    test('empty / whitespace response throws an empty-response error', () => {
        assert.throws(() => parseDetectorResponse(''), /empty response/);
        assert.throws(() => parseDetectorResponse('   \n'), /empty response/);
    });

    test('valid JSON without a triggered array yields no results: {}, null, numbers, strings, arrays', () => {
        for (const raw of ['{}', 'null', '42', '"text"', '[1,2]', '{"triggered":null}', '{"triggered":"a"}', '{"triggered":{}}']) {
            assert.deepEqual(parseDetectorResponse(raw), [], raw);
        }
    });

    test('plain prose is rejected with a not-valid-JSON error', () => {
        assert.throws(() => parseDetectorResponse('No detectors fired.'), /not valid JSON/);
    });

    test('strips markdown fences, with or without a language tag', () => {
        const body = '{"triggered":[{"name":"a","confidence":1,"summary":"","evidence":""}]}';
        for (const raw of [`\`\`\`json\n${body}\n\`\`\``, `\`\`\`\n${body}\n\`\`\``, `\`\`\`json ${body}\`\`\``, `\`\`\`JSON\n${body}\n\`\`\``]) {
            assert.equal(parseDetectorResponse(raw)[0]?.name, 'a', raw);
        }
    });

    test('tolerates prose around the JSON object', () => {
        const body = '{"triggered":[{"name":"a","confidence":0.7,"summary":"x","evidence":"y"}]}';
        assert.equal(parseDetectorResponse(`Here is the result:\n${body}`)[0]?.name, 'a');
        assert.equal(parseDetectorResponse(`Sure! \`\`\`json\n${body}\n\`\`\` Hope that helps.`)[0]?.name, 'a');
    });

    test('repairs output truncated after a complete item', () => {
        const raw = '{"triggered":[{"name":"a","confidence":0.9,"summary":"s","evidence":"e"},{"name":"b","confid';
        assert.deepEqual(parseDetectorResponse(raw).map((r) => r.name), ['a']);
    });

    test('repair respects braces inside strings', () => {
        const raw = '{"triggered":[{"name":"a","confidence":0.9,"summary":"uses { and [ chars","evidence":"e"},{"na';
        const out = parseDetectorResponse(raw);
        assert.equal(out.length, 1);
        assert.equal(out[0].summary, 'uses { and [ chars');
    });

    test('truncation before any complete item is unrecoverable', () => {
        assert.throws(() => parseDetectorResponse('{"triggered":[{"name":"a","conf'), /not valid JSON/);
    });

    test('drops items without a string name', () => {
        const raw = JSON.stringify({ triggered: [null, 'str', 5, {}, { name: 3 }, { name: 'ok' }] });
        assert.deepEqual(parseDetectorResponse(raw).map((r) => r.name), ['ok']);
    });

    test('missing or non-numeric confidence defaults to 0.5', () => {
        const raw = JSON.stringify({ triggered: [{ name: 'a' }, { name: 'b', confidence: '0.9' }] });
        assert.deepEqual(parseDetectorResponse(raw).map((r) => r.confidence), [0.5, 0.5]);
    });

    test('confidence is clamped into [0, 1]', () => {
        const raw = JSON.stringify({ triggered: [{ name: 'a', confidence: 7 }, { name: 'b', confidence: -2 }, { name: 'c', confidence: 1 }, { name: 'd', confidence: 0 }] });
        assert.deepEqual(parseDetectorResponse(raw).map((r) => r.confidence), [1, 0, 1, 0]);
    });

    test('summary/evidence are stringified; missing become empty strings', () => {
        const out = parseDetectorResponse(JSON.stringify({ triggered: [{ name: 'a', summary: 12, evidence: null }] }));
        assert.equal(out[0].summary, '12');
        assert.equal(out[0].evidence, '');
    });

    test('suggested_detectors keeps only strings', () => {
        const out = parseDetectorResponse(JSON.stringify({ triggered: [{ name: 'a', suggested_detectors: ['x', 1, null, 'y'] }] }));
        assert.deepEqual(out[0].suggestedDetectors, ['x', 'y']);
        const notArray = parseDetectorResponse(JSON.stringify({ triggered: [{ name: 'a', suggested_detectors: 'x' }] }));
        assert.deepEqual(notArray[0].suggestedDetectors, []);
    });

    test('task fields: snake_case and camelCase, trimmed, blanks dropped', () => {
        const out = parseDetectorResponse(JSON.stringify({ triggered: [
            { name: 'a', action: ' begin ', task_label: ' L ', task_description: 'D' },
            { name: 'b', taskLabel: 'CL', taskDescription: 'CD' },
            { name: 'c', action: '   ', task_label: '', taskDescription: 5 },
        ] }));
        assert.deepEqual([out[0].taskAction, out[0].taskLabel, out[0].taskDescription], ['begin', 'L', 'D']);
        assert.deepEqual([out[1].taskLabel, out[1].taskDescription], ['CL', 'CD']);
        assert.deepEqual([out[2].taskAction, out[2].taskLabel, out[2].taskDescription], [undefined, undefined, undefined]);
    });

    test('unknown detector names are passed through (filtering is the caller\'s job)', () => {
        assert.equal(parseDetectorResponse('{"triggered":[{"name":"nope"}]}')[0].name, 'nope');
    });

    test('huge output (many items, long strings) parses', () => {
        const items = Array.from({ length: 5000 }, (_, i) => ({ name: `d${i}`, confidence: 0.5, summary: 's'.repeat(200), evidence: '' }));
        const out = parseDetectorResponse(JSON.stringify({ triggered: items }));
        assert.equal(out.length, 5000);
    });

    test('system prompt asks for JSON with a triggered array', () => {
        assert.match(DETECTOR_PIPELINE_SYSTEM_PROMPT, /\{"triggered":\[\]\}/);
    });
});
