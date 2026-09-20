import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/shared/config";
import { REDACTED, redactConfig } from "../src/shared/redact";

const config = (over: Record<string, unknown>) => ConfigSchema.parse(over);

describe("redactConfig", () => {
  it("keeps ${ENV_VAR} placeholders readable", () => {
    const out = redactConfig(
      config({
        http: {
          httpCredentials: { username: "${VC_USER}", password: "${VC_PASS}" },
          extraHTTPHeaders: { Authorization: "${VC_TOKEN}" },
        },
        auth: {
          login: {
            steps: [{ action: "fill", target: { label: "Password" }, value: "${VC_PASS}" }],
          },
        },
      }),
    );
    expect(out.http.httpCredentials).toEqual({
      username: "${VC_USER}",
      password: "${VC_PASS}",
    });
    expect(out.http.extraHTTPHeaders.Authorization).toBe("${VC_TOKEN}");
    expect(out.auth.login!.steps[0]).toMatchObject({ value: "${VC_PASS}" });
  });

  it("strips credentials someone hardcoded", () => {
    const out = redactConfig(
      config({
        http: {
          httpCredentials: { username: "admin", password: "hunter2" },
          extraHTTPHeaders: { "X-Preview-Token": "abc123", "X-Locale": "en-GB" },
        },
        auth: {
          login: {
            steps: [
              { action: "fill", target: { label: "Email" }, value: "me@example.com" },
              { action: "click", target: { role: "button", name: "Sign in" } },
            ],
          },
        },
      }),
    );
    expect(out.http.httpCredentials).toEqual({ username: REDACTED, password: REDACTED });
    expect(out.http.extraHTTPHeaders["X-Preview-Token"]).toBe(REDACTED);
    // Headers that carry no credential keep their value — the snapshot stays useful.
    expect(out.http.extraHTTPHeaders["X-Locale"]).toBe("en-GB");
    expect(out.auth.login!.steps[0]).toMatchObject({ value: REDACTED });
    // Non-fill steps are untouched: a selector is not a secret.
    expect(out.auth.login!.steps[1]).toMatchObject({
      action: "click",
      target: { name: "Sign in" },
    });
  });

  it("leaves the original config alone", () => {
    const input = config({
      http: { httpCredentials: { username: "admin", password: "hunter2" } },
    });
    redactConfig(input);
    expect(input.http.httpCredentials).toEqual({ username: "admin", password: "hunter2" });
  });

  it("preserves everything that isn't a credential", () => {
    const input = config({ target: "https://x.test", scope: { maxPages: 7 } });
    const out = redactConfig(input);
    expect(out.target).toBe("https://x.test");
    expect(out.scope.maxPages).toBe(7);
    expect(out.devices).toEqual(input.devices);
  });
});
