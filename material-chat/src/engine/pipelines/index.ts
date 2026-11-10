/**
 * Memory pipeline registry. Only P1 (baseline) is active.
 */

import { p1Baseline } from "./p1-baseline.js";
import type { MemoryPipeline, PipelineId } from "./types.js";

export function getActivePipeline(_requestedId?: number | null): MemoryPipeline {
    return p1Baseline;
}

export function listPipelines(): MemoryPipeline[] {
    return [p1Baseline];
}

export type { MemoryPipeline, PipelineId, ToolDef } from "./types.js";
