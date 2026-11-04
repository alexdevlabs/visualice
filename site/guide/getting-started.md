# Getting started

visualice catalogues every page of a website, and every state those pages can be in, on
every device you configure. Then you browse them all on one zoomable canvas.
<a href="/visualice/demo/" target="_blank" rel="noopener">The live demo</a> is a catalogue of a small blog,
made with the commands on this page.

Needs Node 22.18 or newer.

## With Claude Code

```
/plugin marketplace add alexdevlabs/visualice
/plugin install visualice@visualice
```

Then run `/visualice https://your.site`, or just ask Claude to "run visualice on
`https://your.site`". It maps the site, shows you the plan (the kinds of page, how many
screenshots, anything exploring would change on the site) and asks once, explores each
kind of page in parallel, captures everything, and `/visualice-view` opens the result.

- Later runs replay what's mapped and explore only what's new.
- `/visualice-explore <focus>` widens the catalogue on purpose: a section like
  `/checkout*`, or something to hunt for, like form errors.
- `/visualice https://your.site --quick` skips exploring: the crawler on its own.

[The explore flow](../../skills/visualice/references/explore-mode.md) has every step.

## With other agents

Codex, Cursor, Gemini CLI and the rest read
[`AGENTS.md`](../../AGENTS.md), which points them at the skill. It is plain Markdown and
works anywhere; agents without subagents explore one kind of page at a time.

## Without an agent

The engine is a CLI of its own: the quick path, and what CI runs.

```bash
npm i -g visualice                  # or run it without installing: npx visualice <command>
visualice doctor                    # checks Node, the browser and the viewer, and fixes what it can
visualice crawl https://your.site   # find pages and states with the heuristics, and screenshot them
visualice serve --open              # browse the results
```

Either way, two files appear next to you: `visualice.config.json` for settings, and
`visualice.routes.md`, a list of the pages and states found. Edit the list to steer the
next run: add a page it missed, or mark one to skip. Everything else goes in a gitignored
`.visualice/` folder.

## Next

- [Crawling](../../docs/crawling.md): commands, the routes file, discovery, CI
- [Configuration](../../docs/configuration.md): scope, devices, browsers, accessibility
- [The viewer](../../docs/viewer.md): navigation, view modes, full screen, sharing

Only crawl sites you own or are allowed to test.
