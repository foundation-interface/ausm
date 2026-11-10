/**
 * deep_research_web — a subagent that does focused web research and returns
 * a compressed digest. Runs its own tool-use loop with Haiku 4.5 (faster +
 * cheaper than Sonnet) and only `web_search` + `web_fetch` tools.
 *
 * The parent agent's context stays clean: instead of seeing 5 web pages and
 * 15K tokens of raw content, it sees a 200–400 word digest with citation
 * indices already minted in the shared CitationRegistry.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { loadPrompt } from "./prompts.js";
import {
    type ToolContext,
    type ToolResult,
    dispatchTool,
} from "./tools.js";

const SUBAGENT_MODEL = process.env.SUBAGENT_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_STEPS = 5;
const MAX_TOKENS = 1024;

// System prompt loaded from prompts/subagent_web_system.txt.
const SUBAGENT_SYSTEM = loadPrompt("subagent_web_system");

const SUB_TOOL_SCHEMAS: Anthropic.Tool[] = [
    {
        name: "web_search",
        description:
            "Search the web (Brave). SAFE TO CALL MULTIPLE TIMES IN PARALLEL with query variants.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string" },
                top_k: { type: "number" },
            },
            required: ["query"],
        },
    },
    {
        name: "web_fetch",
        description: "Fetch full text of a URL. SAFE IN PARALLEL.",
        input_schema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
        },
    },
];

/**
 * Entry point used by the parent agent's tool dispatch.
 * NOTE: shares the parent's CitationRegistry so digest citations are valid
 * in the parent's final answer.
 */
export async function deepResearchWeb(
    input: Record<string, unknown>,
    parentCtx: ToolContext,
): Promise<{ digest: string; citations_added: number[]; steps: number }> {
    const question = String(input.question ?? "").trim();
    const grounding = String(input.grounding ?? "").trim();
    if (!question) throw new Error("question required");

    parentCtx.emit?.({
        type: "subagent_start",
        tool: "deep_research_web",
        question,
    });

    const client = new Anthropic({ apiKey: config.anthropicKey });
    const beforeIndices = new Set(parentCtx.citations.all().map((c) => c.index));

    const userPrompt =
        grounding.length > 0
            ? `# Grounding\n${grounding}\n\n# Question\n${question}`
            : `# Question\n${question}`;

    const messages: Anthropic.MessageParam[] = [
        { role: "user", content: userPrompt },
    ];

    let digest = "";
    let steps = 0;

    for (steps = 0; steps < MAX_STEPS; steps++) {
        const res = await client.messages.create({
            model: SUBAGENT_MODEL,
            max_tokens: MAX_TOKENS,
            temperature: 0.2,
            system: SUBAGENT_SYSTEM,
            tools: SUB_TOOL_SCHEMAS,
            messages,
        });

        // Collect text + tool uses.
        const text = res.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
        const toolUses = res.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        if (text) digest = text;

        if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
            break;
        }

        parentCtx.emit?.({
            type: "subagent_step",
            tool: "deep_research_web",
            detail: `step ${steps + 1}: ${toolUses.map((t) => t.name).join(", ")}`,
        });

        // Dispatch the subagent's tools in parallel against the SHARED context
        // (so citations land in the parent's registry).
        const results = await Promise.all(
            toolUses.map(async (tu): Promise<{ tool_use_id: string; content: string; is_error?: boolean }> => {
                const r: ToolResult = await dispatchTool(
                    tu.name,
                    tu.input as Record<string, unknown>,
                    parentCtx,
                    // Subagent cannot call itself.
                    async () => ({ error: "deep_research_web cannot be called from within itself" }),
                );
                return {
                    tool_use_id: tu.id,
                    content: JSON.stringify(r.ok ? r.data : { error: r.error }),
                    is_error: !r.ok,
                };
            }),
        );

        messages.push({ role: "assistant", content: res.content });
        messages.push({
            role: "user",
            content: results.map((r) => ({
                type: "tool_result" as const,
                tool_use_id: r.tool_use_id,
                content: r.content,
                ...(r.is_error ? { is_error: true } : {}),
            })),
        });
    }

    const afterIndices = parentCtx.citations.all().map((c) => c.index);
    const newlyAdded = afterIndices.filter((i) => !beforeIndices.has(i));

    parentCtx.emit?.({ type: "subagent_done", tool: "deep_research_web" });

    return {
        digest: digest || "(subagent produced no digest)",
        citations_added: newlyAdded,
        steps,
    };
}
