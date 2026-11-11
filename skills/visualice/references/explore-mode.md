# Explore mode — the default flow

This is how an agent catalogues a site: the heuristics map it, you (or explorer agents)
explore each kind of page like a QA reviewer and write a recipe for every state worth
keeping, and the engine captures all of it on every device. SKILL.md §3 says when to
take a shorter path.

Agents explore, the engine captures. Never screenshot the site through your own context:
every state becomes a recipe the engine replays, so the catalogue reruns the same way
next week, or in CI, with no agent involved.

## 1. Map

Let the heuristics find what they can first, without taking screenshots. Explorers then
start from that map instead of rediscovering menus and modals.

- **No `visualice.config.json` yet** → `visualice init <url> --quiet`. Probing and
  merging read the target from it.
- **Signed-in site** → auth must work before anything else (`visualice auth`; see
  [`auth.md`](auth.md)). Discovery and explorers land on the login form otherwise.
- `visualice crawl --dry-run --json --quiet` discovers pages and states and caches them,
  capturing nothing. Its JSON has the `routes` (each page's `url` and state ids), the
  `states` total, the `devices` and the `shots` a capture would take.
- `visualice routes --quiet` writes `visualice.routes.md` from that cache. Read it to
  orient, not the cache JSON.

## 2. Plan, and confirm once

Group the pages into page types. Pages that share a template are one type:
`/tag/react`, `/tag/python` … → `tag/:tag`; `/article/*` → `article/:slug`. For each
type pick a representative (the one with the most content), plus a second when variants
differ. Unique pages (home, login, settings) are a type each.

Then show the user, in a few lines:

- the page types and how many pages each covers,
- the shot count from the dry run, and roughly how much exploring adds (up to 8 states
  per type, on every device),
- anything exploring would _change on the site_: creating an account, posting, adding
  to a shared cart.

Confirm before going on. One confirmation covers the run. If it's large, narrow it here:
`scope.samples`, `--max-pages`, `--include` or fewer devices (SKILL.md §2). Unless the
user allows more, nothing publishes, deletes, pays, signs out or changes account
settings.

## 3. Explore each page type

**In Claude Code with the plugin** → dispatch one `visualice:visualice-explorer` agent
per type, all in a single message (at most 6 at a time; queue the rest). Give each:

- page type, representative page(s), the other pages of the type
- the CLI invocation (`visualice` if it is on the PATH, else `npx -y visualice@0.1.1`,
  or `npm run vc --` in a visualice checkout) and the project directory to run it from
- output file `.visualice/explore/<type-slug>.json` and a shots dir
  (`.visualice/explore/shots/`)
- budget (default 8 states) and the allowed writes
- a focus, when the user named one ("form errors", "signed-in states")
- one line of site context (what the site is, signed in or out)

The agent definition (`agents/visualice-explorer.md`) is the detailed playbook.

**Anywhere else** → do the same loop yourself, one page type after another:

1. **Read the page** — `visualice probe <path> --quiet` prints JSON: the states the
   catalogue already has, and the page's inventory — `triggers` (what discovery clicks),
   `forms` with fields **and the submit button discovery never presses**, `controls`
   (selects with every option), `links`, `headings`. `--device=mobile` probes as a
   configured mobile device.
2. **Decide what's worth a state** — think like a designer reviewing every screen:
   each form submitted empty and with wrong input, the page with and without data (a
   cart with items, a list filtered to nothing), each meaningfully different option of
   a select or tab, opened UI the inventory lists but `states` lacks. Skip lookalikes
   and every item of a long list (one is enough).
3. **Try a state** — `visualice probe <path> --recipe='[…]' --shot=x.png` runs the
   recipe through the same code capture uses, in a browser of its own, and reports
   `ok`/`error.step`, `opened` regions, text that `appeared`/`disappeared`, whether it
   `navigated` or was `sentToLogin`, and `storage` it wrote (`suggestIsolate`). Read the
   shot: it must show the state, not a spinner or an unchanged page. `--state=<id>`
   replays a cached state's recipe instead — for checking one that fails at capture.
   Finish with `--all-devices`: capture replays every recipe on every configured
   device, and a `waitFor` on something hidden at phone width passes on desktop and
   fails on mobile.
4. **Write it down** — put verified states in `.visualice/explore/<type-slug>.json`:
   `{ "states": [{ "page": "/cart", "id": "with-items", "kind": "other", "label": "…",
"isolate": true, "recipe": […] }], "pages": ["/editor"] }`. `page` may be a list for
   a state every page of a type shares; `pages` proposes pages the catalogue lacks.

Work from the `wanted` list too (routes-file `[ ]` lines that nothing realizes yet):
author each one **under the same state id**, and the next run flips its checkbox.

## 4. Merge and capture

1. `visualice author --json` — validates and merges every explore file into the cache
   under the lock (same id on a page replaces), seeds proposed pages in the routes file
   and regenerates it. It reports `added`/`replaced`, `proposedPages` and
   `unknownPages`.
2. `visualice crawl --replay --json --quiet` — discovers any proposed pages and
   captures everything.
3. Proposed pages that are a new _type_ (an editor, a settings page) → one more explore
   round for them, then `author` and `crawl --replay` again.
4. Failures in the summary → re-explore the owning type once with the failing state and
   its error; drop the state if it still fails.

## 5. Check and report

Look at the new shots (`.visualice/sites/<site>/runs/<id>/screenshots/<page>/<state>/<device>.thumb.webp`)
— at least one per type — for login pages, spinners, empty screens and duplicates. Then
report: per page type, the states added; totals (routes, states, shots, failures); what
was skipped and why. Offer the viewer (`visualice serve --open`, or `/visualice-view`).

## Later runs

Once `.visualice/crawl-map.cache.json` exists the site is mapped, and every state in it
replays. Don't explore it all again:

- **Recapture** → `visualice crawl --replay --json --quiet`. Seconds per page, no agents.
- **Something new** (pages added to the routes file, a new section of the site, `wanted`
  lines, or a focus the user names like "checkout errors") → run steps 2–5 for just
  those page types, then `crawl --replay`.
- **The site changed a lot** → `visualice crawl --dry-run --json --quiet` rediscovers
  and merges (authored states survive), then explore only the page types that are new.

Editing `.visualice/crawl-map.cache.json` directly still works for a one-off state; run
`visualice validate --json` afterwards. Don't do it while explorer agents are running —
that's what `author` is for.

## Recipe rules

- Steps are `navigate`, `click`, `hover`, `focus`, `blur`, `fill`, `select` (a
  `<select>` option by value or label: `{ "action": "select", "target": { "testId":
"sort" }, "value": "lohi" }`), `press`, `waitFor`, `scroll` and `wait`.
- A state whose recipe **changes data** — adds to a cart, saves a preference, submits a
  login — gets `"isolate": true`: it is captured in a fresh browser context of its own,
  so what it stores can't show up in the states captured after it. (Automatic
  discovery sets it itself on a state whose trigger wrote to local or session
  storage.) A state that needs
  data first (a cart with items) builds it in its own recipe: `navigate` to where the
  data is made, act, `navigate` back, `waitFor` the result — and is isolated too.
- Inline messages (a form error under a field, a toast that isn't a dialog) aren't
  detected automatically: discovery looks for things that open. Author them, ending
  the recipe on a `waitFor` of the message.
- A state can carry `"devices": ["mobile"]` to capture only on those devices.
- Native browser validation (a `required` field's tooltip) is not in the page and never
  appears in a screenshot: look for the site's own error message instead.
- Values typed into fields are stored in the cache as written: use test data, never
  real credentials.
- The Playwright MCP browser is still the tool for working out a login flow by eye
  (see [`auth.md`](auth.md)); for states, prefer `probe` — what it verifies replays.

## Adding a missing page

Discovery only finds pages something links to. For one it can't reach (behind a login,
or never linked, like a dashboard or a `?id=99` not-found page), don't edit the cache by
hand:

1. Add `- /path` as a top-level bullet in `visualice.routes.md`, or list it in an
   explore file's `"pages"` (`visualice author` seeds those into the routes file).
2. Run `visualice crawl --replay`. Replay discovers just the new pages — routes and
   their states — merges them into the cache and captures everything.
3. Explore the new page like any other page type.

If the page needs a login, configure `auth` first ([`auth.md`](auth.md)), or discovery
lands on the login form and records that instead.

## Hints — advice the engine now acts on

The cached model's `hints` block is read on every run, so what you learn while
exploring keeps paying off:

```json
{
  "hints": {
    "flakyRegions": [".carousel", "#clock"],
    "stableSelectors": ["[data-hydrated]"],
    "skipTriggers": [".js-logout"]
  }
}
```

- `flakyRegions` → merged into `stabilize.maskSelectors`: painted over, so a
  never-identical region (a clock, an ad) doesn't change from run to run.
- `stableSelectors` → waited for (visible) before each screenshot, so a shot isn't
  taken mid-hydration. They are waited on together and share one budget
  (`stabilize.waitForSelectorsTimeoutMs`, 5 s by default); one that never appears
  costs that wait on every shot and logs a warning — don't leave a stale one in place.
- `skipTriggers` → merged into `discovery.interactions.denySelectors`: never probed.
- `unstableIds` → merged into `discovery.unstableIds`: id patterns the site generates
  at render time, never used in a recipe or a signature. Crawls write the ones they
  notice here themselves; move them into the config to keep them with the project.

Hints only ever add to the config; they can't remove what the user set, and applying
them twice changes nothing. Put site-specific knowledge here rather than in the
user's config — it travels with the cached model.
