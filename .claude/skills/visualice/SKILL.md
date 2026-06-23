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

## 2. Establish target & config

- Get the site URL from the user. Pass it as `--base=<url>`, or set `target` in
  `visualice.config.ts`.
- A config file controls scope, devices, stabilization, and auth; sensible defaults
  apply if it is absent. For large sites, confirm scope with the user and set
  `scope.include` / `scope.exclude` globs and `scope.maxPages`, and the `devices` list.

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
- Then capture everything via Replay: `npm run crawl -- --base=<url> --replay`.

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
- `npm run auth` runs the recipe and saves `auth.json`; `crawl` reuses it automatically
  and re-runs the login when the session goes stale (`login.maxAgeHours`).

## 6. Capture, report, view

- Output lands in `.visualice/runs/<id>/`: `screenshots/<path>/<state>/<device>.*`,
  `crawl-map.json`, `viewer-data.json`, `crawl-report.md`.
- Summarize the run for the user from `crawl-report.md`: route/state/shot counts and any
  capture failures (these usually mean a recipe needs an Explore-mode tweak).
- Open the viewer: `npm run serve -- --open` (or `--shoot=out.png` to grab a headless
  screenshot of the viewer itself). Grouped vs all-at-once; thumbnails when zoomed out,
  full resolution as you zoom in.

## Guardrails

- Only crawl sites the user owns or is authorized to test. Stay on the target origin and
  honor the user's scope; respect `politeness` (concurrency, delays, robots).
- Keep secrets in env, never in the manifest, screenshots, or commits.
- The cached model makes re-runs cheap — once a site is mapped, default to `--replay`.
