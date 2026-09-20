# Visualice — Roadmap

> What's left to build, prioritized (updated 2026-08-05). The full 2026-07-28 code
> review produced ~43 findings; everything not listed here was implemented in the
> Tier 1–4 pass (agent contract: failures end-to-end, `--json`, exit codes, strict
> flags, `validate` + manifest schema, retries; CLI ergonomics: override flags,
> cross-platform open, SIGINT handling; discovery: hover + mobile passes, parallel
> probing, dark-mode/locale/TZ pinning, auth verify, `http` config, sitemap/robots
> hardening; viewer: deferred search, indexed layout, rAF pan, immutable caching,
> keyboard nav; 31 new tests). The **project-file UX** (PLAN.md §9 — editable
> `visualice.routes.md` with `skip:`/`[ ]` steering, `wanted` surfacing, `init` +
> `routes` commands, config auto-detection, auto-scaffold on first crawl) shipped
> 2026-08-05. See git history for details.
>
> `PLAN.md` holds the design rationale (architecture, pipeline, viewer design).

## 1. Distribution — the make-or-break cluster

The whole premise is "an on-demand crawler any agent can invoke against whatever
project it's in" — but today visualice only works from this repo's root, through
`tsx`. These four items are really one job:

- [ ] **Location independence.** Run from any cwd: write `.visualice/` into the
      _target project_, resolve viewer assets / fixture relative to the install
      (not `process.cwd()` / `PROJECT_ROOT` assumptions in `cli.ts`).
- [ ] **Build to JS / publish.** `package.json` is `private: true` and ships raw TS;
      `bin/visualice.mjs` re-spawns `npx tsx` (a devDependency required at runtime —
      breaks when installed as a dependency). Ship a `dist/` build with a real `bin`
      entry, npx-able or globally linkable.
- [ ] **Plugin restructure.** Package skill + engine as a marketplace-installable
      Claude Code plugin instead of a cloned repo + symlinked SKILL.md. Focused entry
      points: `/visualice <url>` (crawl), `/visualice-view`, later `/visualice-diff`;
      shared reference material in `references/`.
- [ ] **`visualice doctor`** — idempotent preflight that checks Node version + deps +
      Playwright chromium and self-heals (`npx playwright install chromium`), so the
      skill's first run doesn't die cryptically. Replaces the manual
      `npm install && npx playwright install chromium` step.

**Open decision:** packaging shape — plugin-with-embedded-engine vs. npm package
that a thin skill wrapper shells out to. Leaning npm-package + wrapper (keeps the
engine usable outside Claude).

## 2. Run diffing — the headline feature

- [ ] **Run diff (Phase 2 headline).** The skill/README promise "visual regression
      between runs" and nothing implements it. Minimal version: compare two run dirs'
      manifests, pixel-diff matching shots, emit `diff-report.md` with
      changed/added/removed states; surface in the viewer later. This is what makes
      the tool more than a screenshot script.

## 3. Worth doing, not urgent

- [ ] **Capture page-reuse.** Fresh `page.goto` per route×state×device
      (`capture.ts`) — group states by route×device and reuse the page where safe;
      roughly halves capture time on big sites.
- [ ] **Consume `hints`.** `stableSelectors`/`flakyRegions`/`skipTriggers`
      (`types.ts`) are merged, stored, and validated — but never read by the engine,
      so Explore-mode advice silently does nothing. Same for `site.framework`.
- [ ] **Run lock.** Two concurrent runs sharing `crawl-map.cache.json` / `auth.json`
      corrupt each other (`orchestrator.ts`, `auth.ts`).
- [ ] **Run pruning.** `output.keepRuns` is configured but `pruneRuns` relies on
      lexical dir sort and swallows rm errors (`orchestrator.ts`).
- [ ] **Screenshot safety.** Unbounded full-page shots on infinite-scroll pages
      (clamp height); invalid `maskSelectors` throw at screenshot time with no
      pre-validation.
- [ ] **Config snapshot redaction pass** before writing run artifacts
      (`orchestrator.ts`) — defense in depth on top of the `${ENV_VAR}`
      placeholder convention.
- [ ] **Progress/ETA output + resume** of an interrupted crawl.

## 4. Viewer polish (deferrable)

- [ ] **Run switcher** (today requires restarting the server with `--run=`).
- [ ] **Minimap/overview.**
- [ ] **Failed-capture indicators** (failures are in `viewer-data` inputs now;
      `toViewerData` should surface them).
- [ ] **Robustness:** error boundary + schema validation on `viewer-data.json`
      (`App.tsx`); constrain `?data=` (currently accepts arbitrary URLs); pagination
      for huge runs.
- [ ] **Type drift:** `viewer/src/types.ts` is a hand-maintained duplicate of
      `src/shared/types.ts` — share the types or add a drift test.
- [ ] **LOD mid-tier:** only 480px thumb ↔ full multi-MB PNG (`lod.ts`); add a
      ~1024px tier (or DZI tiles) for dpr-3 full-page shots.
- [ ] **Smaller features:** state-kind filter (data already in
      `ViewerTile.stateKind`); side-by-side device compare; deep-linkable URL state;
      viewport-crop display (`toViewerData` drops `ref.viewport` + `ref.meta`);
      per-tile keyboard focus nav; spatial grid for culling.

## 5. Tests & CI

- [ ] **Orchestration seam coverage:** `orchestrator.ts` (`makeRunId`, `pruneRuns`,
      `updateLatest`, **`toViewerData`** — the viewer data contract), capture failure
      paths, `thumbnails.ts`, auth flow (staleness, `--force`, verify), sitemap /
      `maxDepth`/`maxPages` boundaries, `pool.ts`, `file-serve` MIME/streaming.
- [ ] **CI matrix:** Windows runner (would catch symlink/`open` issues before a user
      does), artifact upload on integration failure, `visualice --help` bin smoke
      test, coverage reporting, fixture rebuild+diff check, release/publish workflow.

## Leftover engine niceties (backlog)

- Focus/validation-state probing in discovery (hover is done; focus states and form
  validation states are not).
- Real hash-SPA support (hash-routed SPAs collapse into one route; the dead
  `followSpaNav` knob was removed).
- Signature dedupe is id-dependent — anonymous dialogs can collapse
  (`discover-states.ts`).
- Cookie-expiry–based auth freshness (currently mtime-only).
- Proxy config in the `http` section.
- Per-candidate re-navigation inside `probeFrom` (route-level parallelism is done;
  within-route probing still re-navigates often).
- SKILL.md: run-size estimation guidance before crawling a large site; `.visualice/`
  cleanup guidance.

## Suggested order

1. Distribution cluster (§1) — decide packaging shape first, then all four items in
   one pass. This is what turns it from a repo into a skill.
2. Run diff (§2).
3. Capture page-reuse + hints + run lock/pruning (§3).
4. Viewer + tests/CI as time allows.
