import { MemoryStore } from "./store.js";

let store: MemoryStore | null = null;

export function initMemory(dbPath: string): MemoryStore {
  store?.close();
  store = new MemoryStore(dbPath);
  return store;
}

export function getMemoryStore(): MemoryStore {
  if (!store) {
    throw new Error("memory store is not initialized — start via src/server.ts");
  }
  return store;
}

export { MemoryStore } from "./store.js";
export type {
  SearchHit,
  RecentHit,
  MaterialRecord,
  SearchOptions,
  RecentOptions,
} from "./store.js";
