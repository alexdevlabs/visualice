---
name: visualice
description: Catalogue a website visually — explore every page and UI state (menus, modals, form errors, a cart with items, signed-in views, multi-step flows), capture each across device profiles, then browse the screenshots on a zoomable canvas. Use when the user wants to screenshot/snapshot a whole site, visually crawl it, audit UI across breakpoints, capture all pages and interactive states, build a visual catalog of a web app, or "see every screen" of a site.
---

# Visualice

Catalogue an entire site — every route and every UI state worth reviewing — across
device profiles, then open it in a zoomable viewer. The heuristics map the site, you
explore it like a QA reviewer (form errors, a cart with items, signed-in views,
multi-step flows), and the `visualice` engine captures every state from the recipes
you verified, so the catalogue reruns without you.

## 1. Locate & preflight

Use `visualice` when it is on the PATH (`npm i -g visualice`) and `visualice --version`
prints 0.2.1 or newer; otherwise run it with `npx -y visualice@0.2.1 <cmd>`, the CLI
version this skill was written for. An older installed CLI lacks commands used below:
use the `npx` form for this task and tell the user once to update it with
`npm i -g visualice@latest`. Both work from any directory, no repo checkout needed. In a source checkout of this repo itself,
use the npm scripts instead: `npm run vc -- <cmd>` for anything below, `npm run crawl --
<args>` for crawls. The commands below say `visualice`; substitute whichever applies.

If a command prints `ℹ visualice X is available (you have Y)…` on stderr, tell the user
once, with the update command it gives (`claude plugin update visualice@visualice`), and
carry on with the task: don't update anything yourself.

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
  Deleting a line is NOT an exclusion (it gets re-added); `skip:` is the tombstone. For a
  page's query variants write one glob with a `?` (`- skip: /metrics?*` keeps `/metrics`),
  not a line per variant.
- `- [ ] state-id — description` — request a state that has no recipe yet. Unmet
  requests surface as `wanted` in `--json` and a `## Wanted` report section — that
  is a work queue for exploring (§3, detail in
  [`references/explore-mode.md`](references/explore-mode.md)).

For large sites, confirm scope with the user and set `scope.include`/`exclude` globs,
`scope.maxPages`, and `devices` in the config. A shop's hundred product pages are one
template: `scope.samples: { "/product/*": 3 }` keeps the first three and skips the rest,
whatever their ids (sites that re-seed their data change ids — a sample survives
that, an id list doesn't). Site-wide chrome (a header dropdown, a chat widget) is
captured once, on the first page it was found on. One-off tweaks don't need config
edits — flags like `--max-pages=<n> --include=<globs> --devices=<names>` override,
`--seed=/a,/b` adds entry pages discovery can't reach by links, and `--no-states`
captures pages only (fast; the states already in the cache are kept).
When running non-interactively, always add `--quiet`, and `--json` on the commands that
take it (`init`, `auth`, `serve` and `probe` don't; `probe` prints JSON anyway). The JSON
is the only thing on stdout; progress lines go to stderr, so read stdout on its own (no
`2>&1`) when parsing it. Add `--fail-on-error` when a failed capture should fail the
command (exit 3).

### Estimate the size before crawling something big

A run is `routes × states × devices` screenshots, and each full-page shot is roughly
0.5–1.5 MB. The bundled 10-route fixture produces 72 shots / ~46 MB in ~30s. So:
**shots ≈ routes × (1 + states per route) × devices**, and disk ≈ 1 MB per shot.

A 200-route site with 3 states each and 2 devices is ~1,200 shots — well over a
gigabyte and many minutes of crawling. Before pointing visualice at anything you
haven't scoped, run `visualice crawl <url> --dry-run --json`: it discovers routes and
states **without taking a single screenshot**. The JSON has the exact `shots` count, the
`states` total, the `devices`, and `routes` (each page's `url` and its state ids). Any
`wrote` entries are triggers discovery left out because clicking them sent a write to
the server (blocked by default): tell the user, and suggest adding their labels to
`discovery.interactions.denyLabels`.
A dry run never writes a config: in a project without one, run `visualice init <url>`
first, or `probe` and `crawl --replay` afterwards have no target.
Then narrow with `--max-pages` / `--include` / `--devices` / `--no-states` and confirm
with the user. A dry run writes the cache, so the
real crawl that follows can be `--replay`.

`output.keepRuns` (default 5) prunes older runs of each site automatically, so
`.visualice/` holds roughly five runs' worth per site. To reclaim space sooner, lower
`keepRuns` or delete `.visualice/sites/<site>/runs/<id>/` directories directly — everything under `.visualice/` is
machine-owned and gitignored. Keep `crawl-map.cache.json`: deleting it forces a full
rediscovery and loses any Explore-mode states authored into it.

## 3. Choose the path

1. **Explore — the default.** No `.visualice/crawl-map.cache.json` yet, so the site
   hasn't been mapped: map it with a dry run, plan the page types with the user,
   explore each type, then capture with `--replay`. Read
   [`references/explore-mode.md`](references/explore-mode.md) and follow it.
2. **Update after code changes.** The site is mapped and the project is a git repo
   whose code changed since the last crawl. Run `visualice changes --json`: it diffs
   against the commit the catalogue was shot from (recorded in the routes file) and
   says whether nothing, some pages, or everything needs reshooting. Work out the
   affected pages, ask the user whether to rerun just those or everything, then run
   `visualice crawl --replay --only=<pages>`, which carries every other page over from
   the last run. Read [`references/update-mode.md`](references/update-mode.md) and
   follow it.
3. **Replay or extend.** The site is mapped. To recapture, run
   `visualice crawl --replay --json --quiet`. For new pages, `wanted` lines, or a focus the user names, explore
   just those page types first (explore-mode.md, "Later runs").
4. **Quick.** Only when the user asks for it ("quick", "just screenshot it", pages only)
   or you're scripting CI: `visualice crawl <url> --json --quiet` runs the heuristics
   and captures in one go, with no exploring. Mention that exploring would find more.

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
- **Triggers still loading.** `stillLoading` in `--json` (and **still loading** rows under
  `## Clicked, nothing opened` in the report) are triggers discovery clicked that showed
  nothing while the page was still busy: a slow server, often a dev build, may have
  hidden a dialog or menu there. Check each with `visualice probe`, and author the
  states that are real (explore-mode.md) so later runs don't depend on probe timing.
  For a slow site, `discovery.interactions.patienceMs` gives every probe longer.
- **Generated ids.** Many frameworks give elements ids at render time (React's
  `useId`, `mat-dialog-0`, `ember812`), which differ on the next load, so a recipe must
  never rely on one. visualice knows the common ones and notices others by loading a
  page twice and opening a dialog twice; what it noticed comes back as `unstableIds` in
  `--json` and under `## Generated ids` in the report. When it does, check the patterns
  (an id the app really chose, like `step-2`, shouldn't be there), add the real ones to
  `discovery.unstableIds` in `visualice.config.json` so they're kept with the project,
  and tell the user in one line. Do the same when you can see the project's framework
  generates ids (its `package.json`, ids in `crawl-map.json`, failures that are
  timeouts on a `waitFor` of an `[id=…]`). A regex per pattern: `"^mat-dialog-\\d+$"`.
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

- Before a large crawl, estimate it with `visualice crawl --dry-run` (§2) and confirm the
  scope — don't spend an hour and a gigabyte of someone's disk without asking.
- A hash-routed SPA (`#/about`) is crawled as one route per view by default; if a
  site uses fragments purely as in-page anchors and the crawl is forking on them, set
  `scope.hashRoutes: "never"`.
- Only crawl sites the user owns or is authorized to test. Stay on the target origin and
  honor the user's scope; respect `politeness` (concurrency, delays, robots).
- Keep secrets in env, never in the manifest, screenshots, or commits.
- Exploring can change data on the site: confirm the allowed writes in the plan, and
  by default never publish, delete, pay, sign out or change account settings.
- The cached model makes re-runs cheap — once a site is mapped, default to `--replay`
  and explore only what's new.
- After code changes, never reshoot part of a catalogue without asking: lay out what
  `visualice changes` found and the pages you traced, and let the user choose between
  those pages and a full run. When in doubt, recommend the full run.
