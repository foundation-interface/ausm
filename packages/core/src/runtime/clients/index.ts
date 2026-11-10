/**
 * @ausm/core/clients
 * 
 * Native service clients for the AUSM runtime.
 * These bridge the runtime to external services (native addons, subprocesses, sockets).
 */

// Selection Client (Native)
export { SelectionClient, createSelectionClient } from './text-selection-client';
export type { SelectionClientOptions, SelectionClientEvents } from './text-selection-client';

// Viewport Client (Native - Window lifecycle monitoring)
export { ViewportClient, createViewportClient } from './viewport-client';
export type { ViewportClientOptions, ViewportClientEvents } from './viewport-client';

// Text Input Client (Text input monitor service)
export { TextInputClient, createTextInputClient } from './text-input-client';
export type { TextInputClientOptions, TextInputClientEvents } from './text-input-client';

// Material Client (Material Manager service process)
export {
    MaterialClient,
    createMaterialClient,
} from './material-client';
export type {
    MaterialClientOptions,
    MaterialClientEvents,
    MaterialFrameMessage,
    MaterialFrameSnapshot,
    MaterialCreatedMessage,
    MaterialFocusedMessage,
    MaterialUnfocusedMessage,
    MaterialSaveMessage,
    MaterialTypeUpdateMessage,
} from './material-client';

// Memory Client (Memory service process — material/frame persistence)
export { MemoryClient, createMemoryClient } from './memory-client';
export type { MemoryClientOptions } from './memory-client';
export type { MaterialRecord, MaterialFrameRecord } from './memory-client';

// Detector Pipeline Client (Vertex Gemini or Cerebras evaluation)
export { DetectorPipelineClient, createDetectorPipelineClient } from './detector-pipeline-client';
export type {
    DetectorPipelineClientOptions,
    DetectorPipelineClientEvents,
    DetectorPipelineClientResult,
} from './detector-pipeline-client';

