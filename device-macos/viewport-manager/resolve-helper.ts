import fs from 'fs';
import path from 'path';

/** Walk up from startDir until a directory containing package.json is found. */
export function findPackageRoot(startDir: string): string {
    let dir = path.resolve(startDir);
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    return path.resolve(startDir, '..');
}

/**
 * Locate a Swift helper after npm install or a local `swift build`.
 * Prefers `build/<publishedName>` (copied at package build time), then
 * the local `swift build` outputs for in-repo development.
 */
export function resolveHelperBinary(
    fromDir: string,
    publishedName: string,
    swiftProductName: string,
): string {
    const root = findPackageRoot(fromDir);
    const candidates = [
        path.join(root, 'build', publishedName),
        path.join(root, 'swift', '.build', 'release', swiftProductName),
        // `swift build -c release --arch arm64 --arch x86_64` (universal) output
        path.join(root, 'swift', '.build', 'apple', 'Products', 'Release', swiftProductName),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}
