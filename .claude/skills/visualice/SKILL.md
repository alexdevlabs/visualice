---
name: visualice
description: Crawl a website and capture every page and UI state (modals, menus, drawers, accordions, tabs) across device profiles, then browse the screenshots on a zoomable canvas. Use when the user wants to screenshot/snapshot a whole site, visually crawl it, audit UI across breakpoints, capture all pages and interactive states, build a visual catalog/regression baseline of a web app, or "see every screen" of a site.
---

# Visualice

Drive the `visualice` tool to screenshot an entire site — every route and every
interactive UI state — across device profiles, then open a zoomable viewer. Discovery
is normally automatic; you (Claude) step in for auth and for states the heuristics miss.

## 1. Locate the tool & install deps

Run all commands from the `visualice` project root (the directory containing its
`package.json` — this repo, or wherever it is installed). On first use only:

```
npm install && npx playwright install chromium
```

## 2. Project files: config + routes file

Two committed files live at the target project's root; everything else is
machine-owned under gitignored `.visualice/`:

- **`visualice.config.json`** — behavior (scope, devices, auth, …). The first
  `crawl <url>` scaffolds a minimal one automatically (and gitignores `.visualice/`);
  `visualice init <url>` does the same without crawling. Any `visualice.config.*` in
  the cwd is picked up automatically — no `--config` needed.
- **`visualice.routes.md`** — the site index: pages as top-level bullets, their UI
  states nested under them. Regenerated after every crawl. **Read THIS to orient,
  never the cache JSON** — it is a few dozen lines and carries the same map.

Steer the crawl by editing the routes file:

- `- /path` — add a line to seed a page discovery missed.
- `- skip: <state-id>` (nested) or `- skip: /path/**` (top-level) — exclude noise.
  Deleting a line is NOT an exclusion (it gets re-added); `skip:` is the tombstone.
- `- [ ] state-id — description` — request a state that has no recipe yet. Unmet
  requests surface as `wanted` in `--json` and a `## Wanted` report section — that
  is your Explore-mode work queue (§4).

Other config notes:

- For large sites, confirm scope with the user and set `scope.include`/`exclude`
  globs, `scope.maxPages`, and the `devices` list in the config.
- One-off tweaks don't need config edits — flags override:
  `--max-pages=<n> --include=<globs> --exclude=<globs> --devices=<names> --timeout=<ms>`.
- Always add `--json` (machine-readable one-line summary on stdout) and `--quiet`
  (suppress progress noise) when running non-interactively. Add `--fail-on-error` when a
  failed capture should fail the command (exit 3).

## 3. Choose a mode

1. **Replay** — a `.visualice/crawl-map.cache.json` already exists and the site is
   unchanged. Fast, deterministic, no rediscovery:
   `npm run crawl -- --base=<url> --replay`
2. **Auto** — first crawl of a public site built from standard components:
   `npm run crawl -- --base=<url>` (heuristic discovery + capture)
3. **Explore (agentic)** — the site needs login, or has states the heuristics miss
   (custom/hover dropdowns, multi-step flows, canvas widgets). See §4.

Prefer Replay once a site has been mapped. Use Auto for the first pass, then escalate
to Explore only for the gaps.

## 4. Explore mode — you drive the browser via Playwright MCP

Use the `browser_*` MCP tools to _author or augment_ the cached site model, then let the
deterministic engine do the bulk capture. Do not screenshot the whole site through your
own context — that is the engine's job; you only discover the tricky parts.

Work from the `wanted` list (routes-file `[ ]` lines that nothing realizes yet): author
each one's recipe into the cache **under the same state id**, and the next run flips its
checkbox to a realized bullet automatically.

- `browser_navigate` to a representative page, then `browser_snapshot` to read its
  accessibility tree.
- Spot interactive triggers the heuristics would miss. `browser_click` / `browser_hover`
  to confirm what each opens; note a robust selector for the trigger (test id > role+name
  > stable CSS) and the id/selector of the element that appears.
- Append each as a state to `.visualice/crawl-map.cache.json` under the right route:
  ```json
  {
    "id": "menu-products",
    "kind": "menu",
    "label": "Products dropdown",
    "trigger": { "role": "button", "name": "Products" },
    "recipe": [
      { "action": "hover", "target": { "role": "button", "name": "Products" } },
      { "action": "waitFor", "selector": "[data-menu='products']", "state": "visible" }
    ],
    "shots": {}
  }
  ```
- After editing the cache, ALWAYS check it before capturing:
  `npm run vc -- validate --json` — it lists every problem with a JSON-path pointer
  (`manifest.schema.json` documents the shape). A state can carry
  `"devices": ["mobile"]` to capture only on those devices (mobile-only navs).
- Then capture everything via Replay: `npm run crawl -- --base=<url> --replay --json`.

Note the heuristics are stronger than they look: hover dropdowns are probed
automatically, and a second discovery pass runs at the first mobile device's viewport so
hamburger navs are found without Explore mode. Escalate to Explore only for what is
still missing after an Auto run.

## 5. Auth (when the site requires login)

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
- `npm run auth` runs the recipe and saves `auth.json`; `crawl` reuses it automatically
  and re-runs the login when the session goes stale (`login.maxAgeHours`).
- Password-protected staging: set `http.httpCredentials` / `http.extraHTTPHeaders`
  (values may use `${ENV_VAR}`) and `http.ignoreHTTPSErrors` for self-signed TLS.

## 6. Capture, report, view

- Output lands in `.visualice/runs/<id>/`: `screenshots/<path>/<state>/<device>.*`,
  `crawl-map.json`, `viewer-data.json`, `crawl-report.md`.
- With `--json` the run summary (route/state/shot counts, a `failures` array of
  `{route, state, device, error}`, and the `wanted` array of unmet routes-file
  requests) arrives on stdout — no report parsing needed.
  `crawl-report.md` has the same data human-formatted, failures in a `## Failures`
  section. A failing state usually means its recipe needs an Explore-mode tweak.
- Failed captures were already retried (`politeness.retries`); don't blindly re-run the
  whole crawl for one flaky shot — fix or mask the cause.
- Open the viewer: `npm run serve -- --open` (or `--shoot=out.png` to grab a headless
  screenshot of the viewer itself). Grouped vs all-at-once; thumbnails when zoomed out,
  full resolution as you zoom in.

## Guardrails

- Only crawl sites the user owns or is authorized to test. Stay on the target origin and
  honor the user's scope; respect `politeness` (concurrency, delays, robots).
- Keep secrets in env, never in the manifest, screenshots, or commits.
- The cached model makes re-runs cheap — once a site is mapped, default to `--replay`.
