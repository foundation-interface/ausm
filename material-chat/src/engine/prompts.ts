/**
 * Prompt loader.
 *
 * Every system prompt for the engine lives in `prompts/<name>.txt`.
 * This file reads them at module load (cached) and strips the editor-facing
 * header so the LLM never sees the docs.
 *
 * File format:
 *
 *   # Any number of header lines starting with `#` or blank
 *   # describing what this prompt is for.
 *   ---            ← divider line (exactly three dashes on its own line)
 *   <actual prompt content>
 *
 * To change a prompt, edit the .txt file and restart the backend.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function resolvePromptsDir(): string {
    const here = typeof __dirname !== "undefined" ? __dirname : process.cwd();
    const candidates = [
        resolve(here, "../../prompts"),
        resolve(here, "../prompts"),
        resolve(here, "prompts"),
    ];
    try {
        const pkg = require.resolve("@ausm/material-chat/package.json");
        candidates.unshift(join(dirname(pkg), "prompts"));
    } catch {
        // package not linked yet
    }
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    return candidates[0];
}

const PROMPTS_DIR = resolvePromptsDir();

const cache = new Map<string, string>();

/** Load a prompt by name (no `.txt` extension). Cached. Strips the header block. */
export function loadPrompt(name: string): string {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const path = join(PROMPTS_DIR, `${name}.txt`);
    const raw = readFileSync(path, "utf8");
    const body = stripHeader(raw);
    cache.set(name, body);
    return body;
}

/** Load a prompt template and substitute `{KEY}` placeholders. */
export function loadPromptTemplate(
    name: string,
    vars: Record<string, string>,
): string {
    let out = loadPrompt(name);
    for (const [k, v] of Object.entries(vars)) {
        out = out.replaceAll(`{${k}}`, v);
    }
    return out;
}

function stripHeader(text: string): string {
    // Find the first line that is exactly `---`.
    const match = text.match(/^---\s*$/m);
    if (!match || match.index === undefined) return text.trimStart();
    const after = text.slice(match.index + match[0].length);
    return after.replace(/^\r?\n/, "").trimEnd() + "\n";
}
