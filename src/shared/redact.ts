import type { Config } from "./config";

/**
 * Defense in depth for the config snapshot written into every run manifest.
 *
 * The convention is that secrets live in the environment and configs only carry
 * `${ENV_VAR}` placeholders, which are resolved at use time and are safe to store.
 * But a config is a file a human edits, and a hardcoded password put there by hand
 * would otherwise be copied verbatim into `crawl-map.json` — an artifact people
 * commit, attach to tickets, and hand to agents. Anything in a credential-bearing
 * field that is *not* a placeholder is replaced before it can get that far.
 */

export const REDACTED = "[redacted]";

/** `${VAR}` placeholders are indirections, not secrets — those stay readable. */
function isPlaceholder(value: string): boolean {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim());
}

const keep = (value: string): string => (isPlaceholder(value) ? value : REDACTED);

/** Header names whose values are credentials rather than configuration. */
const SECRET_HEADER = /authorization|cookie|token|secret|key|password|auth/i;

function redactSteps(steps: unknown[]): unknown[] {
  return steps.map((step) => {
    if (!step || typeof step !== "object") return step;
    const s = step as Record<string, unknown>;
    // Only `fill` carries typed-in values; clicks and waits carry selectors.
    if (s.action === "fill" && typeof s.value === "string") {
      return { ...s, value: keep(s.value) };
    }
    return step;
  });
}

/**
 * A copy of the config with credential material stripped. Structure is preserved
 * so the snapshot still documents *that* auth was configured, and how.
 */
export function redactConfig(config: Config): Config {
  const out: Config = {
    ...config,
    http: { ...config.http, extraHTTPHeaders: { ...config.http.extraHTTPHeaders } },
    auth: { ...config.auth },
  };

  for (const [name, value] of Object.entries(out.http.extraHTTPHeaders)) {
    if (SECRET_HEADER.test(name)) out.http.extraHTTPHeaders[name] = keep(value);
  }

  if (out.http.proxy) {
    out.http.proxy = {
      ...out.http.proxy,
      ...(out.http.proxy.username ? { username: keep(out.http.proxy.username) } : {}),
      ...(out.http.proxy.password ? { password: keep(out.http.proxy.password) } : {}),
    };
  }

  if (out.http.httpCredentials) {
    out.http.httpCredentials = {
      username: keep(out.http.httpCredentials.username),
      password: keep(out.http.httpCredentials.password),
    };
  }

  if (out.auth.login) {
    out.auth.login = { ...out.auth.login, steps: redactSteps(out.auth.login.steps) };
  }

  return out;
}
