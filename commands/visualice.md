---
description: Catalogue a website with visualice — map it, explore every page type with agents, and capture every state across devices
argument-hint: [url] [--quick]
---

Catalogue `$ARGUMENTS` with visualice. If no URL was given, use the target already
configured in `visualice.config.json` in the current directory.

1. Load the `visualice` skill. It has the CLI, auth, scope and guardrails this command
   leaves out.
2. Run `visualice doctor` if this is the first run seen in this session.
3. Pick the path (skill §3):
   - **`--quick` in `$ARGUMENTS`**, or the user asked for a quick pass → drop the flag
     and run `visualice crawl <url> --json --quiet`: the heuristics only, no exploring.
   - **No `.visualice/crawl-map.cache.json` yet** → the full flow in the skill's
     `references/explore-mode.md`:
     map with a dry run, show the user the page types, shot count and any writes and
     confirm once, dispatch one `visualice:visualice-explorer` agent per page type,
     then `visualice author` and `visualice crawl --replay`.
   - **Already mapped** → `visualice crawl --replay --json --quiet`, then explore only
     what's new (pages added to the routes file, `wanted` lines), per "Later runs" in
     the same reference. `/visualice-explore` is for widening it on purpose.
4. Summarize: per page type, the states added; routes, states and shots captured; any
   failures or `wanted` states; what was skipped and why.
5. Mention `/visualice-view` to browse the results.

Only crawl sites the user owns or is authorized to test.
