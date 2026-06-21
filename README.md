# visual-crawl

Crawl a website, capture **every page and every UI state** (modals, menus, drawers, accordions…)
across multiple device profiles, organize the screenshots, record a reusable crawl map, and view
the results on a zoomable Photoshop-like canvas.

See [`PLAN.md`](./PLAN.md) for the full design.

## Status

- ✅ **M0** scaffold (config, types, CLI, fixture site)
- ✅ **M1** capture MVP — replay a manifest's recipes across devices → organized screenshots + thumbnails + manifest + report
- ✅ **M2** route discovery — BFS link crawl + sitemap/robots, scope rules, SPA-aware
- ✅ **M3** state discovery — heuristic interaction probing finds modals/menus/accordions/tabs and records replayable recipes
- ✅ **M4** viewer — zoomable canvas (pan/zoom + LOD + virtualization), grouped & all-at-once layouts, sidebar, filters, inspector
- ⬜ M5 skill (agentic Explore mode) · M6 stabilization hardening

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
npm run crawl -- --base=https://your.site --config=visual-crawl.config.ts

# re-run later, reusing the cached site model (skips discovery, fast + deterministic):
npm run crawl -- --base=https://your.site --replay

# discovery only (writes .visual-crawl/crawl-map.cache.json, no screenshots):
npm run discover -- --base=https://your.site
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

Output lands in `.visual-crawl/runs/<runId>/`:

```
screenshots/<path>/<state>/<device>.png   # + .thumb.webp + .json sidecar
crawl-map.json      # reusable manifest (routes, states, recipes, shots)
viewer-data.json    # flattened tile index for the viewer
crawl-report.md     # human summary
```

## Capture a real site (replay mode)

```bash
npm run capture -- --config=visual-crawl.config.ts --manifest=path/to/crawl-map.json --base=https://your.site
```

The input manifest holds routes + interaction recipes. Discovery (auto-building that manifest)
arrives in M2/M3; for now you author it or copy a prior run's `crawl-map.json`.
