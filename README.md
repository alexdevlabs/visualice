# visualice

Crawl a website, capture **every page and every UI state** (modals, menus, drawers, accordions…)
across multiple device profiles, organize the screenshots, record a reusable crawl map, and view
the results on a zoomable Photoshop-like canvas.

See [`PLAN.md`](./PLAN.md) for the full design and [`IMPROVEMENTS.md`](./IMPROVEMENTS.md)
for the prioritized roadmap.

## Quick start

```bash
npm i -g visualice          # or run it ad hoc: npx visualice <command>
visualice doctor            # preflight: Node, Playwright chromium, sharp, viewer build
visualice crawl https://your.site
```

`doctor` is idempotent and self-heals what it safely can (downloads chromium, builds the
viewer) — it replaces any manual `npx playwright install chromium` step. `--no-fix`
reports without repairing; `--json` prints `{ok, checks}`.

In a checkout of this repo the npm scripts are the equivalents, and the bundled fixture
site gives you something to crawl:

```bash
npm install
npm run demo:crawl  # full auto-discovery → capture against the bundled fixture
npm run demo        # capture-only (hand-written manifest)
npm test            # unit tests
```

## Crawl a real site

```bash
# first run in a project — scaffolds visualice.config.json, gitignores .visualice/,
# crawls, and generates visualice.routes.md:
visualice crawl https://your.site

# from then on the config is picked up from the cwd automatically:
visualice crawl                    # re-discover + capture
visualice crawl --replay           # reuse the cached site model (fast + deterministic)
visualice crawl --resume           # continue the newest interrupted run, keeping its shots

# other commands:
visualice discover https://your.site   # discovery only, no screenshots
visualice init https://your.site       # scaffold the config without crawling
visualice routes                       # regenerate visualice.routes.md from the cache
visualice validate                     # check a hand-edited site model

# one-off scope tweaks without touching the config file:
visualice crawl --max-pages=20 --exclude=/admin/** --devices=mobile
```

Inside this repo the same commands are npm scripts — `npm run crawl -- <args>`,
`npm run discover -- <args>`, and `npm run vc -- <command>` for everything else.

### Project files

A crawl maintains two committed files at the project root (all machine output stays
under gitignored `.visualice/`):

- **`visualice.config.json`** — behavior. Scaffolded minimal (`$schema` + `target`);
  add options only when you need them.
- **`visualice.routes.md`** — the site index: pages as top-level bullets, captured UI
  states nested under them. Regenerated after every crawl, and **editable** — it's how
  you steer the crawler:
  - add a `- /path` line to seed a page discovery missed;
  - `- skip: <state-id>` (or a top-level `- skip: /path/**`) excludes noise — deleting
    a line is not an exclusion, `skip:` is the visible tombstone;
  - `- [ ] state-id — description` requests a state that has no recipe yet; unmet
    requests surface as `wanted` in `--json` output and a **Wanted** report section
    (the Explore-mode work queue).

States are probed at a desktop viewport _and_ (when a mobile device is configured) at the
first mobile device's viewport, so mobile-only states like hamburger navs are discovered
too — those capture only on mobile devices. Hover-revealed dropdowns are probed as well.

For agents and CI: `--json` prints a single machine-readable summary to stdout
(`{runId, runDir, routes, states, shots, failed, failures, wanted}`), `--quiet` silences progress,
and `--fail-on-error` exits 3 when any capture failed. Exit codes: 0 ok · 1 error ·
2 usage · 3 capture failures or visual differences. Failed captures are retried
(`politeness.retries`), then recorded per-shot in the manifest and listed in a
**Failures** section of the report.

Discovery is automatic — the cached site model is built on the first run and merged (never
clobbered) on later ones, so hand-written or Explore-mode states survive a re-crawl. Its
`hints` are applied to every run that uses it: `flakyRegions` get masked, `stableSelectors`
are awaited before each shot, `skipTriggers` are left alone during discovery. To capture
from a manifest you authored yourself and skip discovery entirely:

```bash
visualice capture --manifest=path/to/crawl-map.json --base=https://your.site
```

## View the results

```bash
visualice serve --open          # opens the zoomable viewer for the latest run
visualice serve --run=<id>      # view a specific run
visualice serve --shoot=out.png # headless: screenshot the viewer to a file
```

The viewer is a standalone static app (`viewer/`); it reads `viewer-data.json` + the
screenshots and needs no connection to the crawled site. Scroll to pan, ⌘/ctrl+scroll
(or pinch) to zoom, click any shot for metadata, shift+arrow to step to the next one.
Toggle **Grouped** (by path), **All at once**, or **Devices** — one route at a time with
every device drawn at the same width, so the same element lands in the same place across
the row and a spacing difference is visible by looking straight down. In Devices mode the
sidebar picks the route. Thumbnails load when zoomed out and step up through a
mid-resolution image to full resolution as you zoom in. The minimap shows where you are in
the layout and jumps there on click, and the path list virtualizes past a few dozen routes
so a large run doesn't build a sidebar it never shows.

Filter by device or by state kind, search by path, and flip between runs from the run
switcher — `serve` exposes the sibling runs in the same output directory, so comparing
runs needs no restart. Failed captures are tiles too: a placeholder carrying its error,
an **N failed** toggle and a **Failed** list in the sidebar, so a broken shot is visible
rather than missing. The view lives in the URL (mode, query, devices, kinds, selected
tile, run, comparison), so copying the address bar shares the exact shot you're looking
at. `?data=`
accepts same-origin paths only, and a `viewer-data.json` the viewer can't read gets an
error naming the offending field instead of a blank canvas.

## Compare two runs

```bash
visualice diff                              # the two most recent runs
visualice diff --from=<runId> --to=<runId>  # specific ones
visualice diff --threshold=20 --min-ratio=0.001 --fail-on-error
```

Writes `.visualice/diffs/<from>__<to>/` — `diff-report.md`, `diff.json`, and
`images/<route>/<state>/<device>.png`, the new shot washed out with every changed pixel
painted magenta. Shots are paired on route|state|device, so a renamed route reads as one
removal plus one addition instead of a bogus diff; when a page's height changed only the
overlapping region is compared and the size change is reported separately; a capture that
failed in either run is listed as **uncomparable** with the reason.

`--threshold=<n>` is the per-channel tolerance (0–255, default 12) and `--min-ratio=<f>`
the noise floor: the fraction of pixels that must differ — or, when the height changed,
the fraction of the page gained or lost — before a pair counts as changed (default 0,
so any difference counts; `0.001` lets a page that grew by a few pixels through).
`--json` prints the summary instead of the report path, `--diff-out=<dir>` moves the
output, and `--fail-on-error` exits 3 when anything changed, appeared or disappeared —
the CI gate.

Comparisons show up in the viewer too. `serve` lists them in the **comparison** picker,
and choosing one lays out every changed shot as before / after / diff, biggest change
first — the three images live in two run directories and the diff directory, which is why
this needs the server rather than a single run's data. An **unchanged** toggle brings the
rest in when you want to confirm that nothing else moved.

## Configuration

`visualice.config.ts` is the worked example; every field is optional and falls back to the
defaults in `src/shared/config.ts`. JSON configs are accepted too, and
[`config.schema.json`](./config.schema.json) gives them validation and editor autocomplete:

```jsonc
{
  // what `visualice init` scaffolds; "./config.schema.json" in this repo itself
  "$schema": "node_modules/visualice/config.schema.json",
  "target": "https://your.site",
  "scope": { "exclude": ["/admin/**"] },
}
```

Run `npm run schema` after changing the zod schema — a unit test fails if the two drift apart.

Options worth knowing:

| Option                                      | Default               | What it does                                                                                              |
| ------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| `politeness.respectRobots`                  | `true`                | Obeys robots.txt `Allow`/`Disallow` and `Crawl-delay` while discovering routes                            |
| `politeness.retries`                        | `1`                   | Extra attempts for a failed navigation/capture before recording a failure                                 |
| `politeness.reuseNavigation`                | `true`                | Skip the reload when the next state's recipe just extends what the page already shows                     |
| `scope.hashRoutes`                          | `"auto"`              | `auto` treats `#/about`-style fragments as routes and plain anchors as anchors; `never`/`always` force it |
| `discovery.interactions.nestDepth`          | `1`                   | `0` = default render only, `1` = single mutations, `>1` = probe inside opened states                      |
| `discovery.interactions.maxPerPage`         | `12`                  | Hard cap on states per route, whatever the nesting depth                                                  |
| `discovery.interactions.hover`              | `true`                | Also probe hover-revealed states (dropdown navs)                                                          |
| `discovery.mobileStates`                    | `true`                | Second probe pass at the first mobile device's viewport (finds hamburger navs)                            |
| `devices[].colorScheme`                     | `"light"`             | `prefers-color-scheme` per device — add a `dark` device for a dark-mode catalog                           |
| `devices[].locale` / `timezoneId`           | `en-US` / `UTC`       | Pinned so `Intl`/date rendering is machine-independent                                                    |
| `stabilize.freezeTime` / `seedRandom`       | unset                 | Pin `Date` / `Math.random` in the page so reruns are byte-identical                                       |
| `stabilize.maskSelectors`                   | `[]`                  | Paint opaque boxes over volatile regions (ads, clocks, carousels)                                         |
| `stabilize.waitForSelectors` / `…TimeoutMs` | `[]` / `5000`         | Selectors that must be visible before a shot; they are waited on together and share the budget            |
| `screenshot.alsoViewport`                   | `false`               | Also write an above-the-fold crop next to each full-page shot                                             |
| `screenshot.maxHeight`                      | `20000`               | Crop full-page shots to this CSS-px height and flag them `clamped`; `0` disables (watch memory)           |
| `screenshot.thumbnail.midWidth`             | `1024`                | Mid-resolution LOD step between the thumbnail and the full image; `0` disables                            |
| `http.ignoreHTTPSErrors`                    | `false`               | Accept self-signed TLS (staging environments)                                                             |
| `http.httpCredentials` / `extraHTTPHeaders` | unset                 | Basic-auth / preview-token headers; values may use `${ENV_VAR}`                                           |
| `routesFile`                                | `visualice.routes.md` | Where the editable site index lives; `false` disables it entirely                                         |

## Authenticated sites

```ts
// visualice.config.ts
auth: {
  storageStatePath: ".visualice/auth.json",
  login: {
    url: "/login",
    steps: [
      { action: "fill", target: { label: "Email" }, value: "${VC_USER}" },
      { action: "fill", target: { label: "Password" }, value: "${VC_PASS}" },
      { action: "click", target: { role: "button", name: "Sign in" } },
      { action: "waitFor", url: "**/dashboard" },
    ],
  },
}
```

`visualice auth` runs the login once and saves the session; `crawl` reuses it and
re-authenticates when it goes stale (`visualice auth --force` redoes it now). Credentials come
from the environment — export them, or copy [`.env.example`](./.env.example) to `.env`
(gitignored; real env vars win over it). Secrets never reach the manifest or a sidecar: the
config snapshot written into `crawl-map.json` keeps `${ENV_VAR}` placeholders readable and
redacts anything else sitting in a credential field (basic-auth, secret-looking headers,
`fill` values in the login recipe).

Add a `verify` block so a silently-changed login form fails loudly instead of saving a
logged-out session:

```ts
login: {
  // …steps…
  verify: { url: "**/dashboard", selector: "[data-testid=user-menu]" },
}
```

## Use it as a Claude Code plugin

This repo is both a plugin and a single-plugin marketplace (`.claude-plugin/`), so it
installs from a checkout or a git URL:

```
/plugin marketplace add <this repo>
/plugin install visualice@visualice
```

That brings in the `visualice` skill (`skills/visualice/`, with references for the CLI,
auth recipes and Explore mode) and three commands: `/visualice [url]` to crawl,
`/visualice-view` to open the viewer, `/visualice-diff` to compare two runs. Or just ask
Claude to "visually crawl https://your.site" — the skill picks the right mode
(replay / auto / agentic explore for auth + tricky states), captures, and opens the viewer.

Output lands under the configured output directory (default `.visualice/`):

```
runs/<runId>/
  screenshots/<path>/<state>/<device>.png   # + .thumb.webp, .mid.webp, .json sidecar
  crawl-map.json      # reusable manifest (routes, states, recipes, shots)
  viewer-data.json    # flattened tile index for the viewer
  crawl-report.md     # human summary
diffs/<from>__<to>/   # visualice diff: diff-report.md, diff.json, images/
```

One run owns that directory while it works (`<out>/.lock`, reclaimed automatically when
the holder died): a second concurrent run fails with a message pointing at `--out=<dir>`
instead of interleaving writes into the same cache and storage state.

## Use it as a library

```ts
import { loadConfig, crawlPipeline } from "visualice";

const config = await loadConfig("visualice.config.ts");
const { runDir, manifest } = await crawlPipeline({ config, baseUrl: "https://your.site" });
```

`src/index.ts` re-exports the pipelines, the config schema, the manifest helpers and the pure
utilities (URL normalization, globs, robots parsing). The package ships built ESM plus type
declarations (`dist/`, produced by `npm run build`), so consumers need no `tsx`. Node 20.12
or newer.

## Development

```bash
npm run check             # typecheck + lint + format check + unit tests
npm run test:integration  # browser-driven suites (needs playwright chromium)
npm run test:all          # both
npm run build             # dist/ (node bundle + .d.ts) and viewer/dist
npm run fixture -- --open # browse the bundled fixture site
npm run fixture:build     # rebuild tests/fixture from tests/fixture-src
```

The 309 unit tests are pure and fast. The 36 browser-driven tests in `tests/integration/`
cover the end-to-end crawl against the fixture, robots enforcement, nested state discovery,
the routes-file steering loop (edit → rerun respects it), the determinism guarantee
(identical pixels across two runs of a deliberately volatile page), the packaged `bin/`
entry point run from an unrelated cwd, hover states not leaking between shots that share a
page, `screenshot.maxHeight` clamping, `--resume`, and run diffing.

CI runs the checks on Linux and Windows — Windows is the point of the matrix, since symlink
creation and the `open`-based browser shim behave differently there. Pushing a `v*` tag runs
`release.yml`, which verifies the tag matches `package.json`, reruns everything and publishes
to npm (`prepack` builds the tarball).

## Scope & ethics

Crawl sites you own or are authorized to test. visualice stays on the target origin by
default, honours robots.txt unless you turn `respectRobots` off, and during discovery never
submits non-idempotent forms or clicks triggers matching `denyLabels`.
