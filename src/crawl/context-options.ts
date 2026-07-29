import type { BrowserContextOptions } from "playwright";
import type { Config } from "../shared/config";
import { resolveEnvRecord } from "../shared/env";

/**
 * The `config.http` slice of Playwright context options, shared by discovery,
 * capture and auth so staging environments (self-signed TLS, basic auth, preview
 * headers) work in every phase. ${ENV_VAR} placeholders resolve here, at context
 * creation — the config snapshot in run artifacts keeps the placeholder.
 */
export function httpContextOptions(config: Config): BrowserContextOptions {
  const { ignoreHTTPSErrors, extraHTTPHeaders, httpCredentials } = config.http;
  const opts: BrowserContextOptions = {};
  if (ignoreHTTPSErrors) opts.ignoreHTTPSErrors = true;
  if (Object.keys(extraHTTPHeaders).length) {
    opts.extraHTTPHeaders = resolveEnvRecord(extraHTTPHeaders, "http.extraHTTPHeaders");
  }
  if (httpCredentials) {
    const { username, password } = resolveEnvRecord(httpCredentials, "http.httpCredentials");
    opts.httpCredentials = { username, password };
  }
  return opts;
}
