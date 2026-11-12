# Crawling

How a crawl works, the commands around it, and the files it reads and writes. For every flag,
see the [CLI reference](../skills/visualice/references/cli.md).

## Commands

```bash
# first run in a project — scaffolds visualice.config.json, gitignores .visualice/,
# crawls, and generates visualice.routes.md:
visualice crawl https://your.site

# from then on the config is picked up from the cwd automatically:
visualice crawl                    # re-discover + capture
visualice crawl --replay           # reuse the cached site model (fast + deterministic)
visualice crawl --resume           # continue the newest interrupted run, keeping its shots
visualice crawl --dry-run          # discover, then list what would be captured; capture nothing
visualice crawl --no-states        # pages only, no UI states (fast; cached states are kept)

# after code changes (the routes file records the commit each crawl shot):
visualice changes                  # what changed since, and whether some pages or all need reshooting
visualice crawl --replay --only=/pricing,/blog/**   # reshoot those; carry every other page over

# other commands:
visualice discover https://your.site   # discovery only, no screenshots
visualice init https://your.site       # scaffold the config without crawling
visualice routes                       # regenerate visualice.routes.md from the cache
visualice validate                     # check a hand-edited site model
visualice probe /cart                  # a page's inventory (triggers, forms, selects) as JSON
visualice probe /cart --recipe='[…]' --shot=cart.png   # what a recipe does there
visualice author                       # merge explorer state files into the cache

# one-off scope tweaks without touching the config file:
visualice crawl --max-pages=20 --exclude='/admin/**' --devices=mobile
visualice crawl --seed=/pricing,/help --site=staging   # extra entry pages; write to sites/staging
visualice crawl --headed                               # watch the browser while it works
```

In a checkout of this repo the same commands are npm scripts: `npm run crawl -- <args>`,
`npm run discover -- <args>`, and `npm run vc -- <command>` for everything else.

`doctor` is idempotent and repairs what it safely can (downloads Chromium, builds the
viewer), so there's no manual `npx playwright install chromium` step. `--no-fix` reports
without repairing; `--json` prints `{ok, checks}`.

## Project files

A crawl maintains two committed files at the project root (all machine output stays
under gitignored `.visualice/`):

- **`visualice.config.json`** — behavior. Scaffolded minimal (`$schema` + `target`);
  add options only when you need them.
- **`visualice.routes.md`** — the site index: pages as top-level bullets, captured UI
  states nested under them. Regenerated after every crawl, and **editable** — it's how
  you steer the crawler:
  - add a `- /path` line to seed a page discovery missed (`--replay` discovers just the
    new pages, so it works without a full re-crawl);
  - `- skip: <state-id>` (or a top-level `- skip: /path/**`) excludes noise — deleting
    a line is not an exclusion, `skip:` is the visible tombstone. A path glob covers the
    page whatever its query; one with a `?` matches path and query, so
    `- skip: /metrics?*` drops every `/metrics?network=…` and keeps `/metrics`;
  - `- [ ] state-id — description` requests a state that has no recipe yet; unmet
    requests surface as `wanted` in `--json` output and a **Wanted** report section
    (the Explore-mode work queue).

## Discovery

States are probed at a desktop viewport _and_ (when a mobile device is configured) at the
first mobile device's viewport, so mobile-only states like hamburger navs are discovered
too — those capture only on mobile devices. Hover-revealed dropdowns are probed as well.

Pages are found by following links from the start page, the seeds and the sitemap. Some
links only exist once something is opened: a sidebar whose groups render their links when
clicked, a drawer menu. Opening those is part of probing states, so the links that appear
are followed too, and the pages behind them mapped, within `scope.maxDepth`,
`scope.maxPages` and the include and exclude globs. A link behind something discovery
doesn't open (a denied label, a login) still needs a `- /path` line in the routes file.

Discovery never submits a form, and never clicks a trigger whose label has one of
`discovery.interactions.denyLabels` in it (logout, delete, pay… by default). Labels are
matched as whole words in any case: `import` stops "Import CSV" and leaves a menu group
called "Importers" alone.

Discovery is automatic — the cached site model is built on the first run and merged (never
clobbered) on later ones, so hand-written or Explore-mode states survive a re-crawl. Its
`hints` are applied to every run that uses it: `flakyRegions` get masked, `stableSelectors`
are awaited before each shot, `skipTriggers` are left alone during discovery. To capture
from a manifest you authored yourself and skip discovery entirely:

```bash
visualice capture --manifest=path/to/crawl-map.json --target=https://your.site
```

### Slow pages

A probe clicks a trigger, waits `discovery.interactions.settleMs` (250 ms) and looks at
what opened. A dialog that has to load first (its code, its data, a busy dev server) can
take longer than that. If the page is still busy then (a request the click started is
still loading, or the DOM is still changing), the probe keeps looking, up to
`discovery.interactions.patienceMs` (1500 ms) after the click. A trigger that does
nothing leaves the page idle, so it costs no more than before.

A page that is never idle (a ticker or an animation rewriting the DOM, a poll asking
the server every second) would make every trigger look busy. The first time a trigger
on a page shows nothing while the page is busy, the probe watches the page for a moment
with nothing clicked; what it does on its own is not counted as loading from then on.

Every trigger that showed nothing is listed under **Clicked, nothing opened** in
`crawl-report.md`. Most do nothing visible by design (sorting, refresh, pagination). The
ones marked **still loading** were still busy when the probe gave up: a slow page may be
hiding a state there (`stillLoading` with `--json`). Raise `patienceMs`, or author the
state.

### Generated ids

Many frameworks give elements ids when they render: React's `useId()` (`_r_6_`), and
component libraries like `mat-dialog-0` or `ember812`. Such an id is different on the next
load, on another device or after another click, so a recipe that waits for one, or clicks
one, fails on the next capture. visualice never uses them:

- React's ids and the common libraries (Base UI, Radix, Headless UI, MUI, React Aria,
  react-select…) are known already.
- Discovery notices others: it loads the first page twice and compares the ids, and it
  opens a dialog a second time to see whether it comes back under the same id. What it
  finds is listed under **Generated ids** in `crawl-report.md` (`unstableIds` with
  `--json`) and remembered in the cached model.
- `discovery.unstableIds` in the config keeps them with the project, as regular expressions:

  ```json
  { "discovery": { "unstableIds": ["^mat-dialog-\\d+$", "^ember\\d+$"] } }
  ```

- When a recipe still waits for an id that turns out to have changed, the capture goes
  ahead once the click before it has opened something (a dialog, a menu, an expanded
  panel), instead of failing the shot.

## Scripts and CI

For agents and CI: `--json` prints a single machine-readable summary to stdout
(`{runId, runDir, manifest, report, routes, states, shots, failed, failures, wanted}`, plus
`carried`, `unmatchedOnly`, `stillLoading`, `unstableIds` and `accessibility` when there
is something to say), `--quiet` silences progress,
and `--fail-on-error` exits 3 when any capture failed. Exit codes: 0 ok · 1 error ·
2 usage · 3 capture failures. Failed captures are retried
(`politeness.retries`), then recorded per-shot in the manifest and listed in a
**Failures** section of the report.

To recapture an agent-built catalogue in CI, CI needs the site model the agents wrote
into: `.visualice/crawl-map.cache.json`. Commit it with `git add -f` (it sits in the
gitignored folder; once tracked, git keeps it) or restore it from a CI cache, then run
`visualice crawl --replay --json --quiet --fail-on-error`. Without it, `--replay` falls
back to a full discovery and the explored states are missing.

### Update notice

An installed CLI checks npm for a newer visualice at most once a day, in the background,
and says so on stderr at the start of a later command (`ℹ visualice 0.3.0 is available
…`). It never delays a command for more than a moment, and a failed lookup is ignored.
It is off with `--quiet`, in CI (`CI` set), in a source checkout, and with
`VISUALICE_NO_UPDATE_CHECK=1` (or `NO_UPDATE_NOTIFIER=1`). The last answer is cached in
`~/.cache/visualice/update-check.json` (`$XDG_CACHE_HOME` when set).

`visualice serve` passes the same answer to the viewer, which shows it as a banner with
the update steps (the viewer never contacts npm itself; an export never shows it).

## Output

Output lands under the configured output directory (default `.visualice/`), one folder
per site. A site is named by its hostname without `www.` (`saucedemo.com`; `localhost`
drops its port, which changes every run), or by `output.site` in the config:

```
sites/<site>/runs/<runId>/
  screenshots/<path>/<state>/<device>.png   # + .thumb.webp, .mid.webp, .json sidecar
  crawl-map.json      # reusable manifest (routes, states, recipes, shots)
  viewer-data.json    # flattened tile index for the viewer
  crawl-report.md     # human summary
```

`<path>` is the page's path made safe for a folder name. Where that would lose part of the
path (capitals, non-ASCII letters, a query), a short hash is added (`about__p-3f2a9c`), so
two pages never share a folder.

Each site keeps its own `latest` and its own `output.keepRuns` budget, so crawling one
site never prunes another's runs. Runs from the older flat `runs/<runId>/` layout are moved
into their site folders the first time a crawl, `serve` or `export` runs.

One run owns that directory while it works (`<dir>/.lock`, reclaimed automatically when
the holder died): a second concurrent run fails with a message pointing at `--dir=<dir>`
instead of interleaving writes into the same cache and storage state.
