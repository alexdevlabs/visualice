# Explore mode — driving the browser via Playwright MCP

Read this when a site needs login (also see [`auth.md`](auth.md)) or has UI states the
heuristic discovery misses (custom/hover dropdowns, multi-step flows, canvas widgets),
per SKILL.md §3.

Use the `browser_*` MCP tools to _author or augment_ the cached site model, then let the
deterministic engine do the bulk capture. Do not screenshot the whole site through your
own context — that is the engine's job; you only discover the tricky parts.

Work from the `wanted` list (routes-file `[ ]` lines that nothing realizes yet): author
each one's recipe into the cache **under the same state id**, and the next run flips its
checkbox to a realized bullet automatically.

- `browser_navigate` to a representative page, then `browser_snapshot` to read its
  accessibility tree.
- Spot interactive triggers the heuristics would miss. `browser_click` / `browser_hover`
  to confirm what each opens; note a robust selector for the trigger (test id > role+name
  > stable CSS) and the id/selector of the element that appears.
- Append each as a state to `.visualice/crawl-map.cache.json` under the right route:
  ```json
  {
    "id": "menu-products",
    "kind": "menu",
    "label": "Products dropdown",
    "trigger": { "role": "button", "name": "Products" },
    "recipe": [
      { "action": "hover", "target": { "role": "button", "name": "Products" } },
      { "action": "waitFor", "selector": "[data-menu='products']", "state": "visible" }
    ],
    "shots": {}
  }
  ```
- After editing the cache, ALWAYS check it before capturing:
  `visualice validate --json` — it lists every problem with a JSON-path pointer
  (`manifest.schema.json` documents the shape). A state can carry
  `"devices": ["mobile"]` to capture only on those devices (mobile-only navs).
- Then capture everything via Replay: `visualice crawl <url> --replay --json`.

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
