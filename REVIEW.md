# Visualice — Code review

> Reviewed 2026-09-21 against `3d28b2d` ("Improvements part 3"). Working tree clean.
> The fixes below have since been committed (`7851a4e`, `df734c5`).
>
> **Pass 1** covered `git diff main...HEAD` — 5 commits, ~23k lines, with the careful
> read on `src/`, `bin/`, `scripts/` and `viewer/src/` (~9.3k diff lines); generated
> fixtures, docs and tests were skipped. That is effectively the whole project, since
> those five commits built it, but it is _not_ a fresh read of files untouched since
> `main`.
>
> Every finding below was re-verified against the source before being written down —
> finding 4 by running the CLI, finding 9 by calling `pathSlug`, the rejected claim by
> driving Chromium, the rest by reading the cited code. `IMPROVEMENTS.md`
> is the roadmap (currently empty); this file is the defect list.

## Status

| #   | Finding                                          | File                                    | Severity | Status |
| --- | ------------------------------------------------ | --------------------------------------- | -------- | ------ |
| 1   | Immutable cache on `/data/` serves the old run   | `src/shared/file-serve.ts:137`          | High     | Fixed  |
| 2   | Session expiry is the min of _all_ cookies       | `src/crawl/auth.ts:53`                  | High     | Fixed  |
| 3   | `--to=<older run>` inverts the diff              | `src/cli.ts:316`                        | Medium   | Fixed  |
| 4   | `cmd in COMMAND_FLAGS` walks the prototype chain | `src/cli.ts:616`, `src/cli-args.ts:105` | Medium   | Fixed  |
| 5   | `indexOf` sort cancels out the spatial index     | `viewer/src/lod.ts:124`                 | Medium   | Fixed  |
| 6   | `pruneRuns` keep budget is off by one            | `src/crawl/orchestrator.ts:130`         | Low      | Fixed  |
| 7   | Dead ternary in the "Clamped" report line        | `src/crawl/report.ts:41`                | Trivial  | Fixed  |
| 8   | `atParent` never checks the URL                  | `src/crawl/discover-states.ts:416`      | High     | Fixed  |
| 9   | Hash-route slugs collide                         | `src/shared/slug.ts:42`                 | High     | Fixed  |
| 10  | `sizeChanged` overrides `minRatio`               | `src/diff/index.ts:93`                  | Medium   | Fixed  |
| 11  | `shown.recipe` recorded after stabilize scrolls  | `src/crawl/capture.ts:220`              | Medium   | Fixed  |
| 12  | `atBaseline` compares to zero, not the baseline  | `src/crawl/discover-states.ts:572`      | Medium   | Fixed  |
| 13  | `domPath` collides for portal overlays           | `src/crawl/discover-states.ts:221`      | Medium   | Fixed  |
| 14  | `aria-controls` ID list breaks the selector      | `src/crawl/discover-states.ts:347`      | Low-Med  | Fixed  |

Line numbers refer to `3d28b2d`. All fourteen are fixed in the working tree (uncommitted);
each finding ends with a **Fixed** note saying how, and what changed in behaviour.
Verification is at the end.

## The pattern behind four of them

Findings 1–4 are the same mistake in four places: **a value is treated as stable when
the thing it names is an alias.**

- `/data/` is an alias for whichever run `latest` points at, so caching it as immutable
  is a category error, not a tuning mistake.
- "the session expires at T" is treated as a property of the cookie jar when it is a
  property of one cookie in it.
- `--to` is treated as "the newest run" when it is "a run".
- `in` is treated as "has this key" when it is "can this name be resolved".

Each is a few lines to fix. The habit is worth naming because it will keep producing
findings otherwise.

---

## 1. Immutable caching on `/data/` serves the previous run's screenshots

**`src/shared/file-serve.ts:137`** — High.

```ts
const immutable = [".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2", ".ico"].includes(ext);
res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-store");
```

The comment above it says "immutable per run (a re-crawl gets a new run dir)" — true for
`/runs/<id>/…`, false for `/data/`, which is the same header path.

`cmdServe` (`src/cli.ts:385`) defaults to `runDir = <out>/runs/latest` and `serveViewer`
mounts it at `/data/`. The viewer's default base is `./data/` (`viewer/src/App.tsx:46` —
`run` starts as `null`).

**Failure:** crawl → `visualice serve` → re-crawl → reload the viewer. `viewer-data.json`
is `no-store`, so the tile list is the new run's; but every image URL
(`/data/screenshots/<route>/<state>/<device>.png`) is byte-identical to the previous
run's URL and cached for a year, so the browser never refetches. A visual-regression
tool shows the old pixels with no error and no warning.

**Fix:** mark immutable only when serving from a real run id. `/data/` needs a
revalidating header (`no-cache`, or an ETag), or the viewer should default to
`./runs/<resolved-id>/` — `cmdServe` already resolves `latest` to a concrete id for the
`runId` option it passes to `serveViewer`.

**Fixed.** `serveFileFromRoot` takes an `immutable` option and defaults to revalidation:
media gets `no-cache` plus an `ETag` from size and mtime, so an unchanged file costs a 304
rather than its bytes. `serve.ts` passes `immutable` only for `/runs/<id>/…` where `<id>`
isn't `latest` **and** the run has no `.incomplete` marker — a run still being written,
or awaiting `--resume`, rewrites a half-finished image at the same path, so it isn't final
either. `/data/` and `/diffs/` always revalidate. Tests: `tests/file-serve.test.ts`
(validator changes on rewrite, 304 on match), `tests/serve.test.ts` (header per path,
including `latest` and an incomplete run).

## 2. `storageStateExpiry` takes the minimum over every cookie

**`src/crawl/auth.ts:53`** — High.

```ts
return expiries.length ? Math.min(...expiries) : undefined;
```

`context.storageState()` persists every cookie the login flow picked up — CSRF tokens,
consent banners, analytics — not just the session cookie. Taking the soonest of those as
"when the session expires" means a five-minute CSRF cookie decides the session is stale.

**Failure:** `expiry - Date.now() > 60_000` is false on the next crawl, so
`ensureStorageState` re-runs the login recipe. Worse, once _any_ saved cookie's expiry is
in the past, `fresh` is false permanently and the recipe runs on every invocation
forever. This is a regression from the previous `maxAgeHours` behaviour and will trip
rate limiting or MFA on a real site.

**Fix:** scope the check to cookies that actually carry the session — ignore
already-expired ones, or take the longest-lived rather than the shortest.

**Fixed, differently from either suggestion above.** Neither aggregate is right: a
cookie jar's expiries can't tell you which cookie is the session, and many sessions are
browser-session cookies with no expiry at all — so the old code was often reading _only_
the irrelevant ones. New option `auth.login.sessionCookies` (names; a trailing `*` matches
a prefix, e.g. `wordpress_logged_in_*`). When set, the soonest expiry among those decides;
otherwise freshness is `maxAgeHours` again, which is the pre-regression behaviour.
**Behaviour change:** cookie-based freshness is now opt-in. Schema regenerated, skill
reference updated. Tests: the lapsed-CSRF-cookie regression, a named cookie trusted over
`maxAgeHours`, a named cookie's expiry forcing a login, prefix matching.

## 3. `--to=<older run>` picks a newer baseline and inverts the diff

**`src/cli.ts:316`** — Medium.

```ts
const before = runs.filter((r) => r !== to.id);
const id = before.at(-1);
```

`listRuns` returns ids ascending (`src/crawl/runs.ts:45`; `latestRunId` depends on
`.at(-1)` being newest), so this is "the newest run that isn't `to`" — not "the run
before `to`", which is what `printHelp` documents.

**Failure:** `visualice diff --to=<yesterday's run>` sets `from` to today's run, compares
today against yesterday, and labels today as the baseline. Added and removed routes are
reported backwards.

**Fix:** pick the newest run strictly older than `to.id`.

**Fixed.** `previousRunId(runs, toId)` in `runs.ts`: the newest run strictly older than
`to`, by the ordering `listRuns` uses. A `--to` passed by path is placed where its id
sorts. The oldest run gets its own error. Tests in `tests/runs.test.ts`.

## 4. The unknown-command guard uses `in`

**`src/cli.ts:616`** (and `src/cli-args.ts:105`) — Medium.

```ts
if (!(cmd in COMMAND_FLAGS)) {
```

`COMMAND_FLAGS` is a plain object literal, so every `Object.prototype` name passes.
Both of these were verified by running them:

- `visualice toString` — passes the guard, matches no `switch` case, exits **0** with no
  output. Should print help and exit 2.
- `visualice valueOf --json` — reaches `parseFlags`, where `COMMAND_FLAGS[cmd] ?? []`
  resolves to `Object.prototype.valueOf` (a function, not nullish), and
  `allowed.includes(name)` throws `TypeError: allowed.includes is not a function` with a
  full stack trace.

**Fix:** `Object.hasOwn(COMMAND_FLAGS, cmd)` in both places.

**Fixed.** `isCommand()` in `cli-args.ts` uses `Object.hasOwn`, and all three table
lookups in `parseFlags` (`COMMAND_FLAGS`, `POSITIONAL`, `FLAG_TYPES`) go through an
own-property helper. `visualice toString` now prints help and exits 2; `valueOf --json`
no longer crashes. Tests in `tests/cli-args.test.ts`.

## 5. `cullTilesIndexed` sorts with `indexOf`

**`viewer/src/lod.ts:124`** — Medium (performance).

```ts
return out.sort((a, b) => index.all.indexOf(a) - index.all.indexOf(b));
```

A linear scan of every placed tile, twice per comparison, on a memo that re-runs on every
pan and zoom frame. At the default 2500-tile cap with ~60 tiles on screen that is roughly
350 comparisons × 2 lookups × up to 2500 steps ≈ **1.7M array steps per frame** — on the
line immediately after the spatial grid that exists to avoid exactly this.

**Fix:** build a `Map<Placed, number>` order index once in `buildTileIndex` and sort by
lookup.

**Fixed.** `buildTileIndex` builds a `Map<Placed, number>` once and the cull sorts by
lookup. The new test makes `indexOf` throw on the layout array; it was confirmed to fail
against the old code.

## 6. `pruneRuns` filters `current` after slicing

**`src/crawl/orchestrator.ts:130`** — Low.

```ts
const doomed = ids.slice(0, Math.max(0, ids.length - keep)).filter((id) => id !== current);
```

Removing `current` from the doomed set does not widen the window, so one slot is spent
protecting it and never reclaimed.

**Failure:** whenever the run `latest` points at falls inside the first `len - keep` ids
— a `latest` symlink left pointing at an older run, or clock skew producing a run id that
sorts early — the retained count sits at `keep + 1` permanently.

**Fix:** filter `current` out of `ids` before slicing. Narrow trigger, one-line fix.

**Fixed — and the fix above was wrong.** Filtering `current` out of `ids` before slicing
produces exactly the same doomed set as filtering it after: `current` is still outside the
budget. The actual fix counts it _against_ the budget — `runsToPrune(ids, keep, current)`
keeps `current` plus the newest `keep − 1` others. `pruneRuns` is also now handed the id
of the run just written instead of reading `latest` back: if the symlink couldn't be made,
`latestRunId` falls back to whichever id sorts newest, which under clock skew isn't the
run this crawl produced. Tests in `tests/runs.test.ts`.

## 7. Dead ternary in the report

**`src/crawl/report.ts:41`** — Trivial.

```ts
`- **Clamped:** ${clamped} shot(s) hit the ${m.devices.length ? "" : ""}max-height limit and were cropped`;
```

Both branches are the empty string — an unfinished edit. Output is unaffected, but the
expression reads as though it names the limit and does not.

**Fix:** interpolate `config.screenshot.maxHeight`, or delete the ternary.

**Fixed.** The line names `screenshot.maxHeight`. The manifest doesn't carry the
configured value, and the key is what a reader needs in order to change it.

---

# Pass 2 — the engine, adversarially

Pass 1 read broadly and found nothing in the subsystems most able to produce a screenshot
that is _wrong_ rather than missing. Pass 2 targeted exactly those, with the brief to
challenge the design rather than scan for defects: can reuse diverge from a fresh
navigation, is `response === null` a trustworthy signal, can the parent-state check be
satisfied by a page that is not the parent, can two client routes collide onto one slug.

Eight claims came back. **One was wrong** and is recorded below under "Rejected" — it was
disproven by running the browser, not by reading. The other seven are findings 8–14.

## 8. `atParent` never looks at the URL

**`src/crawl/discover-states.ts:416`** — High.

```ts
const atParent = async (): Promise<boolean> => {
  const snap = await takeSnapshot(page);
  return nested
    ? parent.signature !== undefined && snap.sig === parent.signature
    : ctx.atBaseline(snap);
};
```

`takeSnapshot` reports open modals, expanded triggers and `details` — nothing about which
document is loaded. At the top level `atBaseline` is satisfied by _any_ page whose
signature is empty and whose counters are zero, which is the common case for a route
baseline (`sig === ""`).

So the new fast path in `enterParent` (`if (await atParent())`, `:434`) returns true on a
page the probe navigated to.

**Reachable by construction.** `collectCandidates` skips `type="submit"` and `"reset"`
(`:145`) — the author was clearly thinking about this — but a `<button>` with **no**
`type` attribute inside a `<form>` is an implicit submit, and `[role="button"]` is in the
click pool (`:52-56`), so a div calling `router.push()` qualifies too.

**Failure:** clicking one navigates. `classifyChange` sees no added region, so nothing is
recorded and the loop moves on. `enterParent()` then returns true on the _destination_
page and skips the reload. Every remaining candidate is probed against the wrong
document, and any state discovered there is pushed onto the route with recipe
`[...parent.recipe, click X]` to be replayed from `routeUrl` — a recipe that provably does
not reproduce what was observed — plus a `signature` recorded from the wrong page.

This is the cost of the probe-reuse change: the old unconditional reload made the
question moot.

**Fix:** capture `page.url()` when the parent is entered and require equality in
`atParent`.

**Fixed.** Snapshots now carry `url` (`location.href`) and `doc`, a token that
`markDocument` sets on `window` after each deliberate navigation and that any other
navigation wipes. `atParent` requires both to match; the parent's URL is recorded when the
state is found and refreshed after each canonical restore. Separately, a probe whose
`after` snapshot is on a different document is never recorded as a state — a navigation
is a route, and route discovery owns those. `takeSnapshot` moved to
`src/crawl/snapshot.ts` so capture can use it (finding 11).

Reproduced in a browser before fixing: `tests/integration/probe-ladder.test.ts` recorded
`waitFor [id="dest-help"]` — the dialog on the page the submit button went _to_ — exactly
as described.

## 9. Hash-route slugs collide

**`src/shared/slug.ts:42`** — High.

```ts
const hashSegs = hash.replace(/^#!?/, "").split("/").filter(Boolean).map(safeSegment);
```

Segments are joined with `-`, and `safeSegment` has already replaced unsafe characters
with `-`. Verified by calling `pathSlug` directly:

```
"/#/a/b"   -> home__h-a-b
"/#/a-b"   -> home__h-a-b
"/#/a b"   -> home__h-a-b
```

`canonicalPath` keeps the fragment verbatim, so these survive upstream as three distinct
routes.

**Failure:** all three write to `screenshots/home__h-a-b/default/<device>.png` — whichever
runs last silently overwrites the others. It also corrupts diffing: `indexShots`
(`src/diff/compare.ts:42`) keys on `pathSlug(route.url)`, so the routes collapse to one
map entry and the rest drop out of the pair set entirely.

The query case already solved this — `__q-${shortHash(search)}`. The hash case needs the
same disambiguator.

**Fixed.** Segments join with `--`, which `safeSegment` never produces at a segment's
edge, and a slug that doesn't read back to its own fragment — case, unsafe characters,
`#!`, an empty segment, `--` inside a segment — gets `-<shortHash(fragment)>`, the
disambiguator queries already use. `/#/a/b`, `/#/a-b`, `/#/a b` are now `home__h-a--b`,
`home__h-a-b`, `home__h-a-b-4ffbca`. `#/about` and `#/user-profile` are unchanged.

**Behaviour change:** multi-segment routes get new slugs — `#/users/42` was
`home__h-users-42` and is now `home__h-users--42` — so the first diff against a run
crawled before this change reports those routes as removed + added. `#!/` routes are
always hashed (`home__h-about-ec135a`), since they'd otherwise share a folder with the
`#/` form. Tests: the three colliding URLs plus six lossy variants all distinct, and
`pairShots` pairs all three.

## 10. `sizeChanged` overrides `minRatio`

**`src/diff/index.ts:93`** — Medium.

```ts
const changed = cmp.ratio > minRatio || cmp.sizeChanged;
```

The doc comment on `compareImages` (`src/diff/pixels.ts:5-10`) states the design: full-page
shots "often differ in height between runs (content grew), so this compares the
overlapping region and **reports the size change separately rather than calling the whole
image different**". The consumer then does precisely what the comment says it avoids.

**Failure:** on any site whose page height moves by one pixel between runs — a
lazy-loaded image, a rotating testimonial, a cookie bar — every full-page shot reports as
changed and `visualice diff --fail-on-error` exits 3, with `minRatio` powerless to quiet
it. The flag exists to set a noise floor and this bypasses it.

**Fix:** drop `sizeChanged` from the `changed` predicate and leave it as the separate
signal the comment promises, or give it its own threshold.

**Fixed** — the "own threshold" option, with one threshold. `isChanged` counts a pair
as changed when the overlap's changed-pixel ratio **or** `sizeRatio` — the share of the
larger shot the other doesn't cover — exceeds `minRatio`. Dropping the size signal
outright would let a page that lost its footer (identical overlap, shorter page) pass
`--fail-on-error`. At the default `minRatio` of 0 nothing changes; `--min-ratio=0.001` now
quiets a one-pixel height drift. `sizeRatio` is recorded in `diff.json`; README, `--help`
and the report's threshold line say what the floor applies to.

## 11. `shown.recipe` is recorded after stabilization has mutated the page

**`src/crawl/capture.ts:220`** — Medium.

```ts
await applyRecipe(page, remaining ?? state.recipe);
await stabilizePage(page, config.stabilize, ctx.log);
shown.url = url;
shown.recipe = state.recipe;
```

`shown.recipe` claims "this page is what that recipe produces". Between the recipe and the
claim, `stabilizePage` ran — and with the default `lazyScroll: true`, `autoScroll`
(`src/crawl/stabilize.ts:51-84`) walks `scrollTop` to `scrollHeight` and back to 0 on both
the document and the largest inner container.

**Failure:** overlays that close on scroll (Floating-UI's `hide`, Bootstrap dropdowns,
anything with a `scroll` listener) are already dismissed. State B with recipe
`[click Menu, click Submenu]` then reuses that page and runs only `click Submenu`, which
fails against a closed menu — where a fresh navigation would have succeeded, because
nothing ran between the two clicks. This is a genuine divergence between the reuse path
and the fresh path, which is exactly what reuse is supposed not to have.

**Second, independent of reuse:** the same `scrollTop = 0` silently undoes a
`{action:"scroll"}` recipe step (`src/crawl/recipe.ts:73-78`), since stabilization runs
after `applyRecipe`. That step is a documented public type usable from a hand-authored
manifest, and under default config it never survives to the screenshot.

**Fix:** stabilize before the recipe's final interaction, or mark scroll/overlay-sensitive
states non-reusable.

**Fixed.** Reuse is verified before it's trusted. `stillShowing` runs ahead of every
planned reuse and requires (a) the prefix recipe's closing promises — its trailing
`waitFor`s — to still hold, and (b) the open-region signature to equal the one read
straight after the prefix recipe, before stabilization ran. Either failing means a fresh
navigation, which is never wrong, only slower; the run log counts them
(`N more reloaded: the page had changed since the previous shot`). For the `scroll` step,
`stabilizePage` takes `keepScroll` — set for any recipe containing one — and `autoScroll`
returns the window to where the recipe left it rather than to the top.

Three integration tests in `tests/integration/capture-pool.test.ts` (promise check,
signature check, scroll position) were confirmed to **fail on the old code**; a fourth,
control test confirms reuse still happens when nothing changed. On the fixture: 40 of 124
shots reused before and after, none declined.

## 12. `atBaseline` compares counters to zero rather than to the baseline

**`src/crawl/discover-states.ts:572`** — Medium.

```ts
atBaseline: (s) => s.sig === baseline.sig && !s.modals && !s.expanded && !s.details,
```

`baseline` is the page's own default render, but the predicate demands all three counters
be zero rather than equal to the baseline's. Note that `expanded` (`:256`) is the one
counter **not** passed through `vis`, unlike `modals` and `details` — so hidden elements
count.

**Failure:** a site with a hidden mobile-menu trigger carrying `aria-expanded="true"`, or
a `<details open>` FAQ, has a permanently non-zero counter. `atBaseline` is then false
even on the untouched baseline page, `enterParent` falls through to a full reload for
every candidate, and the headline benefit of the change ("N reuse(s) while probing")
evaporates — with nothing in the log explaining why.

No correctness impact; it silently disables the feature on a large class of sites.

**Fix:** compare against the baseline snapshot's counters.

**Fixed.** `atBaseline` is `sameRegions(s, baseline)`: signature and all three counters
equal to the baseline's. Reproduced before fixing: a page with a hidden
`aria-expanded="true"` trigger spent 4 reloads on 3 probes that changed nothing; now 0.

## 13. `domPath` collides for portal-mounted overlays

**`src/crawl/discover-states.ts:221`** — Medium.

The comment at `:212-217` argues two elements cannot share a DOM path. True while both
exist — but the common React / Radix / Headless UI pattern is the opposite: the overlay is
created under `<body>` on open and removed on close.

**Failure:** `enterParent()` closes overlay A before candidate B is probed, so B's dialog
is appended at the same position, gets an identical `@body1>divN` path, an identical
`after.sig`, and `seenSig.has(after.sig)` (`:502`) discards state B as a duplicate. On a
page with several unnamed portal dialogs, only the first is ever captured.

This is the **inverse** of the limitation already recorded in `IMPROVEMENTS.md`, which
describes a node inserted above a dialog changing its key (a false negative → duplicate
states). This is a false positive → dropped states, which is the worse direction.

**Fix:** a monotonic open-counter or a content-derived key. Position does not hold.

**Fixed.** An unnamed region's key is `@<domPath>~<fingerprint>`, the fingerprint
hashing its first 200 characters of text, or its first media `src` when it has none. Two
dialogs mounted in turn at one position now differ; the same dialog re-opened still
dedupes against itself. Reproduced before fixing: two portal dialogs yielded one state. On
the fixture the only effect is 5 signatures gaining a `~…` suffix — the same 31 states.

What remains: two unnamed regions with the same opening text in the same spot still
collide, and a region whose text changes between probes (a live timer) stops deduping and
fails parent recognition — the less harmful direction, costing a reload.

## 14. `aria-controls` may be an ID list

**`src/crawl/discover-states.ts:347`** — Low-Medium.

The value is taken raw (`:162`, `:186`) and wrapped by `idSelector` into `[id="a b"]`.
ARIA permits a space-separated list of ids; that selector can never match.

**Failure:** `buildSteps` emits
`waitFor { selector: '[id="panel-a panel-b"]', state: "visible" }`, so every capture of
that state burns the full wait and then fails, and the retry path recaptures it
identically. The same raw value is stored in `containers` and passed to
`collectCandidates` as `root` (`:459-462`), where `document.querySelector` returns null,
`scope` becomes null, and nested discovery under that state returns `[]` with no
diagnostic. It also weakens the `byCtrl` dedupe (`:195-197`), which compares whole lists
rather than ids.

**Fix:** take the first token, or fall back to the `openId` path.

**Fixed.** Both places that turn `aria-controls` into a selector now pick one id — the
first that exists (when collecting triggers) or is showing (when snapshotting), else the
first — and the `byCtrl` dedupe keys on it. Reproduced before fixing: the recipe waited on
`[id="panel-a panel-b"]` and the test spent 30s timing out on it; nested discovery inside
the panel now finds the dialog there.

---

## Rejected

**Claimed:** `gotoRoute` misses fragment _removal_ — navigating from `/#/about` to `/`
differs only in the fragment, so Chromium treats it as same-document, `goto` returns
`null`, but `new URL("/").hash` is `""` so no reload fires and the home route
screenshots the About view.

**Disproven by running it.** A fragment navigation requires the _destination_ to carry a
fragment (HTML spec: "if url's fragment is non-null"). Measured against a live Chromium:

```
/#/about -> /           response=200   (full navigation)
/#/about -> /#/home     response=NULL  (same document)
/#/about -> /#          response=NULL  (same document)
/        -> /           response=200
/#/about -> /#/about    response=NULL  (same document)
```

Every case that returns `NULL` has a fragment on the destination, so
`response === null && new URL(url, page.url()).hash` fires in exactly the cases it needs
to. The guard is sound.

One residual, noted for completeness and **not** a finding: row three returns `NULL`
while `new URL("http://h/#").hash` is `""` (WHATWG returns the empty string for a bare
`#`), so that one case would skip the reload. It is unreachable — `hashPart` folds `#`,
`#/` and `#!/` to the empty string, so no route URL ever ends in a bare `#`.

## Challenged and holds

Recorded because "we looked and it survives" is the useful result for the reuse path, and
because a later change that breaks one of these should know it is breaking something
deliberate.

- **`reusePlan` / `orderForReuse`** (`capture.ts:77-132`). Reuse is gated on a strict exact
  prefix — `shown.recipe.length >= recipe.length` bails, and every step is compared by
  `JSON.stringify` — so the only possible divergence between "fresh + full recipe" and
  "reused + suffix" is whatever ran _between_ them. That is finding 11, not the prefix
  logic. `orderForReuse` is a correct greedy walk, and its output is a hint: it returns a
  new array and `state.shots` is keyed by device, so a bad order costs reloads, never
  correctness.
- **The `:hover` leak does not recur.** The pointer is parked only after a navigation, and
  that asymmetry is right: when the page is reused, the prefix's own last interaction —
  a `click`/`hover` through a Playwright locator, which physically moves the mouse — has
  already put the pointer exactly where the same prefix would have put it on a fresh load.
  Focus is prefix-determined for the same reason.
- **`shown` invalidation covers every stale path.** Cleared at `:200-201` before any
  mutation begins, reset again in the `catch` beside `recycle()` (`:438-440`), re-declared
  per route group (`:401`). The `resume` `continue` at `:421` correctly leaves it alone —
  nothing touched the page.
- **`waitForStableSelectors`** (`stabilize.ts:103`). The shared budget is honest: all waits
  start within microseconds off one `deadline`, each catches its own rejection so
  `Promise.all` cannot reject, and the `remaining <= 0` guard handles an exhausted budget.
  Worst case is one budget, not N.
- **Diff pairing** (`src/diff/compare.ts`, `index.ts`). `pairShots` is a correct full outer
  join: the key union is sorted for determinism, `(right ?? left)!` is safe because every
  key comes from one of the two maps, `error`/missing-`full` are routed to `uncomparable`
  before any I/O, and `results` is fully populated with no holes. The overlap comparison is
  index-aligned — both sides extract the same `ow×oh` region and resize to the same `cw×ch`.
- **`fromShot`/`toShot`.** Bare run-relative paths from two run dirs, but the viewer
  resolves them against `diff.from.runId`/`diff.to.runId`
  (`viewer/src/diff-layout.ts:151-152`) and `RunDiff` carries both dirs. Unambiguous.

## Still unreviewed

Neither pass has read: the viewer outside `lod.ts` and `diff-layout.ts`, `src/crawl/discover-forms.ts`
form-state discovery, the plugin/marketplace wiring under `.claude-plugin/`, `scripts/`
beyond the 15-line `gen-schema.ts` change in the diff, or `doctor`.

The `visualice diff` self-check run after the engine rework (72 unchanged, 0 changed)
proves the reworked engine is consistent with the old one _on the fixture_; it does not
prove the reuse path is correct on a site with animations, lazy loading or sticky UI
state. Findings 8, 11 and 13 are exactly that kind of site-dependent divergence, and none
of them is visible on the fixture.

## Found while fixing

- **Stabilization closes scroll-sensitive overlays in the shot itself.** `autoScroll`
  runs after the recipe on the fresh path too, so a menu that closes on scroll is
  photographed closed — whichever path produced the page. Finding 11 made reuse agree with
  the fresh path; it did not make the fresh path right. The fix is to scroll for lazy
  content _before_ the recipe's last interaction, which changes every shot and deserves
  its own diff check. **Not done.**
- The fix text for finding 6 was wrong, as noted there.

## Verification

- **Each engine finding was reproduced in a real browser before it was fixed.**
  `tests/integration/probe-ladder.test.ts` (8, 12, 13, 14) failed 4/4 against
  `3d28b2d`, each with the exact symptom described above; the three finding-11 tests
  failed 3/3 against `3d28b2d`'s `capture.ts` and `stabilize.ts`.
- `npm run check` — typecheck, lint, format, **448 unit tests** (452 as of 2026-09-30).
- `npm run test:integration` — **51 tests**, 12 files (8 of them new).
- `npm run build` — clean.
- **Fixture, before vs after.** The demo crawl was run twice — once from a `3d28b2d`
  worktree, once from the working tree — and diffed: **124 unchanged, 0 changed**. Both
  runs discovered the same 31 states with identical recipes, and both reused the page
  for 40 of 124 shots.
