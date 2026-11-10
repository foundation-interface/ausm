/**
 * Builds a unified tool registry for a request: base tools (defined in
 * tools.ts) plus whatever tools the active memory pipeline contributes.
 *
 * The agent loop receives one registry per turn and uses it for both:
 *   - schemas: array of Anthropic.Tool sent to the model
 *   - dispatch(name, input, ctx): execute a tool by name
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { MemoryPipeline } from "./pipelines/index.js";
import { deepResearchWeb } from "./subagent-web.js";
import { dispatchTool, TOOL_SCHEMAS, type ToolContext, type ToolResult } from "./tools.js";

export interface ToolRegistry {
    schemas: Anthropic.Tool[];
    dispatch(
        name: string,
        input: Record<string, unknown>,
        ctx: ToolContext,
    ): Promise<ToolResult>;
}

export function buildToolRegistry(pipeline: MemoryPipeline): ToolRegistry {
    // Pipeline tools take priority on name collision (intentional —
    // pipelines can override or shadow a base tool if they want to).
    const pipelineNames = new Set(pipeline.tools.map((t) => t.schema.name));
    const baseSchemas = (TOOL_SCHEMAS as unknown as Anthropic.Tool[]).filter(
        (s) => !pipelineNames.has(s.name),
    );
    const schemas: Anthropic.Tool[] = [
        ...baseSchemas,
        ...pipeline.tools.map((t) => t.schema),
    ];

    return {
        schemas,
        async dispatch(name, input, ctx) {
            // Try pipeline tools first.
            const pipelineDef = pipeline.tools.find((t) => t.schema.name === name);
            if (pipelineDef) return pipelineDef.handler(input, ctx);

            // Fall through to the existing base dispatch (which also handles
            // the deep_research_web injection).
            return dispatchTool(name, input, ctx, deepResearchWeb);
        },
    };
}
