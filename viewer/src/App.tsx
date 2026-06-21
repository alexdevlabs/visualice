import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewerData } from "./types";
import { computeLayout, type LayoutMode } from "./layout";
import { Canvas, type CanvasHandle } from "./Canvas";

const DATA_URL = new URLSearchParams(location.search).get("data") ?? "./data/viewer-data.json";

export default function App() {
  const [data, setData] = useState<ViewerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<LayoutMode>("grouped");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [deviceFilter, setDeviceFilter] = useState<Set<string>>(new Set());
  const canvas = useRef<CanvasHandle>(null);

  useEffect(() => {
    fetch(DATA_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((d: ViewerData) => {
        setData(d);
        setDeviceFilter(new Set(d.devices.map((dev) => dev.name)));
      })
      .catch((e) => setError(String(e)));
  }, []);

  const layout = useMemo(
    () => (data ? computeLayout(data, mode, deviceFilter, query) : null),
    [data, mode, deviceFilter, query],
  );

  const selected = useMemo(
    () => data?.tiles.find((t) => t.id === selectedId) ?? null,
    [data, selectedId],
  );

  if (error) {
    return (
      <div className="vc-empty">
        <h1>Visual Crawl</h1>
        <p>Couldn't load <code>{DATA_URL}</code> — {error}</p>
        <p className="vc-dim">Run <code>visual-crawl serve</code> to host a run, or pass <code>?data=&lt;url&gt;</code>.</p>
      </div>
    );
  }
  if (!data || !layout) return <div className="vc-empty"><p className="vc-dim">Loading…</p></div>;

  const toggleDevice = (name: string) => {
    setDeviceFilter((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      if (next.size === 0) return prev; // keep at least one
      return next;
    });
  };

  const groupsWithTiles = data.groups.filter((g) => layout.byRoute.has(g.routeId));

  return (
    <div className="vc-app">
      <header className="vc-topbar">
        <div className="vc-brand">
          <span className="vc-logo">◉</span>
          <span>{data.site.title || data.site.origin}</span>
          <span className="vc-dim vc-run">{data.tiles.length} shots · {data.site.runId}</span>
        </div>
        <div className="vc-controls">
          <div className="vc-seg">
            <button className={mode === "grouped" ? "on" : ""} onClick={() => setMode("grouped")}>Grouped</button>
            <button className={mode === "all" ? "on" : ""} onClick={() => setMode("all")}>All at once</button>
          </div>
          <input
            className="vc-search"
            placeholder="Filter paths / states…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="vc-devices">
            {data.devices.map((d) => (
              <button
                key={d.name}
                className={"vc-chip" + (deviceFilter.has(d.name) ? " on" : "")}
                onClick={() => toggleDevice(d.name)}
                title={`${d.width}×${d.height} @${d.dpr}`}
              >
                {d.name}
              </button>
            ))}
          </div>
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
                <button onClick={() => { const b = layout.byRoute.get(g.routeId); if (b) canvas.current?.focusRect(b); }}>
                  <span className="vc-side-path">{g.path === "home" ? "/" : "/" + g.path}</span>
                  <span className="vc-dim">{g.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="vc-main">
          <Canvas
            ref={canvas}
            layout={layout}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onScaleChange={setScale}
          />
          {selected && (
            <div className="vc-inspector">
              <button className="vc-close" onClick={() => setSelectedId(null)}>✕</button>
              <div className="vc-insp-title">{selected.stateLabel}</div>
              <div className="vc-insp-row"><span>Path</span><code>{selected.routeUrl}</code></div>
              <div className="vc-insp-row"><span>State</span><code>{selected.stateId}</code></div>
              <div className="vc-insp-row"><span>Kind</span><code>{selected.stateKind}</code></div>
              <div className="vc-insp-row"><span>Device</span><code>{selected.device}</code></div>
              {selected.width && (
                <div className="vc-insp-row"><span>Size</span><code>{selected.width}×{selected.height}px</code></div>
              )}
              <div className="vc-insp-actions">
                <a href={"./data/" + selected.full} target="_blank" rel="noreferrer">Open full image ↗</a>
                <a href={new URL(selected.routeUrl, data.site.baseUrl).href} target="_blank" rel="noreferrer">Open live page ↗</a>
              </div>
              <img className="vc-insp-preview" src={"./data/" + selected.full} alt={selected.stateLabel} />
            </div>
          )}
          <div className="vc-hint">scroll to pan · ⌘/ctrl+scroll or pinch to zoom · click a shot for details</div>
        </main>
      </div>
    </div>
  );
}
