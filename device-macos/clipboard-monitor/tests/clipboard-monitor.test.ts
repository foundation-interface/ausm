import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { CopyPasteAction, CopyPasteContentType, type CopyPasteEvent } from '@ausm/core';
import { ClipboardMonitorService, createClipboardMonitor, type ClipboardMonitorConfig } from '../index';
import { makeTempDir, writeFakeHelper, scriptedLines, waitFor, nextEvent, quietConsole, tricky } from '../../test-support/fakes';

const dir = makeTempDir();
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function feed(lines: Record<string, unknown>[], config: ClipboardMonitorConfig = {}) {
    const svc = new ClipboardMonitorService(config);
    const events: CopyPasteEvent[] = [];
    const errors: string[] = [];
    svc.on('copy-paste-event', (e) => events.push(e));
    svc.on('error', (e) => errors.push(e.message));
    for (const l of lines) (svc as any).handleNativeEvent(l);
    return { svc, events, errors };
}

test('clipboard_changed maps to a COPY event with all fields', () => {
    const { events } = feed([
        { type: 'ready' },
        { type: 'clipboard_changed', contentType: 'TEXT', content: 'hello', changeCount: 17, timestamp: 1234 },
    ]);
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.kind, 'copyPaste');
    assert.equal(e.action, CopyPasteAction.COPY);
    assert.equal(e.contentType, CopyPasteContentType.TEXT);
    assert.equal(e.content, 'hello');
    assert.equal(e.contentPaths, null);
    assert.equal(e.changeCount, 17);
    assert.equal(e.timestamp, 1234);
    assert.equal(e.displayID, null);
    assert.match(e.eventID ?? '', /^cp_\d+_[a-z0-9]+$/);
});

test('every content type value is accepted; unknown/missing ones become null', () => {
    for (const t of Object.values(CopyPasteContentType)) {
        assert.equal(feed([{ type: 'clipboard_changed', contentType: t }]).events[0].contentType, t);
    }
    for (const bad of ['text', 'PDF', '', undefined, 3, null]) {
        assert.equal(feed([{ type: 'clipboard_changed', contentType: bad }]).events[0].contentType, null, String(bad));
    }
});

test('text content round-trips unchanged: empty, emoji, RTL, CJK, combining, control chars, 2 MiB', () => {
    for (const [name, text] of Object.entries(tricky)) {
        const e = feed([{ type: 'clipboard_changed', contentType: 'TEXT', content: text }]).events[0];
        assert.equal(e.content, text, name);
    }
});

test('file paths: strings kept, non-strings filtered, empty list → null', () => {
    const paths = ['/Users/a/ファイル.txt', '/tmp/with space', '/tmp/🙂.png'];
    const e1 = feed([{ type: 'clipboard_changed', contentType: 'FILE', content: paths.join('\n'), contentPaths: paths }]).events[0];
    assert.deepEqual(e1.contentPaths, paths);
    assert.equal(e1.content, paths.join('\n'));

    const e2 = feed([{ type: 'clipboard_changed', contentType: 'FILE', contentPaths: ['/a', 3, null, { p: 1 }, '/b'] }]).events[0];
    assert.deepEqual(e2.contentPaths, ['/a', '/b']);

    assert.equal(feed([{ type: 'clipboard_changed', contentPaths: [] }]).events[0].contentPaths, null);
    assert.equal(feed([{ type: 'clipboard_changed', contentPaths: 'not-an-array' }]).events[0].contentPaths, null);
    assert.equal(
        feed([{ type: 'clipboard_changed', contentPaths: [1, null, false] }]).events[0].contentPaths,
        null,
        'a list with no usable paths is reported as no paths, not as an empty list',
    );
});

test('includeContent=false never exposes content even if the helper sends it', () => {
    const { events } = feed(
        [{ type: 'clipboard_changed', contentType: 'FILE', content: 'secret', contentPaths: ['/secret'], changeCount: 1 }],
        { includeContent: false },
    );
    assert.equal(events[0].content, null);
    assert.equal(events[0].contentPaths, null);
    assert.equal(events[0].contentType, CopyPasteContentType.FILE);
    assert.equal(events[0].changeCount, 1);
});

test('concealed pasteboards (password managers) carry no content', () => {
    const e = feed([{ type: 'clipboard_changed', contentType: 'TEXT', concealed: true }]).events[0];
    assert.equal(e.content, null);
    assert.equal(e.contentType, CopyPasteContentType.TEXT);
});

test('non-string content, bad changeCount and timestamp are normalised', () => {
    const before = Date.now();
    const e = feed([{ type: 'clipboard_changed', content: 42, changeCount: '5', timestamp: null }]).events[0];
    assert.equal(e.content, null);
    assert.equal(e.changeCount, null);
    assert.ok(e.timestamp >= before);
    assert.equal(feed([{ type: 'clipboard_changed', changeCount: 0 }]).events[0].changeCount, 0);
});

test('duplicate change counts are passed through (dedupe is the helper\'s job)', () => {
    const { events } = feed([
        { type: 'clipboard_changed', changeCount: 3 },
        { type: 'clipboard_changed', changeCount: 3 },
        { type: 'clipboard_changed', changeCount: 2 }, // out of order
    ]);
    assert.deepEqual(events.map((e) => e.changeCount), [3, 3, 2]);
    assert.equal(new Set(events.map((e) => e.eventID)).size, 3);
});

test('unknown and ready messages produce no events or errors', () => {
    const { events, errors } = feed([{ type: 'ready' }, { type: 'paste' }, { type: 'error', message: 'x' }]);
    assert.equal(events.length, 0);
    assert.equal(errors.length, 0);
});

test('debug logging never includes clipboard contents', async () => {
    const logs: string[] = [];
    const saved = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
    try {
        feed([
            { type: 'clipboard_changed', contentType: 'TEXT', content: 'TOP-SECRET-CONTENT', contentTruncated: true },
            { type: 'clipboard_changed', contentType: 'FILE', contentPaths: ['/Users/x/TOP-SECRET-PATH'] },
            { type: 'clipboard_changed', contentType: 'TEXT', concealed: true },
        ], { debug: true });
    } finally {
        console.log = saved;
    }
    assert.ok(logs.length >= 3);
    assert.ok(logs.every((l) => !l.includes('TOP-SECRET')));
    assert.ok(logs.some((l) => /18 chars, truncated/.test(l)));
    assert.ok(logs.some((l) => /1 files/.test(l)));
    assert.ok(logs.some((l) => /concealed/.test(l)));
});

// ── Process lifecycle with a fake helper script ────────────────────────────

async function argvFor(config: ClipboardMonitorConfig, name: string): Promise<string[]> {
    const argvFile = path.join(dir, `${name}.json`);
    const helperPath = writeFakeHelper(dir, name, scriptedLines([], { argvFile }));
    const svc = new ClipboardMonitorService({ ...config, helperPath });
    svc.start();
    try {
        await waitFor(() => fs.existsSync(argvFile), 5000, 'argv file');
    } finally {
        svc.stop();
    }
    return JSON.parse(fs.readFileSync(argvFile, 'utf8'));
}

test('helper arguments reflect privacy and size options', async () => {
    assert.deepEqual(await argvFor({}, 'cb-a'), []);
    assert.deepEqual(await argvFor({ includeContent: false }, 'cb-b'), ['--no-content']);
    assert.deepEqual(await argvFor({ maxContentBytes: 1024.9 }, 'cb-c'), ['--max-content-bytes', '1024']);
    assert.deepEqual(await argvFor({ maxContentBytes: 0 }, 'cb-d'), []);
    assert.deepEqual(await argvFor({ maxContentBytes: -5 }, 'cb-e'), []);
    assert.deepEqual(
        await argvFor({ includeContent: false, maxContentBytes: 10 }, 'cb-f'),
        ['--no-content', '--max-content-bytes', '10'],
    );
});

test('end-to-end: lines from the helper become events; stop() is clean', async () => {
    const helperPath = writeFakeHelper(dir, 'cb-e2e', scriptedLines([
        { type: 'ready' },
        '{"type":"clipboard_changed",', // torn line
        { type: 'clipboard_changed', contentType: 'URL', content: 'https://example.com/ü', changeCount: 1 },
        { type: 'clipboard_changed', contentType: 'IMAGE', changeCount: 2, newField: { a: 1 } },
    ]));
    const svc = createClipboardMonitor({ helperPath });
    const events: CopyPasteEvent[] = [];
    const statuses: string[] = [];
    svc.on('copy-paste-event', (e) => events.push(e));
    svc.on('status', (s) => statuses.push(s));
    assert.equal(svc.start(), true);
    await waitFor(() => events.length === 2, 5000, 'two events');
    assert.deepEqual(events.map((e) => [e.contentType, e.changeCount]), [
        [CopyPasteContentType.URL, 1],
        [CopyPasteContentType.IMAGE, 2],
    ]);
    assert.equal(events[0].content, 'https://example.com/ü');
    svc.stop();
    assert.deepEqual(statuses, ['started', 'stopped']);
    assert.equal(svc.isRunning(), false);
});

test('missing helper: error + stopped, can be restarted later', async () => {
    const svc = new ClipboardMonitorService({ helperPath: path.join(dir, 'nope') });
    const errors: string[] = [];
    svc.on('error', (e) => errors.push(e.message));
    const statuses: string[] = [];
    svc.on('status', (s) => statuses.push(s));
    svc.start();
    await waitFor(() => statuses.includes('stopped'), 5000, 'stopped');
    assert.match(errors[0], /ENOENT/);
    assert.equal(svc.isRunning(), false);
    // start() again re-spawns (and fails again) rather than claiming to be running.
    svc.start();
    await waitFor(() => statuses.filter((s) => s === 'stopped').length === 2, 5000, 'second stop');
});

test('no error listener: helper failure warns instead of crashing the host', async () => {
    await quietConsole(async () => {
        const svc = new ClipboardMonitorService({ helperPath: path.join(dir, 'nope2') });
        const stopped = nextEvent(svc, 'status').then(() => nextEvent(svc, 'status'));
        svc.start();
        assert.equal(await stopped, 'stopped');
    });
});
