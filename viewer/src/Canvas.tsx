import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CAPTION_MIN_W, SCREEN_GAP } from "./layout";
import type { Layout, Bounds, Placed, ViewMode } from "./layout";
import { chromeAt, maxScroll, type Strip } from "./page";
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

/**
 * The selected tile's ring. Sized in canvas units it would scale with the zoom —
 * a hairline zoomed out, a thick bar zoomed in — so it is sized to the screen.
 */
const RING = "outline-solid outline-accent";
const RING_PX = 2;
/** Scroll mode's scrollbar track, on screen; the thumb is half of it, edge included. */
const SCROLLBAR_PX = 8;
function ring(scale: number): React.CSSProperties {
  return { outlineWidth: RING_PX / scale, outlineOffset: RING_PX / scale };
}

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
  mode?: ViewMode;
}

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(
  { layout, selectedId, onSelect, onScaleChange, base, showMinimap = true, mode = "screen" },
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

  // Where each tile in Scroll mode was scrolled to, so panning it out of view and
  // back (which unmounts it) doesn't send it back to the top.
  const scrolled = useRef(new Map<string, number>());

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
                    {p.page ? (
                      p.cropped && <TileBadge warn>tall</TileBadge>
                    ) : p.tile.screens ? (
                      <TileBadge warn={p.cropped}>
                        {p.cropped
                          ? `${p.screensShown} of ${p.tile.screens} screens`
                          : `${p.tile.screens} screens`}
                      </TileBadge>
                    ) : (
                      p.cropped && <TileBadge warn>tall</TileBadge>
                    )}
                    {p.tile.clamped && <TileBadge warn>cropped</TileBadge>}
                    {p.tile.a11y ? <TileBadge warn>{`a11y ${p.tile.a11y}`}</TileBadge> : null}
                  </div>
                </div>
              )}
              {!failed && src && p.page && mode === "scroll" ? (
                <ScrollTile
                  p={p}
                  src={base + src}
                  active={selected}
                  scale={t.scale}
                  saved={scrolled.current}
                />
              ) : !failed && src && p.page ? (
                <div
                  className={cx(
                    "relative size-full overflow-hidden rounded-[4px] bg-paper shadow-tile",
                    selected && RING,
                  )}
                  style={selected ? ring(t.scale) : undefined}
                >
                  {p.page.strips.map((strip, i) => (
                    <StripImg
                      key={i}
                      strip={strip}
                      k={p.k!}
                      imgH={p.tile.height!}
                      src={base + src}
                      alt={i === 0 ? p.tile.stateLabel : ""}
                    />
                  ))}
                </div>
              ) : !failed && src && p.screenH ? (
                // Each screen is its own frame with canvas between them: a fixed bar
                // repeating on every screen then reads as what it is, not a glitch.
                <div
                  className={cx("relative size-full rounded-[4px]", selected && RING)}
                  style={selected ? ring(t.scale) : undefined}
                >
                  {Array.from({ length: p.screensShown ?? 1 }, (_, i) => (
                    <div
                      key={i}
                      className="absolute inset-x-0 overflow-hidden rounded-[4px] bg-paper shadow-tile"
                      style={{ top: i * (p.screenH! + SCREEN_GAP), height: p.screenH }}
                    >
                      <img
                        className="absolute inset-x-0 block w-full max-w-none"
                        style={{
                          top: -i * p.screenH!,
                          height: p.screenH! * (p.tile.screens ?? 1),
                        }}
                        src={base + src}
                        draggable={false}
                        loading="lazy"
                        decoding="async"
                        alt={i === 0 ? p.tile.stateLabel : ""}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className={cx(
                    "size-full overflow-hidden rounded-[4px] bg-paper shadow-tile",
                    failed
                      ? "outline-1 -outline-offset-1 outline-amber outline-dashed"
                      : selected && RING,
                  )}
                  style={selected && !failed ? ring(t.scale) : undefined}
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

/** Rows of the stacked image, cut out by clipping and drawn where they sit on the page. */
function StripImg({
  strip,
  k,
  imgH,
  src,
  alt,
}: {
  strip: Strip;
  k: number;
  imgH: number;
  src: string;
  alt: string;
}) {
  return (
    // Half a pixel taller than the strip, under the next one: fractional positions
    // would otherwise leave hairline seams between strips at some zoom levels.
    <div
      className="absolute inset-x-0 overflow-hidden"
      style={{ top: strip.at * k, height: strip.len * k + 0.5 }}
    >
      <ImgRows src={src} from={strip.src} k={k} imgH={imgH} alt={alt} />
    </div>
  );
}

/** The stacked image, shifted so row `from` is at the top of its clipping box. */
function ImgRows({
  src,
  from,
  k,
  imgH,
  alt = "",
}: {
  src: string;
  from: number;
  k: number;
  imgH: number;
  alt?: string;
}) {
  return (
    <img
      className="absolute inset-x-0 block w-full max-w-none"
      style={{ top: -from * k, height: imgH * k }}
      src={src}
      draggable={false}
      loading="lazy"
      decoding="async"
      alt={alt}
    />
  );
}

/**
 * One screen of the page, scrolled with the wheel once the tile is selected — the
 * canvas keeps the wheel everywhere else. The page scrolls under the bars pinned
 * to the window, which are drawn from the screen captured nearest that position.
 */
function ScrollTile({
  p,
  src,
  active,
  scale,
  saved,
}: {
  p: Placed;
  src: string;
  active: boolean;
  scale: number;
  saved: Map<string, number>;
}) {
  const page = p.page!;
  const k = p.k!;
  const imgH = p.tile.height!;
  const id = p.tile.id;
  // What the window shows, in image px: one screen, unless the tile was capped.
  const viewH = p.h / k;
  const max = Math.max(0, maxScroll(page) + page.viewH - viewH);
  const [s, setS] = useState(() => clamp(saved.get(id) ?? 0, 0, max));
  const pos = clamp(s, 0, max);
  useEffect(() => {
    saved.set(id, pos);
  }, [saved, id, pos]);

  const el = useRef<HTMLDivElement>(null);
  const live = useRef({ active, scale, k, max });
  live.current = { active, scale, k, max };
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      const { active, scale, k, max } = live.current;
      if (!active || e.ctrlKey || e.metaKey || max <= 0) return;
      // Taken here, so the canvas underneath doesn't pan as well.
      e.preventDefault();
      e.stopPropagation();
      const unit = e.deltaMode === 1 ? 16 : 1;
      // One screen pixel of wheel moves the page one screen pixel, at any zoom.
      setS((cur) => clamp(clamp(cur, 0, max) + (e.deltaY * unit) / (scale * k), 0, max));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const chrome = chromeAt(page, pos);
  const trackH = p.h;
  const thumbH = max > 0 ? Math.max(trackH * 0.08, (trackH * viewH) / (viewH + max)) : trackH;
  const thumbTop = max > 0 ? (pos / max) * (trackH - thumbH) : 0;
  const barW = Math.min(SCROLLBAR_PX / scale, p.w / 16);

  // Dragging the thumb: pointer movement on screen → scroll position on the page.
  const drag = useRef<{ y: number; s0: number } | null>(null);
  const onThumbDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, s0: pos };
  };
  const onThumbMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    const d = drag.current;
    if (!d || trackH <= thumbH) return;
    const dy = (e.clientY - d.y) / scale;
    setS(clamp(d.s0 + (dy / (trackH - thumbH)) * max, 0, max));
  };
  const onThumbUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    drag.current = null;
  };

  return (
    <div
      ref={el}
      className={cx(
        "relative size-full overflow-hidden rounded-[4px] bg-paper shadow-tile",
        active && RING,
      )}
      style={active ? ring(scale) : undefined}
      title={active ? undefined : "Select to scroll"}
    >
      <div className="absolute inset-x-0 top-0" style={{ transform: `translateY(${-pos * k}px)` }}>
        {page.strips.map((strip, i) => (
          <StripImg
            key={i}
            strip={strip}
            k={k}
            imgH={imgH}
            src={src}
            alt={i === 0 ? p.tile.stateLabel : ""}
          />
        ))}
      </div>
      {chrome && chrome.top > 0 && (
        <div
          className="absolute inset-x-0 top-0 overflow-hidden"
          style={{ height: chrome.top * k }}
        >
          <ImgRows src={src} from={chrome.src} k={k} imgH={imgH} />
        </div>
      )}
      {chrome && chrome.bottom > 0 && (
        <div
          className="absolute inset-x-0 bottom-0 overflow-hidden"
          style={{ height: chrome.bottom * k }}
        >
          <ImgRows src={src} from={chrome.src + page.viewH - chrome.bottom} k={k} imgH={imgH} />
        </div>
      )}
      {max > 0 && (
        // Sized to the screen, like the selection ring: in canvas units it would grow
        // into a thick bar when zoomed in. Never wider than a sliver of a tiny tile.
        <div className="absolute inset-y-0 right-0" style={{ width: barW }}>
          <div
            // Gray with a light edge, as the OS draws overlay scrollbars: the gray
            // shows on a light page and the edge on a dark one, whatever is behind.
            className={cx(
              "absolute box-border cursor-grab rounded-full border-solid border-white/70 active:cursor-grabbing",
              active ? "bg-[rgb(128_128_128/0.9)]" : "bg-[rgb(128_128_128/0.6)]",
            )}
            style={{
              top: thumbTop,
              height: thumbH,
              left: barW / 4,
              right: barW / 4,
              borderWidth: Math.min(1 / scale, barW / 8),
            }}
            onPointerDown={onThumbDown}
            onPointerMove={onThumbMove}
            onPointerUp={onThumbUp}
          />
        </div>
      )}
    </div>
  );
}
