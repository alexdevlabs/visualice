# Changelog

## 0.2.0

### Updating from 0.1.x

- 0.1.x can't update itself. Update the plugin by hand with
  `claude plugin update visualice@visualice`, or turn on auto-update under `/plugin` →
  **Marketplaces**. Update an installed CLI with `npm i -g visualice@latest`.
- The skill checks the installed CLI's version: one older than the skill is passed over
  for `npx -y visualice@0.2.0`, and the user is told how to update it.
- The plugin, skill and explorer agent run this version of the CLI.

### Updating after code changes

- Each crawl records the git commit it shot, on a `visualice-source` line in
  `visualice.routes.md` and as `source` in the run's `crawl-map.json` (branch, files with
  uncommitted changes, whether the target was local, a hash of the config). Only a run
  that shot every state moves the routes-file line; one with failed shots or `--no-states`
  leaves it where it was.
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

### Discovery

- Links that only exist once something is opened (a sidebar group that renders its links
  when clicked, a drawer menu) are followed, and the pages behind them mapped. Before,
  only links on the page as it loaded were, so an app with a collapsed sidebar needed
  most of its pages seeded by hand. `scope.maxDepth`, `scope.maxPages`, the scope globs
  and robots.txt apply as for any link.
- `discovery.interactions.denyLabels` match whole words. As plain text inside a label,
  `import` also stopped a menu group called "Importers", and the default `pay` stopped
  "Payments". A label you relied on matching inside a longer word needs that word listed.
  `log out` joins the defaults.
- A scope glob with a `?` in it matches a page's path and query, in `scope.include`,
  `scope.exclude` and routes-file `skip:` lines: `- skip: /metrics?*` leaves out every
  `/metrics?network=…` and keeps `/metrics`. A glob without one is about the path alone,
  as before.

### Viewer

- Shots a partial run took carry an **updated** tag; a carried shot's details say which
  run and commit it was really taken in.
- **Compare with another version** in the details panel shows the same shot from another
  run beside this one.
- The canvas shows at most 200 shots at a time; a bigger run is split into pages, turned
  with the arrows above the canvas or `[` and `]`. A page ends between two states, so a
  state's devices stay side by side. Search, filters and the sidebar still cover every
  page, a link to a shot opens on its page, and stepping past a page's last shot turns to
  the next. This replaces the old cap of 2,500 shots with its **Show all** button.

### Update notice

- An installed CLI tells you when a newer visualice is out (checked against npm at most
  once a day, in the background, never in the way), with the command to update the
  plugin or the CLI. The skill passes it on. Off with `--quiet`, in CI, or with
  `VISUALICE_NO_UPDATE_CHECK=1`.
- `visualice serve` shows the same news as a banner across the top of the viewer, with
  the update steps and a copy button for each command. Dismissed, it stays away until
  the next version; a shared export never shows it.
- The README says how to turn on auto-update for the plugin: a marketplace plugin
  doesn't update itself unless you do.

### Fixes

- A very long page, above all on a high-density phone, no longer fails its shot with
  "Processed image is too large for the WebP format": the viewer's preview images are
  scaled down to fit WebP's 16383px limit, and the full PNG is untouched. With
  `screenshot.format: "webp"`, a page too tall for WebP now says so and how to fix it.
- States no longer time out on capture because of ids an app generates at render time
  (React's `useId()` `_r_6_` / `:r6:` / `«r6»`, `base-ui-…`, `mat-dialog-0`, `ember812`…),
  which differ on the next load, on another device, or after another click. Discovery
  recorded waits, click targets and state signatures from them; now it doesn't, so those
  states also stop going stale between runs:
  - The common libraries are known already.
  - Discovery notices the rest itself, whatever the framework: it loads the first page
    twice and compares ids, and opens a dialog a second time to see whether its id comes
    back. What it found is listed under **Generated ids** in the report (`unstableIds` in
    `--json`) and remembered in the cached model.
  - New `discovery.unstableIds` config: the project's own patterns, as regular
    expressions. The skill adds what a crawl found there.
  - A recipe that still waits for an id that changed (one recorded before, or one nobody
    caught) goes ahead once the click before it has opened something, instead of failing
    the shot.

- A recipe step that waits for a selector to show now passes once any match is visible,
  not only the first. A page that keeps a hidden tab panel or a closed drawer mounted
  (its rows are in the document, ahead of the ones on screen) no longer times the step
  out while what it waits for is showing.
- Discovery no longer misses a dialog or menu that is slow to open. When a click leaves
  the page busy (a request it started still loading, the DOM still changing), the probe
  keeps looking, up to the new `discovery.interactions.patienceMs` (1500 ms), instead of
  calling the trigger dead after 250 ms. A trigger that does nothing costs no more than
  before.
- The report lists the triggers discovery clicked that showed nothing, under **Clicked,
  nothing opened**. The ones still loading when it gave up (`stillLoading` in `--json`)
  are where a slow page may hide a state.
- `changes` and partial runs no longer leave a page stale without saying so:
  - A partial run whose `--only` names no page (a typo, or a page not in the site model)
    says so (`unmatchedOnly` in `--json`, **Not shot** in the report) and leaves the
    commit record where it was. `--only=/pricing` matches a page crawled as `/pricing/`.
  - When the newest run on this computer was shot at another commit than the routes
    file records, `changes` compares against that run, whose shots a partial run
    carries over.
  - A shared file under `app/` whose name ends in "page", "layout" or "error"
    (`app/components/homepage.tsx`) is no longer taken for a route.
  - In a monorepo, changed files are mapped by their path inside the project folder; a
    file outside it is left to be traced, and a root lockfile still asks for a full run.
  - `changes --discover` lists a page the site answers 404 for as removed, though the
    routes file still seeds it.
- A first crawl no longer counts the `.gitignore` it edits as an uncommitted change, and
  a rerun at the same commit with other files uncommitted writes a new record.
- A partial run's accessibility totals cover the carried pages too.
- A recipe that waits for a plain id (`#results`) waits for it to its timeout, even when
  the click opened something else first.
- A page that changes or polls on its own no longer makes every trigger on it wait out
  `patienceMs` and show up as **still loading**.
- Viewer: the shortcuts popover and the phone details sheet sit below the update banner
  instead of overlapping the header.

### Safety and security

- Discovery never clicks a form's submit button. A `<button>` in a form with no `type`
  is one, and was clicked (and the form sent).
- A page that redirects to another site is left out, not probed and shot as part of
  this one.
- A crafted link can no longer make a run write shots outside its folder, and two
  different pages never share a shot folder (`/` and `/home`, `/About` and `/about`,
  paths in non-Latin scripts): where a folder name would lose part of the path, a hash
  of the path is added (`about__p-3f2a9c`).
- The login recipe runs against the site being crawled (`--target`), not the config's
  `target`, and a session saved for another host is not reused. A failed login step no
  longer prints the value it typed.
- The config snapshot in `crawl-map.json` hides more: preview and bypass headers by name
  or by a token-like value, `user:pass@` in the target and proxy URLs, query values in
  the login URL, `select` values. The manifest and the routes file never keep the
  `user:pass@` of a target.
- `visualice serve` answers only to a host name that is this machine's (`localhost`, an
  IP address, the computer's name, or one in `VISUALICE_ALLOWED_HOSTS`), which stops a
  page on another site reading runs through DNS rebinding. The check that the served
  site can't be deleted no longer depends on letter case, and a malformed URL gets a 400.

### More fixes

- Discovery: buttons that share a name (a "Details" on every card), or whose name is
  inside another's ("Menu" and "Close menu"), are probed and replayed instead of failing
  to click. A page is loaded at the path the site links to (`/docs/`), and robots.txt
  rules are checked against that path. `/**/` in a glob matches whole segments
  (`/blog/**/edit` no longer matches `/blog/credit`). Sitemap URLs with `&amp;` or CDATA
  are read correctly. `scope.samples` holds across crawls instead of growing each time.
  Each page is probed in a browser context of its own, so pages probed side by side
  can't disturb each other's stored state.
- Capture: an app shell that locks the page and scrolls inside gets all its screens. A
  font that never loads, or a hung accessibility check, no longer hangs the run. A JPEG
  taller than the format holds is cut to fit and marked clamped, and very tall pages no
  longer fail on the pixel limit. Accessibility checks run on component states written
  as `role=` or `text=` selectors, and a resumed run's totals include the shots it kept.
- `--resume` continues only the newest run, never an old unfinished one with finished
  runs after it. The output lock can't be taken by two processes at once.
- Routes file: a path typed with a trailing slash is the page it names, a page listed
  twice is merged, and a `skip:` written under a state's own line is obeyed. Authored
  state ids must be one word.
- `changes` no longer takes templates, partials or build output (`templates/base.html`,
  `coverage/index.html`) for pages.
- The report's Routes table survives a `|` in a page title.
- CLI: a mistyped short flag (`crawl -h`) is no longer taken for the target and saved
  to the config; `--help` after a command prints help; an expected error prints its
  message without a stack trace (`VISUALICE_DEBUG=1` shows it); `--port=` with no value
  is an error; `--open` works on Windows.
- Viewer: full screen no longer comes back after switching version; right-click and a
  second finger no longer confuse panning, and two fingers pinch to zoom; Cmd/Ctrl
  shortcuts go to the browser; Escape closes an open picker before leaving full screen;
  a device filter from an old link falls back to all devices; the Live page link is
  only ever a web address; tablets get the mobile icon; device names with a comma
  survive in links.
- Docs: `AGENTS.md` starts with `visualice init`, and the rule about `--json` names the
  commands that don't take it.

### Code scanning

- Parsing a routes file, a source line, a URL's parameters and a folder name no longer
  slows down on a long run of spaces, slashes or dashes.
- Report tables escape a backslash in a page title or trigger, not only a `|`.
- CI jobs run with read-only access to the repository.

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
