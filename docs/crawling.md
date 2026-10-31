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
    a line is not an exclusion, `skip:` is the visible tombstone;
  - `- [ ] state-id — description` requests a state that has no recipe yet; unmet
    requests surface as `wanted` in `--json` output and a **Wanted** report section
    (the Explore-mode work queue).

## Discovery

States are probed at a desktop viewport _and_ (when a mobile device is configured) at the
first mobile device's viewport, so mobile-only states like hamburger navs are discovered
too — those capture only on mobile devices. Hover-revealed dropdowns are probed as well.

Discovery is automatic — the cached site model is built on the first run and merged (never
clobbered) on later ones, so hand-written or Explore-mode states survive a re-crawl. Its
`hints` are applied to every run that uses it: `flakyRegions` get masked, `stableSelectors`
are awaited before each shot, `skipTriggers` are left alone during discovery. To capture
from a manifest you authored yourself and skip discovery entirely:

```bash
visualice capture --manifest=path/to/crawl-map.json --target=https://your.site
```

## Scripts and CI

For agents and CI: `--json` prints a single machine-readable summary to stdout
(`{runId, runDir, manifest, report, routes, states, shots, failed, failures, wanted}`), `--quiet` silences progress,
and `--fail-on-error` exits 3 when any capture failed. Exit codes: 0 ok · 1 error ·
2 usage · 3 capture failures. Failed captures are retried
(`politeness.retries`), then recorded per-shot in the manifest and listed in a
**Failures** section of the report.

To recapture an agent-built catalogue in CI, CI needs the site model the agents wrote
into: `.visualice/crawl-map.cache.json`. Commit it with `git add -f` (it sits in the
gitignored folder; once tracked, git keeps it) or restore it from a CI cache, then run
`visualice crawl --replay --json --quiet --fail-on-error`. Without it, `--replay` falls
back to a full discovery and the explored states are missing.

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

Each site keeps its own `latest` and its own `output.keepRuns` budget, so crawling one
site never prunes another's runs. Runs from the older flat `runs/<runId>/` layout are moved
into their site folders the first time a crawl, `serve` or `export` runs.

One run owns that directory while it works (`<dir>/.lock`, reclaimed automatically when
the holder died): a second concurrent run fails with a message pointing at `--dir=<dir>`
instead of interleaving writes into the same cache and storage state.
