# visualice

Crawl a website, capture **every page and every UI state** (modals, menus, drawers, accordions…)
across multiple device profiles, organize the screenshots, record a reusable crawl map, and view
the results on a zoomable Photoshop-like canvas.

See [`PLAN.md`](./PLAN.md) for the full design and [`IMPROVEMENTS.md`](./IMPROVEMENTS.md)
for the prioritized improvement backlog.

## Quick start

```bash
npm install
npx playwright install chromium

npm run demo:crawl  # full auto-discovery → capture against the bundled fixture
npm run demo        # capture-only (hand-written manifest)
npm test            # unit tests
```

## Crawl a real site

```bash
# discover routes + UI states, then screenshot everything across devices:
npm run crawl -- --base=https://your.site --config=visualice.config.ts

# re-run later, reusing the cached site model (skips discovery, fast + deterministic):
npm run crawl -- --base=https://your.site --replay

# discovery only (writes .visualice/crawl-map.cache.json, no screenshots):
npm run discover -- --base=https://your.site

# check a hand-edited site model before capturing with it:
npm run vc -- validate

# one-off scope tweaks without touching the config file:
npm run crawl -- --base=https://your.site --max-pages=20 --exclude=/admin/** --devices=mobile
```

States are probed at a desktop viewport _and_ (when a mobile device is configured) at the
first mobile device's viewport, so mobile-only states like hamburger navs are discovered
too — those capture only on mobile devices. Hover-revealed dropdowns are probed as well.

For agents and CI: `--json` prints a single machine-readable summary to stdout
(`{runId, runDir, routes, states, shots, failed, failures}`), `--quiet` silences progress,
and `--fail-on-error` exits 3 when any capture failed. Exit codes: 0 ok · 1 error ·
2 usage · 3 capture failures. Failed captures are retried (`politeness.retries`), then
recorded per-shot in the manifest and listed in a **Failures** section of the report.

Discovery is automatic — the cached site model is built on the first run and merged (never
clobbered) on later ones, so hand-written or Explore-mode states survive a re-crawl. To capture
from a manifest you authored yourself and skip discovery entirely:

```bash
npm run capture -- --manifest=path/to/crawl-map.json --base=https://your.site
```

## View the results

```bash
npm run serve -- --open          # opens the zoomable viewer for the latest run
npm run serve -- --run=<id>      # view a specific run
npm run serve -- --shoot=out.png # headless: screenshot the viewer to a file
```

The viewer is a standalone static app (`viewer/`); it reads `viewer-data.json` + the
screenshots and needs no connection to the crawled site. Scroll to pan, ⌘/ctrl+scroll
(or pinch) to zoom, click any shot for metadata. Toggle **Grouped** (by path) vs
**All at once**; thumbnails load when zoomed out and swap to full resolution as you zoom in.

## Configuration

`visualice.config.ts` is the worked example; every field is optional and falls back to the
defaults in `src/shared/config.ts`. JSON configs are accepted too, and
[`config.schema.json`](./config.schema.json) gives them validation and editor autocomplete:

```jsonc
{
  "$schema": "./config.schema.json",
  "target": "https://your.site",
  "scope": { "exclude": ["/admin/**"] },
}
```

Run `npm run schema` after changing the zod schema — a unit test fails if the two drift apart.

Options worth knowing:

| Option                                      | Default         | What it does                                                                         |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| `politeness.respectRobots`                  | `true`          | Obeys robots.txt `Allow`/`Disallow` and `Crawl-delay` while discovering routes       |
| `politeness.retries`                        | `1`             | Extra attempts for a failed navigation/capture before recording a failure            |
| `discovery.interactions.nestDepth`          | `1`             | `0` = default render only, `1` = single mutations, `>1` = probe inside opened states |
| `discovery.interactions.maxPerPage`         | `12`            | Hard cap on states per route, whatever the nesting depth                             |
| `discovery.interactions.hover`              | `true`          | Also probe hover-revealed states (dropdown navs)                                     |
| `discovery.mobileStates`                    | `true`          | Second probe pass at the first mobile device's viewport (finds hamburger navs)       |
| `devices[].colorScheme`                     | `"light"`       | `prefers-color-scheme` per device — add a `dark` device for a dark-mode catalog      |
| `devices[].locale` / `timezoneId`           | `en-US` / `UTC` | Pinned so `Intl`/date rendering is machine-independent                               |
| `stabilize.freezeTime` / `seedRandom`       | unset           | Pin `Date` / `Math.random` in the page so reruns are byte-identical                  |
| `stabilize.maskSelectors`                   | `[]`            | Paint opaque boxes over volatile regions (ads, clocks, carousels)                    |
| `screenshot.alsoViewport`                   | `false`         | Also write an above-the-fold crop next to each full-page shot                        |
| `http.ignoreHTTPSErrors`                    | `false`         | Accept self-signed TLS (staging environments)                                        |
| `http.httpCredentials` / `extraHTTPHeaders` | unset           | Basic-auth / preview-token headers; values may use `${ENV_VAR}`                      |

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

`npm run auth` runs the login once and saves the session; `crawl` reuses it and
re-authenticates when it goes stale (`npm run auth -- --force` redoes it now). Credentials come
from the environment — export them, or copy [`.env.example`](./.env.example) to `.env`
(gitignored; real env vars win over it). Secrets never reach the manifest or a sidecar.

Add a `verify` block so a silently-changed login form fails loudly instead of saving a
logged-out session:

```ts
login: {
  // …steps…
  verify: { url: "**/dashboard", selector: "[data-testid=user-menu]" },
}
```

## Use it as a Claude Code skill

The skill lives in `.claude/skills/visualice/` — active automatically when you work in
this repo. To use `/visualice` from any project, symlink it into your personal skills:

```bash
ln -s "$PWD/.claude/skills/visualice" ~/.claude/skills/visualice
```

Then ask Claude to "visually crawl https://your.site" — it picks the right mode
(replay / auto / agentic explore for auth + tricky states), captures, and opens the viewer.

Output lands in `.visualice/runs/<runId>/`:

```
screenshots/<path>/<state>/<device>.png   # + .thumb.webp + .json sidecar
crawl-map.json      # reusable manifest (routes, states, recipes, shots)
viewer-data.json    # flattened tile index for the viewer
crawl-report.md     # human summary
```

## Use it as a library

```ts
import { loadConfig, crawlPipeline } from "./src/index";

const config = await loadConfig("visualice.config.ts");
const { runDir, manifest } = await crawlPipeline({ config, baseUrl: "https://your.site" });
```

`src/index.ts` re-exports the pipelines, the config schema, the manifest helpers and the pure
utilities (URL normalization, globs, robots parsing). The package ships TypeScript sources —
run consumers through `tsx` or any bundler.

## Development

```bash
npm run check             # typecheck + lint + format check + unit tests
npm run test:integration  # browser-driven suites (needs playwright chromium)
npm run test:all          # both
npm run fixture -- --open # browse the bundled fixture site
npm run fixture:build     # rebuild tests/fixture from tests/fixture-src
```

Unit tests are pure and fast. The browser-driven suites in `tests/integration/` cover the
end-to-end crawl against the fixture, robots enforcement, nested state discovery, and the
determinism guarantee (identical pixels across two runs of a deliberately volatile page).

## Scope & ethics

Crawl sites you own or are authorized to test. visualice stays on the target origin by
default, honours robots.txt unless you turn `respectRobots` off, and during discovery never
submits non-idempotent forms or clicks triggers matching `denyLabels`.
