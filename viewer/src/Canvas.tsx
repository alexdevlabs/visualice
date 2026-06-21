import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Layout, Bounds } from "./layout";

export interface CanvasHandle {
  fit: () => void;
  focusRect: (b: Bounds) => void;
  zoomBy: (factor: number) => void;
  getScale: () => number;
}

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
const DATA = "./data/";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface Props {
  layout: Layout;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onScaleChange?: (scale: number) => void;
}

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(
  { layout, selectedId, onSelect, onScaleChange },
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
    if (d.moved) setT({ ...d.t0, x: d.t0.x + dx, y: d.t0.y + dy });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      const tileEl = (e.target as HTMLElement).closest("[data-tile-id]") as HTMLElement | null;
      onSelect(tileEl?.dataset.tileId ?? null);
    }
  };

  // virtualization: only render tiles intersecting the viewport (+ margin)
  const visible = useMemo(() => {
    const margin = 400 / t.scale;
    const x0 = (-t.x) / t.scale - margin;
    const y0 = (-t.y) / t.scale - margin;
    const x1 = (vp.w - t.x) / t.scale + margin;
    const y1 = (vp.h - t.y) / t.scale + margin;
    return layout.placed.filter(
      (p) => p.x + p.w >= x0 && p.x <= x1 && p.y + p.h >= y0 && p.y <= y1,
    );
  }, [layout, t, vp]);

  const labelsVisible = useMemo(() => {
    const x1 = (vp.w - t.x) / t.scale + 200;
    const y0 = (-t.y) / t.scale - 200;
    const y1 = (vp.h - t.y) / t.scale + 200;
    return layout.labels.filter((l) => l.y <= y1 && l.y + 60 >= y0 && l.x <= x1);
  }, [layout, t, vp]);

  const showTileLabels = t.scale > 0.18;

  return (
    <div
      ref={elRef}
      className="vc-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        className="vc-world"
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})` }}
      >
        {labelsVisible.map((l) => (
          <div key={l.routeId} className="vc-group-label" style={{ left: l.x, top: l.y, width: l.w }}>
            <span className="vc-group-title">{l.title}</span>
            <span className="vc-group-sub">{l.subtitle}</span>
          </div>
        ))}
        {visible.map((p) => {
          const onScreenW = p.w * t.scale;
          const useFull = onScreenW > 460 || !p.tile.thumb;
          const src = DATA + (useFull ? p.tile.full : p.tile.thumb);
          const selected = p.tile.id === selectedId;
          return (
            <div
              key={p.tile.id}
              data-tile-id={p.tile.id}
              className={"vc-tile" + (selected ? " is-selected" : "")}
              style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
            >
              <img src={src} draggable={false} loading="lazy" decoding="async" alt={p.tile.stateLabel} />
              {showTileLabels && (
                <div className="vc-tile-meta">
                  <span className="vc-badge">{p.tile.device}</span>
                  <span className="vc-tile-state">{p.tile.stateLabel}</span>
                  {p.cropped && <span className="vc-badge vc-badge-warn">tall</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
