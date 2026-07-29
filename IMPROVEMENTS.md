# Visualice — Improvement Plan

> Findings from a full code review (2026-07-28), prioritized around the project goal:
> a dependable **on-demand agent skill** (Claude Code / any agent), UI-focused with a
> screenshot viewer. Comparison target: [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)
> (plugin packaging, multiple skill entry points, self-contained bootstrap).
>
> `PLAN.md` remains the original design doc; this file tracks what to fix/build next.

> **Progress 2026-07-28:** Tier 1 is fully done; Tier 2 done except plugin
> restructure / bootstrap / location independence / publishing; Tier 3 done except run
> diffing, capture page-reuse, `hints` consumption and the operational-safety items;
> Tier 4 quick wins + canvas keyboard done, feature list still open.

## Tier 1 — Agent contract (necessary; the skill↔engine contract is currently broken)

- [x] **Failure reporting end-to-end.** `SKILL.md` tells Claude to summarize capture
      failures from `crawl-report.md`, but `report.ts` never emits them. `capture.ts`
      swallows per-state errors (`capture.ts:155-158`); `manifest.stats` has no `failed`
      count and shots have no error field — a state that failed on mobile is
      indistinguishable from one never attempted.
  - Add `failures[]` to `manifest.stats` (+ per-shot `error` on `state.shots[device]`).
  - Add a **Failures** section to `crawl-report.md`.
- [x] **`--json` output mode.** Print a machine-readable summary to stdout:
      `{ runId, runDir, routes, states, shots, failures[] }`. Today all logs go to
      stderr and stdout carries a single ad-hoc payload line (`cli.ts:32`, `:225`).
- [x] **Honest exit codes.** CLI exits 0 even if 0 of 400 shots landed. Add
      `--fail-on-error` (or a failure-threshold) → non-zero exit.
- [x] **Fix `parseFlags` silent misparse** (`cli.ts:21-30`): `--port 8080` (space form)
      yields `port === true` → random port, no warning; unknown flags silently ignored.
      Accept `--flag value`, error on unknown flags. Add CLI arg-parsing unit tests.
- [x] **`visualice validate` subcommand + manifest JSON Schema.** Explore mode has the
      agent hand-editing `.visualice/crawl-map.cache.json` with no validation — a
      malformed state fails silently at capture time. There is a schema for the config
      but none for the manifest/cache.
- [x] **Retries.** No retry anywhere: one flaky navigation permanently loses a shot
      (`capture.ts:143-158`) or a route's links (`discover-routes.ts:129-131`). Add
      `politeness.retries` (default 1–2) around capture and discovery navigation.
- [x] **Fix failed-navigation route metadata.** If `page.goto` throws during discovery,
      `route.finalUrl` is set from `page.url()` — the _previous_ page's URL — and
      `status` stays undefined; the route is captured anyway (`discover-routes.ts:117-147`).

## Tier 2 — Packaging & distribution (the Understand-Anything gap)

- [ ] **Restructure as a Claude Code plugin** (marketplace-installable) instead of a
      repo + symlinked single SKILL.md. Split into focused entry points:
      `/visualice <url>` (crawl), `/visualice-view`, later `/visualice-diff`.
      Move shared reference material into `references/`.
- [ ] **Idempotent bootstrap** — `visualice doctor` (or skill preflight) that checks
      node deps + chromium and installs what's missing, replacing the manual
      `npm install && npx playwright install chromium` step.
- [ ] **Location independence.** Must work from any cwd, writing output to the _target
      project's_ `.visualice/`, instead of requiring commands to run from the
      visualice repo root.
- [x] **Wider flag surface** so an agent needn't author a config file for one-off
      tweaks: `--max-pages`, `--include`/`--exclude`, `--devices`, `--concurrency`,
      `--out`, `--timeout`, `--quiet`, `--version`.
- [ ] **Publish properly / build to JS.** `package.json` is `private: true`, ships raw
      TS; `bin/visualice.mjs` re-spawns `npx tsx` (devDependency required at runtime,
      breaks when installed as a dependency).
- [x] _(partial — `open` is now cross-platform; symlink + vite-build issues remain)_
      **Cross-platform fixes:** `spawn("open")` is macOS-only (`cli.ts:135`, `:199`);
      `latest` symlink creation swallows errors (`orchestrator.ts:69`) so default
      `serve` silently breaks on Windows/restricted FS; `ensureViewerBuilt` shells
      `npx vite build viewer` with `cwd: PROJECT_ROOT` (`cli.ts:75-78`).
- [x] _(SIGINT close + `--shoot` in help done; `--detach` still open)_
      **`serve` ergonomics for agents:** no SIGINT handling / server close
      (`cli.ts:137`, `:201`); add `--detach` or print-URL-and-exit. Document `--shoot`
      in `printHelp` (used by SKILL.md but absent from `--help`).
- [x] **`demo` / `demo-crawl` ignore `--config`** (`cli.ts:182`, `:208`).
- [x] _(json/quiet parsing + validate flow documented; run-size estimation still open)_
      **SKILL.md guidance gaps:** token-efficient output parsing, run-size estimation
      before crawling a large site, `.visualice/` cleanup.

## Tier 3 — Capability gaps for the UI-audit use case

- [x] _(hover done — click-fallback + nav-anchor probing; focus/validation states still open)_
      **Hover/focus probing in state discovery.** Discovery is click-only
      (`discover-states.ts:345`); `StateKind` includes `hover`/`popover`/`toast` but
      `classifyChange` can never emit them (everything unclassified falls through to
      `"accordion"`, `:242`). A hover pass removes most Explore-mode manual work —
      highest-leverage discovery improvement. Consider focus/validation states too.
- [x] **Mobile-viewport discovery pass.** _(mobile-only states carry `devices: [...]` and skip desktop capture)_ Discovery runs at a hardcoded 1280×900
      (`discover.ts:27`) — mobile-only states (hamburger nav!) are never discovered.
- [x] **Dark mode + context pinning.** `DeviceSchema` has no `colorScheme`; contexts
      don't set `locale`, `timezoneId`, `reducedMotion`, `forcedColors`
      (`capture.ts:125-132`). Without TZ/locale pinning, cross-machine byte-identity
      isn't actually guaranteed (`freezeTime` freezes `Date` but `Intl`/
      `toLocaleString` still use machine TZ).
- [ ] **Run diffing (Phase 2 headline).** The skill promises a "visual regression
      baseline" but there's no way to compare runs. Minimal version: compare two run
      dirs, flag changed/added/removed tiles, surface in the viewer.
- [x] _(pooled per-route; per-candidate re-navigation inside `probeFrom` still open)_
      **Parallelize state discovery.** `discover.ts:38-41` loops routes serially,
      ignoring `politeness.concurrency`; `probeFrom` re-navigates after nearly every
      candidate (`discover-states.ts:317-327`, `:374`). Use the existing `mapPool`.
- [ ] **Capture efficiency:** fresh `page.goto` per route×state×device
      (`capture.ts:45`) — group states by route and reuse the page where safe.
- [x] _(verify block done; cookie-expiry freshness still mtime-based)_
      **Auth verification.** `ensureStorageState` saves storageState unconditionally
      (`auth.ts:60-73`) — a changed login form silently yields a run of login-wall
      screenshots. Add a post-login assertion (URL/selector); consider cookie-expiry
      freshness instead of mtime-only (`auth.ts:53-55`).
- [x] **Staging-environment support:** _(new `http` config section; proxy still open)_ `ignoreHTTPSErrors`, `extraHTTPHeaders`,
      `httpCredentials`, proxy config — currently blocks self-signed / basic-auth /
      preview-token environments.
- [x] **Identify the crawler.** _(politeFetch: UA + timeout on robots/sitemap fetches)_ Robots parsing self-applies a `visualice` group
      (`robots.ts:10`) but requests never send a custom UA/`From` header; no fetch
      timeout on `robots.txt` (`robots.ts:158`).
- [x] **Sitemap hardening** (`discover-routes.ts:16-41`): no `<sitemapindex>`
      recursion, no `.xml.gz`, no fetch timeout, no URL-count cap before `maxPages`.
- [x] _(dead knob removed; real hash-SPA support still open)_
      **SPA support or remove the knob.** `discovery.followSpaNav` (`config.ts:68`)
      is dead — zero references outside the schema; hash-routed SPAs collapse into one
      route (`url.ts:18` drops the hash).
- [ ] **Consume `hints`.** `stableSelectors`/`flakyRegions`/`skipTriggers`
      (`types.ts:108-113`) are merged and stored but never read. Same for
      `site.framework` (never populated).
- [x] _(magic numbers now configurable + cap-starvation logged; id-dependent dedupe still open)_
      **Discovery robustness details:** id-dependent signature dedupe collapses
      anonymous dialogs (`discover-states.ts:186-190`, `:350`); `maxPerPage` cap is
      shared across nest depths with no log when depth-2 is starved (`:342`, `:428`);
      magic numbers (40-candidate cap, 4000ms click timeout, 250ms settle, viewport,
      slug lengths) should be configurable.
- [ ] **Operational safety:** no lock on concurrent runs sharing
      `crawl-map.cache.json` / `auth.json` (`orchestrator.ts:144-171`, `auth.ts:71`);
      `pruneRuns` relies on lexical dir sort + swallows rm errors
      (`orchestrator.ts:72-82`); unbounded full-page screenshots on infinite-scroll
      pages (`capture.ts:64` + hardcoded lazyScroll `stabilize.ts:51-84`); invalid
      `maskSelectors` throw at screenshot time with no pre-validation
      (`capture.ts:58`); config snapshot written verbatim to run artifacts with no
      redaction pass (`orchestrator.ts:106`); no progress/ETA output, no resume of an
      interrupted crawl.

## Tier 4 — Viewer polish

- [x] _(deferred search, route index, rAF pan, immutable image caching; spatial grid still open)_
      **Perf quick wins:** `computeLayout` grouped mode is O(routes×tiles)
      (`layout.ts:103`, `:117`) and recomputes on every search keystroke
      (`App.tsx:31-34` — debounce / `useDeferredValue`); culling linearly scans all
      tiles per transform change with unthrottled `onPointerMove`
      (`Canvas.tsx:114-133` — rAF-throttle, index by route, consider spatial grid);
      static server sends `Cache-Control: no-store` on immutable screenshots
      (`file-serve.ts:73` — use `max-age`/immutable).
- [x] _(canvas keyboard pan/zoom/fit/Escape + labels done; per-tile focus nav still open)_
      **Accessibility (currently zero):** keyboard nav between tiles, `+`/`-`/`0`
      zoom, arrow panning, Escape-to-close inspector, focusable tiles with roles +
      focus management, live region for loading. (Promised in PLAN §8.4.)
- [ ] **Missing features:** minimap/overview; run switcher (today requires restarting
      the server with `--run=`); failed-capture indicators; state-kind filter (data
      already in `ViewerTile.stateKind`); side-by-side device compare; deep-linkable
      URL state (zoom/selection/filters); viewport-crop display (`toViewerData` drops
      `ref.viewport` + `ref.meta`, `orchestrator.ts:34-64`); download/export.
- [ ] **Robustness:** no error boundary / schema validation on `viewer-data.json`
      (`App.tsx:18-29`); eager whole-file load with no pagination for huge runs;
      `?data=` accepts arbitrary URLs (`App.tsx:6`) — constrain it.
- [ ] **Type drift:** `viewer/src/types.ts` is a hand-maintained duplicate of
      `src/shared/types.ts` (widened `stateKind`, missing `Device` fields) — share or
      add a drift test.
- [ ] **LOD mid-tier:** only 480px thumb ↔ full multi-MB PNG (`lod.ts:61-62`); add a
      ~1024px tier or DZI tiles (Phase 2) for dpr-3 full-page shots.

## Tests & CI

- [x] _(done: CLI arg parsing, report failures, manifest schema + drift, mobile-merge;
      the rest below still open)_
      Cover the orchestration seam: `orchestrator.ts` (`makeRunId`, `pruneRuns`,
      `updateLatest`, **`toViewerData`** — the viewer data contract), capture failure
      paths, `thumbnails.ts`, `report.ts`, auth flow (staleness, `--force`),
      `discover-routes` unit-level (sitemap, `maxDepth`/`maxPages` boundaries,
      goto-failure), `pool.ts` semantics, `file-serve` MIME/streaming, **all CLI arg
      parsing** (would have caught the `--port 8080` bug).
- [ ] CI: OS matrix (Windows would catch the symlink/`open` issues), artifact upload
      on integration failure, `visualice --help` bin smoke test, coverage reporting,
      fixture rebuild+diff check, release/publish workflow.

## Suggested order (top five)

1. Failures + `--json` + exit codes (Tier 1, one pass)
2. `validate` subcommand + manifest schema
3. Plugin packaging + bootstrap + location independence
4. Hover + mobile-viewport discovery
5. Run diff

The first three make it a _trustworthy_ skill; the last two make it clearly better
than pointing an agent at Playwright MCP directly.
