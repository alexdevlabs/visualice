<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner/banner-dark.png">
  <img src="assets/banner/banner-light.png" alt="visualice: every page and UI state of your site, on every device">
</picture>

Point visualice at a website and it screenshots every page, and every state those pages can be
in (open menus, modals, drawers, accordions, tabs), on every device you configure. Then you
browse them all on one zoomable canvas.

- **Finds the states for you.** It clicks through each page the way a user would, records how
  to reopen each state, and replays that on every device, so reruns are fast and repeatable.
- **Shows what users see.** Pages are captured one screen at a time, as a user scrolls, so
  sticky headers, cookie bars and modal backdrops look the way they really do.
- **Works with your agent.** Ships as a Claude Code plugin, and as a skill that Codex, Cursor
  and other agents can use. Agents can add the states a crawler can't find on its own, like
  form errors or a cart with items in it.

![The visualice viewer: the home page of a demo site, with its search, subscribe and menu states on desktop and mobile](assets/viewer.webp)

## Install

Needs Node 22.18 or newer.

```bash
npm i -g visualice    # or run it without installing: npx visualice <command>
visualice doctor      # checks Node, the browser and the viewer, and fixes what it can
```

## Quick start

```bash
visualice crawl https://your.site   # find every page and state, and screenshot them
visualice serve --open              # browse the results
```

The first crawl writes two files next to you: `visualice.config.json` for settings, and
`visualice.routes.md`, a list of the pages and states it found. Edit the list to steer the
next crawl: add a page it missed, or mark one to skip. Everything else goes in a gitignored
`.visualice/` folder.

## Common tasks

| To…                                | Run or set                                                          |
| ---------------------------------- | ------------------------------------------------------------------- |
| See how big a crawl will be first  | `visualice crawl <url> --dry-run`                                   |
| Recapture without rediscovering    | `visualice crawl --replay`                                          |
| Limit what's crawled               | `--max-pages=20 --exclude='/admin/**'`, or `scope` in the config    |
| Capture pages only, no states      | `visualice crawl --no-states`                                       |
| Crawl a site behind a login        | a login recipe in the config, then `visualice auth` ([guide][auth]) |
| Add devices, browsers or dark mode | `devices` in the config ([configuration][config])                   |
| Check accessibility as well        | `checks.accessibility: true`                                        |
| Share the results without a server | `visualice export report/`                                          |
| Use it in CI                       | `--json --quiet --fail-on-error` ([crawling][crawling])             |

## Use it with Claude Code

```
/plugin marketplace add alexecus/visualice
/plugin install visualice@visualice
```

Then ask Claude to "visually crawl https://your.site", or use the commands: `/visualice [url]`
to crawl, `/visualice-explore` to have agents find the states the crawler missed, and
`/visualice-view` to open the viewer.

**Other agents** (Codex, Cursor, Gemini CLI, …): [`AGENTS.md`](AGENTS.md) points them at the
skill, which is plain Markdown and works anywhere. The skill's
[Explore-mode guide][explore] has a by-hand version of `/visualice-explore`.

## Docs

- [Crawling][crawling]: commands, the routes file, discovery, output layout
- [Configuration][config]: every option worth knowing, other browsers, component shots,
  accessibility
- [The viewer][viewer]: navigation, view modes, full screen, shortcuts, sharing
- [Logging in][auth]: login recipes, sessions, secrets
- [CLI reference][cli]: every command and flag
- [Explore mode][explore]: agents authoring the states discovery misses
- [Using it as a library](docs/library.md)
- [Changelog](CHANGELOG.md), including known limitations

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Report security issues privately, as described in
[`SECURITY.md`](SECURITY.md).

## Use it responsibly

Only crawl sites you own or are allowed to test. visualice stays on the target site, follows
robots.txt unless you turn that off, and while discovering it never submits forms that change
data or clicks controls that look destructive (delete, sign out, pay).

## License

MIT, see [`LICENSE`](LICENSE). The viewer bundles the Figtree and IBM Plex Mono fonts, both
under the SIL Open Font License 1.1; their licence texts ship in `viewer/dist/licenses/`.

[crawling]: docs/crawling.md
[config]: docs/configuration.md
[viewer]: docs/viewer.md
[auth]: skills/visualice/references/auth.md
[cli]: skills/visualice/references/cli.md
[explore]: skills/visualice/references/explore-mode.md
