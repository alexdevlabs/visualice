import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ViewerData } from "./types";
import type { RunDiff, ShotStatus } from "./diff-types";
import { computeLayout, routePath, type LayoutMode } from "./layout";
import { interestingShots, matches } from "./diff-layout";
import { Canvas, type CanvasHandle } from "./Canvas";
import { ChangeList, Review, ReviewEmpty, STATUS_COLOR, type ReviewMode } from "./Compare";
import { DL, Inspector } from "./Inspector";
import { VirtualList } from "./VirtualList";
import { fetchDiffList, fetchRunDiff, fetchViewerData, resolveDataUrl, type DiffRef } from "./load";
import { readUrlState, writeUrlState, type UrlState } from "./url-state";
import { percent, runLabel } from "./format";
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
  RouteBadge,
  row,
  Segmented,
  SIDE_EMPTY,
  SIDE_HEAD,
  SIDE_LIST,
  SIDEBAR,
} from "./ui";

/** Past this many tiles the canvas is capped, with a control to lift it. */
const DEFAULT_LIMIT = 2500;
/** The shortest time the boot loader shows, so its walk reads as intentional rather than a flicker. */
const MIN_LOADER_MS = 2000;

/** Must match the route rows' `h-14` below — the virtual list pins rows to it. */
const SIDEBAR_ROW_H = 56;

/** Below this width the viewer switches to the phone layout: no sidebar, filters in a sheet. */
const PHONE_QUERY = "(max-width: 760px)";

/** A comparison opens on what needs looking at; unchanged pairs are opt-in. */
const DEFAULT_STATUSES: ShotStatus[] = ["changed", "added", "removed", "uncomparable"];

const LAYOUTS: {
  value: LayoutMode;
  label: string;
  icon: "grouped" | "grid" | "bydevice";
  title: string;
}[] = [
  { value: "grouped", label: "Grouped", icon: "grouped", title: "One section per route" },
  { value: "all", label: "Grid", icon: "grid", title: "Every shot in one grid" },
  {
    value: "devices",
    label: "By device",
    icon: "bydevice",
    title: "One route, every device at the same width",
  },
];

interface RunList {
  current: string;
  runs: string[];
}

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

export default function App() {
  const initial = useMemo(() => readUrlState(location.search), []);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [data, setData] = useState<ViewerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<LayoutMode>(initial.mode ?? "grouped");
  const [query, setQuery] = useState(initial.q ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(initial.tile ?? null);
  const [scale, setScale] = useState(1);
  const [deviceFilter, setDeviceFilter] = useState<Set<string>>(new Set(initial.devices ?? []));
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set(initial.kinds ?? []));
  const [runs, setRuns] = useState<RunList | null>(null);
  const [run, setRun] = useState<string | null>(initial.run ?? null);
  const [failedOnly, setFailedOnly] = useState(false);
  const [limit, setLimit] = useState<number | undefined>(DEFAULT_LIMIT);
  const [focusRouteId, setFocusRouteId] = useState<string | undefined>(initial.route);
  const [lastRouteId, setLastRouteId] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<DiffRef[]>([]);
  const [diffId, setDiffId] = useState<string | null>(initial.diff ?? null);
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [statuses, setStatuses] = useState<Set<ShotStatus>>(new Set(DEFAULT_STATUSES));
  const [reviewMode, setReviewMode] = useState<ReviewMode>("swipe");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [minimapOn, setMinimapOn] = useState(readMinimap);
  const canvas = useRef<CanvasHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const isPhone = useMediaQuery(PHONE_QUERY);

  // Where this run's files live: the server mounts the current run at ./data/ and
  // every other run at ./runs/<id>/.
  const base = run ? `./runs/${run}/` : "./data/";
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

  // The run list is optional: a viewer served from a bare directory just won't have one.
  useEffect(() => {
    fetch("./runs.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((list: RunList | null) => list?.runs?.length && setRuns(list))
      .catch(() => {});
  }, []);

  // Comparisons are optional in the same way — there simply may not be any yet.
  useEffect(() => {
    fetchDiffList()
      .then(setDiffs)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!diffId) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    fetchRunDiff(diffId)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => {
        if (cancelled) return;
        setNotice(`couldn't load that comparison — ${String(e.message ?? e)}`);
        setDiffId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [diffId]);

  // Deferred: typing in the search box must not recompute the full layout per keystroke.
  const deferredQuery = useDeferredValue(query);
  const layout = useMemo(
    () =>
      data
        ? computeLayout(data, {
            mode,
            devices: deviceFilter,
            kinds: kindFilter,
            query: deferredQuery,
            failedOnly,
            limit,
            focusRouteId,
          })
        : null,
    [data, mode, deviceFilter, kindFilter, deferredQuery, failedOnly, limit, focusRouteId],
  );

  const comparing = diffId !== null;
  const knownDevices = useMemo(() => new Set(data?.devices.map((d) => d.name)), [data]);
  const shots = useMemo(
    () =>
      diff
        ? interestingShots(diff, true).filter(
            (s) =>
              statuses.has(s.status) &&
              // A device this run doesn't know can't be toggled, so it isn't filtered.
              (!knownDevices.has(s.device) || deviceFilter.has(s.device)) &&
              matches(s, deferredQuery),
          )
        : [],
    [diff, statuses, knownDevices, deviceFilter, deferredQuery],
  );
  const shotIndex = comparing ? shots.findIndex((s) => s.key === selectedId) : -1;

  // Opening a comparison lands on its biggest change, and a filter that hides the
  // shot under review moves on to the next one rather than showing nothing.
  useEffect(() => {
    if (comparing && diff && shots.length && shotIndex < 0) setSelectedId(shots[0].key);
  }, [comparing, diff, shots, shotIndex]);

  const selected = useMemo(
    () => (comparing ? null : (data?.tiles.find((t) => t.id === selectedId) ?? null)),
    [comparing, data, selectedId],
  );
  useEffect(() => {
    if (selected) setLastRouteId(selected.routeId);
  }, [selected]);

  // Keep the URL in step with the view, so a link reproduces what's on screen.
  useEffect(() => {
    if (!data) return;
    const state: UrlState = {
      mode,
      q: query || undefined,
      tile: selectedId ?? undefined,
      run: run ?? undefined,
      diff: diffId ?? undefined,
      route: mode === "devices" ? focusRouteId : undefined,
      devices:
        deviceFilter.size && deviceFilter.size !== data.devices.length
          ? [...deviceFilter]
          : undefined,
      kinds: kindFilter.size ? [...kindFilter] : undefined,
    };
    writeUrlState(state);
  }, [data, mode, query, selectedId, run, diffId, focusRouteId, deviceFilter, kindFilter]);

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
      if (comparing) {
        const next = shots[shotIndex + dir];
        if (next) setSelectedId(next.key);
        return;
      }
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
    [comparing, shots, shotIndex, layout, selectedId],
  );

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
      else if (e.key === "/") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (comparing && (e.key === "ArrowLeft" || e.key === "k")) stepShot(-1);
      else if (comparing && (e.key === "ArrowRight" || e.key === "j")) stepShot(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comparing, stepShot, toggleMinimap]);

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
  const kinds = [...kindCounts.keys()].sort();
  const withTiles = new Set(layout.routesWithTiles);
  const groupsWithTiles = data.groups.filter((g) => withTiles.has(g.routeId));
  const failedCount = data.tiles.filter((t) => t.error).length;
  const shown = layout.placed.length + layout.truncated;
  // In device-compare mode the sidebar picks which route is on the canvas, so it
  // has to show which one that currently is; elsewhere it follows the selection.
  const activeRouteId =
    mode === "devices"
      ? (focusRouteId ?? groupsWithTiles[0]?.routeId)
      : (selected?.routeId ?? lastRouteId);
  const shot = comparing ? (shots[shotIndex] ?? null) : null;
  const diffRef = diffs.find((d) => d.id === diffId);

  const openCompare = () => {
    if (comparing || !diffs.length) return;
    setSelectedId(null);
    setDiffId(diffs[0].id);
  };
  const openExplore = () => {
    if (!comparing) return;
    setSelectedId(null);
    setDiffId(null);
  };
  const chooseLayout = (m: LayoutMode) => {
    setMode(m);
    // Open on whatever is selected, so switching modes keeps your place.
    if (m === "devices" && selected) setFocusRouteId(selected.routeId);
  };
  const focusRoute = (routeId: string) => {
    setLastRouteId(routeId);
    // In device compare the sidebar chooses the subject; in the other modes
    // everything is already placed, so it navigates.
    if (mode === "devices") setFocusRouteId(routeId);
    else {
      const b = layout.byRoute.get(routeId);
      if (b) canvas.current?.focusRect(b);
    }
    if (isPhone) setSheetOpen(false);
  };

  // ---- pieces shared by the desktop toolbar and the phone sheet

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

  const statusPills = (big?: boolean) =>
    diff && (
      <>
        {(["changed", "added", "removed", "unchanged", "uncomparable"] as const)
          .filter((s) => s !== "uncomparable" || diff.summary.uncomparable > 0)
          .map((s) => (
            <Pill
              key={s}
              big={big}
              tone="amber"
              dot={STATUS_COLOR[s]}
              on={statuses.has(s)}
              count={diff.summary[s]}
              onClick={() => setStatuses((prev) => toggle(prev, s, true))}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </Pill>
          ))}
      </>
    );

  const compareBadge = diff ? (
    <span className="rounded-full bg-amber px-1.5 text-[10.5px] leading-4 font-semibold text-on-amber">
      {diff.summary.changed}
    </span>
  ) : null;

  // A native select laid invisibly over a styled face: keyboard and screen readers
  // get the real control. On a phone it's just a line of text under the domain.
  const picker = isPhone
    ? "relative flex items-center gap-1 text-[11.5px] whitespace-nowrap text-dim"
    : "relative flex h-8 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 text-[12.5px] whitespace-nowrap text-fg focus-within:border-accent hover:border-line-strong";
  const pickerSelect = "absolute inset-0 w-full cursor-pointer opacity-0";
  const modeSwitch = (
    <Segmented<"explore" | "compare">
      label="View"
      fill={isPhone}
      value={comparing ? "compare" : "explore"}
      onChange={(v) => (v === "compare" ? openCompare() : openExplore())}
      items={[
        { value: "explore", label: "Explore" },
        {
          value: "compare",
          label: "Compare",
          extra: compareBadge,
          disabled: !diffs.length,
          title: diffs.length
            ? "Review what changed between two runs"
            : "No comparisons yet — run `visualice diff`",
        },
      ]}
    />
  );

  const runPicker = comparing ? (
    <label className={picker} title={diffRef ? `${diffRef.from} → ${diffRef.to}` : undefined}>
      <Icon name="clock" size={14} className="text-dim" />
      <span>
        {diffRef ? (
          <>
            {runLabel(diffRef.from)} <span className="text-dim">→</span> {runLabel(diffRef.to)}
          </>
        ) : (
          "Comparison"
        )}
      </span>
      <Icon name="chev" size={14} className="text-dim" />
      <select
        className={pickerSelect}
        aria-label="Comparison"
        value={diffId ?? ""}
        onChange={(e) => {
          setSelectedId(null);
          setDiffId(e.target.value);
        }}
      >
        {diffs.map((d) => (
          <option key={d.id} value={d.id}>
            {runLabel(d.from)} → {runLabel(d.to)}
          </option>
        ))}
      </select>
    </label>
  ) : (
    <label className={picker} title={run ?? runs?.current ?? data.site.runId}>
      <Icon name="clock" size={14} className="text-dim" />
      <span>{runLabel(run ?? runs?.current ?? data.site.runId)}</span>
      {(!run || run === runs?.current) && (
        <span className="rounded-full bg-accent-soft px-[7px] py-px text-[10.5px] font-semibold text-accent">
          latest
        </span>
      )}
      {runs && runs.runs.length > 1 && (
        <>
          <Icon name="chev" size={14} className="text-dim" />
          <select
            className={pickerSelect}
            aria-label="Run"
            value={run ?? runs.current}
            onChange={(e) => {
              setRun(e.target.value === runs.current ? null : e.target.value);
              setSelectedId(null);
            }}
          >
            {[...runs.runs].reverse().map((id) => (
              <option key={id} value={id}>
                {runLabel(id)}
                {id === runs.current ? " (latest)" : ""}
              </option>
            ))}
          </select>
        </>
      )}
    </label>
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

  const domain = data.site.origin.replace(/^https?:\/\//, "");

  const themeToggle = (
    <IconButton
      icon={theme === "dark" ? "sun" : "moon"}
      label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      size={isPhone ? 44 : undefined}
      onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
    />
  );

  const HEADER = "flex h-[52px] shrink-0 items-center border-b border-line bg-panel";
  const header = isPhone ? (
    <header className={cx(HEADER, "gap-2.5 px-3")}>
      <span className="flex shrink-0 items-center">
        <Logo markOnly />
      </span>
      <div className="flex min-w-0 flex-auto flex-col leading-[1.2]">
        <span className="truncate font-mono text-[11px] text-dim">{domain}</span>
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
      <div className="flex shrink-0 items-center">
        <Logo />
      </div>
      <span className={DIVIDER} />
      <div className="flex min-w-0 flex-col leading-[1.2]">
        <span className="truncate font-mono text-[11px] text-dim">{domain}</span>
      </div>
      {runPicker}
      <span className="flex-auto" />
      {modeSwitch}
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
  const toolbar = isPhone ? null : comparing ? (
    <div className={TOOLBAR}>
      <div className={TOOLBAR_GROUP} role="group" aria-label="Show">
        <Caption className="mr-0.5">Show</Caption>
        {statusPills()}
      </div>
      <span className={DIVIDER} />
      <div className={TOOLBAR_GROUP} role="group" aria-label="Devices">
        <Caption className="mr-0.5">Devices</Caption>
        {deviceToggles(false)}
      </div>
      <span className="flex-auto" />
      {diff && (
        <span className="text-[12px] text-dim">
          Threshold{" "}
          <span className="font-mono text-[11.5px] text-fg">{percent(diff.minRatio)}</span>
        </span>
      )}
    </div>
  ) : (
    <div className={TOOLBAR}>
      <div className={TOOLBAR_GROUP} role="group" aria-label="Layout">
        <Caption className="mr-0.5">Layout</Caption>
        <Segmented<LayoutMode>
          small
          label="Layout"
          value={mode}
          onChange={chooseLayout}
          items={LAYOUTS}
        />
      </div>
      <span className={DIVIDER} />
      <div className={TOOLBAR_GROUP} role="group" aria-label="Devices">
        <Caption className="mr-0.5">Devices</Caption>
        {deviceToggles(false)}
      </div>
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

  const body = comparing ? (
    <div className={cx("flex min-h-0 flex-auto", isPhone && "flex-col-reverse")}>
      {diff ? (
        <>
          <ChangeList
            shots={shots}
            selectedKey={shot?.key ?? null}
            onSelect={setSelectedId}
            devices={data.devices}
            phone={isPhone}
          />
          <Review
            diff={diff}
            diffId={diffId!}
            shot={shot}
            index={shotIndex}
            total={shots.length}
            onStep={stepShot}
            mode={reviewMode}
            onMode={setReviewMode}
            device={data.devices.find((d) => d.name === shot?.device)}
            phone={isPhone}
          />
        </>
      ) : (
        <ReviewEmpty>Loading comparison…</ReviewEmpty>
      )}
    </div>
  ) : (
    <div className="flex min-h-0 flex-auto">
      {!isPhone && sidebar}
      <main className="relative min-w-0 flex-auto">
        <Canvas
          ref={canvas}
          layout={layout}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onScaleChange={onScaleChange}
          base={base}
          showMinimap={!isPhone && minimapOn}
        />
        {canvasOverlays}
      </main>
      {selected && (
        <Inspector
          data={data}
          tile={selected}
          base={base}
          onSelect={setSelectedId}
          onStep={stepShot}
          phone={isPhone}
          onCompareDevices={() => {
            setMode("devices");
            setFocusRouteId(selected.routeId);
          }}
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
              setStatuses(new Set(DEFAULT_STATUSES));
              setFailedOnly(false);
            }}
          >
            Reset
          </button>
        </div>
        <div className="flex flex-col gap-[18px] overflow-y-auto px-4">
          {comparing ? (
            <div className={SHEET_GROUP} role="group" aria-label="Show">
              <Caption>Show</Caption>
              <div className={WRAP}>{statusPills(true)}</div>
            </div>
          ) : (
            <>
              <div className={SHEET_GROUP}>
                <Caption>Layout</Caption>
                <Segmented<LayoutMode>
                  fill
                  label="Layout"
                  value={mode}
                  onChange={chooseLayout}
                  items={LAYOUTS}
                />
              </div>
              {kinds.length > 1 && (
                <div className={SHEET_GROUP} role="group" aria-label="States">
                  <Caption>States</Caption>
                  <div className={WRAP}>{statePills(true)}</div>
                </div>
              )}
            </>
          )}
          <div className={SHEET_GROUP} role="group" aria-label="Devices">
            <Caption>Devices</Caption>
            <div className="grid grid-cols-2 gap-2">{deviceToggles(true)}</div>
          </div>
          {!comparing && groupsWithTiles.length > 0 && (
            <div className={SHEET_GROUP}>
              <Caption>Jump to route</Caption>
              <div className={WRAP}>
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
            Show {comparing ? shots.length : shown} shots
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
          <Kbd>←</Kbd> <Kbd>→</Kbd>
        </dt>
        <dd>Previous / next change (Compare)</dd>
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
        {isPhone && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2.5">
            {modeSwitch}
            {searchOpen && search}
          </div>
        )}
        {toolbar}
        {body}
        {sheet}
        {shortcuts}
      </div>
    </>
  );
}
