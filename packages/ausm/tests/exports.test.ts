import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import Module, { createRequire } from 'module';
import { pathToFileURL } from 'url';

/**
 * Verifies the published `ausm` package surface: every subpath in the
 * exports map points at files that exist (run `npm run build` first),
 * resolves through Node's resolver, and loads with the expected API.
 */

const pkgDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
    name: string;
    main: string;
    module: string;
    types: string;
    exports: Record<string, string | Record<string, Record<string, string>>>;
    typesVersions: Record<string, Record<string, string[]>>;
};
const selfRequire = createRequire(path.join(pkgDir, 'package.json'));

// Electron-only subpaths need an electron stand-in to load under plain Node.
const electronStub = {
    app: { getPath: () => pkgDir },
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
    contextBridge: { exposed: [] as string[], exposeInMainWorld(name: string) { this.exposed.push(name); } },
    ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: async () => null },
};
const anyModule = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const originalLoad = anyModule._load;
let savedLog: typeof console.log;
before(() => {
    anyModule._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request === 'electron') return electronStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    savedLog = console.log;
    console.log = () => {};
});
after(() => {
    anyModule._load = originalLoad;
    console.log = savedLog;
});

const subpaths = Object.keys(pkg.exports).filter((k) => k !== './package.json');
const specifier = (sub: string) => (sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`);

/** Representative named exports per subpath (proves the re-export chain is wired). */
const EXPECTED: Record<string, string[]> = {
    '.': ['createTaskEvent', 'TaskStatus', 'DetectorManager', 'createDetectorEvent', 'createMaterialEvent'],
    './runtime': ['createRuntime', 'ausmRuntime', 'AUSMRuntime', 'DetectorManager'],
    './clients': ['createDetectorPipelineClient', 'DetectorPipelineClient', 'createMemoryClient', 'createMaterialClient'],
    './bridge': ['setupAUSMElectronBridge', 'setupAUSMIPCHandlers', 'AUSM_IPC_CHANNELS', 'getAUSMPreloadPath'],
    './bridge/electron': ['setupAUSMElectronBridge', 'serveAUSMScreenshotCache', 'AUSM_SCREENSHOT_SCHEME'],
    './bridge/preload': [],
    './bridge/preload-api': ['createAUSMPreloadAPI', 'exposeAUSM'],
    './material-chat': ['createApp', 'ask', 'askStream', 'config', 'MemoryStore', 'initMemory'],
};

describe('ausm package exports', () => {
    test('every exported subpath has an expectation (keeps this test in sync with package.json)', () => {
        assert.deepEqual([...subpaths].sort(), Object.keys(EXPECTED).sort());
    });

    test('main/module/types point at built files', () => {
        for (const f of [pkg.main, pkg.module, pkg.types]) {
            assert.ok(fs.existsSync(path.join(pkgDir, f)), f);
        }
    });

    for (const sub of subpaths) {
        describe(sub, () => {
            const entry = pkg.exports[sub] as Record<string, Record<string, string>>;

            test('import/require targets and their type declarations exist', () => {
                for (const cond of ['import', 'require']) {
                    for (const key of ['types', 'default']) {
                        const target = entry[cond]?.[key];
                        assert.ok(target, `${cond}.${key} declared`);
                        assert.ok(fs.existsSync(path.join(pkgDir, target)), `${cond}.${key} → ${target}`);
                    }
                }
            });

            test('typesVersions maps the subpath for older TypeScript resolvers', () => {
                if (sub === '.') return;
                const mapped = pkg.typesVersions['*'][sub.slice(2)];
                assert.ok(mapped?.length, 'typesVersions entry');
                assert.equal(path.normalize(mapped[0]), path.normalize(entry.require.types));
            });

            test('resolves via require and import conditions', () => {
                assert.equal(selfRequire.resolve(specifier(sub)), path.join(pkgDir, entry.require.default));
                const resolvedEsm = import.meta.resolve
                    ? import.meta.resolve(specifier(sub), pathToFileURL(path.join(pkgDir, 'package.json')).href)
                    : null;
                if (resolvedEsm) assert.equal(resolvedEsm, pathToFileURL(path.join(pkgDir, entry.import.default)).href);
            });

            test('loads with the expected API (CommonJS)', () => {
                const mod = selfRequire(specifier(sub)) as Record<string, unknown>;
                for (const name of EXPECTED[sub]) {
                    assert.ok(name in mod, `${specifier(sub)} exports ${name}`);
                }
            });
        });
    }

    test('ESM entries load for subpaths that do not need electron', async () => {
        for (const sub of ['.', './runtime', './clients', './material-chat']) {
            const entry = pkg.exports[sub] as Record<string, Record<string, string>>;
            const mod = await import(pathToFileURL(path.join(pkgDir, entry.import.default)).href);
            for (const name of EXPECTED[sub]) assert.ok(name in mod, `${sub} (esm) exports ${name}`);
        }
    });

    test('the default preload exposes window.ausm when loaded', () => {
        assert.ok(electronStub.contextBridge.exposed.includes('ausm'));
    });

    test('package.json is exported for tooling', () => {
        assert.equal((selfRequire(`${pkg.name}/package.json`) as { name: string }).name, 'ausm');
    });
});
