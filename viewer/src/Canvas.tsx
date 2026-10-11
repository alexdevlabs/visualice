import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CAPTION_MIN_W } from "./layout";
import type { Layout, Bounds } from "./layout";
import { buildTileIndex, cullLabels, cullTilesIndexed, lodFor, TILE_LABEL_MIN_SCALE } from "./lod";
import type { Transform } from "./lod";
import { Minimap } from "./Minimap";
import { nextTileId } from "./nav";
import { cx, RouteBadge } from "./ui";

export interface CanvasHandle {
  fit: () => void;
  focusRect: (b: Bounds) => void;
  zoomBy: (factor: number) => void;
  getScale: () => number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
/** Zoom per pixel of wheel delta, and the most one event may contribute. */
const WHEEL_ZOOM_RATE = 0.01;
const WHEEL_ZOOM_MAX = 30;
/** How long the view has to sit still before it is redrawn sharp. */
const SETTLE_MS = 160;

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

  // `will-change: transform` keeps pan and zoom on the compositor, but the browser
  // then stretches the layer it rasterized at the old scale instead of redrawing it —
  // everything goes soft after zooming in. So promote only while the view is moving.
  const [moving, setMoving] = useState(false);
  const skipFirst = useRef(true);
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    setMoving(true);
    const timer = setTimeout(() => setMoving(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [t]);

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
    // Coalesced to one setT per frame: a trackpad fires wheel events well past 60Hz.
    let raf: number | null = null;
    let zoom = 1;
    let at = { x: 0, y: 0 };
    let pan = { x: 0, y: 0 };
    const flush = () => {
      raf = null;
      const factor = zoom;
      const { x: sx, y: sy } = at;
      const { x: dx, y: dy } = pan;
      zoom = 1;
      pan = { x: 0, y: 0 };
      setT((cur) => {
        const ns = clamp(cur.scale * factor, MIN_SCALE, MAX_SCALE);
        const wx = (sx - cur.x) / cur.scale;
        const wy = (sy - cur.y) / cur.scale;
        const zoomed = factor === 1 ? cur : { scale: ns, x: sx - wx * ns, y: sy - wy * ns };
        return { ...zoomed, x: zoomed.x - dx, y: zoomed.y - dy };
      });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Firefox reports a mouse wheel in lines, not pixels.
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        // A pinch arrives as many small deltas, a wheel notch as one of ~100. The
        // clamp lets the rate suit the pinch without a notch jumping several levels.
        zoom *= Math.exp(
          -clamp(e.deltaY * unit, -WHEEL_ZOOM_MAX, WHEEL_ZOOM_MAX) * WHEEL_ZOOM_RATE,
        );
      } else {
        pan = { x: pan.x + e.deltaX * unit, y: pan.y + e.deltaY * unit };
      }
      raf ??= requestAnimationFrame(flush);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (raf != null) cancelAnimationFrame(raf);
    };
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

  // Sources are picked by the device pixels a tile covers: on a 2x display a 400px
  // tile needs 800px of image, which a thumbnail doesn't have.
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const showTileLabels = t.scale > TILE_LABEL_MIN_SCALE;

  return (
    <div
      ref={elRef}
      className="absolute inset-0 cursor-grab touch-none overflow-hidden bg-canvas bg-[radial-gradient(var(--color-grid-dot)_1px,transparent_1px)] bg-size-[22px_22px] focus-visible:-outline-offset-2 active:cursor-grabbing"
      role="application"
      aria-label="Screenshot canvas — arrow keys pan, shift+arrows move between shots, plus and minus zoom, 0 fits all"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <div
        className={cx("absolute top-0 left-0 origin-top-left", moving && "will-change-transform")}
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})` }}
      >
        {labelsVisible.map((l) => (
          <div
            key={l.routeId}
            className="absolute flex h-10 items-center gap-3 overflow-hidden whitespace-nowrap"
            style={{ left: l.x, top: l.y, width: l.w }}
          >
            {l.path && <RouteBadge path={l.path} size="lg" />}
            <span className="truncate text-[20px] font-semibold text-fg">{l.title}</span>
            <span className="text-[15px] text-dim">{l.subtitle}</span>
          </div>
        ))}
        {visible.map((p) => {
          const src = lodFor(p.tile, p.w * t.scale * dpr);
          const selected = p.tile.id === selectedId;
          const failed = p.tile.error !== undefined;
          return (
            <div
              key={p.tile.id}
              data-tile-id={p.tile.id}
              className="absolute"
              style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
            >
              {showTileLabels && (
                // Above the shot, in the row gap — never over the page it describes.
                // The name gets a row to itself: beside the badges, a phone-width tile
                // leaves it a letter or two.
                <div
                  className="absolute bottom-full left-0 flex flex-col gap-0.5 pb-1.5"
                  style={{ width: Math.max(p.w, CAPTION_MIN_W) }}
                >
                  <span className="truncate text-[12px] leading-[16px] font-medium text-fg">
                    {p.tile.stateLabel}
                  </span>
                  <div className="flex items-center gap-1 overflow-hidden">
                    <TileBadge>{p.tile.stateKind}</TileBadge>
                    <TileBadge>{p.tile.device}</TileBadge>
                    {p.cropped && <TileBadge warn>tall</TileBadge>}
                    {p.tile.clamped && <TileBadge warn>cropped</TileBadge>}
                    {p.tile.a11y ? <TileBadge warn>{`a11y ${p.tile.a11y}`}</TileBadge> : null}
                  </div>
                </div>
              )}
              <div
                className={cx(
                  "size-full overflow-hidden rounded-[4px] bg-paper shadow-tile",
                  failed
                    ? "outline-1 -outline-offset-1 outline-amber outline-dashed"
                    : selected && "outline-3 outline-offset-3 outline-accent",
                )}
              >
                {failed || !src ? (
                  // A failed capture still occupies its place in the catalog: dropping
                  // it would read as "this state doesn't exist".
                  <div className="flex size-full flex-col items-center justify-center gap-2.5 bg-[repeating-linear-gradient(45deg,var(--color-hatch-a),var(--color-hatch-a)_12px,var(--color-hatch-b)_12px,var(--color-hatch-b)_24px)] p-3 text-center text-dim">
                    <span className="text-[44px] leading-none font-bold text-amber">!</span>
                    {showTileLabels && (
                      <span className="line-clamp-4 max-w-[90%] text-[13px]">{p.tile.error}</span>
                    )}
                  </div>
                ) : (
                  <img
                    className="block size-full object-cover object-top"
                    src={base + src}
                    draggable={false}
                    loading="lazy"
                    decoding="async"
                    alt={p.tile.stateLabel}
                  />
                )}
              </div>
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

/** A tile's kind / device / warning tag, in the caption above it. */
function TileBadge({ children, warn }: { children: string; warn?: boolean }) {
  return (
    <span
      className={cx(
        "rounded-[4px] border bg-chip px-1 font-mono text-[10px] leading-[15px] whitespace-nowrap",
        warn ? "border-amber-line text-amber" : "border-line-strong text-dim",
      )}
    >
      {children}
    </span>
  );
}
