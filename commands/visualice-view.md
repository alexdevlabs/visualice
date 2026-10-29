---
description: Open the zoomable visualice viewer for a crawl run
argument-hint: [--run=<id>] [--screenshot=<file>]
---

Open the `visualice` viewer for the most recent crawl run.

- `visualice serve --open` — launch the viewer and open it in the browser.
- `visualice serve --site=<name> --open` — view another site's latest run
- `visualice serve --run=<id> --open` — view a specific run instead of the latest
  (pass `--run=<id>` if `$ARGUMENTS` names one).
- `visualice serve --screenshot=<file>` — headless: capture a screenshot of the viewer
  itself to `<file>` and exit, instead of opening a browser (useful when there's no
  display, or `$ARGUMENTS` asks for a shot instead of an open window).

If no run exists yet, say so and suggest `/visualice <url>` first.
