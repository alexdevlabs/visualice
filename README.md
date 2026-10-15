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
visualice probe /cart                  # a page's inventory (triggers, forms, selects) as JSON
visualice probe /cart --recipe='[…]' --shot=cart.png   # what a recipe does there
visualice author                       # merge explorer state files into the cache

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
  - add a `- /path` line to seed a page discovery missed (`--replay` discovers just the
    new pages, so it works without a full re-crawl);
  - `- skip: <state-id>` (or a top-level `- skip: /path/**`) excludes noise — deleting
    a line is not an exclusion, `skip:` is the visible tombstone;
  - `- [ ] state-id — description` requests a state that has no recipe yet; unmet
    requests surface as `wanted` in `--json` output and a **Wanted** report section
    (the Explore-mode work queue).

States are probed at a desktop viewport _and_ (when a mobile device is configured) at the
first mobile device's viewport, so mobile-only states like hamburger navs are discovered
too — those capture only on mobile devices. Hover-revealed dropdowns are probed as well.

For agents and CI: `--json` prints a single machine-readable summary to stdout
(`{runId, runDir, manifest, report, routes, states, shots, failed, failures, wanted}`), `--quiet` silences progress,
and `--fail-on-error` exits 3 when any capture failed. Exit codes: 0 ok · 1 error ·
2 usage · 3 capture failures. Failed captures are retried
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
visualice serve --open          # several sites: a dashboard of them; one: its latest run
visualice serve --site=<name>   # another site in the same output directory
visualice serve --run=<id>      # view a specific run of that site
visualice serve --shoot=out.png # headless: screenshot the viewer to a file
```

The viewer is a standalone static app (`viewer/`); it reads `viewer-data.json` + the
screenshots and needs no connection to the crawled site. Scroll to pan, ⌘/ctrl+scroll
(or pinch) to zoom, click any shot for metadata (and to download the image), shift+arrow to step to the next one.
Shots are grouped by route: one section per path, a row per state, a column per device.

The mode switch in the toolbar picks how each shot is drawn. The images are never edited;
every mode is a different way of cropping the same file.

- **Screen** (default): the screens the page was captured in, one card each, exactly as
  the browser showed them — a sticky header or cookie bar appears on every screen.
- **Continuous**: the screens joined into one page. The capture records which rows of each
  screen bars pinned to the window covered, so the header is shown once at the top and a
  bottom bar once at the bottom.
- **Scroll**: one screen of that page per tile. Click a shot, then scroll it with the
  wheel or drag its scrollbar; the pinned bars stay put while the page moves under them.
  Esc, or a click elsewhere, gives the wheel back to the canvas.

Continuous and Scroll need runs captured with this version; an older run's screens are
laid end to end instead, repeated bars included.
Thumbnails load when zoomed out and step up through a
mid-resolution image to full resolution as you zoom in. The minimap is hidden until you
turn it on (the button in the zoom controls, or `M`); it shows where you are in the layout
and jumps there on click. The path list virtualizes past a few dozen routes so a large run
doesn't build a sidebar it never shows.

`⌘K` or `/` focuses search, `+` `−` `0` zoom in, out and fit, and `?` lists every
shortcut. The header's sun/moon button switches between the light (default) and dark
theme; that choice and the minimap's are remembered in the browser. Below 760px the
viewer switches to a phone layout with the filters in a bottom sheet.

Filter by device or by state kind, search by path, and flip between runs from the run
switcher — `serve` exposes the sibling runs in the same output directory, so comparing
runs needs no restart. Failed captures are tiles too: a placeholder carrying its error,
an **N failed** toggle and a **Failed** list in the sidebar, so a broken shot is visible
rather than missing. The view lives in the URL (mode, route, query, devices, kinds, selected
tile, run), so copying the address bar shares the exact shot you're looking
at. `?data=`
accepts same-origin paths only, and a `viewer-data.json` the viewer can't read gets an
error naming the offending field instead of a blank canvas.

## Share a run

```bash
visualice export report/     # the viewer + the latest run
```

writes a static folder that any file server can host (`npx serve report`) — a CI
artifact, a preview deploy, a zip for a reviewer.

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

| Option                                      | Default               | What it does                                                                                                            |
| ------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `politeness.respectRobots`                  | `true`                | Obeys robots.txt `Allow`/`Disallow` and `Crawl-delay` while discovering routes                                          |
| `politeness.retries`                        | `1`                   | Extra attempts for a failed navigation/capture before recording a failure                                               |
| `politeness.reuseNavigation`                | `true`                | Skip the reload when the next state's recipe just extends what the page already shows                                   |
| `scope.samples`                             | `{}`                  | At most N pages per path glob (`{ "/product/*": 3 }`): a few pages of a template stand for the rest, whatever their ids |
| `scope.hashRoutes`                          | `"auto"`              | `auto` treats `#/about`-style fragments as routes and plain anchors as anchors; `never`/`always` force it               |
| `discovery.interactions.nestDepth`          | `1`                   | `0` = default render only, `1` = single mutations, `>1` = probe inside opened states                                    |
| `discovery.interactions.maxPerPage`         | `12`                  | Hard cap on states per route, whatever the nesting depth                                                                |
| `discovery.interactions.hover`              | `true`                | Also probe hover-revealed states (dropdown navs)                                                                        |
| `discovery.interactions.siteWideOnce`       | `true`                | A state found identically on several pages (header dropdown, chat widget) is kept on the first page only                |
| `discovery.mobileStates`                    | `true`                | Second probe pass at the first mobile device's viewport (finds hamburger navs)                                          |
| `testIdAttribute`                           | `"data-testid"`       | The attribute the site's test ids live in (`data-test`, `data-cy`, …); `testId` targets and discovery use it            |
| `devices[].colorScheme`                     | `"light"`             | `prefers-color-scheme` per device — add a `dark` device for a dark-mode catalog                                         |
| `devices[].locale` / `timezoneId`           | `en-US` / `UTC`       | Pinned so `Intl`/date rendering is machine-independent                                                                  |
| `devices[].browser`                         | `"chromium"`          | `firefox` or `webkit` captures that device in another engine (`npx playwright install <name>` first)                    |
| `components`                                | `[]`                  | `{ name, selector, routes }` — screenshot an element on its own, on every route that has it                             |
| `checks.accessibility`                      | `false`               | Run axe-core on every captured state; results land in the report, the sidecars and the viewer                           |
| `stabilize.freezeTime` / `seedRandom`       | unset                 | Pin `Date` / `Math.random` in the page so reruns are byte-identical                                                     |
| `stabilize.maskSelectors`                   | `[]`                  | Paint opaque boxes over volatile regions (ads, clocks, carousels)                                                       |
| `stabilize.waitForSelectors` / `…TimeoutMs` | `[]` / `5000`         | Selectors that must be visible before a shot; they are waited on together and share the budget                          |
| `screenshot.alsoViewport`                   | `false`               | Also write an above-the-fold crop next to each full-page shot                                                           |
| `screenshot.screens`                        | `true`                | Capture full pages one screen at a time, as a user scrolls, so fixed bars and backdrops show truthfully                 |
| `screenshot.maxScreens`                     | `30`                  | Most screens per shot; a longer page is cut there and flagged `clamped`                                                 |
| `screenshot.maxHeight`                      | `20000`               | With `screens` off, crop full-page shots to this CSS-px height and flag them `clamped`; `0` disables (watch memory)     |
| `screenshot.thumbnail.midWidth`             | `1024`                | Mid-resolution LOD step between the thumbnail and the full image; `0` disables                                          |
| `http.ignoreHTTPSErrors`                    | `false`               | Accept self-signed TLS (staging environments)                                                                           |
| `http.httpCredentials` / `extraHTTPHeaders` | unset                 | Basic-auth / preview-token headers; values may use `${ENV_VAR}`                                                         |
| `routesFile`                                | `visualice.routes.md` | Where the editable site index lives; `false` disables it entirely                                                       |

## More than page screenshots

**Other browsers.** Give a device `browser: "firefox"` or `"webkit"` and it is captured in
that engine, beside the Chromium ones, as another column in the catalog. Discovery still
runs in Chromium; the recipes it records are replayed in each engine.

```jsonc
"devices": [
  { "name": "desktop", "width": 1440, "height": 900, "dpr": 2 },
  { "name": "safari", "width": 1440, "height": 900, "dpr": 2, "browser": "webkit" }
]
```

**Components.** `components` photographs an element on its own — a header, a pricing card
— on every route that has it, as a state of kind `component`. A route without the element
is skipped rather than failed. A hand-written state can carry `element` too, with a
recipe, for a component that has to be opened first.

```jsonc
"components": [
  { "name": "Header", "selector": "header" },
  { "name": "Pricing card", "selector": ".pricing-card", "routes": ["/pricing/**"] }
]
```

**Accessibility.** `checks.accessibility: true` runs [axe-core](https://github.com/dequelabs/axe-core)
against every state while it is on screen — including inside the opened modals and menus a
static scan never reaches. The crawl report gets an **Accessibility** section (rules,
impact, how many shots), each shot's sidecar lists the elements, `--json` carries the
roll-up, and the viewer badges the tiles and lists the findings in the inspector.

## Authenticated sites

```ts
// visualice.config.ts
auth: {
  storageStatePath: ".visualice/auth.json",
  login: {
    url: "/login",
    steps: [
      { action: "fill", target: { testId: "email" }, value: "${VC_USER}" },
      { action: "fill", target: { testId: "password" }, value: "${VC_PASS}" },
      { action: "click", target: { testId: "login-submit" } },
      { action: "waitFor", url: "**/dashboard" },
    ],
  },
}
```

Target the form's own fields (test ids, or a selector scoped to the form): a label like
"Email" often also matches a newsletter field elsewhere on the page, and an ambiguous
target fails the login.

`visualice auth` runs the login once and saves the session; `crawl` reuses it and
re-authenticates when it goes stale (`visualice auth --force` redoes it now). Staleness is read
from `login.sessionCookies` when you name the session cookie, else from `login.maxAgeHours`
(12h); name it for any site whose session is shorter. A protected page that lands on the login
page mid-run fails with "landed on the login page" rather than being filed as a screenshot of
the login form. Credentials come
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
auth recipes and Explore mode), the `visualice-explorer` agent, and three commands:
`/visualice [url]` to crawl, `/visualice-explore` to have explorer agents find the states
discovery missed, and `/visualice-view` to open the viewer. Or just ask
Claude to "visually crawl https://your.site" — the skill picks the right mode
(replay / auto / agentic explore for auth + tricky states), captures, and opens the viewer.

### Agentic exploration

Discovery's heuristics find what _opens_ — dialogs, menus, drawers, tabs. What a catalog
also needs is judgment: which errors matter, that a cart needs items in it first, which
of a dropdown's options to show. `/visualice-explore` hands that to agents, the way
Understand-Anything pairs tree-sitter with LLM analysis — the engine supplies the
mechanics and the evidence, agents the decisions:

1. Pages are grouped into kinds (`/tag/*` is one), and one `visualice-explorer` agent per
   kind runs in parallel.
2. Each reads its page with `visualice probe <page>`: the triggers discovery would
   click, every form with the submit button discovery never presses, every select
   with its options, the links out.
3. It tries each candidate state with `visualice probe <page> --recipe=…`, which runs
   the recipe through the same code capture uses, in a browser of its own, and
   reports what opened, which text appeared (inline errors), whether it navigated or
   hit the login page, and whether it wrote to storage (→ `isolate: true`). It looks
   at the probe's screenshot before keeping a state.
4. It writes what it verified to `.visualice/explore/<kind>.json`; `visualice author`
   merges every file into the cache under the lock, seeding pages the explorers found
   into the routes file; `visualice crawl --replay` captures it all.

Agents never take the catalog's screenshots: they author recipes, the engine replays
them, so a run stays deterministic.

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
site never prunes another's runs. In the viewer, the domain in the header picks the site
and the date beside it picks the version. With more than one site, the viewer opens on a
dashboard: a card per site with its latest run's home page and counts (the eye button
hides the previews, remembered like the theme), and the logo leads back to it. Runs from the older flat `runs/<runId>/` layout
are moved into their site folders the first time a crawl, `serve` or `export` runs.

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

Both the viewer and the fixture site are styled with Tailwind v4, configured in CSS rather
than a `tailwind.config.js`: the viewer's theme tokens live in `viewer/src/index.css`, the
fixture's in `tests/fixture-src/tailwind.input.css`.

The 463 unit tests are pure and fast. The 72 browser-driven tests in `tests/integration/`
cover the end-to-end crawl against the fixture, robots enforcement, nested state discovery,
the routes-file steering loop (edit → rerun respects it), the determinism guarantee
(identical pixels across two runs of a deliberately volatile page), the packaged `bin/`
entry point run from an unrelated cwd, hover states not leaking between shots that share a
page, `screenshot.maxHeight` clamping, `--resume`, component shots and accessibility
checks, and the viewer itself — built from source and driven in a browser, from `serve` and
from a static export.

CI runs the checks on Linux and Windows — Windows is the point of the matrix, since symlink
creation and the `open`-based browser shim behave differently there. Pushing a `v*` tag runs
`release.yml`, which verifies the tag matches `package.json`, reruns everything and publishes
to npm (`prepack` builds the tarball).

## Scope & ethics

Crawl sites you own or are authorized to test. visualice stays on the target origin by
default, honours robots.txt unless you turn `respectRobots` off, and during discovery never
submits non-idempotent forms or clicks triggers matching `denyLabels`.
