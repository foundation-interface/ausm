/**
 * Material Metadata Extractors — Application-specific metadata extraction.
 *
 * When a material is created or updated, registered extractors are called to
 * populate `Material.appMetadata` with structured, application-specific context
 * (e.g. the current URL for browsers, the open file path for IDEs).
 *
 * This metadata flows through the entire material pipeline, giving downstream
 * consumers richer context about what the user is looking at beyond just the
 * window title.
 *
 * ## Extensibility
 *
 * Implement the `MaterialMetadataExtractor` interface and pass instances via
 * `MaterialManagerConfig.metadataExtractors`. To augment the defaults:
 *
 * ```ts
 * import { DEFAULT_METADATA_EXTRACTORS, type MaterialMetadataExtractor } from '@ausm/device-macos-material-manager';
 *
 * class SlackMetadataExtractor implements MaterialMetadataExtractor {
 *   matches(bundleId) { return bundleId === 'com.tinyspeck.slackmacgap'; }
 *   extract(event) { return { channel: parseChannelFromTitle(event.title) }; }
 * }
 *
 * const mm = new MaterialManager({
 *   metadataExtractors: [...DEFAULT_METADATA_EXTRACTORS, new SlackMetadataExtractor()],
 * });
 * ```
 */

import type { WindowStateEventLike } from './material-manager';

// ── Interface ──────────────────────────────────────────────────────────────

/**
 * Extracts application-specific metadata from a window event.
 *
 * Extractors are called synchronously whenever a material is created or
 * refreshed (APPEAR, FOCUSED, TITLE_CHANGED). Keep `extract()` fast — do
 * not perform I/O, network requests, or blocking work.
 */
export interface MaterialMetadataExtractor {
    /**
     * Return true if this extractor applies to the given application.
     * Called for every window event — must be fast.
     */
    matches(bundleId: string | null, application: string | null): boolean;

    /**
     * Extract metadata from the window event.
     *
     * Return a flat, string-valued record. Null values are allowed (the field
     * was expected but unavailable). An empty record means no metadata was found.
     * All values will be coerced to strings in prompt rendering.
     */
    extract(event: WindowStateEventLike): Record<string, string | null>;
}

// ── Browser extractor ──────────────────────────────────────────────────────

/**
 * macOS bundle IDs for known browsers.
 * The AXDocument attribute (exposed as `documentPath` on window events) is the
 * current page URL for all major browsers, making this data zero-cost to capture.
 */
const BROWSER_BUNDLE_IDS = new Set([
    'com.google.Chrome',
    'com.google.Chrome.beta',
    'com.google.Chrome.canary',
    'com.apple.Safari',
    'com.apple.SafariTechnologyPreview',
    'org.mozilla.firefox',
    'org.mozilla.nightly',
    'com.brave.Browser',
    'com.brave.Browser.nightly',
    'com.microsoft.edgemac',
    'com.microsoft.edgemac.Beta',
    'com.microsoft.edgemac.Dev',
    'company.thebrowser.Browser',   // Arc
    'com.operasoftware.Opera',
    'com.vivaldi.Vivaldi',
]);

const BROWSER_APP_NAMES = new Set([
    'google chrome',
    'chrome',
    'safari',
    'firefox',
    'brave browser',
    'microsoft edge',
    'arc',
    'opera',
    'vivaldi',
]);

/**
 * Extracts browser-specific metadata from the window event.
 *
 * Privacy: `url` is the full page URL, including any query string or
 * fragment (which can carry tokens).  Supply your own extractor list via
 * `MaterialManagerConfig.metadataExtractors` if that is not acceptable.
 *
 * Fields populated:
 *   - `url`      — the current page URL (from AXDocument / documentPath)
 *   - `scheme`   — URL scheme ("https", "http", "file", …)
 *   - `hostname` — URL hostname as-is (e.g. "gist.github.com")
 *   - `path`     — URL path when non-trivial (omitted for root "/")
 */
export class BrowserMetadataExtractor implements MaterialMetadataExtractor {
    matches(bundleId: string | null, application: string | null): boolean {
        if (bundleId && BROWSER_BUNDLE_IDS.has(bundleId)) return true;
        if (application && BROWSER_APP_NAMES.has(application.toLowerCase())) return true;
        return false;
    }

    extract(event: WindowStateEventLike): Record<string, string | null> {
        const url = event.documentPath ?? null;
        if (!url) return {};

        const meta: Record<string, string | null> = { url };

        try {
            const parsed = new URL(url);
            meta['scheme'] = parsed.protocol.replace(/:$/, '');
            meta['hostname'] = parsed.hostname;
            if (parsed.pathname && parsed.pathname !== '/') {
                meta['path'] = parsed.pathname;
            }
        } catch {
            // documentPath is not a well-formed URL — still surface the raw value
        }

        return meta;
    }
}

// ── IDE / code-editor extractor ────────────────────────────────────────────

const IDE_BUNDLE_IDS = new Set([
    'com.microsoft.VSCode',
    'com.microsoft.VSCodeInsiders',
    'com.apple.dt.Xcode',
    'com.jetbrains.intellij',
    'com.jetbrains.intellij.ce',
    'com.jetbrains.pycharm',
    'com.jetbrains.pycharm.ce',
    'com.jetbrains.webstorm',
    'com.jetbrains.goland',
    'com.jetbrains.clion',
    'com.jetbrains.rubymine',
    'com.sublimetext.4',
    'com.sublimetext.3',
    'com.panic.Nova',
    'com.github.atom',
    'dev.zed.zed',
    'dev.zed.zed-preview',
]);

/**
 * Extracts IDE/editor-specific metadata.
 *
 * Fields populated:
 *   - `file`      — absolute path of the currently open document
 *   - `filename`  — basename (e.g. "index.ts")
 *   - `extension` — file extension without dot (e.g. "ts")
 */
export class IDEMetadataExtractor implements MaterialMetadataExtractor {
    matches(bundleId: string | null, _application: string | null): boolean {
        return !!bundleId && IDE_BUNDLE_IDS.has(bundleId);
    }

    extract(event: WindowStateEventLike): Record<string, string | null> {
        const docPath = event.documentPath ?? null;
        if (!docPath) return {};

        const meta: Record<string, string | null> = {};

        // Resolve file:// URL → POSIX path
        let filePath = docPath;
        if (docPath.startsWith('file://')) {
            try {
                filePath = decodeURIComponent(new URL(docPath).pathname);
            } catch {
                filePath = docPath.replace(/^file:\/\//, '');
            }
        }

        meta['file'] = filePath;

        const lastSlash = filePath.lastIndexOf('/');
        const filename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
        meta['filename'] = filename;

        const dotIdx = filename.lastIndexOf('.');
        if (dotIdx > 0) {
            meta['extension'] = filename.slice(dotIdx + 1);
        }

        return meta;
    }
}

// ── Default registry ───────────────────────────────────────────────────────

/**
 * Default metadata extractor registry, registered in MaterialManager when
 * `MaterialManagerConfig.metadataExtractors` is not provided.
 *
 * Includes: BrowserMetadataExtractor, IDEMetadataExtractor.
 */
export const DEFAULT_METADATA_EXTRACTORS: MaterialMetadataExtractor[] = [
    new BrowserMetadataExtractor(),
    new IDEMetadataExtractor(),
];

// ── Utility ────────────────────────────────────────────────────────────────

/**
 * Run all matching extractors against a window event and merge their results.
 * Later extractors in the array win on key conflicts.
 *
 * An extractor that throws (or returns a non-object) is skipped; `onError`
 * is called with the thrown value so the caller can log it.
 */
export function runExtractors(
    extractors: MaterialMetadataExtractor[],
    event: WindowStateEventLike,
    onError?: (err: unknown, extractor: MaterialMetadataExtractor) => void,
): Record<string, string | null> | null {
    const merged: Record<string, string | null> = {};
    let hasData = false;

    for (const ext of extractors) {
        let result: Record<string, string | null>;
        try {
            if (!ext.matches(event.bundleId ?? null, event.application ?? null)) continue;
            result = ext.extract(event);
        } catch (err) {
            onError?.(err, ext);
            continue;
        }
        if (!result || typeof result !== 'object' || Object.keys(result).length === 0) continue;
        Object.assign(merged, result);
        hasData = true;
    }

    return hasData ? merged : null;
}
