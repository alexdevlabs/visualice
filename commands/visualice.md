---
description: Crawl a website and capture every page and UI state across devices with visualice
argument-hint: [url]
---

Crawl `$ARGUMENTS` with the `visualice` tool — if no URL was given, use the target
already configured in `visualice.config.json` in the current directory.

Follow the `visualice` skill for the full workflow: preflight (`visualice doctor`),
locating/reading the project's `visualice.config.json` and `visualice.routes.md`,
choosing Replay vs. Auto vs. Explore mode, and reporting the result.

Steps:

1. Load the `visualice` skill and follow it — it has the decision-making detail this
   command intentionally omits.
2. Run `visualice doctor` if this is the first crawl seen in this session.
3. Run the crawl (`visualice crawl $ARGUMENTS --json --quiet`, escalating to Explore
   mode per the skill when discovery needs help), then summarize the result: routes,
   states, and shots captured, and any failures or `wanted` states.
4. Mention `/visualice-view` to browse the results.

Only crawl sites the user owns or is authorized to test.
