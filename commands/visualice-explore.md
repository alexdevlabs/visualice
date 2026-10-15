---
description: Have explorer agents find and author the UI states visualice's automatic discovery missed
argument-hint: [pages or focus, e.g. "/checkout*" or "signed-in states"]
---

Explore the site in this project with `visualice-explorer` agents, one per kind of
page, then capture what they found. `$ARGUMENTS` narrows it (a path glob, or a
focus like "forms and errors"); empty means the whole site.

Load the `visualice` skill first for the CLI, auth and guardrails; this command is
the agentic part of it.

## 1. Have a map

- No `.visualice/crawl-map.cache.json` yet → run `visualice crawl --json --quiet`
  (it discovers and captures what the heuristics can) and read its summary.
- Read `visualice.routes.md` — pages and the states they already have.
- Signed-in site → auth must work first (`visualice auth`; see the skill's auth
  reference). Explorers can't recover a lapsed session.

## 2. Group pages into page types

Pages that share a template are one type: `/tag/react`, `/tag/python` … →
`tag/:tag`; `/article/*` → `article/:slug`. For each type pick a representative
(the one with the most content), plus a second when variants differ. Unique pages
(home, login, settings) are a type each. Skip types `$ARGUMENTS` rules out.

Show the user the types (and anything the exploration would _change on the site_:
creating an account, posting, adding to a shared cart) and confirm before
dispatching if there are more than ~8 types or any such writes.

## 3. Dispatch explorers in parallel

One `visualice-explorer` agent per type, all in a single message (at most 6 at a
time; queue the rest). Give each:

- page type, representative page(s), the other pages of the type
- the CLI invocation (`npx visualice`, or `npm run vc --` in a visualice checkout)
  and the project directory to run it from
- output file `.visualice/explore/<type-slug>.json` and a shots dir
  (`.visualice/explore/shots/`)
- budget (default 8 states) and the allowed writes
- one line of site context (what the site is, signed in or out)

## 4. Merge and capture

1. `visualice author --json` — merges every explorer file into the cache under the
   lock and regenerates the routes file. It reports `added`/`replaced`,
   `proposedPages` (now seeded in the routes file) and `unknownPages`.
2. `visualice crawl --replay --json --quiet` — discovers any proposed pages and
   captures everything.
3. Proposed pages that are a new _type_ (an editor, a settings page) → one more
   explorer round for them, then `author` and `crawl --replay` again.
4. Failures in the summary → re-dispatch the owning explorer once with the failing
   state and its error; drop the state if it still fails.

## 5. Check and report

Look at the new shots (`.visualice/sites/<site>/runs/<id>/screenshots/<page>/<state>/<device>.thumb.webp`)
— at least one per type — for login pages, spinners, empty screens and duplicates.
Then report: per page type, the states added; totals (routes, states, shots,
failures); what was skipped and why. Mention `/visualice-view` to browse.
