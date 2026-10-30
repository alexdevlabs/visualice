# AGENTS.md

Notes for coding agents (Codex, Cursor, Gemini CLI, Claude Code, …), whether you are
using visualice on a project or working on this repo.

## Using visualice

- The workflow lives in [`skills/visualice/SKILL.md`](skills/visualice/SKILL.md), with
  the full flag surface in [`references/cli.md`](skills/visualice/references/cli.md).
  It is plain Markdown and works for any agent; agents that load skills can copy the
  `skills/visualice/` folder into their skills directory as it is.
- Run the CLI as `visualice` if it is installed, else `npx -y visualice@0.1.0 <cmd>`.
  Needs Node 22.18+. Start with `visualice doctor`.
- Run non-interactively with `--json --quiet`: a command given `--json` prints one JSON
  summary on stdout (`probe` always does), progress goes to stderr, and exit codes are
  0 ok, 1 error, 2 usage, 3 capture failures (with `--fail-on-error`).
- Before a big crawl, `visualice crawl <url> --dry-run --json` counts the screenshots
  without taking any. Confirm the scope with the user.
- Read `visualice.routes.md` to orient, not the cache JSON. Edit it to steer the crawl
  (`- /path` seeds a page, `skip:` excludes, `- [ ] id` requests a state).
- `/visualice-explore` and the `visualice-explorer` agent are Claude Code extras.
  Elsewhere, do the same by hand for each page type:
  1. `visualice probe <page>` for the page's inventory.
  2. `visualice probe <page> --recipe='[…]' --shot=x.png` until the shot shows the state.
  3. Write the states to `.visualice/explore/<type>.json`.
  4. `visualice author`, then `visualice crawl --replay`.

  The steps and file format are in
  [`references/explore-mode.md`](skills/visualice/references/explore-mode.md) ("By hand").

- Only crawl sites the user owns or is authorized to test.

## Working on this repo

- `npm install`, then `npm run check` (typecheck, lint, format, unit tests) before
  handing work back; `npm run test:integration` drives a real browser.
- Run the CLI from source with `npm run vc -- <cmd>`.
- `npm run schema` regenerates `config.schema.json` after a config change; a test fails
  if it drifts.
- Viewer rule: the shot actions in the details tray and the floating bar must match 1:1.
  Change them only in `viewer/src/ShotActions.tsx` (see [`CLAUDE.md`](CLAUDE.md)).
- Commit subjects are `feat: …`, `fix: …` or `chore: …`.
