import type { MiddlewareHandler } from "hono";

/**
 * Material Chat answers questions from the user's screen memory and spends their API key, so
 * only this Mac may talk to it:
 *  - the server listens on 127.0.0.1 (see server.ts), so other machines can't connect;
 *  - the Host header must name localhost, which stops DNS-rebinding pages from reaching it;
 *  - a browser request must come from a local origin (http://localhost, http://127.0.0.1,
 *    file://) or one listed in MATERIAL_CHAT_ALLOWED_ORIGINS, so a website you happen to have
 *    open can neither read memory nor trigger the agent.
 * Requests without an Origin header (Node, the Electron main process, curl) are allowed.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostName(host: string): string {
  // "127.0.0.1:8788" → "127.0.0.1", "[::1]:8788" → "[::1]"
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

export function isAllowedOrigin(origin: string, extra: readonly string[]): boolean {
  if (extra.includes(origin)) return true;
  if (origin === "file://") return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTS.has(url.hostname === "::1" ? "[::1]" : url.hostname);
  } catch {
    return false;
  }
}

export function localOnly(extraOrigins: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host");
    if (host && !LOCAL_HOSTS.has(hostName(host.toLowerCase()))) {
      return c.json({ error: "forbidden host" }, 403);
    }
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin, extraOrigins)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  };
}
