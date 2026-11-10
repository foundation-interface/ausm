/**
 * AUSM Memory — platform-independent persistent storage for materials,
 * frames, and content from various producers (material-manager, clipboard,
 * screenshots, etc.).
 *
 * Instantiated by the runtime. Producers emit events that are forwarded
 * to Memory for storage. The store runs in a standalone Node process
 * (see service.ts) so better-sqlite3 stays out of Electron.
 */

export { MemoryStore, type MemoryStoreConfig, type MaterialOcrResult } from './memory-store';
export { OcrWorker, LineDeduper, type OcrWorkerOptions } from './ocr-worker';
export type { Material, MaterialFrame } from './types';
