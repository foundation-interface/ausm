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
 * Prefers `build/<publishedName>` (copied by `npm run build:swift`), then the
 * SwiftPM outputs for in-repo development: the universal build
 * (`swift/.build/apple/Products/Release`) and the host-arch release build.
 */
export function resolveHelperBinary(
    fromDir: string,
    publishedName: string,
    swiftProductName: string,
): string {
    const root = findPackageRoot(fromDir);
    const candidates = [
        path.join(root, 'build', publishedName),
        path.join(root, 'swift', '.build', 'apple', 'Products', 'Release', swiftProductName),
        path.join(root, 'swift', '.build', 'release', swiftProductName),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}
