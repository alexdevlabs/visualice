import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { ViewerData } from "./types";
import { computeLayout, routePath, type ViewMode } from "./layout";
import { Canvas, type CanvasHandle } from "./Canvas";
import { DL, Inspector } from "./Inspector";
import { ShotActions } from "./ShotActions";
import { FullScreen } from "./FullScreen";
import { VirtualList } from "./VirtualList";
import { Dropdown } from "./Dropdown";
import { fetchSites, runBase, type SiteList } from "./sites";
import { fetchViewerData, resolveDataUrl } from "./load";
import { readUrlState, writeUrlState, type UrlState } from "./url-state";
import { runLabel } from "./format";
import { Loader, Logo } from "./brand";
import { applyTheme, readTheme, type Theme } from "./theme";
import {
  Caption,
  Count,
  cx,
  deviceIcon,
  DeviceToggle,
  DIVIDER,
  EMPTY,
  Icon,
  IconButton,
  Kbd,
  LINK,
  Pill,
  ROW_MAIN,
  Segmented,
  RouteBadge,
  row,
  SIDE_EMPTY,
  SIDE_HEAD,
  SIDE_LIST,
  SIDEBAR,
} from "./ui";

/** Past this many tiles the canvas is capped, with a control to lift it. */
const DEFAULT_LIMIT = 2500;
/** The shortest time the boot loader shows: one full pass of its crawl over the pages (2 s in the SVG). */
const MIN_LOADER_MS = 2000;

/** Must match the route rows' `h-14` below — the virtual list pins rows to it. */
const SIDEBAR_ROW_H = 56;

/** Below this width the viewer switches to the phone layout: no sidebar, filters in a sheet. */
const PHONE_QUERY = "(max-width: 760px)";

function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const update = () => setOn(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return on;
}

/** Animations still run to their end under reduced motion (so animationend fires), just instantly. */
const REDUCED = "motion-reduce:[animation-delay:0ms] motion-reduce:[animation-duration:1ms]";

const TOOLBAR_GROUP = "flex items-center gap-1.5";
const ZOOM_BUTTON =
  "flex size-[30px] items-center justify-center rounded-[7px] border-0 bg-transparent text-fg hover:bg-raised";
const SHEET_GROUP = "flex flex-col gap-2";
const WRAP = "flex flex-wrap gap-1.5";

const MINIMAP_KEY = "visualice:minimap";

/** The minimap starts hidden unless this browser turned it on before. */
function readMinimap(): boolean {
  try {
    return localStorage.getItem(MINIMAP_KEY) === "on";
  } catch {
    return false;
  }
}

/** Keystrokes aimed at a text field are the user typing, not a shortcut. */
function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** `onHome` returns to the dashboard; absent when there is only the one site. */
export default function App({ onHome }: { onHome?: () => void } = {}) {
  const initial = useMemo(() => readUrlState(location.search), []);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [data, setData] = useState<ViewerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState(initial.q ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(initial.tile ?? null);
  const [scale, setScale] = useState(1);
  const [deviceFilter, setDeviceFilter] = useState<Set<string>>(new Set(initial.devices ?? []));
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set(initial.kinds ?? []));
  const [sites, setSites] = useState<SiteList | null>(null);
  // Both null: the run the server was started on. A run alone is one of that site's.
  const [site, setSite] = useState<string | null>(initial.site ?? null);
  const [run, setRun] = useState<string | null>(initial.run ?? null);
  const [failedOnly, setFailedOnly] = useState(false);
  const [limit, setLimit] = useState<number | undefined>(DEFAULT_LIMIT);
  const [routeId, setRouteId] = useState<string | null>(initial.route ?? null);
  const [mode, setMode] = useState<ViewMode>(initial.mode ?? "screen");
  const [full, setFull] = useState(!!initial.full);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [minimapOn, setMinimapOn] = useState(readMinimap);
  const canvas = useRef<CanvasHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const isPhone = useMediaQuery(PHONE_QUERY);

  // Where this run's files live: the server mounts the current run at ./data/, every
  // run at ./sites/<site>/runs/<id>/, and the current site's at ./runs/<id>/ too.
  const base = site && run ? runBase(site, run) : run ? `./runs/${run}/` : "./data/";
  const dataUrl = useMemo(() => resolveDataUrl(location.search, base + "viewer-data.json"), [base]);

  useEffect(() => applyTheme(theme), [theme]);

  // The loader holds for at least MIN_LOADER_MS so a fast local load doesn't
  // flash it, then fades out over the page (`loaderGone` once that's finished).
  const [loaderMinDone, setLoaderMinDone] = useState(false);
  const [loaderGone, setLoaderGone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLoaderMinDone(true), MIN_LOADER_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (dataUrl.note) setNotice(dataUrl.note);
  }, [dataUrl.note]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchViewerData(dataUrl.url)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // Only seed the filters when the URL didn't already specify them.
        setDeviceFilter((prev) => (prev.size ? prev : new Set(d.devices.map((dev) => dev.name))));
      })
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [dataUrl.url]);

  // The site list is optional: a viewer served from a bare directory just won't have one.
  useEffect(() => {
    void fetchSites().then((list) => list && setSites(list));
  }, []);

  /**
   * Show `nextRun` of `nextSite`, named in the URL so a reload or a shared link opens
   * the same run. Another site's routes, shots and devices aren't this one's, so
   * moving between sites starts from a clean view.
   */
  const openRun = useCallback(
    (nextSite: string, nextRun: string) => {
      const leaving = nextSite !== (site ?? sites?.current.site);
      setSite(nextSite);
      setRun(nextRun);
      setSelectedId(null);
      if (leaving) {
        setRouteId(null);
        setDeviceFilter(new Set());
        setKindFilter(new Set());
      }
    },
    [sites, site],
  );

  // Deferred: typing in the search box must not recompute the full layout per keystroke.
  const deferredQuery = useDeferredValue(query);
  const layout = useMemo(
    () =>
      data
        ? computeLayout(data, {
            devices: deviceFilter,
            kinds: kindFilter,
            query: deferredQuery,
            failedOnly,
            limit,
            routeId: routeId ?? undefined,
            mode,
          })
        : null,
    [data, deviceFilter, kindFilter, deferredQuery, failedOnly, limit, routeId, mode],
  );

  const selected = useMemo(
    () => data?.tiles.find((t) => t.id === selectedId) ?? null,
    [data, selectedId],
  );
  // The panel keeps showing the last shot while it slides out after a close.
  const [detailed, setDetailed] = useState(selected);
  if (selected && selected !== detailed) setDetailed(selected);
  // Two routes can lay out to the same size, which the canvas alone takes for the
  // same layout; a route change always starts from the whole of the new one.
  const firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) firstRoute.current = false;
    else canvas.current?.fit();
  }, [routeId]);

  // A link to a shot opens on that shot's route, not on one it isn't part of.
  useEffect(() => {
    if (selected && routeId && selected.routeId !== routeId) setRouteId(selected.routeId);
  }, [selected, routeId]);

  // Keep the URL in step with the view, so a link reproduces what's on screen.
  useEffect(() => {
    if (!data) return;
    const state: UrlState = {
      q: query || undefined,
      tile: selectedId ?? undefined,
      site: site ?? undefined,
      run: run ?? undefined,
      route: routeId ?? undefined,
      devices:
        deviceFilter.size && deviceFilter.size !== data.devices.length
          ? [...deviceFilter]
          : undefined,
      kinds: kindFilter.size ? [...kindFilter] : undefined,
      mode: mode === "screen" ? undefined : mode,
      full: full || undefined,
    };
    writeUrlState(state);
  }, [data, query, selectedId, site, run, routeId, deviceFilter, kindFilter, mode, full]);

  // Full screen is about the selected shot; without one there's nothing to show.
  const isFull = full && !!selected;
  const openFull = useCallback(() => setFull(true), []);
  const exitFull = useCallback(() => setFull(false), []);

  const onScaleChange = useCallback((s: number) => setScale(s), []);

  const toggleMinimap = useCallback(() => {
    setMinimapOn((on) => {
      try {
        localStorage.setItem(MINIMAP_KEY, on ? "off" : "on");
      } catch {
        // Blocked storage just doesn't remember it.
      }
      return !on;
    });
  }, []);

  const stepShot = useCallback(
    (dir: -1 | 1) => {
      if (!layout?.placed.length) return;
      const i = layout.placed.findIndex((p) => p.tile.id === selectedId);
      const next = layout.placed[(i + dir + layout.placed.length) % layout.placed.length];
      setSelectedId(next.tile.id);
      canvas.current?.focusRect({
        minX: next.x,
        minY: next.y,
        maxX: next.x + next.w,
        maxY: next.y + next.h,
      });
    },
    [layout, selectedId],
  );

  // The selected state on each device it was captured on, in device order.
  const sameState = useMemo(
    () =>
      selected
        ? (data?.devices ?? []).flatMap(
            (d) =>
              data?.tiles.find(
                (t) =>
                  t.device === d.name &&
                  t.routeId === selected.routeId &&
                  t.stateId === selected.stateId,
              ) ?? [],
          )
        : [],
    [data, selected],
  );
  // Full screen shows that state on every device Devices has on — or, when none
  // of those captured it, on the selected shot's own device.
  const fullShown = useMemo(() => {
    const on = sameState.filter((t) => deviceFilter.has(t.device));
    return on.length ? on : selected ? [selected] : [];
  }, [sameState, deviceFilter, selected]);
  // Turning the selected shot's device off moves the selection to one still shown.
  useEffect(() => {
    if (isFull && selected && !fullShown.includes(selected)) setSelectedId(fullShown[0].id);
  }, [isFull, selected, fullShown]);
  // D in full screen: the next shown device, or with only one shown, the state
  // on the next device that captured it, in its place.
  const cycleDevice = useCallback(
    (dir: -1 | 1) => {
      if (!selected) return;
      const pool = fullShown.length > 1 ? fullShown : sameState;
      const next = pool[(pool.indexOf(selected) + dir + pool.length) % pool.length];
      if (!next || next === selected) return;
      if (fullShown.length <= 1) setDeviceFilter(new Set([next.device]));
      setSelectedId(next.id);
    },
    [selected, fullShown, sameState],
  );

  // Full screen steps through the shots of the device on screen, in canvas order.
  const devicePlaced = useMemo(
    () =>
      layout && selected ? layout.placed.filter((p) => p.tile.device === selected.device) : [],
    [layout, selected],
  );
  const devicePosition = useMemo(() => {
    const i = devicePlaced.findIndex((p) => p.tile.id === selectedId);
    return i >= 0 ? { index: i + 1, total: devicePlaced.length } : undefined;
  }, [devicePlaced, selectedId]);
  const stepDevice = useCallback(
    (dir: -1 | 1) => {
      if (!devicePlaced.length) return;
      const i = devicePlaced.findIndex((p) => p.tile.id === selectedId);
      setSelectedId(devicePlaced[(i + dir + devicePlaced.length) % devicePlaced.length].tile.id);
    },
    [devicePlaced, selectedId],
  );

  const hasSelection = !!selected;
  // Shortcuts that work anywhere on the page. The canvas handles its own keys
  // (pan, zoom, shift+arrows) while it has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }
      if (e.key === "Escape") {
        setSheetOpen(false);
        setShortcutsOpen(false);
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") setShortcutsOpen((v) => !v);
      else if (e.key === "m") toggleMinimap();
      else if (e.key === "f" && hasSelection) setFull(true);
      else if (e.key === "/") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMinimap, hasSelection]);

  if (error) {
    return (
      <div className={EMPTY}>
        <Logo large />
        <p className="text-fg">
          Couldn't load <code>{dataUrl.url}</code> — {error}
        </p>
        <p className="text-dim">
          Run <code>visualice serve</code> to host a run, or pass <code>?data=&lt;path&gt;</code>.
        </p>
      </div>
    );
  }
  if (!data || !layout || !loaderMinDone)
    return (
      <div className={cx(EMPTY, "animate-loader-in", REDUCED)}>
        <Loader />
      </div>
    );

  const toggle = <T,>(set: Set<T>, v: T, keepOne: boolean): Set<T> => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    if (keepOne && next.size === 0) return set; // never filter everything away
    return next;
  };

  // Counts for the filter pills and the sidebar, under the device filter only —
  // a count that shrank as you clicked its own pill would be no guide at all.
  const onDevices = data.tiles.filter((t) => deviceFilter.has(t.device));
  const kindCounts = new Map<string, number>();
  const routeCounts = new Map<string, number>();
  for (const t of onDevices) {
    kindCounts.set(t.stateKind, (kindCounts.get(t.stateKind) ?? 0) + 1);
    if (!kindFilter.size || kindFilter.has(t.stateKind))
      routeCounts.set(t.routeId, (routeCounts.get(t.routeId) ?? 0) + 1);
  }
  // The page as it loads leads; the rest follow alphabetically.
  const kinds = [...kindCounts.keys()].sort((a, b) =>
    a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b),
  );
  const withTiles = new Set(layout.routesWithTiles);
  const groupsWithTiles = data.groups.filter((g) => withTiles.has(g.routeId));
  const failedCount = data.tiles.filter((t) => t.error).length;
  const shown = layout.placed.length + layout.truncated;
  const activeRouteId = routeId;
  /** Put one route on the canvas, or all of them with `null`. The canvas refits itself. */
  const focusRoute = (id: string | null) => {
    setRouteId(id);
    if (selected && id && selected.routeId !== id) setSelectedId(null);
    if (isPhone) setSheetOpen(false);
  };

  const detailedIndex = detailed ? layout.placed.findIndex((p) => p.tile.id === detailed.id) : -1;

  // ---- pieces shared by the desktop toolbar and the phone sheet

  /** Toggles for every device: which ones the canvas shows, full screen too. */
  const deviceToggles = (card: boolean) =>
    data.devices.map((d) => (
      <DeviceToggle
        key={d.name}
        card={card}
        name={d.name}
        width={d.width}
        icon={deviceIcon(d)}
        on={deviceFilter.has(d.name)}
        onToggle={() => setDeviceFilter((prev) => toggle(prev, d.name, true))}
      />
    ));

  const modeSwitch = (fill?: boolean) => (
    <Segmented<ViewMode>
      label="Mode"
      small={!fill}
      fill={fill}
      value={mode}
      onChange={setMode}
      items={[
        { value: "screen", label: "Screen", title: "Each screen as it was captured" },
        {
          value: "continuous",
          label: "Continuous",
          title: "The screens joined into one page, pinned bars shown once",
        },
        {
          value: "scroll",
          label: "Scroll",
          title: "One screen at a time — select a shot, then scroll it",
        },
      ]}
    />
  );

  const statePills = (big?: boolean) => (
    <>
      <Pill
        big={big}
        on={kindFilter.size === 0}
        count={onDevices.length}
        onClick={() => setKindFilter(new Set())}
      >
        All
      </Pill>
      {kinds.map((k) => (
        <Pill
          key={k}
          big={big}
          on={kindFilter.has(k)}
          count={kindCounts.get(k)}
          title={`Show ${k} states`}
          onClick={() => setKindFilter((prev) => toggle(prev, k, false))}
        >
          {k}
        </Pill>
      ))}
    </>
  );

  // A native select laid invisibly over a styled face: keyboard and screen readers
  // get the real control. On a phone it's just a line of text under the domain.
  const picker = isPhone
    ? "flex items-center gap-1 text-[11.5px] whitespace-nowrap text-dim"
    : "flex h-8 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 text-[12.5px] whitespace-nowrap text-fg hover:border-line-strong aria-expanded:border-accent";
  const domain = data.site.origin.replace(/^https?:\/\//, "");
  const shownSite = site ?? sites?.current.site;
  const shownRun = run ?? (site ? null : sites?.current.run) ?? data.site.runId;
  const siteEntry = sites?.sites.find((x) => x.key === shownSite);
  const siteFace = <span className="truncate font-mono text-[11px]">{domain}</span>;
  const sitePicker =
    sites && sites.sites.length > 1 ? (
      <Dropdown
        label="Site"
        value={shownSite}
        className="flex min-w-0 items-center gap-1 border-0 bg-transparent p-0 text-dim hover:text-fg aria-expanded:text-fg"
        options={sites.sites.map((x) => ({
          value: x.key,
          label: <span className="font-mono text-[12px]">{x.key}</span>,
          hint: x.runs.length === 1 ? "1 version" : `${x.runs.length} versions`,
        }))}
        onChange={(key) => {
          const next = sites.sites.find((x) => x.key === key);
          const latest = next?.latest ?? next?.runs[0];
          if (next && latest) openRun(next.key, latest);
        }}
      >
        {siteFace}
      </Dropdown>
    ) : (
      <span className="flex min-w-0 text-dim" title={shownSite}>
        {siteFace}
      </span>
    );
  const runFace = (
    <>
      <Icon name="clock" size={14} className="text-dim" />
      <span>{runLabel(shownRun)}</span>
      {(!siteEntry || shownRun === siteEntry.latest) && (
        <span className="rounded-full bg-accent-soft px-[7px] py-px text-[10.5px] font-semibold text-accent">
          latest
        </span>
      )}
    </>
  );
  const runPicker =
    siteEntry && shownSite && siteEntry.runs.length > 1 ? (
      <Dropdown
        label="Version"
        value={shownRun}
        className={picker}
        options={siteEntry.runs.map((id) => ({
          value: id,
          label: runLabel(id),
          badge: id === siteEntry.latest ? "latest" : undefined,
        }))}
        onChange={(id) => openRun(shownSite, id)}
      >
        {runFace}
      </Dropdown>
    ) : (
      <span className={picker} title={shownRun}>
        {runFace}
      </span>
    );

  const search = (
    <label
      className={cx(
        "flex items-center gap-2 rounded-lg border border-line bg-panel pr-2 pl-2.5 text-dim focus-within:border-accent",
        isPhone ? "h-10 w-full" : "h-8 w-70",
      )}
    >
      <Icon name="search" size={15} />
      <input
        className="min-w-0 flex-auto border-0 bg-transparent px-0.5 py-px text-[12.5px] text-fg outline-none placeholder:text-dim"
        ref={searchRef}
        type="search"
        aria-label="Search routes and states"
        placeholder="Search routes and states"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && (e.currentTarget.blur(), setSearchOpen(false))}
      />
      {!isPhone && <Kbd>⌘K</Kbd>}
    </label>
  );

  // ---- header

  const themeToggle = (
    <IconButton
      icon={theme === "dark" ? "sun" : "moon"}
      label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      size={isPhone ? 44 : undefined}
      onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
    />
  );

  const HEADER = "flex h-[52px] shrink-0 items-center border-b border-line bg-panel";
  // The logo leads back to every site, when there is more than this one.
  const goHome = (e: MouseEvent) => {
    if (!onHome || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onHome();
  };
  const homeLink = (logo: ReactNode) =>
    onHome ? (
      <a
        href="./"
        className="flex items-center rounded-md"
        aria-label="All sites"
        title="All sites"
        onClick={goHome}
      >
        {logo}
      </a>
    ) : (
      logo
    );
  // The way back spelled out: a breadcrumb ahead of the site picker.
  const sitesCrumb = onHome && (
    <>
      <a
        href="./"
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-dim no-underline hover:bg-hover hover:text-fg"
        onClick={goHome}
      >
        <Icon name="grid" size={15} />
        Sites
      </a>
      <span className="-mx-2 shrink-0 text-dim" aria-hidden="true">
        ›
      </span>
    </>
  );
  const header = isPhone ? (
    <header className={cx(HEADER, "gap-2.5 px-3")}>
      {onHome ? (
        <a
          href="./"
          className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-dim hover:bg-hover hover:text-fg"
          aria-label="All sites"
          title="All sites"
          onClick={goHome}
        >
          <Icon name="left" />
        </a>
      ) : (
        <span className="flex shrink-0 items-center">
          <Logo markOnly />
        </span>
      )}
      <div className="flex min-w-0 flex-auto flex-col leading-[1.2]">
        {sitePicker}
        {runPicker}
      </div>
      <IconButton
        icon="search"
        label="Search"
        size={44}
        pressed={searchOpen}
        onClick={() => setSearchOpen((v) => !v)}
      />
      <IconButton
        icon="sliders"
        label="View and filters"
        size={44}
        onClick={() => setSheetOpen(true)}
      />
      {themeToggle}
    </header>
  ) : (
    <header className={cx(HEADER, "gap-3.5 pr-3.5 pl-4")}>
      <div className="flex shrink-0 items-center">{homeLink(<Logo />)}</div>
      <span className={DIVIDER} />
      {sitesCrumb}
      <div className="flex min-w-0 flex-col leading-[1.2]">{sitePicker}</div>
      {runPicker}
      <span className="flex-auto" />
      {search}
      <IconButton
        icon="kbd"
        label="Keyboard shortcuts (?)"
        pressed={shortcutsOpen}
        onClick={() => setShortcutsOpen((v) => !v)}
      />
      {themeToggle}
    </header>
  );

  const TOOLBAR =
    "flex min-h-12 shrink-0 flex-wrap items-center gap-x-[18px] gap-y-2 border-b border-line bg-app px-4 py-2";
  /** Mode and Devices, the toolbar's start, the same on the canvas and full screen. */
  const viewControls = () => (
    <>
      <div className={TOOLBAR_GROUP}>
        <Caption className="mr-0.5">Mode</Caption>
        {modeSwitch()}
      </div>
      <span className={DIVIDER} />
      <div className={TOOLBAR_GROUP} role="group" aria-label="Devices">
        <Caption className="mr-0.5">Devices</Caption>
        {deviceToggles(false)}
      </div>
    </>
  );
  const toolbar = isPhone ? null : (
    <div className={TOOLBAR}>
      {viewControls()}
      {kinds.length > 1 && (
        <>
          <span className={DIVIDER} />
          <div className={cx(TOOLBAR_GROUP, "flex-wrap")} role="group" aria-label="States">
            <Caption className="mr-0.5">States</Caption>
            {statePills()}
          </div>
        </>
      )}
      <span className="flex-auto" />
      <span className="text-[12px] whitespace-nowrap text-dim">
        {shown} shots · {groupsWithTiles.length} routes
      </span>
    </div>
  );

  // ---- body

  const sidebar = (
    <nav className={cx(SIDEBAR, "w-66 shrink-0 border-r border-line")} aria-label="Routes">
      <div className={SIDE_HEAD}>
        <Caption>Routes</Caption>
        <Count>{groupsWithTiles.length}</Count>
      </div>
      {groupsWithTiles.length > 1 && (
        <div className="px-2 pb-1">
          <button
            type="button"
            className={cx(row(routeId === null), "h-10")}
            aria-current={routeId === null}
            onClick={() => focusRoute(null)}
          >
            <span className="flex-1 text-[13px] font-medium">All routes</span>
            <span
              className={cx(
                "rounded-md px-1.5 py-px font-mono text-[11px] text-dim",
                routeId === null ? "bg-panel" : "bg-canvas",
              )}
            >
              {[...routeCounts.values()].reduce((a, b) => a + b, 0)}
            </span>
          </button>
        </div>
      )}
      {groupsWithTiles.length === 0 ? (
        <p className={SIDE_EMPTY}>No route has shots matching these filters.</p>
      ) : (
        <VirtualList
          className={SIDE_LIST}
          items={groupsWithTiles}
          rowHeight={SIDEBAR_ROW_H}
          children={(g) => {
            const on = g.routeId === activeRouteId;
            return (
              <li key={g.routeId}>
                <button
                  type="button"
                  className={cx(row(on), "h-14")}
                  aria-current={on}
                  onClick={() => focusRoute(g.routeId)}
                >
                  <span className={ROW_MAIN}>
                    <RouteBadge path={routePath(g.path)} active={on} />
                    <span className="truncate text-[12px] text-dim">
                      {g.title || routePath(g.path)}
                    </span>
                  </span>
                  <span
                    className={cx(
                      "rounded-md px-1.5 py-px font-mono text-[11px] text-dim",
                      on ? "bg-panel" : "bg-canvas",
                    )}
                  >
                    {routeCounts.get(g.routeId) ?? 0}
                  </span>
                </button>
              </li>
            );
          }}
        />
      )}
      <div className="flex items-center border-t border-line px-3 py-2.5 text-[12px]">
        {failedCount > 0 ? (
          <button
            type="button"
            className={cx(
              "flex flex-auto items-center gap-2 rounded-[7px] border border-amber-line px-2 py-1.5",
              failedOnly ? "bg-amber font-semibold text-on-amber" : "bg-amber-soft text-amber",
            )}
            aria-pressed={failedOnly}
            onClick={() => setFailedOnly((v) => !v)}
          >
            <Icon name="alert" size={14} />
            <span>
              {failedCount} failed {failedCount === 1 ? "capture" : "captures"}
            </span>
            <span className="flex-auto" />
            <span className="text-[12px]">{failedOnly ? "Show all" : "Show only"}</span>
          </button>
        ) : (
          <span className="flex items-center gap-2 px-1 py-0.5 text-ok">
            <Icon name="check" size={14} />
            <span className="text-dim">All {data.tiles.length} shots captured</span>
          </span>
        )}
      </div>
    </nav>
  );

  const TOAST =
    "flex items-center gap-3 rounded-[10px] border bg-overlay py-[7px] pr-2 pl-3 text-[12.5px]";
  const canvasOverlays = (
    <>
      <div
        className={cx(
          "absolute z-5 flex items-center gap-0.5 rounded-[10px] border border-line bg-overlay p-[3px]",
          isPhone ? "right-3 bottom-3" : minimapOn ? "right-[222px] bottom-4" : "right-4 bottom-4",
        )}
        role="group"
        aria-label="Zoom"
      >
        <button
          type="button"
          className={ZOOM_BUTTON}
          aria-label="Zoom out"
          title="Zoom out (−)"
          onClick={() => canvas.current?.zoomBy(0.8)}
        >
          <Icon name="minus" size={15} />
        </button>
        <span className="w-11 text-center font-mono text-[12px] tabular-nums">
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          className={ZOOM_BUTTON}
          aria-label="Zoom in"
          title="Zoom in (+)"
          onClick={() => canvas.current?.zoomBy(1.25)}
        >
          <Icon name="plus" size={15} />
        </button>
        <span className="mx-0.5 h-[18px] w-px bg-line" />
        <button
          type="button"
          className={ZOOM_BUTTON}
          aria-label="Fit to screen"
          title="Fit to screen (0)"
          onClick={() => canvas.current?.fit()}
        >
          <Icon name="fit" size={15} />
        </button>
        {!isPhone && (
          <button
            type="button"
            className={cx(
              ZOOM_BUTTON,
              minimapOn && "bg-accent-soft text-accent-ink hover:bg-accent-soft",
            )}
            aria-label="Minimap"
            aria-pressed={minimapOn}
            title={minimapOn ? "Hide minimap (M)" : "Show minimap (M)"}
            onClick={toggleMinimap}
          >
            <Icon name="map" size={15} />
          </button>
        )}
      </div>
      {!isPhone && (
        <div className="pointer-events-none absolute bottom-4 left-4 flex items-center gap-1.5 rounded-[10px] border border-line bg-overlay px-2.5 py-1.5 text-[12px] whitespace-nowrap text-dim">
          <Kbd>⇧</Kbd>
          <Kbd>←</Kbd>
          <Kbd>→</Kbd>
          <span>step</span>
          <Kbd className="ml-1.5">?</Kbd>
          <span>shortcuts</span>
        </div>
      )}
      <div
        className={cx(
          "absolute z-6 flex max-w-[calc(100%-32px)] flex-col items-start gap-2",
          isPhone ? "top-3 left-3" : "top-4 left-4",
        )}
      >
        {layout.truncated > 0 && (
          <div className={cx(TOAST, "border-line text-dim")}>
            Showing {layout.placed.length} of {shown} shots
            <button type="button" className={LINK} onClick={() => setLimit(undefined)}>
              Show all
            </button>
          </div>
        )}
        {!layout.placed.length && (
          <div className={cx(TOAST, "border-line text-dim")}>
            No shots match these filters.
            <button
              type="button"
              className={LINK}
              onClick={() => {
                setQuery("");
                setKindFilter(new Set());
                setFailedOnly(false);
              }}
            >
              Clear filters
            </button>
          </div>
        )}
        {notice && (
          <div className={cx(TOAST, "border-amber-line text-amber")}>
            {notice}
            <IconButton ghost icon="x" label="Dismiss" size={24} onClick={() => setNotice(null)} />
          </div>
        )}
      </div>
    </>
  );

  // What's on the canvas, above it rather than on it: a title drawn on the canvas
  // pans and zooms away with the shots.
  const heading = layout.heading;
  const canvasHeader = (
    <div
      className={cx(
        "flex min-h-11 shrink-0 items-center gap-2.5 overflow-hidden border-b border-line bg-app whitespace-nowrap",
        isPhone ? "px-3" : "px-4",
      )}
    >
      {heading ? (
        <>
          {heading.path && (
            // The badge aligns itself to the top of a row; this keeps it centred.
            <span className="flex min-w-0 shrink">
              <RouteBadge path={heading.path} />
            </span>
          )}
          <span className="truncate text-[14px] font-semibold text-fg">{heading.title}</span>
          <span className="text-[12.5px] text-dim">{heading.subtitle}</span>
        </>
      ) : (
        <>
          <span className="text-[14px] font-semibold text-fg">All routes</span>
          <span className="text-[12.5px] text-dim">
            {groupsWithTiles.length} route{groupsWithTiles.length === 1 ? "" : "s"}
          </span>
        </>
      )}
    </div>
  );

  const body = (
    <div className="flex min-h-0 flex-auto overflow-hidden">
      {!isPhone && sidebar}
      <main className="flex min-w-0 flex-auto flex-col">
        {canvasHeader}
        <div className="relative min-h-0 flex-auto">
          <Canvas
            ref={canvas}
            layout={layout}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onScaleChange={onScaleChange}
            base={base}
            showMinimap={!isPhone && minimapOn}
            mode={mode}
            selectionBar={
              !isPhone &&
              selected && (
                <ShotActions
                  data={data}
                  tile={selected}
                  base={base}
                  variant="bar"
                  onFullScreen={openFull}
                />
              )
            }
          />
          {canvasOverlays}
        </div>
      </main>
      {detailed && (
        <Inspector
          data={data}
          tile={detailed}
          base={base}
          onSelect={setSelectedId}
          onStep={stepShot}
          phone={isPhone}
          closing={!selected}
          onClosed={() => setDetailed(null)}
          onFullScreen={openFull}
          compare={
            siteEntry && shownSite && shownRun && siteEntry.runs.length > 1
              ? {
                  runs: siteEntry.runs.filter((r) => r !== shownRun),
                  baseFor: (r) => runBase(shownSite, r),
                  current: shownRun,
                }
              : undefined
          }
          position={
            detailedIndex >= 0
              ? { index: detailedIndex + 1, total: layout.placed.length }
              : undefined
          }
        />
      )}
    </div>
  );

  // ---- phone filter sheet

  const sheet = isPhone && sheetOpen && (
    <>
      <div className="fixed inset-0 z-20 bg-scrim" onClick={() => setSheetOpen(false)} />
      <div
        className="fixed inset-x-0 bottom-0 z-21 flex max-h-[85%] flex-col rounded-t-2xl border-t border-line-strong bg-panel shadow-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="View and filters"
      >
        <div className="mx-auto mt-2 mb-0.5 h-1 w-9 rounded-[2px] bg-line-strong" />
        <div className="flex items-center px-4 pt-1.5 pb-2.5">
          <h2 className="flex-auto text-[16px] font-semibold">View &amp; filters</h2>
          <button
            type="button"
            className="h-11 border-0 bg-transparent px-1 text-[13px] text-accent hover:text-accent-hover"
            onClick={() => {
              setDeviceFilter(new Set(data.devices.map((d) => d.name)));
              setKindFilter(new Set());
              setFailedOnly(false);
            }}
          >
            Reset
          </button>
        </div>
        <div className="flex flex-col gap-[18px] overflow-y-auto px-4">
          <div className={SHEET_GROUP}>
            <Caption>Mode</Caption>
            {modeSwitch(true)}
          </div>
          {kinds.length > 1 && (
            <div className={SHEET_GROUP} role="group" aria-label="States">
              <Caption>States</Caption>
              <div className={WRAP}>{statePills(true)}</div>
            </div>
          )}
          <div className={SHEET_GROUP} role="group" aria-label="Devices">
            <Caption>Devices</Caption>
            <div className="grid grid-cols-2 gap-2">{deviceToggles(true)}</div>
          </div>
          {groupsWithTiles.length > 0 && (
            <div className={SHEET_GROUP}>
              <Caption>Route</Caption>
              <div className={WRAP}>
                <button
                  type="button"
                  className={cx(
                    "flex min-h-[34px] items-center rounded-md border px-2 text-[13px]",
                    routeId === null
                      ? "border-accent-line bg-accent-soft text-accent-ink"
                      : "border-line-strong bg-panel",
                  )}
                  onClick={() => focusRoute(null)}
                >
                  All routes
                </button>
                {groupsWithTiles.map((g) => (
                  <button
                    key={g.routeId}
                    type="button"
                    className="flex min-h-[34px] max-w-full items-center border-0 bg-transparent px-0 py-1"
                    onClick={() => focusRoute(g.routeId)}
                  >
                    <RouteBadge path={routePath(g.path)} active={g.routeId === activeRouteId} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="px-4 pt-3 pb-5">
          <button
            type="button"
            className="h-[46px] w-full rounded-[10px] border-0 bg-accent text-[14px] font-semibold text-on-accent"
            onClick={() => setSheetOpen(false)}
          >
            Show {shown} shots
          </button>
        </div>
      </div>
    </>
  );

  const shortcuts = shortcutsOpen && (
    <div
      className="fixed top-[60px] right-3.5 z-30 w-[340px] rounded-xl border border-line-strong bg-panel px-3.5 pt-3 pb-4 shadow-pop"
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      <div className="mb-2.5 flex items-center justify-between">
        <Caption>Keyboard shortcuts</Caption>
        <IconButton
          ghost
          icon="x"
          label="Close"
          size={24}
          onClick={() => setShortcutsOpen(false)}
        />
      </div>
      <dl
        className={cx(DL, "grid-cols-[auto_minmax(0,1fr)] items-center [&>dt]:whitespace-nowrap")}
      >
        <dt>
          <Kbd>⌘K</Kbd> <Kbd>/</Kbd>
        </dt>
        <dd>Search routes and states</dd>
        <dt>
          <Kbd>scroll</Kbd>
        </dt>
        <dd>Pan the canvas</dd>
        <dt>
          <Kbd>⌘</Kbd> + <Kbd>scroll</Kbd>
        </dt>
        <dd>Zoom</dd>
        <dt>
          <Kbd>+</Kbd> <Kbd>−</Kbd> <Kbd>0</Kbd>
        </dt>
        <dd>Zoom in, out, fit</dd>
        <dt>
          <Kbd>M</Kbd>
        </dt>
        <dd>Show / hide the minimap</dd>
        <dt>
          <Kbd>⇧</Kbd> + <Kbd>arrows</Kbd>
        </dt>
        <dd>Step between shots</dd>
        <dt>
          <Kbd>F</Kbd>
        </dt>
        <dd>Selected shot full screen</dd>
        <dt>
          <Kbd>Esc</Kbd>
        </dt>
        <dd>Clear the selection</dd>
      </dl>
    </div>
  );

  return (
    <>
      {/* The loader stays on top while it fades out, crossfading into the page. */}
      {!loaderGone && (
        <div
          className={cx(
            EMPTY,
            "pointer-events-none fixed inset-0 z-100 bg-app animate-loader-out",
            REDUCED,
          )}
          aria-hidden="true"
          onAnimationEnd={() => setLoaderGone(true)}
        >
          <Loader />
        </div>
      )}
      <div className={cx("flex h-full flex-col", !loaderGone && cx("animate-app-in", REDUCED))}>
        {header}
        {isPhone && searchOpen && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2.5">
            {search}
          </div>
        )}
        {toolbar}
        {/* Full screen keeps the header and toolbar; only the body changes. */}
        {isFull && selected ? (
          <FullScreen
            data={data}
            tile={selected}
            shown={fullShown}
            base={base}
            mode={mode}
            onSelect={setSelectedId}
            onCycleDevice={cycleDevice}
            onStep={stepDevice}
            onExit={exitFull}
            position={devicePosition}
          />
        ) : (
          body
        )}
        {sheet}
        {shortcuts}
      </div>
    </>
  );
}
