---
name: visualice
description: Crawl a website and capture every page and UI state (modals, menus, drawers, accordions, tabs) across device profiles, then browse the screenshots on a zoomable canvas. Use when the user wants to screenshot/snapshot a whole site, visually crawl it, audit UI across breakpoints, capture all pages and interactive states, build a visual catalog of a web app, or "see every screen" of a site.
---

# Visualice

Drive the `visualice` tool to screenshot an entire site — every route and every
interactive UI state — across device profiles, then open a zoomable viewer. Discovery
is normally automatic; you (Claude) step in for auth and for states the heuristics miss.

## 1. Locate & preflight

Prefer an installed CLI: `npm i -g visualice`, or run it ad hoc with `npx visualice <cmd>`
— both work from any directory, no repo checkout needed. In a source checkout of this
repo itself, use the equivalent npm scripts instead: `npm run vc -- <cmd>` for anything
below, `npm run crawl -- <args>` for crawls.

Before the first crawl in a project, run `visualice doctor` — an idempotent preflight
that checks Node/Playwright chromium/sharp/the viewer build and self-heals what it
safely can (installs chromium, builds the viewer; `--no-fix` to only report). This
replaces any manual `npm install && npx playwright install chromium` step. Full
command/flag reference: [`references/cli.md`](references/cli.md).

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

- `- /path` — add a line to seed a page discovery missed. A `--replay` run discovers
  just the new pages and merges them into the cache, so no full re-crawl is needed.
- `- skip: <state-id>` (nested) or `- skip: /path/**` (top-level) — exclude noise.
  Deleting a line is NOT an exclusion (it gets re-added); `skip:` is the tombstone.
- `- [ ] state-id — description` — request a state that has no recipe yet. Unmet
  requests surface as `wanted` in `--json` and a `## Wanted` report section — that
  is your Explore-mode work queue (§3, detail in
  [`references/explore-mode.md`](references/explore-mode.md)).

For large sites, confirm scope with the user and set `scope.include`/`exclude` globs,
`scope.maxPages`, and `devices` in the config. A shop's hundred product pages are one
template: `scope.samples: { "/product/*": 3 }` keeps the first three and skips the rest,
whatever their ids (sites that re-seed their data change ids — a sample survives
that, an id list doesn't). Site-wide chrome (a header dropdown, a chat widget) is
captured once, on the first page it was found on. One-off tweaks don't need config
edits — flags like `--max-pages=<n> --include=<globs> --devices=<names>` override.
Always add `--json` and `--quiet` when running non-interactively, and `--fail-on-error`
when a failed capture should fail the command (exit 3).

### Estimate the size before crawling something big

A run is `routes × states × devices` screenshots, and each full-page shot is roughly
0.5–1.5 MB. The bundled 10-route fixture produces 72 shots / ~46 MB in ~30s. So:
**shots ≈ routes × (1 + states per route) × devices**, and disk ≈ 1 MB per shot.

A 200-route site with 3 states each and 2 devices is ~1,200 shots — well over a
gigabyte and many minutes of crawling. Before pointing visualice at anything you
haven't scoped, run `visualice discover <url> --json` first: it maps routes and
states **without taking a single screenshot**, and its counts are the real estimate.
Then narrow with `--max-pages` / `--include` / `--devices` and confirm with the user.

`output.keepRuns` (default 5) prunes older runs of each site automatically, so
`.visualice/` holds roughly five runs' worth per site. To reclaim space sooner, lower
`keepRuns` or delete `.visualice/sites/<site>/runs/<id>/` directories directly — everything under `.visualice/` is
machine-owned and gitignored. Keep `crawl-map.cache.json`: deleting it forces a full
rediscovery and loses any Explore-mode states authored into it.

## 3. Choose a mode

1. **Replay** — a `.visualice/crawl-map.cache.json` already exists and the site is
   unchanged. Fast, deterministic, no rediscovery: `visualice crawl <url> --replay`
2. **Auto** — first crawl of a public site built from standard components:
   `visualice crawl <url>` (heuristic discovery + capture)
3. **Explore (agentic)** — the site needs login, or has states the heuristics miss
   (inline errors, data-dependent views like a cart with items, dropdown choices,
   multi-step flows). `visualice probe` shows you a page's inventory and verifies a
   recipe before you keep it; `/visualice-explore` runs explorer agents over the whole
   site in parallel. Read [`references/explore-mode.md`](references/explore-mode.md)
   before starting.

Prefer Replay once a site has been mapped. Use Auto for the first pass, then escalate
to Explore only for the gaps.

## 4. Auth (when the site requires login)

Discover the login flow interactively with the MCP browser once, then encode it as a
recipe in the config so the deterministic engine can reproduce it on every run —
`visualice auth` runs the recipe and saves the storage state; `crawl` reuses it
automatically and re-logs-in when the session goes stale. Secrets always come from
env, never hardcoded or committed. Full recipe syntax, the `verify` block that stops
a silently-failed login from being saved, and HTTP Basic-auth credentials for
password-protected staging: [`references/auth.md`](references/auth.md).

## 5. Capture, report, view

- Output lands in `.visualice/sites/<site>/runs/<id>/`: `screenshots/<path>/<state>/<device>.*`,
  `crawl-map.json`, `viewer-data.json`, `crawl-report.md`.
- With `--json` the run summary (route/state/shot counts, a `failures` array of
  `{route, state, device, error}`, and the `wanted` array of unmet routes-file
  requests) arrives on stdout — no report parsing needed. `crawl-report.md` has the
  same data human-formatted, failures in a `## Failures` section. A failing state
  usually means its recipe needs an Explore-mode tweak.
- Failed captures were already retried (`politeness.retries`); don't blindly re-run
  the whole crawl for one flaky shot — fix or mask the cause.
- Open the viewer: `visualice serve --open` (`--site=<name>` for another site in the
  output directory, `--run=<id>` for a specific run instead of the latest,
  `--screenshot=out.png` to grab a headless screenshot of the viewer itself). Shots are
  grouped by route, a row per state and a column per device. The mode switch draws
  each shot as **Screen** (the captured screens, one card each), **Continuous** (the
  screens joined, pinned bars shown once) or **Scroll** (one scrollable screen per
  tile). The device toggles pick which devices show; **Full screen** (`F`) on a selected
  shot shows that state on every checked device side by side, which is how you answer
  "does this look right on mobile?". Thumbnails when zoomed out, full resolution as you
  zoom in.
- The viewer also surfaces failures (an "N failed captures · Show only" button in the
  sidebar, each failed shot rendered as a placeholder carrying its error), lets you
  switch site and version from the header without restarting the server, and puts
  the current view in the URL — copy the address bar to point the user at one
  specific shot.
- Interrupted mid-crawl? `visualice crawl --resume` continues the newest unfinished
  run and keeps the shots already on disk instead of starting over.

## 6. Share a run

`visualice export <dir>` writes the viewer and the run as a static folder, for
sharing without a server.

Beyond page screenshots, the config can ask for more from the same crawl:
`devices[].browser` (`firefox` / `webkit`) for cross-browser shots, `components`
(`{ name, selector, routes }`) for element-level shots, and `checks.accessibility: true`
for an axe-core audit of every state — reported in `crawl-report.md`, `--json`
(`accessibility`) and the viewer.

Full flag reference: [`references/cli.md`](references/cli.md).

## Guardrails

- Before a large crawl, estimate it with `visualice discover` (§2) and confirm the
  scope — don't spend an hour and a gigabyte of someone's disk without asking.
- A hash-routed SPA (`#/about`) is crawled as one route per view by default; if a
  site uses fragments purely as in-page anchors and the crawl is forking on them, set
  `scope.hashRoutes: "never"`.
- Only crawl sites the user owns or is authorized to test. Stay on the target origin and
  honor the user's scope; respect `politeness` (concurrency, delays, robots).
- Keep secrets in env, never in the manifest, screenshots, or commits.
- The cached model makes re-runs cheap — once a site is mapped, default to `--replay`.
