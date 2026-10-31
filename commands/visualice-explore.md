---
description: Explore more of a site visualice has already catalogued — new sections, a focus like form errors, or signed-in states
argument-hint: [pages or focus, e.g. "/checkout*" or "signed-in states"]
---

Widen the catalogue of the site in this project: explore the page types `$ARGUMENTS`
names (a path glob, or a focus like "forms and errors") with
`visualice:visualice-explorer` agents, then capture what they found. Empty means every
page type, for a site whose first run was a quick one.

Load the `visualice` skill first, then follow steps 2–5 of its
`references/explore-mode.md`:

1. **Have a map.** No `.visualice/crawl-map.cache.json` yet → this is a first run; do
   step 1 of the reference (or `/visualice <url>`) first. Otherwise read
   `visualice.routes.md` for the pages and the states they already have.
2. **Plan.** Group the pages `$ARGUMENTS` covers into page types; tell each explorer
   the focus, and that the states already listed for its pages don't need authoring
   again. Confirm with the user before dispatching if there are more than ~8 types or
   any writes to the site.
3. **Explore** in parallel, one explorer per type (at most 6 at a time), with the brief
   the reference lists.
4. **Merge and capture** with `visualice author --json` and
   `visualice crawl --replay --json --quiet`.
5. **Check and report** per page type. Mention `/visualice-view` to browse.
