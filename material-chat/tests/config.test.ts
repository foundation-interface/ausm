import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

/**
 * config.ts reads the environment at import time, so each scenario loads a
 * fresh copy with a controlled env.
 */
const CONFIG_PATH = require.resolve("../src/config.ts");
const KEYS = [
  "ANTHROPIC_API_KEY", "BRAVE_API_KEY", "AUSM_DB", "AUSM_PORT", "MATERIAL_CHAT_DATA_DIR", "SESSIONS_PATH",
  "MATERIAL_URL_SCHEME", "AUSM_URL", "USER_NAME", "USER_ALIASES", "TIMEZONE", "PLANNER_MODEL", "SYNTH_MODEL",
  "PERSONAL_TOP_K", "WEB_TOP_K", "WEB_FETCH_TOP_K",
];

function loadConfig(env: Record<string, string>): any {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try {
    delete require.cache[CONFIG_PATH];
    const cfg = require(CONFIG_PATH).config;
    // Materialize getters while the env is still in place.
    return { ...cfg, sessionsPath: cfg.sessionsPath, preferencesPath: cfg.preferencesPath };
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[CONFIG_PATH];
  }
}

const appSupport = path.join(os.homedir(), "Library/Application Support/ausm");

describe("material-chat config", () => {
  test("defaults", () => {
    const c = loadConfig({});
    assert.equal(c.anthropicKey, "");
    assert.equal(c.braveKey, "");
    assert.equal(c.port, 8788);
    assert.equal(c.dbPath, path.join(appSupport, "ausm.db"));
    assert.equal(c.dataDir, path.join(appSupport, "material-chat"));
    assert.equal(c.sessionsPath, path.join(appSupport, "material-chat", "sessions.json"));
    assert.equal(c.preferencesPath, path.join(appSupport, "material-chat", "preferences.md"));
    assert.equal(c.materialUrlScheme, "material://");
    assert.deepEqual(c.userAliases, []);
    assert.equal(c.defaultPipeline, 1);
    assert.deepEqual(c.allowedOrigins, []);
  });

  test("values supplied by the runtime's HttpHost are honoured", () => {
    const c = loadConfig({ AUSM_DB: "/tmp/x.db", AUSM_PORT: "9001", MATERIAL_CHAT_DATA_DIR: "/tmp/mc" });
    assert.equal(c.dbPath, "/tmp/x.db");
    assert.equal(c.port, 9001);
    assert.equal(c.dataDir, "/tmp/mc");
    assert.equal(c.sessionsPath, "/tmp/mc/sessions.json");
  });

  test(":memory: db is kept verbatim; relative paths are resolved", () => {
    assert.equal(loadConfig({ AUSM_DB: ":memory:" }).dbPath, ":memory:");
    assert.equal(loadConfig({ AUSM_DB: "rel.db" }).dbPath, path.resolve("rel.db"));
  });

  test("API keys are trimmed", () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: "  test-key \n", BRAVE_API_KEY: "\t" });
    assert.equal(c.anthropicKey, "test-key");
    assert.equal(c.braveKey, "");
  });

  test("empty-string path variables fall back to defaults instead of the cwd", () => {
    const c = loadConfig({ AUSM_DB: "", MATERIAL_CHAT_DATA_DIR: "", SESSIONS_PATH: "" });
    assert.equal(c.dbPath, path.join(appSupport, "ausm.db"));
    assert.equal(c.dataDir, path.join(appSupport, "material-chat"));
    assert.equal(c.sessionsPath, path.join(appSupport, "material-chat", "sessions.json"));
  });

  test("empty-string string settings fall back to defaults", () => {
    const c = loadConfig({ MATERIAL_URL_SCHEME: "", SYNTH_MODEL: "" });
    assert.equal(c.materialUrlScheme, "material://");
    assert.ok(c.synthModel.length > 0);
  });

  test("invalid integers fall back; out-of-range ports fall back", () => {
    assert.equal(loadConfig({ AUSM_PORT: "abc" }).port, 8788);
    assert.equal(loadConfig({ AUSM_PORT: "" }).port, 8788);
    assert.equal(loadConfig({ AUSM_PORT: "-1" }).port, 8788);
    assert.equal(loadConfig({ AUSM_PORT: "70000" }).port, 8788);
    assert.equal(loadConfig({ AUSM_PORT: "0" }).port, 0);
  });

  test("MATERIAL_CHAT_ALLOWED_ORIGINS is a trimmed comma list", () => {
    assert.deepEqual(loadConfig({ MATERIAL_CHAT_ALLOWED_ORIGINS: " app://x , https://y.test ,," }).allowedOrigins, ["app://x", "https://y.test"]);
  });

  test("SESSIONS_PATH overrides the data dir default", () => {
    assert.equal(loadConfig({ SESSIONS_PATH: "/tmp/s.json" }).sessionsPath, "/tmp/s.json");
  });

  test("user aliases are split, trimmed and blanks dropped", () => {
    assert.deepEqual(loadConfig({ USER_ALIASES: " a , ,b,, c " }).userAliases, ["a", "b", "c"]);
  });
});
