/**
 * Replace optional native/service packages with fakes for the duration of a test file.
 * The runtime loads them lazily with require(), so intercepting Module._load is enough.
 * Any sensor package that is NOT faked is blocked, so a test can never reach real
 * helpers, event taps or the native selection addon by accident.
 */
import Module from 'module';

const BLOCKED = [
    /^@ausm\/device-macos-/,
    /^@ausm\/core\/clients$/,
    /^node-gyp-build$/,
];

export function installModuleFakes(fakes: Record<string, unknown>): () => void {
    const M = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
    const original = M._load;
    M._load = function (request: string, parent: unknown, isMain: boolean) {
        if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
        if (BLOCKED.some((re) => re.test(request))) {
            throw new Error(`blocked in tests: ${request}`);
        }
        return original.call(this, request, parent, isMain);
    };
    return () => {
        M._load = original;
    };
}
