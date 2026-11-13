/**
 * Tool definitions for the agent loop.
 *
 * Each tool has:
 *   - an Anthropic tool schema (name + description + input_schema)
 *   - a handler that executes it and returns a value the model can read
 *
 * The handler receives a shared CitationRegistry so every tool that surfaces
 * a "source" (a personal material or a web URL) can register it and get back
 * a stable [N] index. The model is told to cite using those indices.
 *
 * Tool descriptions intentionally encourage parallel use — "SAFE TO CALL
 * MULTIPLE TIMES IN PARALLEL with different queries". The Anthropic API
 * defaults to allowing parallel tool_use blocks within a single response.
 */

import { config } from "../config.js";
import type { Citation, PersonalHit, WebHit } from "../types.js";
import { JinaReaderFetcher } from "../retrieval/web/fetch.js";
import { BraveProvider } from "../retrieval/web/providers/brave.js";
import { getMemoryStore } from "../memory/index.js";
import { AusmMemoryClient } from "../retrieval/personal/ausm.js";

// ────────────────────────────────────────────────────────────────────────────
// Citation registry
// ────────────────────────────────────────────────────────────────────────────

export class CitationRegistry {
    private byRef = new Map<string, Citation>();
    private order: Citation[] = [];

    /** Add or fetch the index for a source. Returns the [N] index. */
    register(c: Omit<Citation, "index">): number {
        const key = `${c.kind}:${c.ref}`;
        const existing = this.byRef.get(key);
        if (existing) return existing.index;
        const index = this.order.length + 1;
        const cite: Citation = { ...c, index };
        this.byRef.set(key, cite);
        this.order.push(cite);
        return index;
    }

    all(): Citation[] {
        return [...this.order];
    }

    /** Used by the agent if it wants to filter to only-cited sources. */
    keepOnlyReferenced(text: string): Citation[] {
        const seen = new Set<number>();
        for (const m of text.matchAll(/\[(\d+)\]/g)) seen.add(Number(m[1]));
        return this.order.filter((c) => seen.has(c.index));
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool context (what every tool handler sees)
// ────────────────────────────────────────────────────────────────────────────

export interface ToolContext {
    citations: CitationRegistry;
    /** Speculative-warmup cache. Key: `${tool}:${json(input)}`. */
    warmCache: Map<string, Promise<unknown>>;
    /** Emits events for the agent stream — lets tools surface progress. */
    emit?: (event: ToolStreamEvent) => void;
}

export type ToolStreamEvent =
    | { type: "subagent_start"; tool: string; question: string }
    | { type: "subagent_step"; tool: string; detail: string }
    | { type: "subagent_done"; tool: string };

// ────────────────────────────────────────────────────────────────────────────
// Tool schemas (sent to Anthropic verbatim)
// ────────────────────────────────────────────────────────────────────────────

export const TOOL_SCHEMAS = [
    {
        name: "personal_search",
        description:
            "Search the user's captured personal materials (OCR'd screen content — Slack, browser tabs, docs, editors, etc.). " +
            "Use for anything about the user's life, projects, conversations, recent activity, or facts grounded in their own files. " +
            "SAFE TO CALL MULTIPLE TIMES IN PARALLEL with different queries — issue 2–4 query variants at once if you're not sure which phrasing will match. " +
            "Each hit includes a citation index [N] you can use directly in your final answer.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Natural-language search query." },
                top_k: { type: "number", description: "Max hits to return (default 5)." },
            },
            required: ["query"],
        },
    },
    {
        name: "read_material",
        description:
            "Get the FULL cleaned OCR text of a personal material by its id. " +
            "Use when a snippet from personal_search looks relevant and you need the rest. " +
            "Material ids look like 'mat_xxxxxxx'. SAFE IN PARALLEL.",
        input_schema: {
            type: "object",
            properties: {
                material_id: { type: "string" },
            },
            required: ["material_id"],
        },
    },
    {
        name: "personal_recent",
        description:
            "List the materials the user engaged with in a time range, most-recent first. " +
            "Use for 'what was I doing yesterday' / 'this week' / temporal queries. " +
            "Pass ISO datetimes like '2026-03-11 00:00:00'. Returns titles + ids, not full text.",
        input_schema: {
            type: "object",
            properties: {
                since: { type: "string", description: "ISO datetime lower bound (inclusive)." },
                until: { type: "string", description: "ISO datetime upper bound (inclusive). Optional." },
                top_k: { type: "number", description: "Max results (default 20)." },
                bundle: { type: "string", description: "Optional macOS bundle id filter (e.g. 'com.tinyspeck.slackmacgap')." },
            },
            required: ["since"],
        },
    },
    {
        name: "web_search",
        description:
            "Search the public web (Brave). Use ONLY AFTER you've gathered any relevant personal context " +
            "that could refine your query — e.g., if the question references a specific school/project/person, " +
            "search personal materials first to ground the web query in real names. " +
            "SAFE TO CALL MULTIPLE TIMES IN PARALLEL with different query variants. " +
            "Returns snippets only; use web_fetch for full content.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string" },
                top_k: { type: "number", description: "Default 5." },
            },
            required: ["query"],
        },
    },
    {
        name: "web_fetch",
        description:
            "Fetch and clean the full text of a specific URL. Use after web_search to drill into the most relevant result. SAFE IN PARALLEL.",
        input_schema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
        },
    },
    {
        name: "deep_research_web",
        description:
            "Delegate a web research question to a focused subagent (Haiku). Use when a question is " +
            "web-heavy and needs multi-query exploration (e.g., 'find the official commencement date for " +
            "the user's specific program'). You provide the question and any personal grounding; the subagent " +
            "fans out web queries in parallel, fetches the best pages, and returns a compressed digest with " +
            "citations. Slower than web_search (~3–5s) but better quality for non-trivial questions.",
        input_schema: {
            type: "object",
            properties: {
                question: { type: "string", description: "The specific question to research." },
                grounding: {
                    type: "string",
                    description: "Optional context already established from personal materials (people, projects, dates, affiliations). Pass anything that will help the subagent form specific web queries.",
                },
            },
            required: ["question"],
        },
    },
] as const;

// ────────────────────────────────────────────────────────────────────────────
// Tool dispatch
// ────────────────────────────────────────────────────────────────────────────

type ToolInput = Record<string, unknown>;
export type ToolResult =
    | { ok: true; data: unknown }
    | { ok: false; error: string };

/**
 * Run a tool by name. Pulls from speculative warm cache when possible.
 * `deepResearchWeb` is injected to avoid a circular dependency with subagent.ts.
 */
export async function dispatchTool(
    name: string,
    input: ToolInput,
    ctx: ToolContext,
    deepResearchWeb: (input: ToolInput, ctx: ToolContext) => Promise<unknown>,
): Promise<ToolResult> {
    const cacheKey = `${name}:${JSON.stringify(input)}`;
    if (ctx.warmCache.has(cacheKey)) {
        try {
            const data = await ctx.warmCache.get(cacheKey)!;
            return { ok: true, data };
        } catch (err) {
            // fall through to real call
            ctx.warmCache.delete(cacheKey);
        }
    }

    try {
        let data: unknown;
        switch (name) {
            case "personal_search":
                data = await runPersonalSearch(input, ctx);
                break;
            case "read_material":
                data = await runReadMaterial(input, ctx);
                break;
            case "personal_recent":
                data = await runPersonalRecent(input, ctx);
                break;
            case "web_search":
                data = await runWebSearch(input, ctx);
                break;
            case "web_fetch":
                data = await runWebFetch(input, ctx);
                break;
            case "deep_research_web":
                data = await deepResearchWeb(input, ctx);
                break;
            default:
                return { ok: false, error: `Unknown tool: ${name}` };
        }
        return { ok: true, data };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Individual tool handlers
// ────────────────────────────────────────────────────────────────────────────

const ausm = new AusmMemoryClient();
const braveProvider = new BraveProvider();
const jinaFetcher = new JinaReaderFetcher();

async function runPersonalSearch(input: ToolInput, ctx: ToolContext) {
    const query = String(input.query ?? "").trim();
    const topK = numOr(input.top_k, 5);
    if (!query) throw new Error("query required");

    const hits: PersonalHit[] = await ausm.search(query, topK);
    const out = hits.map((h) => ({
        citation: ctx.citations.register({
            kind: "personal",
            ref: h.id,
            title: h.title ?? h.id,
            url: `${config.materialUrlScheme}${h.id}`,
        }),
        material_id: h.id,
        title: h.title,
        application: h.application,
        last_seen: h.lastSeen,
        frame_count: h.frameCount,
        snippet: h.snippet,
    }));
    return { hits: out };
}

async function runReadMaterial(input: ToolInput, ctx: ToolContext) {
    const id = String(input.material_id ?? "").trim();
    if (!id) throw new Error("material_id required");
    const m = getMemoryStore().getMaterial(id);
    if (!m) throw new Error(`material not found: ${id}`);
    const citation = ctx.citations.register({
        kind: "personal",
        ref: m.material_id,
        title: m.title ?? m.material_id,
        url: `${config.materialUrlScheme}${m.material_id}`,
    });
    // Truncate full text aggressively — the model rarely needs more than 4k chars.
    const text = (m.cleaned_text ?? "").slice(0, 4000);
    return {
        citation,
        material_id: m.material_id,
        title: m.title,
        application: m.bundle_id,
        first_seen: m.first_seen,
        last_seen: m.last_seen,
        frame_count: m.frame_count,
        text,
        truncated: (m.cleaned_text?.length ?? 0) > 4000,
    };
}

async function runPersonalRecent(input: ToolInput, ctx: ToolContext) {
    const hits = getMemoryStore().recent({
        since: String(input.since ?? "") || null,
        until: input.until ? String(input.until) : null,
        topK: numOr(input.top_k, 20),
        bundle: input.bundle ? String(input.bundle) : null,
    });
    return {
        hits: hits.map((h) => ({
            citation: ctx.citations.register({
                kind: "personal",
                ref: h.material_id,
                title: h.title ?? h.material_id,
                url: `${config.materialUrlScheme}${h.material_id}`,
            }),
            material_id: h.material_id,
            title: h.title,
            application: h.bundle_id,
            first_seen: h.first_seen,
            last_seen: h.last_seen,
            frame_count: h.frame_count,
        })),
    };
}

async function runWebSearch(input: ToolInput, ctx: ToolContext) {
    const query = String(input.query ?? "").trim();
    const topK = numOr(input.top_k, 5);
    if (!query) throw new Error("query required");
    const results = await braveProvider.search(query, topK);
    return {
        hits: results.map((r) => ({
            citation: ctx.citations.register({
                kind: "web",
                ref: r.url,
                title: r.title,
                url: r.url,
            }),
            title: r.title,
            url: r.url,
            snippet: r.snippet,
        })),
    };
}

async function runWebFetch(input: ToolInput, ctx: ToolContext) {
    const url = String(input.url ?? "").trim();
    if (!url) throw new Error("url required");
    const text = await jinaFetcher.fetch(url);
    const citation = ctx.citations.register({
        kind: "web",
        ref: url,
        title: url,
        url,
    });
    // Bound the content the model sees per call.
    return { citation, url, text: text.slice(0, 6000), truncated: text.length > 6000 };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function numOr(v: unknown, fallback: number): number {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
        const n = parseFloat(v);
        if (Number.isFinite(n)) return n;
    }
    return fallback;
}

// Re-export for callers
export type { PersonalHit, WebHit };
