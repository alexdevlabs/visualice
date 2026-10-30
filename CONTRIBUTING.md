# Contributing

Thanks for helping. Bugs and ideas go in [issues](https://github.com/alexecus/visualice/issues);
security problems go through [`SECURITY.md`](SECURITY.md) instead. For a change bigger than
a fix, open an issue first so we can agree on the shape.

## Setup

Node 22.18 or newer, then:

```bash
npm install
npx playwright install chromium
npm run demo:crawl        # full discover → capture run against the bundled fixture site
npm run serve -- --open   # look at it
```

Run the CLI from source with `npm run vc -- <command>`.

## Checks

```bash
npm run check             # typecheck + lint + format check + unit tests
npm run test:integration  # browser-driven suites (needs playwright chromium)
npm run test:all          # both
npm run build             # dist/ (node bundle + .d.ts) and viewer/dist
npm run fixture -- --open # browse the bundled fixture site
npm run fixture:build     # rebuild tests/fixture from tests/fixture-src
```

`npm run check` must pass before a pull request; CI runs it plus the integration suite.
After a change to the config schema in `src/shared/config.ts`, run `npm run schema`: a unit
test fails if `config.schema.json` drifts from it.

Both the viewer and the fixture site are styled with Tailwind v4, configured in CSS rather
than a `tailwind.config.js`: the viewer's theme tokens live in `viewer/src/index.css`, the
fixture's in `tests/fixture-src/tailwind.input.css`.

## Tests

The 487 unit tests are pure and fast. The 80 browser-driven tests in `tests/integration/`
cover the end-to-end crawl against the fixture, robots enforcement, nested state discovery,
the routes-file steering loop (edit → rerun respects it), the determinism guarantee
(identical pixels across two runs of a deliberately volatile page), the packaged `cli/`
entry point run from an unrelated cwd, hover states not leaking between shots that share a
page, `screenshot.maxHeight` clamping, `--resume`, component shots and accessibility
checks, and the viewer itself — built from source and driven in a browser, from `serve` and
from a static export.

CI runs the checks on Linux and Windows, on Node 22.18 and 24. Windows is the point of the
matrix, since symlink creation and the `open`-based browser shim behave differently there. Pushing a `v*` tag runs
`release.yml`, which verifies the tag matches `package.json`, reruns everything and publishes
to npm (`prepack` builds the tarball).

## Conventions

- Commit subjects are `feat: …`, `fix: …` or `chore: …`, in the imperative or as a noun
  phrase, with no ticket prefix.
- The viewer's shot actions in the details tray and the floating bar must match 1:1. Both
  render `viewer/src/ShotActions.tsx`; change them only there (see [`CLAUDE.md`](CLAUDE.md)).
- Update [`CHANGELOG.md`](CHANGELOG.md) for anything a user would notice.
