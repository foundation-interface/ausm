import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Session, SessionStore, StoredMessage } from "./types.js";

const DEFAULT_TITLE = "New chat";

/**
 * Single-file, lock-serialized session store.
 * Concurrency: a tiny in-process write queue prevents interleaved fs.writeFile
 * calls. For single-user local use this is sufficient; swap to SQLite when needed.
 */
export class FileSessionStore {
  private cache: SessionStore | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private filePath: string) {}

  private async load(): Promise<SessionStore> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.cache = JSON.parse(raw) as SessionStore;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {};
      } else {
        throw err;
      }
    }
    return this.cache!;
  }

  private async flush(): Promise<void> {
    const data = JSON.stringify(this.cache ?? {}, null, 2);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // write to tmp + rename for atomicity
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, this.filePath);
  }

  private queueWrite(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.flush(), () => this.flush());
    return this.writeChain;
  }

  async list(): Promise<Session[]> {
    const store = await this.load();
    return Object.values(store).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Session | null> {
    const store = await this.load();
    return store[id] ?? null;
  }

  async create(title: string = DEFAULT_TITLE): Promise<Session> {
    const store = await this.load();
    const now = Date.now();
    const session: Session = {
      id: crypto.randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    store[session.id] = session;
    await this.queueWrite();
    return session;
  }

  async appendMessage(id: string, msg: StoredMessage): Promise<Session> {
    const store = await this.load();
    const session = store[id];
    if (!session) throw new Error(`Session not found: ${id}`);
    session.messages.push(msg);
    session.updatedAt = Date.now();
    if (session.title === DEFAULT_TITLE && msg.role === "user") {
      session.title = msg.content.slice(0, 60).trim() || DEFAULT_TITLE;
    }
    await this.queueWrite();
    return session;
  }

  async rename(id: string, title: string): Promise<Session> {
    const store = await this.load();
    const session = store[id];
    if (!session) throw new Error(`Session not found: ${id}`);
    session.title = title.trim() || DEFAULT_TITLE;
    session.updatedAt = Date.now();
    await this.queueWrite();
    return session;
  }

  async delete(id: string): Promise<void> {
    const store = await this.load();
    if (!store[id]) return;
    delete store[id];
    await this.queueWrite();
  }
}

let cached: FileSessionStore | null = null;
export function getSessionStore(filePath: string): FileSessionStore {
  if (!cached) cached = new FileSessionStore(filePath);
  return cached;
}
