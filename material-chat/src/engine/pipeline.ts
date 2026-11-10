/**
 * pipeline.ts — public entry points for the engine.
 *
 * On the agentic_search branch this is a thin wrapper around the agent loop.
 * The old planner+retriever+synth pipeline has been replaced.
 *
 * Exposes:
 *   - askStream(question, opts) — async generator of StreamEvent for SSE
 *   - ask(question, opts)       — single-shot Promise<AnswerResult> for /ask
 */

import type { Citation, RetrievalHit, RetrievalPlan, AnswerResult } from "../types.js";
import { runAgent, type AgentStreamEvent } from "./agent.js";
import type Anthropic from "@anthropic-ai/sdk";

export interface AskOptions {
    history?: Anthropic.MessageParam[];
}

/**
 * Public SSE stream-event surface for /chat/stream and the frontend.
 * Keeps `session` event (server-emitted) and re-shapes agent events into
 * what the existing UI expects, plus the new tool_* events.
 */
export type StreamEvent =
    | { type: "session"; sessionId: string; title: string }
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
          summary: string;
      }
    | { type: "subagent"; event: { type: string; tool: string; question?: string; detail?: string } }
    | { type: "token"; text: string }
    | {
          type: "usage";
          step: number;
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
      }
    | { type: "citations"; citations: Citation[] }
    | { type: "done"; markdown: string; hits: RetrievalHit[]; citations: Citation[] }
    | { type: "error"; message: string };

export async function* askStream(
    question: string,
    opts: AskOptions = {},
): AsyncGenerator<StreamEvent> {
    for await (const evt of runAgent(question, opts)) {
        yield mapEvent(evt);
    }
}

function mapEvent(e: AgentStreamEvent): StreamEvent {
    // Agent events are already the right shape for SSE — pass through, but
    // strip out subagent's internal ToolStreamEvent variants we don't expose.
    if (e.type === "subagent") {
        const inner = e.event;
        return {
            type: "subagent",
            event: {
                type: inner.type,
                tool: inner.tool,
                ...("question" in inner ? { question: inner.question } : {}),
                ...("detail" in inner ? { detail: inner.detail } : {}),
            },
        };
    }
    return e;
}

/**
 * Non-streaming version. Collects the agent's output into a single AnswerResult.
 * Used by /ask and by any internal callers that don't need streaming.
 */
export async function ask(
    question: string,
    opts: AskOptions = {},
): Promise<AnswerResult> {
    let markdown = "";
    let citations: Citation[] = [];
    let hits: RetrievalHit[] = [];
    const timings: Record<string, number> = {};
    const t0 = Date.now();

    for await (const evt of runAgent(question, opts)) {
        if (evt.type === "done") {
            markdown = evt.markdown;
            citations = evt.citations;
            hits = evt.hits;
        } else if (evt.type === "error") {
            throw new Error(evt.message);
        }
    }

    timings.total = Date.now() - t0;
    // Backwards-compat: the old AnswerResult had a `plan` field; provide a stub.
    const plan: RetrievalPlan = {
        needPersonal: false,
        needWeb: false,
        queries: [question],
        reasoning: "agent loop (no upfront plan)",
    };
    return { question, markdown, citations, hits, plan, timings };
}
