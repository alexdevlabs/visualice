import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Layout, Bounds } from "./layout";
import { buildTileIndex, cullLabels, cullTilesIndexed, lodFor, TILE_LABEL_MIN_SCALE } from "./lod";
import type { Transform } from "./lod";
import { Minimap } from "./Minimap";
import { nextTileId } from "./nav";

export interface CanvasHandle {
  fit: () => void;
  focusRect: (b: Bounds) => void;
  zoomBy: (factor: number) => void;
  getScale: () => number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 8;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface Props {
  layout: Layout;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onScaleChange?: (scale: number) => void;
  /** URL prefix for shot paths — the run being viewed. */
  base: string;
  showMinimap?: boolean;
}

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(
  { layout, selectedId, onSelect, onScaleChange, base, showMinimap = true },
  ref,
) {
  const elRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 1, h: 1 });
  const [t, setT] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    onScaleChange?.(t.scale);
  }, [t.scale, onScaleChange]);

  // measure viewport
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setVp({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fitTo = (b: Bounds, pad = 0.86) => {
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const scale = clamp(Math.min(vp.w / w, vp.h / h) * pad, MIN_SCALE, MAX_SCALE);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    setT({ scale, x: vp.w / 2 - cx * scale, y: vp.h / 2 - cy * scale });
  };

  const zoomAt = (sx: number, sy: number, factor: number) => {
    setT((cur) => {
      const ns = clamp(cur.scale * factor, MIN_SCALE, MAX_SCALE);
      const wx = (sx - cur.x) / cur.scale;
      const wy = (sy - cur.y) / cur.scale;
      return { scale: ns, x: sx - wx * ns, y: sy - wy * ns };
    });
  };

  /** Centre a world point without changing zoom — used by the minimap and tile nav. */
  const centerOn = (wx: number, wy: number) => {
    setT((cur) => ({ ...cur, x: vp.w / 2 - wx * cur.scale, y: vp.h / 2 - wy * cur.scale }));
  };

  useImperativeHandle(ref, () => ({
    fit: () => fitTo(layout.bounds),
    focusRect: (b: Bounds) => fitTo(b, 0.82),
    zoomBy: (factor: number) => zoomAt(vp.w / 2, vp.h / 2, factor),
    getScale: () => tRef.current.scale,
  }));

  // fit when the layout identity changes
  const layoutKey = layout.placed.length + ":" + layout.bounds.maxX + ":" + layout.bounds.maxY;
  const fittedKey = useRef("");
  useEffect(() => {
    if (vp.w > 1 && layoutKey !== fittedKey.current) {
      fittedKey.current = layoutKey;
      fitTo(layout.bounds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, vp.w, vp.h]);

  // native wheel listener (passive:false so we can preventDefault)
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
      } else {
        setT((cur) => ({ ...cur, x: cur.x - e.deltaX, y: cur.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // pointer pan + click-to-select
  const drag = useRef<{ x: number; y: number; t0: Transform; moved: boolean } | null>(null);
  const panRaf = useRef<number | null>(null);
  const pendingPan = useRef<Transform | null>(null);
  useEffect(
    () => () => {
      if (panRaf.current != null) cancelAnimationFrame(panRaf.current);
    },
    [],
  );
  const onPointerDown = (e: React.PointerEvent) => {
    // Capture on the canvas itself, not the tile under the cursor — a tile can be
    // unmounted by virtualization mid-drag, which would drop the capture and strand
    // the pan (drag.current left non-null, no pointerup).
    elRef.current?.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, t0: tRef.current, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true;
    if (!d.moved) return;
    // Coalesce to one setT per frame — pointermove can fire far faster than 60Hz.
    pendingPan.current = { ...d.t0, x: d.t0.x + dx, y: d.t0.y + dy };
    panRaf.current ??= requestAnimationFrame(() => {
      panRaf.current = null;
      if (pendingPan.current) setT(pendingPan.current);
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      // Hit-test by coordinate, not `e.target`: the pointer capture above retargets
      // every event to the canvas, so the tile under the cursor is only findable here.
      const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const tileEl = hit?.closest("[data-tile-id]") as HTMLElement | null;
      onSelect(tileEl?.dataset.tileId ?? null);
    }
  };

  /** Move the selection one tile in a direction and bring it on screen. */
  const stepSelection = (dx: -1 | 0 | 1, dy: -1 | 0 | 1) => {
    const id = nextTileId(layout.placed, selectedId, dx, dy);
    if (!id) return;
    onSelect(id);
    const target = layout.placed.find((p) => p.tile.id === id);
    if (target) centerOn(target.x + target.w / 2, target.y + target.h / 2);
  };

  // keyboard: arrows pan, shift+arrows walk tiles, +/- zoom, 0 fits, Escape clears
  const onKeyDown = (e: React.KeyboardEvent) => {
    const PAN = 90;
    switch (e.key) {
      case "+":
      case "=":
        zoomAt(vp.w / 2, vp.h / 2, 1.25);
        break;
      case "-":
      case "_":
        zoomAt(vp.w / 2, vp.h / 2, 0.8);
        break;
      case "0":
        fitTo(layout.bounds);
        break;
      case "ArrowLeft":
        if (e.shiftKey) stepSelection(-1, 0);
        else setT((c) => ({ ...c, x: c.x + PAN }));
        break;
      case "ArrowRight":
        if (e.shiftKey) stepSelection(1, 0);
        else setT((c) => ({ ...c, x: c.x - PAN }));
        break;
      case "ArrowUp":
        if (e.shiftKey) stepSelection(0, -1);
        else setT((c) => ({ ...c, y: c.y + PAN }));
        break;
      case "ArrowDown":
        if (e.shiftKey) stepSelection(0, 1);
        else setT((c) => ({ ...c, y: c.y - PAN }));
        break;
      case "Escape":
        onSelect(null);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // virtualization: only render tiles intersecting the viewport (+ margin)
  const index = useMemo(() => buildTileIndex(layout.placed), [layout]);
  const visible = useMemo(() => cullTilesIndexed(index, t, vp), [index, t, vp]);
  const labelsVisible = useMemo(() => cullLabels(layout.labels, t, vp), [layout, t, vp]);

  const showTileLabels = t.scale > TILE_LABEL_MIN_SCALE;

  return (
    <div
      ref={elRef}
      className="vc-canvas"
      role="application"
      aria-label="Screenshot canvas — arrow keys pan, shift+arrows move between shots, plus and minus zoom, 0 fits all"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <div
        className="vc-world"
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})` }}
      >
        {labelsVisible.map((l) => (
          <div
            key={l.routeId}
            className="vc-group-label"
            style={{ left: l.x, top: l.y, width: l.w }}
          >
            <span className="vc-group-title">{l.title}</span>
            <span className="vc-group-sub">{l.subtitle}</span>
          </div>
        ))}
        {visible.map((p) => {
          const src = lodFor(p.tile, p.w * t.scale);
          const selected = p.tile.id === selectedId;
          const failed = p.tile.error !== undefined;
          return (
            <div
              key={p.tile.id}
              data-tile-id={p.tile.id}
              className={
                "vc-tile" + (selected ? " is-selected" : "") + (failed ? " is-failed" : "")
              }
              style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
            >
              {failed || !src ? (
                // A failed capture still occupies its place in the catalog: dropping
                // it would read as "this state doesn't exist".
                <div className="vc-tile-failed">
                  <span className="vc-tile-failed-mark">!</span>
                  {showTileLabels && <span className="vc-tile-failed-msg">{p.tile.error}</span>}
                </div>
              ) : (
                <img
                  src={base + src}
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  alt={p.tile.stateLabel}
                />
              )}
              {showTileLabels && (
                <div className="vc-tile-meta">
                  <span className="vc-badge">{p.tile.device}</span>
                  <span className="vc-tile-state">{p.tile.stateLabel}</span>
                  {p.cropped && <span className="vc-badge vc-badge-warn">tall</span>}
                  {p.tile.clamped && <span className="vc-badge vc-badge-warn">cropped</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {showMinimap && (
        <Minimap
          layout={layout}
          transform={t}
          viewport={vp}
          selectedId={selectedId}
          onJump={centerOn}
        />
      )}
    </div>
  );
});
