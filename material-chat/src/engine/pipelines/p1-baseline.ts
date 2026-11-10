import type { MemoryPipeline } from "./types.js";

/**
 * P1 — Baseline. No Tier-2 memory layer at all.
 *
 * Agent only has the base tools (personal_search, web_search, etc.) that hit
 * material_processed directly. No always-in-context block beyond user
 * identity. This is the "as if Tier-2 didn't exist" control condition.
 */
export const p1Baseline: MemoryPipeline = {
    id: 1,
    name: "p1-baseline",
    description: "No Tier-2 memory. Agent searches material_processed directly each turn.",
    tools: [],
    async alwaysInContext() {
        return "";
    },
    systemPromptExtension() {
        return "";
    },
};
