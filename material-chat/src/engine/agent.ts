/**
 * Main agent loop — replaces the fixed planner+retrieval+synth pipeline.
 *
 * Properties:
 *   - Tool-use loop: Sonnet decides what to call next based on what it's seen.
 *   - PARALLEL dispatch: all `tool_use` blocks in one model response run via
 *     Promise.all. The system prompt instructs the model to batch independent
 *     lookups in a single response.
 *   - SPECULATIVE WARMUP: while the model is producing the first response,
 *     a `personal_search(raw_query)` is already in flight; the tool handler
 *     reads from `warmCache` on first match.
 *   - PROMPT CACHING: system prompt + tool schema are marked
 *     `cache_control: ephemeral` so subsequent turns in the same chat session
 *     don't re-bill those tokens.
 *   - STREAMING: text tokens are emitted as they arrive; tool_use blocks
 *     become discrete trace events for the UI.
 *   - SUBAGENT: `deep_research_web` is dispatched here so the parent agent's
 *     context stays clean — only the digest comes back.
 */

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import { config } from "../config.js";
import type { Citation, RetrievalHit } from "../types.js";
import { renderSources } from "./citations.js";
import { getActivePipeline, type MemoryPipeline } from "./pipelines/index.js";
import { loadPrompt } from "./prompts.js";
import { buildToolRegistry } from "./tool-registry.js";
import {
  CitationRegistry,
  dispatchTool,
  type ToolContext,
  type ToolStreamEvent,
} from "./tools.js";
import { userContextBlock } from "./user.js";

const PREFERENCES_PATH = config.preferencesPath;

/** Read the shared preferences file once per turn. Returns "" if missing. */
async function loadPreferences(): Promise<string> {
  try {
    const raw = await fs.readFile(PREFERENCES_PATH, "utf8");
    return raw.trim();
  } catch {
    return "";
  }
}

const MAX_STEPS = 12;
const MAX_TOKENS = 4096;

// ────────────────────────────────────────────────────────────────────────────
// Public stream-event surface (replaces plan/retrieved with tool_*)
// ────────────────────────────────────────────────────────────────────────────

export type AgentStreamEvent =
  | { type: "agent_step"; step: number }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: Record<string, unknown>;
      step: number;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      step: number;
      ok: boolean;
      error?: string;
      summary: string; // short human-readable summary for the trace
    }
  | { type: "subagent"; event: ToolStreamEvent }
  | { type: "token"; text: string }
  | {
      // Emitted after each model turn — running totals so far in this query.
      type: "usage";
      step: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    }
  | { type: "citations"; citations: Citation[] }
  | {
      type: "done";
      markdown: string;
      hits: RetrievalHit[];
      citations: Citation[];
    }
  | { type: "error"; message: string };

// ────────────────────────────────────────────────────────────────────────────
// Agent system prompt — the heart of the parallel-fan-out behavior.
// LOADED FROM prompts/agent_system.txt (edit there, restart server).
// ────────────────────────────────────────────────────────────────────────────

/**
 * A short, human-readable "current date and time" block. Injected as its own
 * system block so the model can reason about "today", "recently", "next week",
 * and how old captured facts are — without us hard-coding a date into prompts.
 *
 * Rendered fresh on every request (it's volatile) and instructs the model to
 * treat the timestamp as background context, NOT something to echo back unless
 * the user asks or it's directly relevant.
 */
function currentDateTimeBlock(): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(config.timezone ? { timeZone: config.timezone } : {}),
  }).format(new Date());

  return (
    `# Current date and time\n` +
    `Right now it is ${formatted}.\n` +
    `Use this only as background context for time-relative reasoning — e.g. resolving ` +
    `"today", "yesterday", "recently", "next week", or judging how old a remembered fact is. ` +
    `Do NOT state or repeat the current date/time in your answer unless the user explicitly ` +
    `asks for it or it is directly relevant to the response.`
  );
}

async function agentSystem(
  pipeline: MemoryPipeline,
): Promise<Anthropic.TextBlockParam[]> {
  const base = loadPrompt("agent_system");
  const userBlock = userContextBlock();
  const pipelineExt = pipeline.systemPromptExtension();

  // Shared across ALL pipelines: high-level preferences/habits prose.
  // Hand-curated in data/preferences.md; lets every pipeline (including
  // baseline) share the same lens on tone, style, and decision-making.
  const prefs = await loadPreferences();

  const alwaysInCtx = await pipeline.alwaysInContext();

  const pipelineHeader = `\n\n# Active memory pipeline\nUsing pipeline ${pipeline.id} (${pipeline.name}): ${pipeline.description}\n`;

  const prefsBlock = prefs
    ? `\n\n# Preferences & habits (shared, high-level)\n${prefs}`
    : "";

  // Build a single text block with prompt caching. We put the always-in-context
  // last because it's the most volatile (will change as memory grows); the
  // prefs + pipeline-extension prefix is stable across turns in a session.
  return [
    {
      type: "text",
      text:
        base +
        userBlock +
        pipelineHeader +
        (pipelineExt ? `\n${pipelineExt}` : "") +
        prefsBlock +
        (alwaysInCtx ? `\n\n# Memory (pipeline-specific)\n${alwaysInCtx}` : ""),
      cache_control: { type: "ephemeral" },
    },
    // Volatile current date/time — deliberately AFTER the cached breakpoint so
    // it never invalidates the cached prefix above as the clock advances.
    {
      type: "text",
      text: currentDateTimeBlock(),
    },
  ];
}

// ────────────────────────────────────────────────────────────────────────────
// Agent loop
// ────────────────────────────────────────────────────────────────────────────

export interface AgentOptions {
  history?: Anthropic.MessageParam[];
}

export async function* runAgent(
  question: string,
  opts: AgentOptions = {},
): AsyncGenerator<AgentStreamEvent> {
  try {
    const client = new Anthropic({ apiKey: config.anthropicKey });

    // Resolve the active pipeline. Tools + always-in-context come from here.
    const pipeline: MemoryPipeline = getActivePipeline();
    const registry = buildToolRegistry(pipeline);

    const citations = new CitationRegistry();
    const warmCache = new Map<string, Promise<unknown>>();

    // ── Speculative warmup: fire personal_search(raw question) immediately.
    // Most queries need personal context first; this overlaps the search
    // with the model's first inference.
    const warmKey = `personal_search:${JSON.stringify({ query: question, top_k: 5 })}`;
    warmCache.set(
      warmKey,
      (async () => {
        const dummyCtx: ToolContext = { citations, warmCache: new Map() };
        const r = await dispatchTool(
          "personal_search",
          { query: question, top_k: 5 },
          dummyCtx,
          async () => ({ error: "noop" }),
        );
        if (!r.ok) throw new Error(r.error);
        return r.data;
      })(),
    );
    // Swallow the warm-cache promise rejection if model never asks for it.
    warmCache.get(warmKey)!.catch(() => {});

    const emit = (e: ToolStreamEvent) => {
      // Bridged via a closure so subagent → agent → SSE
      queuedSubagentEvents.push(e);
    };
    const queuedSubagentEvents: ToolStreamEvent[] = [];

    const ctx: ToolContext = { citations, warmCache, emit };

    const history = opts.history ?? [];
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: "user", content: question },
    ];

    let finalText = "";

    for (let step = 0; step < MAX_STEPS; step++) {
      yield { type: "agent_step", step };

      // Stream this turn's response.
      const stream = client.messages.stream({
        model: config.synthModel,
        max_tokens: MAX_TOKENS,
        temperature: 0.3,
        system: await agentSystem(pipeline),
        tools: registry.schemas,
        messages,
      });

      // Track per-step usage from the SDK stream events directly:
      //  - message_start carries input_tokens + cache_creation/read
      //  - message_delta carries output_tokens (final count)
      // final.usage is unreliable when the stop_reason is tool_use, so we
      // accumulate as we go. (We still consult final.usage as a fallback.)
      let stepInput = 0;
      let stepOutput = 0;
      let stepCacheCreate = 0;
      let stepCacheRead = 0;

      for await (const evt of stream) {
        if (
          evt.type === "content_block_delta" &&
          evt.delta.type === "text_delta"
        ) {
          yield { type: "token", text: evt.delta.text };
        } else if (evt.type === "message_start") {
          const u = evt.message.usage;
          if (u) {
            stepInput = u.input_tokens ?? 0;
            stepCacheCreate = u.cache_creation_input_tokens ?? 0;
            stepCacheRead = u.cache_read_input_tokens ?? 0;
          }
        } else if (evt.type === "message_delta") {
          const u = evt.usage;
          if (u) stepOutput = u.output_tokens ?? 0;
        }
      }

      const final = await stream.finalMessage();

      // Belt + suspenders: pull from final.usage if streamed events
      // somehow gave us nothing.
      if (stepInput === 0 && final.usage?.input_tokens)
        stepInput = final.usage.input_tokens;
      if (stepOutput === 0 && final.usage?.output_tokens)
        stepOutput = final.usage.output_tokens;
      if (stepCacheCreate === 0 && final.usage?.cache_creation_input_tokens) {
        stepCacheCreate = final.usage.cache_creation_input_tokens;
      }
      if (stepCacheRead === 0 && final.usage?.cache_read_input_tokens) {
        stepCacheRead = final.usage.cache_read_input_tokens;
      }

      yield {
        type: "usage",
        step,
        input_tokens: stepInput,
        output_tokens: stepOutput,
        cache_creation_input_tokens: stepCacheCreate,
        cache_read_input_tokens: stepCacheRead,
      };

      const turnText = final.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const toolUses = final.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      // If the model stopped without calling tools, this turn IS the answer.
      if (final.stop_reason !== "tool_use" || toolUses.length === 0) {
        finalText = turnText;
        break;
      }

      // Drain any subagent events queued from prior turns (best-effort UX).
      while (queuedSubagentEvents.length > 0) {
        yield { type: "subagent", event: queuedSubagentEvents.shift()! };
      }

      // Announce each tool call.
      for (const tu of toolUses) {
        yield {
          type: "tool_call",
          id: tu.id,
          name: tu.name,
          input: tu.input as Record<string, unknown>,
          step,
        };
      }

      // Run them in parallel via the unified registry (base + pipeline tools).
      const results = await Promise.all(
        toolUses.map(async (tu) => {
          const r = await registry.dispatch(
            tu.name,
            tu.input as Record<string, unknown>,
            ctx,
          );
          return { tu, r };
        }),
      );

      // Yield results + bridge any subagent events that fired during dispatch.
      for (const { tu, r } of results) {
        while (queuedSubagentEvents.length > 0) {
          yield { type: "subagent", event: queuedSubagentEvents.shift()! };
        }
        yield {
          type: "tool_result",
          id: tu.id,
          name: tu.name,
          step,
          ok: r.ok,
          error: r.ok ? undefined : r.error,
          summary: summarizeResult(tu.name, r.ok ? r.data : null),
        };
      }

      // Feed back to the model.
      messages.push({ role: "assistant", content: final.content });
      messages.push({
        role: "user",
        content: results.map(({ tu, r }) => ({
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: JSON.stringify(r.ok ? r.data : { error: r.error }),
          ...(r.ok ? {} : { is_error: true as const }),
        })),
      });
    }

    // Final outputs.
    const allCitations = citations.all();
    const cited = citations.keepOnlyReferenced(finalText);
    yield { type: "citations", citations: cited };

    // For backwards-compat with the existing UI hits panel.
    const hits: RetrievalHit[] = []; // Hits are captured inside tool results; UI can re-derive if needed.
    yield {
      type: "done",
      markdown: finalText + renderSources(cited.length ? cited : allCitations),
      hits,
      citations: cited.length ? cited : allCitations,
    };
  } catch (err) {
    yield { type: "error", message: (err as Error).message };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Result summarizer — short human-readable line for the UI trace
// ────────────────────────────────────────────────────────────────────────────

function summarizeResult(toolName: string, data: unknown): string {
  if (!data || typeof data !== "object") return "(no data)";
  const d = data as Record<string, unknown>;

  if (toolName === "personal_search" || toolName === "personal_recent") {
    const hits = (d.hits as unknown[]) ?? [];
    return `${hits.length} hits`;
  }
  if (toolName === "read_material") {
    const len = typeof d.text === "string" ? d.text.length : 0;
    const title = (d.title as string) ?? d.material_id;
    return `${title}: ${len} chars${d.truncated ? " (truncated)" : ""}`;
  }
  if (toolName === "web_search") {
    const hits = (d.hits as unknown[]) ?? [];
    return `${hits.length} web hits`;
  }
  if (toolName === "web_fetch") {
    const len = typeof d.text === "string" ? d.text.length : 0;
    return `fetched ${len} chars`;
  }
  if (toolName === "deep_research_web") {
    const steps = typeof d.steps === "number" ? d.steps : 0;
    const added = (d.citations_added as unknown[]) ?? [];
    return `digest from ${steps} step(s), +${added.length} sources`;
  }
  return "ok";
}
