import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const defaultDataDir = path.join(
  os.homedir(),
  "Library/Application Support/activity-visualizer/material-chat",
);

const defaultDbPath = path.join(
  os.homedir(),
  "Library/Application Support/activity-visualizer/ausm-materials.db",
);

export const config = {
  anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() ?? "",
  braveKey: process.env.BRAVE_API_KEY?.trim() ?? "",

  dbPath: (() => {
    const raw = process.env.AUSM_DB ?? defaultDbPath;
    return raw === ":memory:" ? raw : path.resolve(raw);
  })(),
  port: int("AUSM_PORT", 8788),

  dataDir: path.resolve(process.env.MATERIAL_CHAT_DATA_DIR ?? defaultDataDir),

  get sessionsPath(): string {
    return path.resolve(
      process.env.SESSIONS_PATH ?? path.join(this.dataDir, "sessions.json"),
    );
  },
  get preferencesPath(): string {
    return path.join(this.dataDir, "preferences.md");
  },

  materialUrlScheme: process.env.MATERIAL_URL_SCHEME ?? "material://",
  ausmUrl: process.env.AUSM_URL ?? "http://127.0.0.1:8788",

  userName: process.env.USER_NAME ?? "",
  userAliases: (process.env.USER_ALIASES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  timezone: process.env.TIMEZONE ?? "",
  defaultPipeline: 1,

  plannerModel: process.env.PLANNER_MODEL ?? "claude-haiku-4-5-20251001",
  synthModel: process.env.SYNTH_MODEL ?? "claude-sonnet-4-6",

  personalTopK: int("PERSONAL_TOP_K", 5),
  webTopK: int("WEB_TOP_K", 5),
  webFetchTopK: int("WEB_FETCH_TOP_K", 3),
};

export function ensureDataDir(): void {
  if (!existsSync(config.dataDir)) {
    // created lazily by the session store
  }
}
