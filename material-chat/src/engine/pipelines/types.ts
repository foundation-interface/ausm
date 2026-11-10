/**
 * Pipeline interface. Each Tier-2 design (or absence thereof) implements this.
 *
 * The base agent loop (runAgent in agent.ts) calls into the active pipeline
 * to (a) merge its tools into the model's toolset, and (b) inject any always-
 * in-context block into the system prompt before each turn.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext, ToolResult } from "../tools.js";

export type PipelineId = 1;

export interface ToolDef {
    schema: Anthropic.Tool;
    handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface MemoryPipeline {
    id: PipelineId;
    name: string;
    /** Short description that appears in the agent's system prompt + UI. */
    description: string;
    /** Tools this pipeline contributes (merged on top of the base toolset). */
    tools: ToolDef[];
    /** Block prepended to the system prompt for every turn. Empty string OK. */
    alwaysInContext(): Promise<string>;
    /** Pipeline-specific guidance appended to the agent system prompt. */
    systemPromptExtension(): string;
}
