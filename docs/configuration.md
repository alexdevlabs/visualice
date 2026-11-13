# Configuration

[`visualice.config.ts`](../visualice.config.ts) is the worked example; every field is optional and falls back to the
defaults in `src/shared/config.ts`. JSON configs are accepted too, and
[`config.schema.json`](../config.schema.json) gives them validation and editor autocomplete:

```jsonc
{
  // what `visualice init` scaffolds; "./config.schema.json" in this repo itself
  "$schema": "https://unpkg.com/visualice@0.2.1/config.schema.json",
  "target": "https://your.site",
  "scope": { "exclude": ["/admin/**"] },
}
```

Options worth knowing:

| Option                                      | Default               | What it does                                                                                                                                                   |
| ------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `politeness.respectRobots`                  | `true`                | Obeys robots.txt `Allow`/`Disallow` and `Crawl-delay` while discovering routes                                                                                 |
| `politeness.retries`                        | `1`                   | Extra attempts for a failed navigation/capture before recording a failure                                                                                      |
| `politeness.reuseNavigation`                | `true`                | Skip the reload when the next state's recipe just extends what the page already shows                                                                          |
| `scope.include` / `exclude`                 | `["/**"]` / `[]`      | Path globs for what's crawled; a glob is about the path whatever the query, and one with a `?` matches path and query (`/search?*` leaves `/search` itself in) |
| `scope.maxDepth` / `maxPages`               | `4` / `200`           | How many links deep discovery follows from a start page, and the most pages it keeps                                                                           |
| `scope.samples`                             | `{}`                  | At most N pages per path glob (`{ "/product/*": 3 }`): a few pages of a template stand for the rest, whatever their ids                                        |
| `scope.hashRoutes`                          | `"auto"`              | `auto` treats `#/about`-style fragments as routes and plain anchors as anchors; `never`/`always` force it                                                      |
| `discovery.interactions.auto`               | `true`                | Probe pages for UI states; `false` captures each page's default render only                                                                                    |
| `discovery.interactions.nestDepth`          | `1`                   | `1` = states one interaction away, `>1` = also probe inside opened states (expensive)                                                                          |
| `discovery.interactions.maxPerPage`         | `12`                  | Hard cap on states per route, whatever the nesting depth                                                                                                       |
| `discovery.interactions.hover`              | `true`                | Also probe hover-revealed states (dropdown navs)                                                                                                               |
| `discovery.interactions.siteWideOnce`       | `true`                | A state found identically on several pages (header dropdown, chat widget) is kept on the first page only                                                       |
| `discovery.interactions.denyLabels`         | logout, delete, send… | Triggers never clicked, by the words in their label: whole words, any case (`import` stops "Import CSV", not "Importers")                                      |
| `discovery.interactions.blockWrites`        | `true`                | Stop the requests a probed trigger makes that would change data on the site, and leave the trigger out ([discovery](crawling.md#discovery))                    |
| `discovery.interactions.allowWrites`        | `[]`                  | Path globs a probed trigger may write to (an analytics endpoint): neither blocked nor a reason to leave it out                                                 |
| `discovery.interactions.patienceMs`         | `1500`                | How long a probe keeps looking after a click while the page is still loading ([slow pages](crawling.md#slow-pages))                                            |
| `discovery.unstableIds`                     | `[]`                  | Regular expressions for ids the site generates at render time, never used in a recipe ([generated ids](crawling.md#generated-ids))                             |
| `discovery.mobileStates`                    | `true`                | Second probe pass at the first mobile device's viewport (finds hamburger navs)                                                                                 |
| `testIdAttribute`                           | `"data-testid"`       | The attribute the site's test ids live in (`data-test`, `data-cy`, …); `testId` targets and discovery use it                                                   |
| `devices[].colorScheme`                     | `"light"`             | `prefers-color-scheme` per device — add a `dark` device for a dark-mode catalog                                                                                |
| `devices[].locale` / `timezoneId`           | `en-US` / `UTC`       | Pinned so `Intl`/date rendering is machine-independent                                                                                                         |
| `devices[].browser`                         | `"chromium"`          | `firefox` or `webkit` captures that device in another engine (`npx playwright install <name>` first)                                                           |
| `components`                                | `[]`                  | `{ name, selector, routes }` — screenshot an element on its own, on every route that has it                                                                    |
| `checks.accessibility`                      | `false`               | Run axe-core on every captured state; results land in the report, the sidecars and the viewer                                                                  |
| `stabilize.freezeTime` / `seedRandom`       | unset                 | Pin `Date` / `Math.random` in the page so reruns are byte-identical                                                                                            |
| `stabilize.maskSelectors`                   | `[]`                  | Paint opaque boxes over volatile regions (ads, clocks, carousels)                                                                                              |
| `stabilize.waitForSelectors` / `…TimeoutMs` | `[]` / `5000`         | Selectors that must be visible before a shot; they are waited on together and share the budget                                                                 |
| `screenshot.alsoViewport`                   | `false`               | Also write an above-the-fold crop next to each full-page shot                                                                                                  |
| `screenshot.fullPage`                       | `"screens"`           | `screens`: one screen at a time, as a user scrolls, so fixed bars and backdrops show truthfully; `single`: one tall render; `false`: the first screen only     |
| `screenshot.maxHeight`                      | `25000`               | Longest page captured, in CSS px, in either full-page mode; a longer one is cut there and flagged `clamped`; `0` disables (watch memory)                       |
| `screenshot.thumbnail.zoomWidth`            | `1024`                | Width of the in-between image the viewer shows while zooming in; `0` disables                                                                                  |
| `http.ignoreHTTPSErrors`                    | `false`               | Accept self-signed TLS (staging environments)                                                                                                                  |
| `http.httpCredentials` / `extraHTTPHeaders` | unset                 | Basic-auth / preview-token headers; values may use `${ENV_VAR}`                                                                                                |
| `routesFile`                                | `visualice.routes.md` | Where the editable site index lives; `false` disables it entirely                                                                                              |

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
