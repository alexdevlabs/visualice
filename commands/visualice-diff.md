---
description: Compare two visualice runs and report what changed visually
argument-hint: [--from=<runId>] [--to=<runId>]
---

Compare two `visualice` crawl runs and report what changed.

- `visualice diff` — with no args, compares the latest run against the approved
  baseline if there is one (`visualice approve` sets it), otherwise against the run
  before it. `--from=previous` forces the run before.
- `visualice diff --from=<runId> --to=<runId>` — compare specific runs (parse these
  out of `$ARGUMENTS` if given).
- Add `--json` for a machine-readable summary instead of reading the report file.

The report is written to `.visualice/diffs/<from>__<to>/diff-report.md` — read it (or
the `--json` output) and summarize the changed, added, and removed states for the
user; call out anything that looks like a regression rather than an intentional
content change.

If fewer than two runs exist yet and there is no baseline, say so and suggest
`/visualice <url>` to produce another one. Don't run `visualice approve` unless the user
asks — approving is them accepting how the pages look.
