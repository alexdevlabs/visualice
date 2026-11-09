# Changelog

## Unreleased

### Updating after code changes

- Each crawl records the git commit it shot, on a `visualice-source` line in
  `visualice.routes.md` and as `source` in the run's `crawl-map.json` (branch, files with
  uncommitted changes, whether the target was local, a hash of the config).
- `visualice changes` diffs the project against that commit: the commits and files since,
  the changes that reach every page (dependencies, global styles, root layouts, header
  and footer, the config), the pages file-based routing ties changed files to, and the
  files left for an agent to trace. It gives a verdict (`none`, `partial`, `full`,
  `unknown`) and the command to run; `--discover` also lists new and removed pages.
- `crawl --only=<paths>` shoots only those pages (paths or globs) and carries every
  other page's shots over from the last finished run, as hard links where the disk
  allows, so the new run is still the whole site. A page the last run can't cover (new,
  or missing shots) is shot anyway. With `--replay` the named pages' states are
  discovered again. `--dry-run` shows what would be shot and carried.
- The skill and `/visualice` follow it: run `changes`, trace the affected pages, ask
  whether to rerun those or everything, then run it.

### Viewer

- Shots a partial run took carry an **updated** tag; a carried shot's details say which
  run and commit it was really taken in.
- **Compare with another version** in the details panel shows the same shot from another
  run beside this one.

## 0.1.1

### Fixes

- A state found twice, once at desktop and again at the mobile viewport, no longer shows
  up as two mobile states.
- `visualice export` never carries the viewer's development data into an export.
- The plugin, skill and explorer agent run this version of the CLI
  (`npx -y visualice@0.1.1`).

### Viewer

- The details panel's **Live page** link can point at a hosted copy of a site instead of
  the address it was crawled from (`site.liveBase` in a run's data), as the docs site's
  live demo does.

### Project

- Docs site and live demo: [alexdevlabs.github.io/visualice](https://alexdevlabs.github.io/visualice/),
  now the package's homepage.

## 0.1.0 — first release

Crawl a website, capture every page and UI state across devices, and browse the shots on
a zoomable canvas.

### Crawling

- `visualice crawl <url>` discovers routes (links, sitemaps, data-loaded links,
  hash-router routes) and UI states (modals, menus, drawers, accordions, tabs, hover
  dropdowns, form focus and validation), then captures them on every configured device.
  A second probe pass at the first mobile viewport finds hamburger navs.
- Full pages are captured one screen at a time, as a user scrolls, so sticky headers,
  cookie bars and modal backdrops show as they really do.
- A cached site model makes later runs fast and deterministic (`--replay`); `--resume`
  continues an interrupted run. Hand-written and Explore-mode states survive re-crawls.
- `visualice.routes.md` is an editable site index: add `- /path` to seed a page,
  `- skip:` to exclude one, `- [ ] state` to request a state.
- Template sampling (`scope.samples`), site-wide states kept once, automatic isolation
  for states that write to storage, robots.txt and crawl-delay, retries, and a guard
  that fails a shot that lands on the login page.
- Login recipes with saved sessions, staleness checks and credential redaction.
- Other engines (`devices[].browser`: Firefox, WebKit), element-level component shots
  and axe-core accessibility checks.

### CLI

- `crawl --dry-run` lists the pages, states and screenshot count a crawl would take,
  without capturing. `--no-states` crawls pages only and keeps the states already cached.
  `--seed=<paths>` adds entry pages, `--site=<name>` picks the site folder a crawl
  writes to, and `--headed` shows the browser windows.
- Clearer names, with the old ones still accepted (and a warning): `--target` (was
  `--base`), `--dir` (was `--out`), `--timeout-ms` (was `--timeout`),
  `serve --screenshot` (was `--shoot`). In the config, `screenshot.fullPage` is now
  `"screens" | "single" | false` (replacing `fullPage` + `screens`), `maxHeight` limits
  both modes (default 25000 CSS px; `maxScreens` still works), `thumbnail.midWidth` is
  `zoomWidth`, and `interactions.auto: false` is the one way to turn states off
  (`nestDepth: 0` still works).

### Agentic exploration

- As a plugin or skill, exploring is the default: `/visualice <url>` maps the site with a
  dry run, confirms the page types and shot count with the user, then runs one
  `visualice-explorer` agent per page type. Each reads its page with `visualice probe`,
  verifies candidate recipes through the same code capture uses, and writes what it
  verified to an explore file; `visualice author` merges them into the cache and
  `crawl --replay` captures everything. `--quick` skips exploring.
- `/visualice-explore` widens an existing catalogue: a new section, or a focus like form
  errors or signed-in states.

### Viewer

- `visualice serve`: a dashboard of sites, each with dated versions, and a canvas per
  run, grouped by route with a row per state and a column per device.
- Screen, Continuous and Scroll view modes; device and state-kind filters; search;
  minimap; light and dark themes; a phone layout.
- Click a shot to focus it, with a floating bar of its actions (Full screen, Live page,
  Copy link, Download, Full image) matching the details panel.
- Full screen shows a state on every checked device, with device captions.
- Failed captures render as placeholder tiles; the view lives in the URL.
- Sites can be deleted from the dashboard (from this computer only).
- `visualice export <dir>` writes the viewer and a run as a static folder.

### Distribution

- An npm package (`npx visualice`) with `visualice doctor` as a self-healing
  preflight, and a Claude Code plugin with the `visualice` skill, the explorer agent and
  three commands. The skill runs the CLI pinned to its own version
  (`npx -y visualice@0.1.0`).
- `AGENTS.md` points other agents (Codex, Cursor, Gemini CLI) at the skill, with a
  by-hand version of the explore flow.
- Needs Node 22.18 or newer, which runs a `visualice.config.ts` natively; older Node
  gets a clear message instead of a stack trace. Works on Windows: `doctor`'s repairs
  run without `npx`.
- `init` points the config's `$schema` at a versioned unpkg URL, so editors find it for
  global and npx installs too.

## Known limitations

Things worth knowing before someone reports them as bugs.

- **No annotations in the viewer.** Shots can be downloaded and linked to, not drawn on
  or commented on.
- **Discovery runs in Chromium only.** A Firefox or WebKit device replays the recipes
  Chromium recorded; a state that only exists in another engine isn't found. Firefox
  has no mobile emulation, so a `mobile: true` Firefox device is a narrow desktop one.
- **`scope.hashRoutes: "always"` will fork on anchors.** It exists for routers that
  drop the slash (`#about`); on a documentation site it turns every heading link into a
  route. `auto` is the default for that reason.
- **The Windows integration leg has never actually run.** It's wired and the code it
  exercises is OS-sensitive (symlinked `latest`, run directories, temp paths); the
  first CI run on it is the one to watch.
- **Unnamed region signatures are a DOM path plus a hash of what the region says.** Two
  unnamed regions with the same opening text in the same spot still collide, and a
  region whose text changes between probes (a live timer) stops deduping against
  itself. Named regions (`id`, `aria-label`, `aria-labelledby`) are unaffected, which is
  most of them.
- **A state that closes on scroll is shot without a post-open lazy-load pass.** The
  page is scrolled before the state is opened instead, so content that only starts
  loading once the state is open _and_ the page is scrolled isn't woken.
