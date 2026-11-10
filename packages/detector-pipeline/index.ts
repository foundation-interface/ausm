/**
 * @ausm/detector-pipeline
 *
 * Detector evaluation service — evaluates natural language detector specs
 * against screen frames and a live stream of user activity events.
 * Providers: Vertex AI (Gemini) or Cerebras (OpenAI-compatible).
 */

export { DetectorPipelineService, createDetectorPipeline } from './detector-pipeline';
export { VertexDetectorClient } from './vertex-client';
export { CerebrasDetectorClient, CEREBRAS_DEFAULT_MODEL, CEREBRAS_DEFAULT_BASE_URL } from './cerebras-client';

export type {
    DetectorPipelineConfig,
    DetectorPipelineEvents,
    DetectorTriggerResult,
    DetectorSpec,
    ActivityEvent,
    PromptTrace,
    DetectorProvider,
    DetectorModelClient,
    DetectorEvaluateResult,
} from './types';

export type { VertexDetectorClientConfig } from './vertex-client';
export type { CerebrasDetectorClientConfig } from './cerebras-client';
