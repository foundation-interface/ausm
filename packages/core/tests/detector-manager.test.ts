import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DetectorManager, parseDetectorFrontmatter, loadDetectorsFromDir, stripYamlComments } from '../src/detectors/DetectorManager';

const fm = (lines: string[], body = 'Body text.') => `---\n${lines.join('\n')}\n---\n${body}`;
const BASE = ['name: alpha', 'description: Alpha detector', 'event: alpha-event'];

let tmp: string;
let quiet: { log: typeof console.log; warn: typeof console.warn };

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ausm-detectors-'));
    quiet = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = () => {};
});
afterEach(() => {
    console.log = quiet.log;
    console.warn = quiet.warn;
    fs.rmSync(tmp, { recursive: true, force: true });
});

function writeDetector(root: string, dir: string, content: string): string {
    const d = path.join(root, dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'DETECTOR.md'), content);
    return d;
}

describe('parseDetectorFrontmatter', () => {
    test('parses required fields and trims the body', () => {
        const out = parseDetectorFrontmatter(fm(BASE, '\n\n  Rules here.  \n'));
        assert.deepEqual(out, { frontmatter: { name: 'alpha', description: 'Alpha detector', event: 'alpha-event' }, body: 'Rules here.' });
    });

    test('parses every optional field', () => {
        const out = parseDetectorFrontmatter(fm([
            ...BASE, 'cooldown: 100', 'interval: 200', 'debounce: 50', 'trigger: screen', 'enabled: false',
            'isolated: true', 'dispatchOnly: true', 'sources: [screen, "events"]', "events: ['material', window-state]",
        ]))!;
        assert.deepEqual(out.frontmatter, {
            name: 'alpha', description: 'Alpha detector', event: 'alpha-event',
            cooldown: 100, interval: 200, debounce: 50, trigger: 'screen', enabled: false,
            isolated: true, dispatchOnly: true, sources: ['screen', 'events'], events: ['material', 'window-state'],
        });
    });

    test('CRLF line endings', () => {
        const out = parseDetectorFrontmatter(fm([...BASE, 'cooldown: 5']).replace(/\n/g, '\r\n'));
        assert.equal(out?.frontmatter.name, 'alpha');
        assert.equal(out?.frontmatter.cooldown, 5);
    });

    test('a UTF-8 BOM before the opening fence is tolerated', () => {
        assert.equal(parseDetectorFrontmatter('﻿' + fm(BASE))?.frontmatter.name, 'alpha');
    });

    test('frontmatter only (no body, no trailing newline)', () => {
        const out = parseDetectorFrontmatter(`---\n${BASE.join('\n')}\n---`);
        assert.equal(out?.body, '');
    });

    test('missing fences or missing required fields return null', () => {
        assert.equal(parseDetectorFrontmatter(BASE.join('\n')), null);
        assert.equal(parseDetectorFrontmatter(''), null);
        assert.equal(parseDetectorFrontmatter('---\n---\n'), null);
        for (const drop of [0, 1, 2]) {
            assert.equal(parseDetectorFrontmatter(fm(BASE.filter((_, i) => i !== drop))), null, `without ${BASE[drop]}`);
        }
    });

    test('an empty required field does not swallow the next line', () => {
        assert.equal(parseDetectorFrontmatter(fm(['name:', 'description: d', 'event: e'])), null);
        assert.equal(parseDetectorFrontmatter(fm(['name: n', 'description:', 'event: e'])), null);
        assert.equal(parseDetectorFrontmatter(fm(['name: n', 'description: d', 'event:', 'cooldown: 5'])), null);
    });

    test('surrounding quotes are stripped; inner and unmatched quotes are preserved', () => {
        const out = parseDetectorFrontmatter(fm(['name: "quoted"', "description: 'Single quoted'", 'event: "e"']))!;
        assert.deepEqual([out.frontmatter.name, out.frontmatter.description, out.frontmatter.event], ['quoted', 'Single quoted', 'e']);
        const inner = parseDetectorFrontmatter(fm(['name: n', 'description: Says "hi"', 'event: e']))!;
        assert.equal(inner.frontmatter.description, 'Says "hi"');
        const apostrophe = parseDetectorFrontmatter(fm(['name: n', "description: It's the user's", 'event: e']))!;
        assert.equal(apostrophe.frontmatter.description, "It's the user's");
    });

    test('invalid numeric / enum / boolean values are ignored (defaults apply later)', () => {
        const out = parseDetectorFrontmatter(fm([
            ...BASE, 'cooldown: -5', 'interval: 1.5', 'debounce: soon', 'trigger: hourly', 'enabled: yes', 'isolated: 1', 'dispatchOnly: TRUE',
        ]))!;
        assert.deepEqual(Object.keys(out.frontmatter).sort(), ['description', 'event', 'name']);
    });

    test('sources: unknown values dropped; all-invalid or empty list leaves sources unset', () => {
        assert.deepEqual(parseDetectorFrontmatter(fm([...BASE, 'sources: [screen, audio]']))!.frontmatter.sources, ['screen']);
        assert.equal(parseDetectorFrontmatter(fm([...BASE, 'sources: [audio]']))!.frontmatter.sources, undefined);
        assert.equal(parseDetectorFrontmatter(fm([...BASE, 'sources: []']))!.frontmatter.sources, undefined);
        assert.equal(parseDetectorFrontmatter(fm([...BASE, 'sources: screen']))!.frontmatter.sources, undefined, 'non-list form is ignored');
    });

    test('events: blanks dropped; empty list leaves events unset', () => {
        assert.deepEqual(parseDetectorFrontmatter(fm([...BASE, 'events: [a, , b]']))!.frontmatter.events, ['a', 'b']);
        assert.equal(parseDetectorFrontmatter(fm([...BASE, 'events: []']))!.frontmatter.events, undefined);
    });

    test('unicode names and descriptions survive', () => {
        const out = parseDetectorFrontmatter(fm(['name: 检测器', 'description: Détecteur — ünïcode', 'event: événement']))!;
        assert.deepEqual([out.frontmatter.name, out.frontmatter.description, out.frontmatter.event], ['检测器', 'Détecteur — ünïcode', 'événement']);
    });

    test('a body containing --- lines is kept intact', () => {
        const out = parseDetectorFrontmatter(fm(BASE, 'Line 1\n---\nLine 2'))!;
        assert.equal(out.body, 'Line 1\n---\nLine 2');
    });

    test('the reserved task event parses like any other', () => {
        assert.equal(parseDetectorFrontmatter(fm(['name: t', 'description: d', 'event: task']))!.frontmatter.event, 'task');
    });
});

describe('loadDetectorsFromDir', () => {
    test('missing directory yields []', async () => {
        assert.deepEqual(await loadDetectorsFromDir(path.join(tmp, 'nope')), []);
    });

    test('empty directory and stray files yield []', async () => {
        fs.writeFileSync(path.join(tmp, 'README.md'), 'x');
        fs.mkdirSync(path.join(tmp, 'no-detector-file'));
        assert.deepEqual(await loadDetectorsFromDir(tmp), []);
    });

    test('defaults: cooldown 10000, interval = cooldown, debounce = interval/2, trigger interval, both sources, enabled', async () => {
        writeDetector(tmp, 'a', fm(BASE));
        writeDetector(tmp, 'b', fm(['name: b', 'description: d', 'event: e', 'cooldown: 3001']));
        writeDetector(tmp, 'c', fm(['name: c', 'description: d', 'event: e', 'cooldown: 3000', 'interval: 501']));
        writeDetector(tmp, 'd', fm(['name: d', 'description: d', 'event: e', 'interval: 0', 'debounce: 0', 'cooldown: 0']));
        const byName = Object.fromEntries((await loadDetectorsFromDir(tmp)).map((e) => [e.name, e]));
        assert.deepEqual(
            [byName.alpha.cooldownMs, byName.alpha.intervalMs, byName.alpha.debounceMs, byName.alpha.trigger, byName.alpha.sources, byName.alpha.enabled],
            [10000, 10000, 5000, 'interval', ['screen', 'events'], true],
        );
        assert.deepEqual([byName.b.cooldownMs, byName.b.intervalMs, byName.b.debounceMs], [3001, 3001, 1500]);
        assert.deepEqual([byName.c.cooldownMs, byName.c.intervalMs, byName.c.debounceMs], [3000, 501, 250]);
        assert.deepEqual([byName.d.cooldownMs, byName.d.intervalMs, byName.d.debounceMs], [0, 0, 0]);
        assert.equal(byName.alpha.filePath, path.join(tmp, 'a', 'DETECTOR.md'));
        assert.equal(byName.alpha.dirPath, path.join(tmp, 'a'));
        assert.equal(byName.alpha.body, 'Body text.');
    });

    test('malformed detectors are skipped, valid siblings load', async () => {
        writeDetector(tmp, 'good', fm(BASE));
        writeDetector(tmp, 'bad', 'no frontmatter at all');
        writeDetector(tmp, 'partial', fm(['name: x']));
        assert.deepEqual((await loadDetectorsFromDir(tmp)).map((e) => e.name), ['alpha']);
    });

    test('files over maxFileBytes are skipped', async () => {
        writeDetector(tmp, 'big', fm(BASE, 'x'.repeat(2000)));
        writeDetector(tmp, 'small', fm(['name: small', 'description: d', 'event: e']));
        assert.deepEqual((await loadDetectorsFromDir(tmp, { maxFileBytes: 500 })).map((e) => e.name), ['small']);
    });

    test('100 detectors load', async () => {
        for (let i = 0; i < 100; i++) writeDetector(tmp, `d${i}`, fm([`name: d${i}`, 'description: d', 'event: e']));
        assert.equal((await loadDetectorsFromDir(tmp)).length, 100);
    });

    test('disabled flag, isolated and dispatchOnly propagate', async () => {
        writeDetector(tmp, 'x', fm([...BASE, 'enabled: false', 'isolated: true', 'dispatchOnly: true', 'events: [material]']));
        const [e] = await loadDetectorsFromDir(tmp);
        assert.equal(e.enabled, false);
        assert.equal(e.isolated, true);
        assert.equal(e.dispatchOnly, true);
        assert.deepEqual(e.events, ['material']);
    });
});

describe('DetectorManager', () => {
    test('loads the bundled rapid-task detector plus extraDirs', async () => {
        writeDetector(tmp, 'mine', fm(BASE));
        const m = new DetectorManager({ extraDirs: [tmp] });
        await m.load();
        const names = m.getAllDetectors().map((d) => d.name);
        assert.ok(names.includes('rapid-task'), 'bundled detector');
        assert.ok(names.includes('alpha'));
        const rt = m.getDetector('rapid-task')!;
        assert.equal(rt.event, 'task');
        assert.equal(rt.isolated, true);
        assert.equal(rt.cooldownMs, 0);
    });

    test('an extraDirs detector with the same name overrides the bundled one', async () => {
        writeDetector(tmp, 'override', fm(['name: rapid-task', 'description: custom', 'event: task', 'cooldown: 42']));
        const m = new DetectorManager({ extraDirs: [tmp] });
        await m.load();
        assert.equal(m.getDetector('rapid-task')!.description, 'custom');
        assert.equal(m.getAllDetectors().filter((d) => d.name === 'rapid-task').length, 1);
    });

    test('duplicate names across extraDirs: the later directory wins', async () => {
        const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ausm-detectors2-'));
        try {
            writeDetector(tmp, 'a', fm(['name: dup', 'description: first', 'event: e']));
            writeDetector(second, 'a', fm(['name: dup', 'description: second', 'event: e']));
            const m = new DetectorManager({ extraDirs: [tmp, second] });
            await m.load();
            assert.equal(m.getDetector('dup')!.description, 'second');
        } finally {
            fs.rmSync(second, { recursive: true, force: true });
        }
    });

    test('missing / empty extraDirs are ignored', async () => {
        const m = new DetectorManager({ extraDirs: [path.join(tmp, 'missing'), tmp] });
        await m.load();
        assert.ok(m.getDetector('rapid-task'));
    });

    test('entries config disables a detector; disabled detectors are excluded from active', async () => {
        writeDetector(tmp, 'a', fm(BASE));
        writeDetector(tmp, 'b', fm(['name: beta', 'description: d', 'event: e', 'enabled: false']));
        const m = new DetectorManager({ extraDirs: [tmp], entries: { alpha: { enabled: false }, beta: { enabled: true } } });
        await m.load();
        assert.equal(m.getDetector('alpha')!.enabled, false);
        assert.equal(m.getDetector('beta')!.enabled, false, 'entries cannot force-enable a file-disabled detector');
        const active = m.getActiveDetectors().map((d) => d.name);
        assert.ok(!active.includes('alpha'));
        assert.ok(!active.includes('beta'));
        assert.equal(m.hasDetector('alpha'), false);
    });

    test('enable/disable toggles; unknown names are no-ops', async () => {
        writeDetector(tmp, 'a', fm(BASE));
        const m = new DetectorManager({ extraDirs: [tmp] });
        await m.load();
        m.disableDetector('alpha');
        assert.equal(m.hasDetector('alpha'), false);
        m.enableDetector('alpha');
        assert.equal(m.hasDetector('alpha'), true);
        m.enableDetector('ghost');
        m.disableDetector('ghost');
        assert.equal(m.getDetector('ghost'), null);
        assert.equal(m.getDetectorBody('ghost'), null);
        assert.equal(m.getDetectorBody('alpha'), 'Body text.');
        assert.equal(m.hasDetector('ghost'), false);
    });

    test('load() is idempotent', async () => {
        writeDetector(tmp, 'a', fm(BASE));
        const m = new DetectorManager({ extraDirs: [tmp] });
        await m.load();
        const n = m.getAllDetectors().length;
        writeDetector(tmp, 'b', fm(['name: late', 'description: d', 'event: e']));
        await m.load();
        assert.equal(m.getAllDetectors().length, n);
    });

    test('before load(), queries return empty results', () => {
        const m = new DetectorManager();
        assert.deepEqual(m.getAllDetectors(), []);
        assert.deepEqual(m.getActiveDetectors(), []);
    });
});

describe('YAML comments in frontmatter', () => {
    test('trailing and whole-line comments are ignored, as in the docs example', () => {
        const parsed = parseDetectorFrontmatter(fm([
            '# a stuck detector',
            'name: stuck-on-error        # required',
            'description: Notices repeated errors',
            'event: stuck                # `task` is reserved for the TaskTracker',
            'cooldown: 30000             # ms between firings',
            'interval: 30000',
            'trigger: interval           # interval | screen',
            'sources: [screen, events]   # what the model sees',
            'events: [window-state, copy-paste]  # filter',
            'isolated: false             # true = its own model call',
        ]));
        assert.ok(parsed);
        assert.deepEqual(parsed.frontmatter, {
            name: 'stuck-on-error', description: 'Notices repeated errors', event: 'stuck',
            cooldown: 30000, interval: 30000, trigger: 'interval',
            sources: ['screen', 'events'], events: ['window-state', 'copy-paste'], isolated: false,
        });
    });

    test('a # inside quotes or a word is kept', () => {
        assert.equal(stripYamlComments('description: "fires on #1 # issues"  # c'), 'description: "fires on #1 # issues"');
        assert.equal(stripYamlComments("description: 'it''s #2'"), "description: 'it''s #2'");
        assert.equal(stripYamlComments('description: issue#42'), 'description: issue#42');
        assert.equal(stripYamlComments("description: don't # c"), "description: don't");
    });
});
