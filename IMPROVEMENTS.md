# Visualice — Roadmap

> Updated 2026-09-21. The 2026-07-28 code review's ~43 findings and the
> **project-file UX** (PLAN.md §9, shipped 2026-08-05) are done. The 2026-09-21
> roadmap pass — everything that used to be §1–§5 of this file — is done too, and
> is summarised below so the remaining items have context.
>
> `PLAN.md` holds the design rationale (architecture, pipeline, viewer design);
> §10 there covers the distribution and diffing decisions from this pass.

## Status

Everything marked ✅ below landed in `113e2b2` "Implemented improvements part 1"
(87 files). The form-state follow-up described next is in the working tree on top
of it.

**Verification as of the last run — everything below is green:**

- `npm run check` (typecheck · lint · format · unit): **323 unit tests**.
- `npm run test:integration`: **39 tests**.
- `npm run demo:crawl`: 10 routes, **72 shots**, 0 failures, ~31s.
- `visualice diff` across two consecutive fixture crawls: 72 unchanged, 0 changed.

Form-state discovery is now confirmed. For the record, the two things that took a
crawl rather than a test to find:

- **States with no `signature` were duplicated by the mobile pass.**
  `mergeMobileStates` (`src/crawl/discover.ts:31-35`) dedupes by `signature`, so
  signature-less form states survived it and `uniqueId` renamed them — **two
  `focus` states per form route**, 68 shots becoming 74. Fixed by keying the
  signature on the field (`focus:<target>`, `validation:<targets>`); `/contact` and
  `/login` now record exactly one each.
- **`targetFor` ignored `data-testid`**, which the trigger prober
  (`discover-states.ts:98`) already treats as the most stable handle. The fixture's
  login inputs carry only a test id, so the recorded recipe fell through to a
  positional `nth:` — a position in the page's whole field order that any input
  added above it would invalidate. Now `testId` is preferred first. The re-crawl
  diffs clean against the previous one, so the recipes target the same fields; they
  just no longer depend on counting.

Also worth knowing: the fixture's own contact form validates on submit, not on blur,
so no `validation` state is discovered there — correct behaviour (discovery never
submits), and the reason the validation path is covered by a synthetic
blur-validating page in `tests/integration/discover-forms.test.ts` instead.

## ✅ Shipped in the 2026-09-21 pass

Everything in this section is done. The unchecked boxes further down are the
**11 items that remain open** — see "What's left, and why" below for where each
came from.

- [x] **Distribution.** Publishable npm package (`dist/` ESM bundle + declarations via
      `npm run build`, `prepack`, `files`, `engines`); `bin/visualice.mjs` runs the build
      and falls back to `tsx` only in a source checkout whose sources are newer than it.
      `visualice doctor` is the self-healing preflight. The repo root is now a Claude
      Code plugin _and_ marketplace (`.claude-plugin/`, `commands/`, `skills/`),
      replacing the cloned-repo + symlinked-SKILL.md arrangement. Location independence
      is held down end-to-end by `tests/integration/cli-bin.test.ts`.
- [x] **Run diffing.** `visualice diff` pairs two runs by route|state|device, pixel-diffs
      each pair (overlap-only when a page's height changed), writes `diff-report.md` +
      `diff.json` + magenta-highlighted diff images, and exits 3 under `--fail-on-error`.
- [x] **Engine.** Page reuse per worker; `hints` consumed (flakyRegions → masks,
      stableSelectors → waits, skipTriggers → discovery denials); output-directory lock;
      pruning by parsed run time that never counts or deletes directories it didn't
      create; `screenshot.maxHeight` clamp + selector pre-validation; credential
      redaction in the config snapshot; progress + ETA; `crawl --resume`; `http.proxy`;
      auth freshness from cookie expiry rather than file mtime; focus/validation form
      states.
- [x] **Viewer.** Grouped layout wraps into columns (Fit went from 2% to ~17% on the
      fixture); run switcher; minimap; failed captures as placeholder tiles with a filter
      toggle; error boundary + `viewer-data.json` validation; `?data=` restricted to
      same-origin; mid-resolution LOD tier (56 KB vs 735 KB at reading zoom);
      spatial-grid culling; state-kind filter; deep-linkable URL state; shift+arrow tile
      navigation; viewport-crop link; tile cap for huge runs; types shared with the
      engine instead of duplicated.
- [x] **Tests & CI.** 323 unit + 39 integration tests. CI runs a Windows leg, a bin smoke
      test against the built CLI, coverage, failure-only artifact upload and a
      fixture/schema drift check; `release.yml` publishes on a `v*` tag.

Two bugs were found and fixed by this work rather than reported by anyone:

- **Page reuse leaked `:hover` between shots.** A reused page keeps its pointer
  position, and the browser re-applies `:hover` at that position to each newly
  loaded document — a phantom hover painted into unrelated screenshots. Caught by
  `visualice diff` itself (9 of 68 shots changed against the pre-rework baseline),
  fixed by parking the pointer off-viewport after navigation, and pinned by
  `tests/integration/capture-pool.test.ts` (60,000 leaked pixels without the fix).
- **`clip` without `fullPage` silently clamps to the viewport**, so the first cut of
  `screenshot.maxHeight` produced 300px-tall images instead of 1000px ones.

## What's left, and why

The 11 unchecked items below are all genuinely open. Where they came from:

- **1 is a gap in the pass itself.** _Side-by-side device compare_ (§2) was one of
  six sub-items bundled into the old §4 "Smaller features" line. The other five
  (state-kind filter, deep-linkable URL state, viewport-crop, keyboard tile nav,
  spatial-grid culling) shipped; this one didn't. It should have.
- **3 were deferred backlog, never part of §1–§5.** Hash-SPA support, id-dependent
  signature dedupe, and `probeFrom` re-navigation sat under "Leftover engine
  niceties" before this pass and still do. The other four backlog items —
  focus/validation states, cookie-expiry auth, proxy config, and the SKILL.md
  run-size/cleanup guidance — are done.
- **7 are new, found by doing the work.** Diff-in-the-viewer only became possible
  once `diff` existed; the page-reuse measurement and the `waitForSelectors` budget
  came out of profiling; range requests, the ad-hoc coverage dependency and the
  missing Windows integration leg were noticed while building CI.

## 1. Engine niceties still open

- [ ] **Real hash-SPA support.** Hash-routed SPAs still collapse into one route.
- [ ] **Signature dedupe is id-dependent** (`discover-states.ts`) — two anonymous
      dialogs can still collapse into one state.
- [ ] **Per-candidate re-navigation inside `probeFrom`.** Route-level parallelism is
      done; within-route probing still re-navigates more than it needs to.
- [ ] **Page reuse didn't pay off as hoped.** Measured on the bundled fixture it made
      no difference (30.2s before and after, 68 shots): the cost is navigation plus
      stabilization, not the page lifecycle. The reuse is worth keeping — the
      retry/recycle path is built on it — but the remaining win is in skipping
      redundant _navigation_, which needs the engine to know when a recipe can run on
      the page already loaded.
- [ ] **`stabilize.waitForSelectors` timeout is per-selector, not per-shot.** Eight
      stale selectors cost 8 × 5s on every shot. A shared budget would be better.

## 2. Viewer polish still open

- [ ] **Diff results in the viewer.** `visualice diff` writes images and a report; the
      viewer can't show them. A third layout mode showing before/after/diff per changed
      shot is the natural home, and would finish the regression story.
- [ ] **Side-by-side device compare.** Pick one state, see every device aligned.
      _The one item from the §1–§5 scope that didn't get done._
- [ ] **Virtualized sidebar** for runs with hundreds of routes.

## 3. Serving & infrastructure

- [ ] **Range requests in `file-serve.ts`.** No `Accept-Ranges`, no `Content-Length`;
      a `Range` header gets a 200 with the whole body. Fine for PNGs over localhost,
      wrong if the viewer is ever proxied or serves video.
- [ ] **`@vitest/coverage-v8` as a real devDependency.** CI installs it ad hoc with
      `npm i -D --no-save` so coverage runs without it being in `package.json`.
- [ ] **Windows integration leg.** The `check` job runs on Windows; the browser
      integration job does not.

## Suggested order

1. **Commit the form-state follow-up** — verified, but still only in the tree.
2. Diff results in the viewer (§2) — the data exists but stops at the report.
3. Everything else as it gets in the way.
