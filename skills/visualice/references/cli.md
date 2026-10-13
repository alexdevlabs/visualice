# CLI reference

Complete command and flag surface for the `visualice` binary. Installed globally
(`npm i -g visualice`) or run ad hoc with `npx visualice <cmd>`, both work from any
directory. In a source checkout of this repo, use `npm run vc -- <cmd>` instead (or
the dedicated script where one exists, e.g. `npm run crawl -- <args>`).

## Commands

| Command                     | Purpose                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| `init [url]`                | Scaffold `visualice.config.json` (+ `.gitignore` entry) without crawling |
| `crawl [url]`               | Discover routes + UI states, then capture across devices                 |
| `discover [url]`            | Auto-discover routes + UI states only — no screenshots                   |
| `routes`                    | Regenerate `visualice.routes.md` from the cached site model              |
| `validate`                  | Validate a crawl manifest / cached site model                            |
| `auth [--force]`            | Run the configured login recipe, save storage state                      |
| `capture --manifest=<path>` | Replay a given manifest's recipes and capture screenshots                |
| `demo`                      | Capture the bundled fixture from a hand-written manifest                 |
| `demo-crawl`                | Full discover → capture run against the bundled fixture                  |
| `fixture`                   | Serve the bundled fixture blog so you can browse it                      |
| `doctor [--no-fix]`         | Idempotent preflight: check Node/Playwright/sharp/viewer, self-heal      |
| `serve`                     | Launch the zoomable results viewer                                       |
| `export <dir>`              | Write the viewer + a run as a static folder                              |
| `--version`                 | Print the installed version                                              |
| `help`                      | Print usage                                                              |

## Flags

Flags accept `--name=value` or `--name value`; only the flags relevant to a given
command are accepted by it.

| Flag                | Applies to           | Meaning                                                            |
| ------------------- | -------------------- | ------------------------------------------------------------------ |
| `--config=<path>`   | most                 | Config file (`.ts`/`.js`/`.json`); cwd auto-detection if omitted   |
| `--base=<url>`      | most                 | Base URL (overrides `config.target`); same as the bare `[url]` arg |
| `--no-save`         | `crawl`              | Don't scaffold a config on first run                               |
| `--manifest=<path>` | `capture`/`validate` | Input manifest path                                                |
| `--replay`          | `crawl`              | Reuse the cached site model, skip discovery                        |
| `--resume`          | `crawl`              | Continue the newest interrupted run, keeping its shots             |
| `--json`            | most                 | Print a machine-readable JSON summary to stdout                    |
| `--quiet`           | most                 | Suppress progress output on stderr                                 |
| `--fail-on-error`   | capture cmds         | Exit 3 if any capture failed                                       |
| `--max-pages=<n>`   | `crawl`/`discover`   | Override `scope.maxPages`                                          |
| `--include=<globs>` | `crawl`/`discover`   | Override `scope.include` (comma-separated)                         |
| `--exclude=<globs>` | `crawl`/`discover`   | Override `scope.exclude` (comma-separated)                         |
| `--devices=<names>` | `crawl`/`capture`    | Capture only these configured devices (comma-separated)            |
| `--concurrency=<n>` | `crawl`/`capture`    | Override `politeness.concurrency`                                  |
| `--timeout=<ms>`    | `crawl`/`capture`    | Override `politeness.timeoutMs`                                    |
| `--out=<dir>`       | most                 | Override `output.dir` (default `.visualice`)                       |
| `--run=<id>`        | `serve`/`export`     | Which run to act on (default: latest)                              |
| `--port=<n>`        | `serve`/`fixture`    | Fixed port (default: random)                                       |
| `--open`            | `serve`/`fixture`    | Open in your browser                                               |
| `--shoot=<file>`    | `serve`              | Headless-screenshot the viewer to a file, then exit                |
| `--force`           | `auth`/`init`        | Re-run the login despite a fresh session; `init`: overwrite config |
| `--no-fix`          | `doctor`             | Report problems without repairing them                             |

## Exit codes

- `0` — ok
- `1` — error
- `2` — usage
- `3` — capture failures (only when `--fail-on-error` was passed)

## Project files

- **`visualice.config.json`** — behavior: `$schema`, `target`, `scope`, `devices`,
  `auth`, `http`, `politeness`, `output`, `components`, `checks`, … The first `crawl` scaffolds a minimal one
  (`$schema` + `target`); `init` does the same without crawling. Any
  `visualice.config.*` in the cwd is picked up automatically.
- **`visualice.routes.md`** — the editable site index. Pages as top-level bullets, UI
  states nested under them, regenerated after every crawl:
  - `- /path` seeds a page discovery missed (`--replay` discovers just the new pages).
  - `- skip: <id>` (nested) or `- skip: /path/**` (top-level) excludes noise —
    deleting a line is not an exclusion, `skip:` is the tombstone.
  - `- [ ] id — desc` requests a state with no recipe yet; it surfaces as `wanted`
    in `--json` output and a `## Wanted` report section until Explore mode fills it in.

## Output layout

Everything machine-owned lives under gitignored `.visualice/`:

- `.visualice/runs/<runId>/` — one directory per crawl: `screenshots/<path>/<state>/<device>.*`,
  `crawl-map.json`, `viewer-data.json`, `crawl-report.md`.
- `.visualice/crawl-map.cache.json` — the cached site model that `--replay` and Explore
  mode read/write.
- `.visualice/auth.json` — saved storage state from `auth`/`crawl`.
