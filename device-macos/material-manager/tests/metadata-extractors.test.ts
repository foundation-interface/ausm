import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    BrowserMetadataExtractor,
    IDEMetadataExtractor,
    DEFAULT_METADATA_EXTRACTORS,
    runExtractors,
    type MaterialMetadataExtractor,
} from '../metadata-extractors';
import type { WindowStateEventLike } from '../material-manager';

function ev(over: Partial<WindowStateEventLike>): WindowStateEventLike {
    return {
        windowId: 1,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        displayId: 1,
        title: 't',
        application: null,
        bundleId: null,
        pid: 1,
        state: 'FOCUSED',
        documentPath: null,
        ...over,
    };
}

test('browser extractor parses URL parts', () => {
    const ex = new BrowserMetadataExtractor();
    assert.equal(ex.matches('com.google.Chrome', null), true);
    assert.equal(ex.matches(null, 'Safari'), true);
    assert.equal(ex.matches('com.apple.Terminal', 'Terminal'), false);
    assert.deepEqual(ex.extract(ev({ documentPath: 'https://gist.github.com/a/b?q=1' })), {
        url: 'https://gist.github.com/a/b?q=1',
        scheme: 'https',
        hostname: 'gist.github.com',
        path: '/a/b',
    });
    // root path omitted
    assert.equal(ex.extract(ev({ documentPath: 'https://example.com/' })).path, undefined);
    // malformed URL still surfaces raw value
    assert.deepEqual(ex.extract(ev({ documentPath: 'not a url' })), { url: 'not a url' });
    assert.deepEqual(ex.extract(ev({ documentPath: null })), {});
});

test('IDE extractor decodes file:// URLs', () => {
    const ex = new IDEMetadataExtractor();
    assert.equal(ex.matches('com.microsoft.VSCode', null), true);
    assert.equal(ex.matches(null, 'Code'), false);
    assert.deepEqual(ex.extract(ev({ documentPath: 'file:///Users/me/My%20Proj/index.test.ts' })), {
        file: '/Users/me/My Proj/index.test.ts',
        filename: 'index.test.ts',
        extension: 'ts',
    });
    // dotfile has no extension
    assert.deepEqual(ex.extract(ev({ documentPath: '/home/me/.bashrc' })), {
        file: '/home/me/.bashrc',
        filename: '.bashrc',
    });
});

test('runExtractors merges matching extractors, later wins', () => {
    const a: MaterialMetadataExtractor = { matches: () => true, extract: () => ({ k: 'a', x: '1' }) };
    const b: MaterialMetadataExtractor = { matches: () => true, extract: () => ({ k: 'b' }) };
    const none: MaterialMetadataExtractor = { matches: () => false, extract: () => ({ z: 'z' }) };
    assert.deepEqual(runExtractors([a, b, none], ev({})), { k: 'b', x: '1' });
    assert.equal(runExtractors([none], ev({})), null);
    assert.equal(runExtractors([], ev({})), null);
});

test('runExtractors skips throwing extractors and reports them', () => {
    const bad: MaterialMetadataExtractor = {
        matches: () => true,
        extract: () => {
            throw new Error('boom');
        },
    };
    const badMatch: MaterialMetadataExtractor = {
        matches: () => {
            throw new Error('match boom');
        },
        extract: () => ({}),
    };
    const good: MaterialMetadataExtractor = { matches: () => true, extract: () => ({ ok: 'yes' }) };
    const errors: unknown[] = [];
    assert.deepEqual(runExtractors([bad, badMatch, good], ev({}), (e) => errors.push(e)), { ok: 'yes' });
    assert.equal(errors.length, 2);
});

test('default extractors cover browsers and IDEs', () => {
    const meta = runExtractors(
        DEFAULT_METADATA_EXTRACTORS,
        ev({ bundleId: 'com.apple.Safari', documentPath: 'https://example.com/x' }),
    );
    assert.equal(meta?.hostname, 'example.com');
});
