# Visualice — Roadmap

> Updated 2026-09-21. The 2026-07-28 code review's ~43 findings, the **project-file
> UX** (PLAN.md §9, shipped 2026-08-05) and the 2026-09-21 roadmap pass are all done.
> This second pass closed the 11 items that pass left open, so **the roadmap is
> currently empty** — what's below is the record of what was built and what it cost,
> plus the handful of limitations worth knowing before the next one.
>
> `PLAN.md` holds the design rationale (architecture, pipeline, viewer design);
> §10 there covers the distribution and diffing decisions.

## Status

The first pass landed in `113e2b2` "Implemented improvements part 1" (87 files) and
`e690169` "Improvements part 2". The work described under "Second pass" below is in
the working tree on top of those.

**Verification as of the last run — everything is green:**

- `npm run check` (typecheck · lint · format · unit): **414 unit tests**, 37 files.
- `npm run test:integration`: **43 tests**, 11 files (~80s).
- `npm run demo:crawl`: 10 routes, **72 shots**, 0 failures, ~31s,
  `page reuse: 20 of 72 shot(s) needed no reload`.
- `visualice diff` across the pre-change baseline and the post-change crawl of the
  same fixture: **72 unchanged, 0 changed** — the engine rework is behaviour-preserving
  by its own measurement.
- `npm run build` + `node bin/visualice.mjs doctor --json --no-fix`: all four checks ok.

## ✅ Shipped in the first pass (2026-09-21)

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
      auth freshness from cookie expiry rather than file mtime (since narrowed to the cookies
      named in `login.sessionCookies` — see `REVIEW.md` finding 2); focus/validation form
      states.
- [x] **Viewer.** Grouped layout wraps into columns (Fit went from 2% to ~17% on the
      fixture); run switcher; minimap; failed captures as placeholder tiles with a filter
      toggle; error boundary + `viewer-data.json` validation; `?data=` restricted to
      same-origin; mid-resolution LOD tier (56 KB vs 735 KB at reading zoom);
      spatial-grid culling; state-kind filter; deep-linkable URL state; shift+arrow tile
      navigation; viewport-crop link; tile cap for huge runs; types shared with the
      engine instead of duplicated.
- [x] **Tests & CI.** CI runs a Windows leg, a bin smoke test against the built CLI,
      coverage, failure-only artifact upload and a fixture/schema drift check;
      `release.yml` publishes on a `v*` tag.

Two bugs were found and fixed by that work rather than reported by anyone:

- **Page reuse leaked `:hover` between shots.** A reused page keeps its pointer
  position, and the browser re-applies `:hover` at that position to each newly
  loaded document — a phantom hover painted into unrelated screenshots. Caught by
  `visualice diff` itself (9 of 68 shots changed against the pre-rework baseline),
  fixed by parking the pointer off-viewport after navigation, and pinned by
  `tests/integration/capture-pool.test.ts` (60,000 leaked pixels without the fix).
- **`clip` without `fullPage` silently clamps to the viewport**, so the first cut of
  `screenshot.maxHeight` produced 300px-tall images instead of 1000px ones.

## ✅ Shipped in the second pass — the 11 that were left open

### Engine

- [x] **Real hash-SPA support.** `scope.hashRoutes` (`auto` by default) makes a
      router-shaped fragment — `#/about`, `#!/about` — part of route identity, while a
      plain `#pricing` anchor stays an anchor. `#`, `#/` and `#!/` fold onto the page
      itself so the router's home isn't a second copy of `/`. `pathSlug` gives each
      client route its own folder (`home__h-about`), since they all share one pathname.
      The half that isn't URL parsing: a fragment-only change is a **same-document**
      navigation, so `goto` returns no response and the previous view is still on
      screen — `gotoRoute` reloads in that case, which is what makes the shot the right
      page rather than the one before it. `tests/integration/hash-routes.test.ts`
      crawls a real hash-routed SPA and asserts the four shots are four different
      images.
- [x] **Signature dedupe is no longer id-dependent.** `takeSnapshot` keyed every open
      region on its `id`, so two anonymous dialogs both snapshotted as `m:` and the
      second was discarded as a duplicate of the first. Regions now fall back to
      `aria-label`, then the text of `aria-labelledby`, then a sibling-index DOM path —
      deterministic for a given DOM, so a state re-probed still dedupes against itself.
- [x] **Per-candidate re-navigation inside `probeFrom`.** The loop reloaded the route
      after every candidate. It now tries the cheap things first: look (most probes
      change nothing at all, and the page is already where it should be), then dismiss
      (Escape plus parking the pointer closes what a probe opened), and only then
      reload. The nested case is no longer special-cased into an unconditional reload —
      it recognises its parent by the signature it was recorded with. Each route logs
      `N reload(s), M reuse(s) while probing`.
- [x] **Page reuse now pays off.** The measurement in the first pass was right: the
      cost is navigation, not the page lifecycle. So capture skips the navigation when
      it can. `reusePlan` runs a state's recipe on the page already loaded whenever
      that recipe _extends_ what's on screen — every state captured straight after its
      route's default render, and every nested state captured after its parent.
      `orderForReuse` sorts a route's states so those pairs end up adjacent, and the
      pool's unit of work is now a route rather than a state so one worker sees them in
      a row. On the fixture: **20 of 72 shots need no reload**, and the run diffs clean
      against the pre-change baseline. `politeness.reuseNavigation` turns it off.
- [x] **`stabilize.waitForSelectors` shares one budget per shot.** Eight stale
      selectors used to cost 8 × 5s on _every_ shot. They're now waited on
      concurrently against a single deadline, so the ones that are there resolve
      immediately and only the genuinely absent ones reach the timeout — once,
      together. Sequential-with-a-shared-budget would have been the wrong fix: the
      first stale selector would eat the whole budget and make the rest look stale too.

### Viewer

- [x] **Diff results in the viewer.** `serve` now exposes `/diffs.json` and
      `/diffs/<id>/…` beside the runs, and picking a comparison lays out every changed
      shot as before / after / diff, biggest change first, with an **unchanged** toggle.
      This needs the server rather than a single run's data because the three images
      live in three directories — which is also why `diff.json` now records
      `fromShot`/`toShot` instead of leaving a reader to reimplement the slugging rules
      to find the pictures the numbers are about.
- [x] **Side-by-side device compare.** The item the first pass claimed and didn't do.
      A **Devices** mode lays out one route at a time, one row per state, every device
      drawn at the _same_ width — grouped mode scales each device to its viewport, so
      the two renders can't be compared by looking straight down the row. The sidebar
      picks the subject, the inspector has a "Compare devices" button, and the route is
      in the URL.
- [x] **Virtualized sidebar.** Past 60 rows the path list renders only what's in view
      plus a margin, bracketed by two spacers so the scrollbar stays the size the full
      list would give it. Below that threshold it renders normally — virtualizing a
      twenty-route run costs a scroll listener and fixed row heights for nothing.

### Serving & infrastructure

- [x] **Range requests in `file-serve.ts`.** `Accept-Ranges`, `Content-Length`, 206 with
      `Content-Range`, 416 for a range past the end, and `HEAD`. Anything unimplemented
      (an unknown unit, a multi-range request) answers with the whole body, which is
      always a correct answer to a range request; 416 is reserved for a well-formed
      range that lies outside the file, where quietly serving the first N bytes would
      corrupt whatever the client is assembling.
- [x] **`@vitest/coverage-v8` is a real devDependency.** With a `coverage` block in
      `vitest.config.ts` (`all: true`, so a module with no tests is visible rather than
      absent) and an `npm run test:coverage` script. CI's ad-hoc `npm i -D --no-save` is
      gone.
- [x] **Windows integration leg.** The browser integration job is now a matrix over
      ubuntu + windows, with the per-OS Playwright cache path and browser install.
      `tests/integration/helpers.ts` honours `VISUALICE_TEST_TMP` so the failure
      artifact can actually collect what a crashed test left behind, wherever that
      runner's temp directory happens to be.

## Known limitations

Not roadmap items — things worth knowing before someone reports them as bugs.

- **The diff view loads full-size images.** `visualice diff` writes no thumbnails, so
  the before/after/diff tiles have only a `full` source and the LOD ladder has nothing
  to step through. Fine for a handful of changed shots; a diff with hundreds of them
  will be slow to paint at low zoom.
- **Comparisons need `visualice serve`, not a bare run directory.** A diff's three
  images live in two run directories and the diff directory; a viewer served from one
  run has no path to the other two, so the comparison picker simply doesn't appear.
- **`scope.hashRoutes: "always"` will fork on anchors.** It exists for routers that
  drop the slash (`#about`); on a documentation site it turns every heading link into a
  route. `auto` is the default for that reason.
- **The Windows integration leg has never actually run.** It's wired and the code it
  exercises is OS-sensitive (symlinked `latest`, run directories, temp paths) — the
  first CI run on it is the one to watch.
- **Unnamed region signatures are a DOM path plus a hash of what the region says.** The
  hash is what tells apart two portal dialogs mounted in turn at the same spot (see
  `REVIEW.md` finding 13). Two unnamed regions with the same opening text in the same
  spot still collide, and a region whose text changes between probes (a live timer)
  stops deduping against itself. Named regions (`id`, `aria-label`, `aria-labelledby`)
  are unaffected, which is most of them.
- **Stabilization can close what a recipe opened.** The lazy-load scroll runs after the
  recipe, so a menu that closes on scroll is photographed closed. Page reuse now detects
  this and reloads rather than building on it (`REVIEW.md` finding 11), but the shot of
  the menu state itself is still taken after the scroll.
