import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ViewerData } from "./types";
import { computeLayout, type LayoutMode } from "./layout";
import { Canvas, type CanvasHandle } from "./Canvas";
import { fetchViewerData, resolveDataUrl } from "./load";
import { readUrlState, writeUrlState, type UrlState } from "./url-state";

/** Past this many tiles the canvas is capped, with a control to lift it. */
const DEFAULT_LIMIT = 2500;

interface RunList {
  current: string;
  runs: string[];
}

export default function App() {
  const initial = useMemo(() => readUrlState(location.search), []);
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
  const canvas = useRef<CanvasHandle>(null);

  // Where this run's files live: the server mounts the current run at ./data/ and
  // every other run at ./runs/<id>/.
  const base = run ? `./runs/${run}/` : "./data/";
  const dataUrl = useMemo(() => {
    const fallback = base + "viewer-data.json";
    const resolved = resolveDataUrl(location.search, fallback);
    return resolved;
  }, [base]);

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
          })
        : null,
    [data, mode, deviceFilter, kindFilter, deferredQuery, failedOnly, limit],
  );

  const selected = useMemo(
    () => data?.tiles.find((t) => t.id === selectedId) ?? null,
    [data, selectedId],
  );

  // Keep the URL in step with the view, so a link reproduces what's on screen.
  useEffect(() => {
    if (!data) return;
    const state: UrlState = {
      mode,
      q: query || undefined,
      tile: selectedId ?? undefined,
      run: run ?? undefined,
      devices:
        deviceFilter.size && deviceFilter.size !== data.devices.length
          ? [...deviceFilter]
          : undefined,
      kinds: kindFilter.size ? [...kindFilter] : undefined,
    };
    writeUrlState(state);
  }, [data, mode, query, selectedId, run, deviceFilter, kindFilter]);

  const onScaleChange = useCallback((s: number) => setScale(s), []);

  if (error) {
    return (
      <div className="vc-empty">
        <h1>Visualice</h1>
        <p>
          Couldn't load <code>{dataUrl.url}</code> — {error}
        </p>
        <p className="vc-dim">
          Run <code>visualice serve</code> to host a run, or pass <code>?data=&lt;path&gt;</code>.
        </p>
      </div>
    );
  }
  if (!data || !layout)
    return (
      <div className="vc-empty">
        <p className="vc-dim">Loading…</p>
      </div>
    );

  const toggle = (set: Set<string>, name: string, keepOne: boolean): Set<string> => {
    const next = new Set(set);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    if (keepOne && next.size === 0) return set; // never filter everything away
    return next;
  };

  const kinds = [...new Set(data.tiles.map((t) => t.stateKind))].sort();
  const groupsWithTiles = data.groups.filter((g) => layout.byRoute.has(g.routeId));
  const failedTiles = data.tiles.filter((t) => t.error);

  return (
    <div className="vc-app">
      <header className="vc-topbar">
        <div className="vc-brand">
          <span className="vc-logo">◉</span>
          <span>{data.site.title || data.site.origin}</span>
          <span className="vc-dim vc-run">
            {data.tiles.length} shots
            {failedTiles.length > 0 && (
              <button
                className={"vc-failed-count" + (failedOnly ? " on" : "")}
                title={failedOnly ? "Show every capture" : "Show only the failed captures"}
                aria-pressed={failedOnly}
                onClick={() => setFailedOnly((v) => !v)}
              >
                {failedTiles.length} failed
              </button>
            )}
            {runs && runs.runs.length > 1 ? (
              <select
                className="vc-run-select"
                aria-label="Run"
                value={run ?? runs.current}
                onChange={(e) => {
                  setRun(e.target.value === runs.current ? null : e.target.value);
                  setSelectedId(null);
                }}
              >
                {runs.runs.map((id) => (
                  <option key={id} value={id}>
                    {id}
                    {id === runs.current ? " (latest)" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <> · {data.site.runId}</>
            )}
          </span>
        </div>
        <div className="vc-controls">
          <div className="vc-seg">
            <button className={mode === "grouped" ? "on" : ""} onClick={() => setMode("grouped")}>
              Grouped
            </button>
            <button className={mode === "all" ? "on" : ""} onClick={() => setMode("all")}>
              All at once
            </button>
          </div>
          <input
            className="vc-search"
            aria-label="Filter paths and states"
            placeholder="Filter paths / states…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="vc-devices">
            {data.devices.map((d) => (
              <button
                key={d.name}
                className={"vc-chip" + (deviceFilter.has(d.name) ? " on" : "")}
                onClick={() => setDeviceFilter((prev) => toggle(prev, d.name, true))}
                title={`${d.width}×${d.height} @${d.dpr}`}
              >
                {d.name}
              </button>
            ))}
          </div>
          {kinds.length > 1 && (
            <div className="vc-devices vc-kinds">
              {kinds.map((k) => (
                <button
                  key={k}
                  className={"vc-chip" + (kindFilter.has(k) ? " on" : "")}
                  onClick={() => setKindFilter((prev) => toggle(prev, k, false))}
                  title={`Show only ${k} states`}
                >
                  {k}
                </button>
              ))}
            </div>
          )}
          <div className="vc-zoom">
            <button onClick={() => canvas.current?.zoomBy(0.8)}>−</button>
            <span>{Math.round(scale * 100)}%</span>
            <button onClick={() => canvas.current?.zoomBy(1.25)}>+</button>
            <button onClick={() => canvas.current?.fit()}>Fit</button>
          </div>
        </div>
      </header>

      <div className="vc-body">
        <aside className="vc-sidebar">
          <div className="vc-side-title">Paths</div>
          <ul>
            {groupsWithTiles.map((g) => (
              <li key={g.routeId}>
                <button
                  onClick={() => {
                    const b = layout.byRoute.get(g.routeId);
                    if (b) canvas.current?.focusRect(b);
                  }}
                >
                  <span className="vc-side-path">{g.path === "home" ? "/" : "/" + g.path}</span>
                  <span className="vc-dim">{g.title}</span>
                </button>
              </li>
            ))}
          </ul>
          {failedTiles.length > 0 && (
            <>
              <div className="vc-side-title">Failed</div>
              <ul>
                {failedTiles.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => setSelectedId(t.id)}>
                      <span className="vc-side-path vc-failed">
                        {t.routePath === "home" ? "/" : "/" + t.routePath}
                      </span>
                      <span className="vc-dim">
                        {t.stateId} · {t.device}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>

        <main className="vc-main">
          <Canvas
            ref={canvas}
            layout={layout}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onScaleChange={onScaleChange}
            base={base}
          />
          {selected && (
            <div className="vc-inspector">
              <button className="vc-close" onClick={() => setSelectedId(null)}>
                ✕
              </button>
              <div className="vc-insp-title">{selected.stateLabel}</div>
              <div className="vc-insp-row">
                <span>Path</span>
                <code>{selected.routeUrl}</code>
              </div>
              <div className="vc-insp-row">
                <span>State</span>
                <code>{selected.stateId}</code>
              </div>
              <div className="vc-insp-row">
                <span>Kind</span>
                <code>{selected.stateKind}</code>
              </div>
              <div className="vc-insp-row">
                <span>Device</span>
                <code>{selected.device}</code>
              </div>
              {selected.width && !selected.error && (
                <div className="vc-insp-row">
                  <span>Size</span>
                  <code>
                    {selected.width}×{selected.height}px{selected.clamped ? " (cropped)" : ""}
                  </code>
                </div>
              )}
              {selected.error && (
                <div className="vc-insp-error">
                  <strong>Capture failed</strong>
                  <code>{selected.error}</code>
                  <span className="vc-dim">
                    A failing state usually means its recipe needs a tweak — a stale selector, a
                    changed trigger, or an auth wall.
                  </span>
                </div>
              )}
              <div className="vc-insp-actions">
                {selected.full && (
                  <a href={base + selected.full} target="_blank" rel="noreferrer">
                    Open full image ↗
                  </a>
                )}
                {selected.viewport && (
                  <a href={base + selected.viewport} target="_blank" rel="noreferrer">
                    Open viewport crop ↗
                  </a>
                )}
                {data.site.baseUrl && (
                  <a
                    href={new URL(selected.routeUrl, data.site.baseUrl).href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open live page ↗
                  </a>
                )}
              </div>
              {selected.full && (
                <img
                  className="vc-insp-preview"
                  src={base + (selected.mid ?? selected.full)}
                  alt={selected.stateLabel}
                />
              )}
            </div>
          )}
          {layout.truncated > 0 && (
            <div className="vc-truncated">
              Showing {layout.placed.length} of {layout.placed.length + layout.truncated} shots
              <button className="vc-chip" onClick={() => setLimit(undefined)}>
                Show all
              </button>
            </div>
          )}
          {notice && <div className="vc-notice">{notice}</div>}
          <div className="vc-hint">
            scroll to pan · ⌘/ctrl+scroll or pinch to zoom · click a shot for details · shift+arrows
            to step
          </div>
        </main>
      </div>
    </div>
  );
}
