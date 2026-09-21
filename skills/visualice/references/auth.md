# Auth — logging in before a crawl

Read this when the target site requires a login, per SKILL.md §4.

Discover the login flow interactively with the MCP browser, then encode it once as a
recipe in the config so the deterministic engine can reproduce it:

```ts
auth: {
  storageStatePath: ".visualice/auth.json",
  login: {
    url: "/login",
    steps: [
      { action: "fill", target: { label: "Email" }, value: "${VC_USER}" },
      { action: "fill", target: { label: "Password" }, value: "${VC_PASS}" },
      { action: "click", target: { role: "button", name: "Sign in" } },
      { action: "waitFor", url: "**/dashboard" }
    ]
  }
}
```

- Secrets come from env (`${VC_USER}`, `${VC_PASS}`) — never hardcode or commit them.
- Add `verify: { url: "**/dashboard" }` (and/or a `selector`) to the login block — the
  engine then refuses to save a logged-out session when the login silently fails.
- `visualice auth` runs the recipe and saves `auth.json`; `crawl` reuses it automatically
  and re-runs the login when the session goes stale (`login.maxAgeHours`, 12h by
  default). If you know which cookie carries the session, name it —
  `sessionCookies: ["sessionid"]` (a trailing `*` matches a prefix) — and staleness is
  read from that cookie's own expiry instead. Other cookies the login set (CSRF,
  consent, analytics) are never consulted. Use `visualice auth --force` to re-run the
  login even if the saved session looks fresh.
- Password-protected staging: set `http.httpCredentials` / `http.extraHTTPHeaders`
  (values may use `${ENV_VAR}`) and `http.ignoreHTTPSErrors` for self-signed TLS.
