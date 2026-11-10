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

test('browser extractor: odd but real-world URLs', () => {
    const ex = new BrowserMetadataExtractor();
    assert.deepEqual(ex.extract(ev({ documentPath: 'about:blank' })), {
        url: 'about:blank', scheme: 'about', hostname: '', path: 'blank',
    });
    const idn = ex.extract(ev({ documentPath: 'https://例え.jp/パス?q=1#frag' }));
    assert.equal(idn.hostname, 'xn--r8jz45g.jp');
    assert.equal(idn.path, '/%E3%83%91%E3%82%B9');
    const port = ex.extract(ev({ documentPath: 'http://localhost:5173/' }));
    assert.equal(port.hostname, 'localhost');
    assert.equal(port.path, undefined);
    const fileUrl = ex.extract(ev({ documentPath: 'file:///Users/me/My%20Docs/a.pdf' }));
    assert.equal(fileUrl.scheme, 'file');
    assert.equal(fileUrl.path, '/Users/me/My%20Docs/a.pdf');
    // garbage / empty
    assert.deepEqual(ex.extract(ev({ documentPath: '' })), {});
    assert.deepEqual(ex.extract(ev({ documentPath: 'http://' })), { url: 'http://' });
    assert.deepEqual(ex.extract(ev({ documentPath: '://x' })), { url: '://x' });
    assert.deepEqual(ex.extract(ev({ documentPath: undefined })), {});
});

test('browser extractor matching is case-insensitive on app name only', () => {
    const ex = new BrowserMetadataExtractor();
    assert.equal(ex.matches(null, 'GOOGLE CHROME'), true);
    assert.equal(ex.matches('COM.GOOGLE.CHROME', null), false);
    assert.equal(ex.matches('company.thebrowser.Browser', null), true);
    assert.equal(ex.matches(null, null), false);
    assert.equal(ex.matches('', ''), false);
});

test('IDE extractor: spaces, unicode, bad escapes, hosts, directories', () => {
    const ex = new IDEMetadataExtractor();
    assert.deepEqual(ex.extract(ev({ documentPath: 'file:///Users/me/Proj%20X/文档 notes.md' })), {
        file: '/Users/me/Proj X/文档 notes.md',
        filename: '文档 notes.md',
        extension: 'md',
    });
    // malformed percent-escape: decodeURIComponent throws → raw path kept
    assert.equal(ex.extract(ev({ documentPath: 'file:///tmp/100%ZZ.txt' })).file, '/tmp/100%ZZ.txt');
    // file://host/path → host dropped by URL parsing
    assert.equal(ex.extract(ev({ documentPath: 'file://localhost/etc/hosts' })).file, '/etc/hosts');
    // directory URL → empty filename, no extension
    assert.deepEqual(ex.extract(ev({ documentPath: 'file:///Users/me/proj/' })), {
        file: '/Users/me/proj/',
        filename: '',
    });
    // bare filename, multiple dots, trailing dot
    assert.deepEqual(ex.extract(ev({ documentPath: 'archive.tar.gz' })), {
        file: 'archive.tar.gz', filename: 'archive.tar.gz', extension: 'gz',
    });
    assert.equal(ex.extract(ev({ documentPath: '/a/b.' })).extension, '');
    assert.deepEqual(ex.extract(ev({ documentPath: '' })), {});
    assert.equal(ex.matches('com.microsoft.vscode', null), false, 'bundle ids are case-sensitive');
    assert.equal(ex.matches(null, null), false);
});

test('runExtractors ignores non-object / empty results and works without onError', () => {
    const weird: MaterialMetadataExtractor = {
        matches: () => true,
        extract: () => null as unknown as Record<string, string | null>,
    };
    const empty: MaterialMetadataExtractor = { matches: () => true, extract: () => ({}) };
    const str: MaterialMetadataExtractor = {
        matches: () => true,
        extract: () => 'x' as unknown as Record<string, string | null>,
    };
    const thrower: MaterialMetadataExtractor = { matches: () => true, extract: () => { throw 'str'; } };
    assert.equal(runExtractors([weird, empty, str, thrower], ev({})), null);
    // null values are preserved (field expected but unavailable)
    const nul: MaterialMetadataExtractor = { matches: () => true, extract: () => ({ url: null }) };
    assert.deepEqual(runExtractors([nul], ev({})), { url: null });
});

test('default extractors: VS Code file URL yields file metadata, unknown apps yield null', () => {
    const meta = runExtractors(
        DEFAULT_METADATA_EXTRACTORS,
        ev({ bundleId: 'com.microsoft.VSCode', documentPath: 'file:///src/a%20b.ts' }),
    );
    assert.deepEqual(meta, { file: '/src/a b.ts', filename: 'a b.ts', extension: 'ts' });
    assert.equal(
        runExtractors(DEFAULT_METADATA_EXTRACTORS, ev({ bundleId: 'com.apple.Terminal', documentPath: '/x' })),
        null,
    );
});
