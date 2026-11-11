# Updating a catalogue after code changes

A crawl records the commit it shot in `visualice.routes.md`, on a line under the
title:

```md
<!-- visualice-source commit=3f2a9c1… branch=main dirty=0 captured=2026-11-09T10:00:00.000Z target=http://localhost:3000/ config=bab17dc92481 -->
```

Each run's `crawl-map.json` has the same record as `source`, with the list of files
that had uncommitted changes. Only a run that shot every state moves the line: one with
failed shots, or a `--no-states` run, leaves it at the last complete run, so `changes`
still diffs from there. When the project moves on (new pages, edited ones), you
don't have to reshoot everything: find out what changed, work out which pages it
touches, and reshoot only those. A partial run carries every other page's shots over
from the last run, so the new run is still the whole site.

## 1. Ask what changed

```bash
visualice changes --json          # add --discover to also map the site for new/removed pages
```

The answer, in short:

| Field        | What it is                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `verdict`    | `none` (nothing to do), `partial` (some pages), `full` (everything), `unknown` (no baseline: run a full crawl)   |
| `reasons`    | Why, most important first. Read these out to the user                                                            |
| `baseline`   | The commit the catalogue shows, its branch, when it was shot, and whether the target was local                   |
| `commits`    | Commits since (hash, subject), newest first; `commitCount` is the total                                          |
| `files`      | Every changed file that counts (committed since, uncommitted now, untracked, and files dirty at capture time)    |
| `global`     | Changed files that reach every page: dependencies, global styles, theme, root layouts, header/footer/nav, config |
| `candidates` | Changed files that file-based routing ties to pages: `{file, pattern, kind, pages}`                              |
| `unmapped`   | Changed files that map to no page on their own: components, hooks, utilities, data                               |
| `routes`     | With `--discover`: `added` and `removed` pages                                                                   |
| `suggest`    | The command to run, when the facts settle it (no unmapped files)                                                 |

The visualice files themselves (`visualice.routes.md`, `.visualice/`) never count.
The config is compared by its hash: changing devices or capture settings means a full
run.

## 2. Work out the affected pages

`verdict: "full"` or `"unknown"` → skip to step 3 and recommend a full run.

For `partial`:

- **`candidates`** already list their pages. A `layout` candidate covers every page
  under its pattern (`/docs/**`). A candidate with no `pages` is a page the catalogue
  doesn't have yet: include its `pattern` as a new page.
- **`unmapped`** files are yours to trace. For each one, find who imports it (search
  for its module name or path) and follow the chain up to page or layout files, then
  map those the same way the candidates are mapped. Read the diff
  (`git diff <baseline.commit> -- <file>`) when the reach is unclear: a renamed CSS
  class in a shared component reaches every page that renders it, a fixed typo in one
  prop doesn't.
  - A component used by most pages (a button, a card used everywhere, a design-system
    primitive) is effectively global: say so and recommend a full run.
  - Data files, API handlers and server code can change what a page shows without a
    UI file changing. If a page reads that data, include it.
  - Tests, docs, CI config, and server code no page renders don't affect screenshots:
    leave them out, and say you did.
- **`routes.removed`** pages are gone: suggest a `- skip: /path` line in the routes
  file so they stop being carried over.

Map files to the page paths the routes file uses (`/pricing`, not `pricing.tsx`). Globs
work: `/blog/**` covers every post.

## 3. Ask the user

Lay it out in one short message, then ask: rerun the affected pages, or everything?
Recommend one.

> Since 3f2a9c1 (6 commits): `/pricing` and `/compare` changed (PricingCard.tsx is used
> by both), and `/blog` is new. Nothing global changed.
> → **Rerun 3 pages (≈24 shots)**, carrying the other 38 pages over · or rerun
> everything (≈310 shots)

Recommend everything when:

- `verdict` is `full` or `unknown`;
- you couldn't trace an unmapped file with confidence;
- the baseline wasn't shot from a local server (`baseline.local: false`): it shows what
  was deployed, which may not be that commit;
- the catalogue has gone through several partial runs since the last full one (check
  the earlier runs' `partial` field): a full run now and then catches what tracing
  missed.

Add `--dry-run --json` to the command to show exact numbers before running it. With
`--only`, its `partial` field lists the pages to shoot and the pages to carry.

## 4. Run it

```bash
# Affected pages only: rediscovers their states (a changed page may have new ones),
# maps new pages, shoots them, carries every other page from the last run.
visualice crawl --replay --only=/pricing,/compare,/blog --json --quiet

# Everything
visualice crawl --replay --json --quiet     # or without --replay to rediscover the whole site
```

`--only` takes comma-separated paths or globs. A page outside it is still shot when the
last run can't cover it: a page new since, or one whose shots are missing or failed
there (a device added, a state added). The summary's `carried` count says how many
shots came from the earlier run.

When the run finishes, the routes file records the new commit. Tell the user to commit
`visualice.routes.md` with their change, so the next `changes` starts from here.

## In the viewer

A partial run marks the shots it took with an **updated** tag. A carried shot says so
in its details panel, with the run and commit it was really taken in. **Compare with
another version** in the details panel puts the same shot from another run beside it.
