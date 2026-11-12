/**
 * DetectorManager — loads, filters, and serves detector specs to the AUSM runtime.
 *
 * Mirrors the SkillManager pattern: scans directories for DETECTOR.md files,
 * parses YAML frontmatter + NL body, and manages enabled/disabled state.
 */

import { DetectorEntry, DetectorFrontmatter, DetectorsConfig, DetectorEntryConfig } from './types';

// ============================================================================
// Frontmatter Parser
// ============================================================================

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Read a single-line scalar `key: value`. `[ \t]*` (not `\s*`) keeps an empty
 * value from swallowing the next line; only a matching pair of surrounding
 * quotes is stripped, so `Says "hi"` keeps its closing quote.
 */
function readScalar(yamlBlock: string, key: string): string | null {
    const match = yamlBlock.match(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm'));
    if (!match) return null;
    let value = match[1];
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
        value = value.slice(1, -1);
    }
    value = value.trim();
    return value || null;
}

/**
 * Parse DETECTOR.md frontmatter and body.
 * Handles the fields specific to detectors: name, description, event, cooldown, sources, enabled.
 */
export function parseDetectorFrontmatter(raw: string): { frontmatter: DetectorFrontmatter; body: string } | null {
    const match = raw.replace(/^\uFEFF/, '').match(FRONTMATTER_RE);
    if (!match) return null;

    const yamlBlock = match[1];
    const body = match[2].trim();

    const name = readScalar(yamlBlock, 'name');
    const description = readScalar(yamlBlock, 'description');
    const event = readScalar(yamlBlock, 'event');

    if (!name || !description || !event) return null;

    const frontmatter: DetectorFrontmatter = { name, description, event };

    const cooldownMatch = yamlBlock.match(/^cooldown:\s*(\d+)\s*$/m);
    if (cooldownMatch) {
        frontmatter.cooldown = parseInt(cooldownMatch[1], 10);
    }

    const intervalMatch = yamlBlock.match(/^interval:\s*(\d+)\s*$/m);
    if (intervalMatch) {
        frontmatter.interval = parseInt(intervalMatch[1], 10);
    }

    const debounceMatch = yamlBlock.match(/^debounce:\s*(\d+)\s*$/m);
    if (debounceMatch) {
        frontmatter.debounce = parseInt(debounceMatch[1], 10);
    }

    const triggerMatch = yamlBlock.match(/^trigger:\s*(interval|screen)\s*$/m);
    if (triggerMatch) {
        frontmatter.trigger = triggerMatch[1] as 'interval' | 'screen';
    }

    const enabledMatch = yamlBlock.match(/^enabled:\s*(true|false)\s*$/m);
    if (enabledMatch) {
        frontmatter.enabled = enabledMatch[1] === 'true';
    }

    const isolatedMatch = yamlBlock.match(/^isolated:\s*(true|false)\s*$/m);
    if (isolatedMatch) {
        frontmatter.isolated = isolatedMatch[1] === 'true';
    }

    const dispatchOnlyMatch = yamlBlock.match(/^dispatchOnly:\s*(true|false)\s*$/m);
    if (dispatchOnlyMatch) {
        frontmatter.dispatchOnly = dispatchOnlyMatch[1] === 'true';
    }

    const sourcesMatch = yamlBlock.match(/^sources:\s*\[([^\]]*)\]\s*$/m);
    if (sourcesMatch) {
        const items = sourcesMatch[1].split(',').map(s => s.trim().replace(/["']/g, ''));
        const valid = items.filter((s): s is 'screen' | 'events' => s === 'screen' || s === 'events');
        if (valid.length > 0) {
            frontmatter.sources = valid;
        }
    }

    const eventsMatch = yamlBlock.match(/^events:\s*\[([^\]]*)\]\s*$/m);
    if (eventsMatch) {
        const items = eventsMatch[1].split(',').map(s => s.trim().replace(/["']/g, ''));
        const valid = items.filter(s => s.length > 0);
        if (valid.length > 0) {
            frontmatter.events = valid;
        }
    }

    return { frontmatter, body };
}

// ============================================================================
// Directory Scanner
// ============================================================================

export async function loadDetectorsFromDir(
    dirPath: string,
    opts: { maxFileBytes?: number } = {},
): Promise<DetectorEntry[]> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');

    const maxFileBytes = opts.maxFileBytes ?? 262144;
    const entries: DetectorEntry[] = [];

    let items: string[];
    try {
        items = fs.readdirSync(dirPath) as string[];
    } catch {
        return entries;
    }

    for (const item of items) {
        const detectorDir = path.join(dirPath, item);
        const detectorFile = path.join(detectorDir, 'DETECTOR.md');

        let stat;
        try {
            stat = fs.statSync(detectorDir);
        } catch {
            continue;
        }
        if (!stat.isDirectory()) continue;

        let raw: string;
        try {
            const fileStat = fs.statSync(detectorFile);
            if (fileStat.size > maxFileBytes) {
                console.warn(`[DetectorLoader] Skipping ${item}/DETECTOR.md (${fileStat.size} bytes > ${maxFileBytes} limit)`);
                continue;
            }
            raw = fs.readFileSync(detectorFile, 'utf-8') as string;
        } catch {
            continue;
        }

        const parsed = parseDetectorFrontmatter(raw);
        if (!parsed) {
            console.warn(`[DetectorLoader] Failed to parse frontmatter for ${item}/DETECTOR.md`);
            continue;
        }

        entries.push({
            name: parsed.frontmatter.name,
            description: parsed.frontmatter.description,
            event: parsed.frontmatter.event,
            frontmatter: parsed.frontmatter,
            body: parsed.body,
            dirPath: detectorDir,
            filePath: detectorFile,
            cooldownMs: parsed.frontmatter.cooldown ?? 10000,
            intervalMs: parsed.frontmatter.interval ?? parsed.frontmatter.cooldown ?? 10000,
            debounceMs: parsed.frontmatter.debounce ?? Math.floor((parsed.frontmatter.interval ?? parsed.frontmatter.cooldown ?? 10000) / 2),
            trigger: parsed.frontmatter.trigger ?? 'interval',
            enabled: parsed.frontmatter.enabled !== false,
            sources: parsed.frontmatter.sources ?? ['screen', 'events'],
            events: parsed.frontmatter.events,
            isolated: parsed.frontmatter.isolated,
            dispatchOnly: parsed.frontmatter.dispatchOnly,
        });
    }

    return entries;
}

// ============================================================================
// DetectorManager
// ============================================================================

export class DetectorManager {
    private config: DetectorsConfig;
    private detectors: Map<string, DetectorEntry> = new Map();
    private loaded = false;

    constructor(config: DetectorsConfig = {}) {
        this.config = config;
    }

    // ========================================================================
    // Loading
    // ========================================================================

    async load(): Promise<void> {
        if (this.loaded) return;

        const dirs = this.resolveDetectorDirs();
        const maxFileBytes = this.config.maxDetectorFileBytes;

        for (const dir of dirs) {
            const entries = await loadDetectorsFromDir(dir, { maxFileBytes });
            for (const entry of entries) {
                const entryConfig = this.config.entries?.[entry.name];
                if (entryConfig?.enabled === false) {
                    entry.enabled = false;
                }
                this.detectors.set(entry.name, entry);
            }
        }

        this.loaded = true;
        console.log(`[DetectorManager] Loaded ${this.detectors.size} detector(s)`);
    }

    private resolveDetectorDirs(): string[] {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require('path');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs');
        const dirs: string[] = [];
        const seen = new Set<string>();

        const addIfPopulated = (candidate: string): void => {
            if (seen.has(candidate)) return;
            try {
                const stat = fs.statSync(candidate);
                if (stat.isDirectory() && (fs.readdirSync(candidate) as string[]).length > 0) {
                    seen.add(candidate);
                    dirs.push(candidate);
                }
            } catch {
                // not found
            }
        };

        try {
            const pkg = require.resolve('@ausm/core/package.json');
            addIfPopulated(path.join(path.dirname(pkg), 'detectors'));
        } catch {
            // package.json export unavailable (e.g. running from source before install)
        }

        let dir = __dirname;
        const root = path.parse(dir).root;
        while (dir !== root) {
            addIfPopulated(path.join(dir, 'detectors'));
            dir = path.dirname(dir);
        }

        if (this.config.extraDirs) {
            for (const extra of this.config.extraDirs) {
                addIfPopulated(extra);
            }
        }

        return dirs;
    }

    // ========================================================================
    // Querying
    // ========================================================================

    getActiveDetectors(): DetectorEntry[] {
        return Array.from(this.detectors.values()).filter(d => d.enabled);
    }

    getAllDetectors(): DetectorEntry[] {
        return Array.from(this.detectors.values());
    }

    getDetector(name: string): DetectorEntry | null {
        return this.detectors.get(name) ?? null;
    }

    getDetectorBody(name: string): string | null {
        return this.detectors.get(name)?.body ?? null;
    }

    hasDetector(name: string): boolean {
        const d = this.detectors.get(name);
        return d != null && d.enabled;
    }

    // ========================================================================
    // Enable / Disable
    // ========================================================================

    enableDetector(name: string): void {
        const d = this.detectors.get(name);
        if (d) d.enabled = true;
    }

    disableDetector(name: string): void {
        const d = this.detectors.get(name);
        if (d) d.enabled = false;
    }
}
