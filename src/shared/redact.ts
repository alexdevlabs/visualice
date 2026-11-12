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

/**
 * Header names whose values are credentials rather than configuration. Extra headers
 * are there for preview tokens and bypass cookies, so the list is wide
 * (`x-vercel-protection-bypass`, `CF-Access-Client-Id`, `X-Preview`).
 */
const SECRET_HEADER =
  /authorization|cookie|token|secret|key|password|auth|bypass|access|client|preview|session|csrf|signature|credential|protect/i;

/** A value that reads like a token whatever its header is called: long, no spaces. */
const TOKEN_LIKE = /^[A-Za-z0-9_\-+/=.:~]{20,}$/;

const secretHeader = (name: string, value: string): boolean =>
  SECRET_HEADER.test(name) || TOKEN_LIKE.test(value.trim());

/**
 * One stretch of a URL between `&`s and `#`s, with the value of its `key=value` hidden.
 * The key starts at the `&`, or at the first `?` that has a name after it.
 */
function redactParam(part: string): string {
  let at = part.startsWith("&") ? 0 : part.indexOf("?");
  while (at !== -1) {
    const eq = part.indexOf("=", at + 1);
    if (eq === -1) return part;
    if (eq > at + 1) {
      const value = part.slice(eq + 1);
      if (value === "" || isPlaceholder(value)) return part;
      return part.slice(0, eq + 1) + REDACTED;
    }
    at = part.indexOf("?", at + 1);
  }
  return part;
}

/**
 * A URL without what it may carry of a credential: `user:pass@` and, with `query`,
 * the values of its parameters (`?token=…`). Not a URL: returned as it is.
 */
export function redactUrl(url: string, query = false): string {
  if (isPlaceholder(url)) return url;
  // Dropped, not replaced: what is left is still a URL that can be opened.
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, "$1");
  if (query) {
    out = out
      .split(/(?=[&#])/)
      .map((part) => redactParam(part))
      .join("");
  }
  return out;
}

function redactSteps(steps: unknown[]): unknown[] {
  return steps.map((step) => {
    if (!step || typeof step !== "object") return step;
    const s = step as Record<string, unknown>;
    // Only `fill` carries typed-in values; clicks and waits carry selectors.
    if (s.action === "fill" && typeof s.value === "string") {
      return { ...s, value: keep(s.value) };
    }
    // A login may pick a tenant or an account by value, or start at a one-time link.
    if (s.action === "select") {
      const value = Array.isArray(s.value)
        ? s.value.map((v) => (typeof v === "string" ? keep(v) : v))
        : typeof s.value === "string"
          ? keep(s.value)
          : s.value;
      return { ...s, value };
    }
    if (s.action === "navigate" && typeof s.url === "string") {
      return { ...s, url: redactUrl(s.url, true) };
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
    if (secretHeader(name, value)) out.http.extraHTTPHeaders[name] = keep(value);
  }
  if (out.target) out.target = redactUrl(out.target);

  if (out.http.proxy) {
    out.http.proxy = {
      ...out.http.proxy,
      server: redactUrl(out.http.proxy.server),
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
    out.auth.login = {
      ...out.auth.login,
      ...(out.auth.login.url ? { url: redactUrl(out.auth.login.url, true) } : {}),
      steps: redactSteps(out.auth.login.steps),
    };
  }

  return out;
}
