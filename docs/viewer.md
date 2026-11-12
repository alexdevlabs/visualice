# The viewer

```bash
visualice serve --open          # several sites: a dashboard of them; one: its latest run
visualice serve --site=<name>   # another site in the same output directory
visualice serve --run=<id>      # view a specific run of that site
visualice serve --screenshot=out.png # headless: screenshot the viewer to a file
```

The viewer is a standalone static app (`viewer/`); it reads `viewer-data.json` + the
screenshots and needs no connection to the crawled site. Scroll to pan, ⌘/ctrl+scroll
(or pinch) to zoom, click any shot to focus it and open its details, shift+arrow to step
to the next one. Shots are grouped by route: one section per path, a row per state, a
column per device.

A selected shot has a floating bar under it with the same actions as its details panel:
**Full screen**, **Live page**, **Copy link**, **Download** and **Full image**. The bar can
be dragged aside and remembers where you put it. Full screen keeps the header and toolbar,
frames the canvas in the accent colour and shows that state on every checked device, each
with a caption naming the device and its width. Tall shots fill the width and are read from
the top. In full screen ← → step through the shots,
`D` (`⇧D` backwards) switches device, and `Esc` or `F` exits.

The mode switch in the toolbar picks how each shot is drawn. The images are never edited;
every mode is a different way of cropping the same file.

- **Screen** (default): the screens the page was captured in, one card each, exactly as
  the browser showed them — a sticky header or cookie bar appears on every screen.
- **Continuous**: the screens joined into one page. The capture records which rows of each
  screen bars pinned to the window covered, so the header is shown once at the top and a
  bottom bar once at the bottom.
- **Scroll**: one screen of that page per tile. Click a shot, then scroll it with the
  wheel or drag its scrollbar; the pinned bars stay put while the page moves under them.
  Esc, or a click elsewhere, gives the wheel back to the canvas.

Continuous and Scroll need runs captured with this version; an older run's screens are
laid end to end instead, repeated bars included.
Thumbnails load when zoomed out and step up through a
mid-resolution image to full resolution as you zoom in. The minimap is hidden until you
turn it on (the button in the zoom controls, or `M`); it shows where you are in the layout
and jumps there on click. The path list virtualizes past a few dozen routes so a large run
doesn't build a sidebar it never shows.

The canvas shows at most 200 shots at a time, because more than that makes panning and
zooming lag. A bigger selection is split into pages: the arrows above the canvas, or `[`
and `]`, turn them, and the page is kept in the link. A page ends between two states, so
a state's devices stay side by side, and a route cut by a page break carries on at the top
of the next. Search, the filters and the sidebar count every page. Selecting a shot on
another page (a link, the details panel's arrows) turns to it.

`⌘K` or `/` focuses search, `+` `−` `0` zoom in, out and fit, `M` toggles the minimap, `F`
opens the selected shot in full screen, `Esc` clears the selection, and `?` lists the
shortcuts. The header's sun/moon button switches between the light (default) and dark
theme; that choice and the minimap's are remembered in the browser. Below 760px the
viewer switches to a phone layout with the filters in a bottom sheet.

Filter by device or by state kind, search by path, and switch site and version from the
**Site** and **Version** dropdowns in the header — `serve` exposes every site and run in
the output directory, so switching needs no restart. Failed captures are tiles too: a
placeholder carrying its error, plus an **N failed captures · Show only** button at the
foot of the sidebar, so a broken shot is visible rather than missing. The view lives in the
URL (site, run, mode, route, query, devices, kinds, page, selected tile, full screen), so
copying the address bar
shares the exact shot you're looking at. `?data=` accepts same-origin paths only, and a
`viewer-data.json` the viewer can't read gets an error naming the offending field instead
of a blank canvas.

`serve` listens on every network interface, so a phone on the same network can browse the
runs. Writes are local only: deleting a site (below) is refused from any other machine
(403) and from pages on other origins. The server answers only to a name that is this
machine's (`localhost`, an IP address, the computer's own name), so a web page elsewhere
can't read the runs by pointing its own domain here; behind a reverse proxy, list its
host name in `VISUALICE_ALLOWED_HOSTS` (comma-separated).

## Sites and versions

In the viewer, the domain in the header picks the site
and the date beside it picks the version. With more than one site, the viewer opens on a
dashboard: a card per site with its latest run's home page and counts (the eye button
hides the previews, remembered like the theme), with search and sort, and the logo leads
back to it. A card's trash button deletes the site and all its runs from disk after a
confirmation; the site `serve` was started on can't be deleted (409) while that server
runs.

### Partial runs and comparing versions

A partial run (`crawl --only`, see [updating after code changes](../skills/visualice/references/update-mode.md))
shoots the pages that changed and carries the rest over. Its shots carry an **updated**
tag on the canvas; a carried shot's details panel says so, with the run and commit it
was really taken in. The details panel's footer shows the commit a shot came from.

**Compare with another version**, in the details panel, puts the same shot from another
run of the site beside this one (the previous version by default). A shot that was
carried over unchanged says so instead of looking like a coincidence.

## Share a run

```bash
visualice export report/     # the viewer + the latest run
```

writes a static folder that any file server can host (`npx serve report`) — a CI
artifact, a preview deploy, a zip for a reviewer.
