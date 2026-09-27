import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ViewerData } from "./types";
import type { RunDiff, ShotStatus } from "./diff-types";
import { computeLayout, routePath, type LayoutMode } from "./layout";
import { interestingShots, matches } from "./diff-layout";
import { Canvas, type CanvasHandle } from "./Canvas";
import { ChangeList, Review, STATUS_COLOR, type ReviewMode } from "./Compare";
import { Inspector } from "./Inspector";
import { VirtualList } from "./VirtualList";
import { fetchDiffList, fetchRunDiff, fetchViewerData, resolveDataUrl, type DiffRef } from "./load";
import { readUrlState, writeUrlState, type UrlState } from "./url-state";
import { percent, runLabel } from "./format";
import { Loader, Logo } from "./brand";
import { applyTheme, readTheme, type Theme } from "./theme";
import {
  Caption,
  Count,
  deviceIcon,
  DeviceToggle,
  Icon,
  IconButton,
  Kbd,
  Pill,
  RouteBadge,
  Segmented,
} from "./ui";

/** Past this many tiles the canvas is capped, with a control to lift it. */
const DEFAULT_LIMIT = 2500;
/** The shortest time the boot loader shows, so its walk reads as intentional rather than a flicker. */
const MIN_LOADER_MS = 2000;

/** Must match `.vc-route-row` in styles.css — the virtual list pins rows to it. */
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
      else if (e.key === "/") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (comparing && (e.key === "ArrowLeft" || e.key === "k")) stepShot(-1);
      else if (comparing && (e.key === "ArrowRight" || e.key === "j")) stepShot(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comparing, stepShot]);

  if (error) {
    return (
      <div className="vc-empty">
        <Logo />
        <p>
          Couldn't load <code>{dataUrl.url}</code> — {error}
        </p>
        <p className="vc-dim">
          Run <code>visualice serve</code> to host a run, or pass <code>?data=&lt;path&gt;</code>.
        </p>
      </div>
    );
  }
  if (!data || !layout || !loaderMinDone)
    return (
      <div className="vc-empty vc-boot">
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

  const statePills = (
    <>
      <Pill
        on={kindFilter.size === 0}
        count={onDevices.length}
        onClick={() => setKindFilter(new Set())}
      >
        All
      </Pill>
      {kinds.map((k) => (
        <Pill
          key={k}
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

  const statusPills = diff && (
    <>
      {(["changed", "added", "removed", "unchanged", "uncomparable"] as const)
        .filter((s) => s !== "uncomparable" || diff.summary.uncomparable > 0)
        .map((s) => (
          <Pill
            key={s}
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

  const compareBadge = diff ? <span className="vc-seg-badge">{diff.summary.changed}</span> : null;
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
    <label className="vc-picker" title={diffRef ? `${diffRef.from} → ${diffRef.to}` : undefined}>
      <Icon name="clock" size={14} />
      <span>
        {diffRef ? (
          <>
            {runLabel(diffRef.from)} <span className="vc-dim">→</span> {runLabel(diffRef.to)}
          </>
        ) : (
          "Comparison"
        )}
      </span>
      <Icon name="chev" size={14} />
      <select
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
    <label className="vc-picker" title={run ?? runs?.current ?? data.site.runId}>
      <Icon name="clock" size={14} />
      <span>{runLabel(run ?? runs?.current ?? data.site.runId)}</span>
      {(!run || run === runs?.current) && <span className="vc-tag">latest</span>}
      {runs && runs.runs.length > 1 && (
        <>
          <Icon name="chev" size={14} />
          <select
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
    <label className="vc-search">
      <Icon name="search" size={15} />
      <input
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

  const header = isPhone ? (
    <header className="vc-header is-phone">
      <span className="vc-logo">
        <Logo markOnly />
      </span>
      <div className="vc-site">
        <span className="vc-mono vc-dim">{domain}</span>
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
    <header className="vc-header">
      <div className="vc-brand">
        <Logo />
      </div>
      <span className="vc-divider" />
      <div className="vc-site">
        <span className="vc-mono vc-dim">{domain}</span>
      </div>
      {runPicker}
      <span className="vc-grow" />
      {modeSwitch}
      <span className="vc-grow" />
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

  const toolbar = isPhone ? null : comparing ? (
    <div className="vc-toolbar">
      <div className="vc-group" role="group" aria-label="Show">
        <Caption>Show</Caption>
        {statusPills}
      </div>
      <span className="vc-divider" />
      <div className="vc-group" role="group" aria-label="Devices">
        <Caption>Devices</Caption>
        {deviceToggles(false)}
      </div>
      <span className="vc-grow" />
      {diff && (
        <span className="vc-dim vc-small">
          Threshold <span className="vc-mono vc-text">{percent(diff.minRatio)}</span>
        </span>
      )}
    </div>
  ) : (
    <div className="vc-toolbar">
      <div className="vc-group" role="group" aria-label="Layout">
        <Caption>Layout</Caption>
        <Segmented<LayoutMode>
          small
          label="Layout"
          value={mode}
          onChange={chooseLayout}
          items={LAYOUTS}
        />
      </div>
      <span className="vc-divider" />
      <div className="vc-group" role="group" aria-label="Devices">
        <Caption>Devices</Caption>
        {deviceToggles(false)}
      </div>
      {kinds.length > 1 && (
        <>
          <span className="vc-divider" />
          <div className="vc-group vc-group-wrap" role="group" aria-label="States">
            <Caption>States</Caption>
            {statePills}
          </div>
        </>
      )}
      <span className="vc-grow" />
      <span className="vc-dim vc-small vc-nowrap">
        {shown} shots · {groupsWithTiles.length} routes
      </span>
    </div>
  );

  // ---- body

  const sidebar = (
    <nav className="vc-sidebar" aria-label="Routes">
      <div className="vc-side-head">
        <Caption>Routes</Caption>
        <Count>{groupsWithTiles.length}</Count>
      </div>
      {groupsWithTiles.length === 0 ? (
        <p className="vc-side-empty">No route has shots matching these filters.</p>
      ) : (
        <VirtualList
          className="vc-side-list"
          items={groupsWithTiles}
          rowHeight={SIDEBAR_ROW_H}
          children={(g) => {
            const on = g.routeId === activeRouteId;
            return (
              <li key={g.routeId}>
                <button
                  type="button"
                  className={"vc-route-row" + (on ? " on" : "")}
                  aria-current={on}
                  onClick={() => focusRoute(g.routeId)}
                >
                  <span className="vc-row-main">
                    <RouteBadge path={routePath(g.path)} active={on} />
                    <span className="vc-row-title vc-dim">{g.title || routePath(g.path)}</span>
                  </span>
                  <span className="vc-row-count">{routeCounts.get(g.routeId) ?? 0}</span>
                </button>
              </li>
            );
          }}
        />
      )}
      <div className="vc-side-foot">
        {failedCount > 0 ? (
          <button
            type="button"
            className={"vc-failed-toggle" + (failedOnly ? " on" : "")}
            aria-pressed={failedOnly}
            onClick={() => setFailedOnly((v) => !v)}
          >
            <Icon name="alert" size={14} />
            <span>
              {failedCount} failed {failedCount === 1 ? "capture" : "captures"}
            </span>
            <span className="vc-grow" />
            <span className="vc-small">{failedOnly ? "Show all" : "Show only"}</span>
          </button>
        ) : (
          <span className="vc-ok">
            <Icon name="check" size={14} />
            <span className="vc-dim">All {data.tiles.length} shots captured</span>
          </span>
        )}
      </div>
    </nav>
  );

  const canvasOverlays = (
    <>
      <div className="vc-zoom" role="group" aria-label="Zoom">
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out (−)"
          onClick={() => canvas.current?.zoomBy(0.8)}
        >
          <Icon name="minus" size={15} />
        </button>
        <span className="vc-mono">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in (+)"
          onClick={() => canvas.current?.zoomBy(1.25)}
        >
          <Icon name="plus" size={15} />
        </button>
        <span className="vc-zoom-sep" />
        <button
          type="button"
          aria-label="Fit to screen"
          title="Fit to screen (0)"
          onClick={() => canvas.current?.fit()}
        >
          <Icon name="fit" size={15} />
        </button>
      </div>
      {!isPhone && (
        <div className="vc-hint">
          <Kbd>⇧</Kbd>
          <Kbd>←</Kbd>
          <Kbd>→</Kbd>
          <span>step</span>
          <Kbd>?</Kbd>
          <span>shortcuts</span>
        </div>
      )}
      <div className="vc-toasts">
        {layout.truncated > 0 && (
          <div className="vc-toast">
            Showing {layout.placed.length} of {shown} shots
            <button type="button" className="vc-link" onClick={() => setLimit(undefined)}>
              Show all
            </button>
          </div>
        )}
        {!layout.placed.length && (
          <div className="vc-toast">
            No shots match these filters.
            <button
              type="button"
              className="vc-link"
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
          <div className="vc-toast is-warn">
            {notice}
            <IconButton icon="x" label="Dismiss" size={24} onClick={() => setNotice(null)} />
          </div>
        )}
      </div>
    </>
  );

  const body = comparing ? (
    <div className={"vc-body is-compare" + (isPhone ? " is-phone" : "")}>
      {diff ? (
        <>
          <ChangeList
            shots={shots}
            selectedKey={shot?.key ?? null}
            onSelect={setSelectedId}
            devices={data.devices}
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
          />
        </>
      ) : (
        <div className="vc-review is-empty">
          <p className="vc-dim">Loading comparison…</p>
        </div>
      )}
    </div>
  ) : (
    <div className="vc-body">
      {!isPhone && sidebar}
      <main className="vc-main">
        <Canvas
          ref={canvas}
          layout={layout}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onScaleChange={onScaleChange}
          base={base}
          showMinimap={!isPhone}
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
      <div className="vc-scrim" onClick={() => setSheetOpen(false)} />
      <div className="vc-sheet" role="dialog" aria-modal="true" aria-label="View and filters">
        <div className="vc-sheet-grip" />
        <div className="vc-sheet-head">
          <h2>View &amp; filters</h2>
          <button
            type="button"
            className="vc-link"
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
        <div className="vc-sheet-body">
          {comparing ? (
            <div className="vc-sheet-group" role="group" aria-label="Show">
              <Caption>Show</Caption>
              <div className="vc-wrap">{statusPills}</div>
            </div>
          ) : (
            <>
              <div className="vc-sheet-group">
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
                <div className="vc-sheet-group" role="group" aria-label="States">
                  <Caption>States</Caption>
                  <div className="vc-wrap">{statePills}</div>
                </div>
              )}
            </>
          )}
          <div className="vc-sheet-group" role="group" aria-label="Devices">
            <Caption>Devices</Caption>
            <div className="vc-device-cards">{deviceToggles(true)}</div>
          </div>
          {!comparing && groupsWithTiles.length > 0 && (
            <div className="vc-sheet-group">
              <Caption>Jump to route</Caption>
              <div className="vc-wrap">
                {groupsWithTiles.map((g) => (
                  <button
                    key={g.routeId}
                    type="button"
                    className="vc-chip-btn"
                    onClick={() => focusRoute(g.routeId)}
                  >
                    <RouteBadge path={routePath(g.path)} active={g.routeId === activeRouteId} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="vc-sheet-foot">
          <button type="button" className="vc-primary" onClick={() => setSheetOpen(false)}>
            Show {comparing ? shots.length : shown} shots
          </button>
        </div>
      </div>
    </>
  );

  const shortcuts = shortcutsOpen && (
    <div className="vc-popover" role="dialog" aria-label="Keyboard shortcuts">
      <div className="vc-popover-head">
        <Caption>Keyboard shortcuts</Caption>
        <IconButton icon="x" label="Close" size={24} onClick={() => setShortcutsOpen(false)} />
      </div>
      <dl className="vc-dl is-keys">
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
          className="vc-empty vc-boot is-leaving"
          aria-hidden="true"
          onAnimationEnd={() => setLoaderGone(true)}
        >
          <Loader />
        </div>
      )}
      <div className={"vc-app" + (isPhone ? " is-phone" : "") + (loaderGone ? "" : " is-entering")}>
        {header}
        {isPhone && (
          <div className="vc-phone-bar">
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
