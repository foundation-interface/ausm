import path from "node:path";
import os from "node:os";

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Env string with "" treated as unset (path.resolve("") would silently mean the cwd). */
function str(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function port(name: string, fallback: number): number {
  const n = int(name, fallback);
  return n >= 0 && n <= 65535 ? n : fallback;
}

const defaultDataDir = path.join(
  os.homedir(),
  "Library/Application Support/ausm/material-chat",
);

const defaultDbPath = path.join(
  os.homedir(),
  "Library/Application Support/ausm/ausm.db",
);

export const config = {
  anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() ?? "",
  braveKey: process.env.BRAVE_API_KEY?.trim() ?? "",

  dbPath: (() => {
    const raw = str("AUSM_DB", defaultDbPath);
    return raw === ":memory:" ? raw : path.resolve(raw);
  })(),
  port: port("AUSM_PORT", 8788),

  dataDir: path.resolve(str("MATERIAL_CHAT_DATA_DIR", defaultDataDir)),

  get sessionsPath(): string {
    return path.resolve(
      str("SESSIONS_PATH", path.join(this.dataDir, "sessions.json")),
    );
  },
  get preferencesPath(): string {
    return path.join(this.dataDir, "preferences.md");
  },

  /** Browser origins besides localhost and file:// that may call the server. */
  allowedOrigins: (process.env.MATERIAL_CHAT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  materialUrlScheme: str("MATERIAL_URL_SCHEME", "material://"),

  userName: process.env.USER_NAME ?? "",
  userAliases: (process.env.USER_ALIASES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  timezone: process.env.TIMEZONE ?? "",
  defaultPipeline: 1,

  synthModel: str("SYNTH_MODEL", "claude-sonnet-4-6"),
};
