# Explore mode — agents author what discovery misses

Read this when a site needs login (also see [`auth.md`](auth.md)) or has UI states the
heuristic discovery misses (inline errors, data-dependent views, dropdown choices,
multi-step flows), per SKILL.md §3.

The engine does the mechanics and the capture; you (or explorer agents) decide what's
worth a state and write its recipe. Never screenshot the site through your own context —
that is the engine's job, from your recipes.

## The whole site: `/visualice-explore`

For more than a handful of pages, run the `/visualice-explore` command: it groups pages
into kinds, dispatches one `visualice-explorer` agent per kind in parallel, merges their
results with `visualice author`, and captures with `--replay`. The agent definition
(`agents/visualice-explorer.md`) is the detailed playbook; the steps below are the same
loop by hand.

## By hand: probe, author, replay

1. **Read the page** — `visualice probe <path> --quiet` prints JSON: the states the
   catalog already has, and the page's inventory — `triggers` (what discovery clicks),
   `forms` with fields **and the submit button discovery never presses**, `controls`
   (selects with every option), `links`, `headings`. `--device=mobile` probes as a
   configured mobile device.
2. **Try a state** — `visualice probe <path> --recipe='[…]' --shot=x.png` runs the
   recipe through the same code capture uses, in a browser of its own, and reports
   `ok`/`error.step`, `opened` regions, text that `appeared`/`disappeared`, whether it
   `navigated` or was `sentToLogin`, and `storage` it wrote (`suggestIsolate`). Read the
   shot. `--state=<id>` replays a cached state's recipe instead — for checking one that
   fails at capture. Finish with `--all-devices`: capture replays every recipe on
   every configured device, and a `waitFor` on something hidden at phone width
   passes on desktop and fails on mobile.
3. **Write it down** — put verified states in `.visualice/explore/<name>.json`:
   `{ "states": [{ "page": "/cart", "id": "with-items", "kind": "other", "label": "…",
"isolate": true, "recipe": […] }], "pages": ["/editor"] }`. `page` may be a list for
   a state every page of a kind shares; `pages` proposes pages the catalog lacks.
4. **Merge and capture** — `visualice author` validates and merges every explore file
   into the cache (under the lock; same id on a page replaces), seeds proposed pages in
   the routes file, and regenerates it. Then `visualice crawl --replay`.

Editing `.visualice/crawl-map.cache.json` directly still works for a one-off state; run
`visualice validate --json` afterwards. Don't do it while explorer agents are running —
that's what `author` is for.

Work from the `wanted` list too (routes-file `[ ]` lines that nothing realizes yet):
author each one **under the same state id**, and the next run flips its checkbox.

Recipe rules:

- Steps are `navigate`, `click`, `hover`, `focus`, `blur`, `fill`, `select` (a
  `<select>` option by value or label: `{ "action": "select", "target": { "testId":
"sort" }, "value": "lohi" }`), `press`, `waitFor`, `scroll` and `wait`.
- A state whose recipe **changes data** — adds to a cart, saves a preference, submits a
  login — gets `"isolate": true`: it is captured in a fresh browser context of its own,
  so what it stores can't show up in the states captured after it. A state that needs
  data first (a cart with items) builds it in its own recipe: `navigate` to where the
  data is made, act, `navigate` back, `waitFor` the result — and is isolated too.
- Inline messages (a form error under a field, a toast that isn't a dialog) aren't
  detected automatically: discovery looks for things that open. Author them, ending
  the recipe on a `waitFor` of the message.
- A missing **page** (reachable only after login, or never linked): add `- /path` to
  `visualice.routes.md` (or list it in an explore file's `pages`). The next run —
  `--replay` included — discovers that page alone and merges it into the cache.
- A state can carry `"devices": ["mobile"]` to capture only on those devices.
- Native browser validation (a `required` field's tooltip) is not in the page and never
  appears in a screenshot: look for the site's own error message instead.
- The Playwright MCP browser is still the tool for working out a login flow by eye
  (see [`auth.md`](auth.md)); for states, prefer `probe` — what it verifies replays.

Note the heuristics are stronger than they look: hover dropdowns are probed
automatically, and a second discovery pass runs at the first mobile device's viewport so
hamburger navs are found without Explore mode. Escalate to Explore only for what is
still missing after an Auto run.

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
  taken mid-hydration. Each has a short timeout and logs a warning if it never
  appears — don't leave a stale one in place.
- `skipTriggers` → merged into `discovery.interactions.denySelectors`: never probed.

Hints only ever add to the config; they can't remove what the user set, and applying
them twice changes nothing. Put site-specific knowledge here rather than in the
user's config — it travels with the cached model.
