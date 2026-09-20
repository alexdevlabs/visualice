---
description: Compare two visualice runs and report what changed visually
argument-hint: [--from=<runId>] [--to=<runId>]
---

Compare two `visualice` crawl runs and report what changed.

- `visualice diff` — with no args, compares the two most recent runs.
- `visualice diff --from=<runId> --to=<runId>` — compare specific runs (parse these
  out of `$ARGUMENTS` if given).
- Add `--json` for a machine-readable summary instead of reading the report file.

The report is written to `.visualice/diffs/<from>__<to>/diff-report.md` — read it (or
the `--json` output) and summarize the changed, added, and removed states for the
user; call out anything that looks like a regression rather than an intentional
content change.

If fewer than two runs exist yet, say so and suggest `/visualice <url>` to produce
another one.
