import type { BrowserContextOptions } from "playwright";
import type { Config } from "../shared/config";
import type { Device } from "../shared/types";
import { resolveEnvRecord } from "../shared/env";

/**
 * The `config.http` slice of Playwright context options, shared by discovery,
 * capture and auth so staging environments (self-signed TLS, basic auth, preview
 * headers) work in every phase. ${ENV_VAR} placeholders resolve here, at context
 * creation — the config snapshot in run artifacts keeps the placeholder.
 */
export function httpContextOptions(config: Config): BrowserContextOptions {
  const { ignoreHTTPSErrors, extraHTTPHeaders, httpCredentials, proxy } = config.http;
  const opts: BrowserContextOptions = {};
  if (ignoreHTTPSErrors) opts.ignoreHTTPSErrors = true;
  if (Object.keys(extraHTTPHeaders).length) {
    opts.extraHTTPHeaders = resolveEnvRecord(extraHTTPHeaders, "http.extraHTTPHeaders");
  }
  if (httpCredentials) {
    const { username, password } = resolveEnvRecord(httpCredentials, "http.httpCredentials");
    opts.httpCredentials = { username, password };
  }
  if (proxy) {
    // Only the fields that were set are resolved: `resolveEnvRecord` throws on an
    // unset variable, and an absent optional field has no variable to miss.
    const resolved = resolveEnvRecord(
      Object.fromEntries(Object.entries(proxy).filter(([, v]) => v !== undefined)) as Record<
        string,
        string
      >,
      "http.proxy",
    );
    opts.proxy = {
      server: resolved.server,
      ...(resolved.bypass ? { bypass: resolved.bypass } : {}),
      ...(resolved.username ? { username: resolved.username } : {}),
      ...(resolved.password ? { password: resolved.password } : {}),
    };
  }
  return opts;
}

/**
 * Everything a device's browser context is created with. Capture and `probe` share
 * it, so a recipe an agent verifies with `probe` meets the same viewport, user
 * agent, locale and session the capture will replay it in.
 */
export function deviceContextOptions(
  config: Config,
  device: Device,
  storageState?: string,
): BrowserContextOptions {
  const engine = device.browser ?? "chromium";
  return {
    ...httpContextOptions(config),
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dpr,
    // Firefox has no mobile emulation and rejects the option outright.
    ...(engine === "firefox" ? {} : { isMobile: device.mobile ?? false }),
    hasTouch: device.touch ?? device.mobile ?? false,
    userAgent: device.userAgent,
    colorScheme: device.colorScheme ?? "light",
    reducedMotion: device.reducedMotion ?? "reduce",
    // Pinned locale + timezone: Date is frozen by the stabilizer, but
    // Intl/toLocaleString would otherwise still render in the machine's TZ.
    locale: device.locale ?? "en-US",
    timezoneId: device.timezoneId ?? "UTC",
    storageState,
  };
}
