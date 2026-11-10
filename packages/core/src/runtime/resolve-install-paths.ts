import fs from 'fs';
import path from 'path';

const CORE_PACKAGE = '@ausm/core';
const SCREEN_STREAM_PACKAGE = '@ausm/device-macos-screen-stream';

export function resolvePackageDir(packageName: string, fallback?: string): string | null {
    try {
        return path.dirname(require.resolve(`${packageName}/package.json`));
    } catch {
        if (fallback && fs.existsSync(fallback)) return fallback;
        return null;
    }
}

/** Directory of the installed (or workspace) `@ausm/core` package. */
export function resolveCorePackageDir(): string | null {
    return resolvePackageDir(CORE_PACKAGE, path.resolve(__dirname, '..'));
}

/**
 * Python executable. Uses an explicit path, then a repo-local `.venv`
 * (monorepo checkout only), then the system interpreter.
 */
export function resolvePythonPath(explicit?: string): string {
    if (explicit) return explicit;

    let dir = resolveCorePackageDir() ?? __dirname;
    for (let i = 0; i < 5; i++) {
        const venv = path.join(dir, '.venv', 'bin', 'python3');
        if (fs.existsSync(venv)) return venv;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Directory to add to PYTHONPATH so `import screen_stream_reader` works.
 * Prefers the copy shipped inside `@ausm/device-macos-screen-stream`, then
 * the monorepo `internal-lib` path.
 */
export function resolveScreenStreamReaderPath(explicit?: string): string | undefined {
    if (explicit) return explicit;

    const fromPackage = resolvePackageDir(SCREEN_STREAM_PACKAGE);
    if (fromPackage) {
        const vendored = path.join(fromPackage, 'python', 'screen-stream-reader');
        if (fs.existsSync(vendored)) return vendored;
    }

    const coreDir = resolveCorePackageDir();
    if (coreDir) {
        const legacy = path.resolve(coreDir, '../../device-macos/internal-lib/screen-stream-reader');
        if (fs.existsSync(legacy)) return legacy;
    }

    return undefined;
}
