import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CAPTION_MIN_W, HEADER_BAND, ROW_GAP, SCREEN_GAP, SECTION_GAP } from "./layout";
import type { Layout, Bounds, GroupLabel, Placed, ViewMode } from "./layout";
import { chromeAt, maxScroll, type Strip } from "./page";
import { buildTileIndex, cullLabels, cullTilesIndexed, lodFor, TILE_LABEL_MIN_SCALE } from "./lod";
import type { Transform } from "./lod";
import { Minimap } from "./Minimap";
import { nextTileId } from "./nav";
import type { Device } from "./types";
import { cx, deviceIcon, Icon, RouteBadge } from "./ui";

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
/** Bringing a selected shot into focus: how long it takes, and the room left around it. */
const GLIDE_MS = 320;
const FOCUS_PAD = 0.86;
/** A long page, fitted by its width rather than whole; the gap above it then. */
const LONG_PAGE = 3;
/**
 * Solo (full screen), the shots are what the view is for: they're fitted by width as
 * soon as fitting them whole would leave them this much smaller, and read from the top.
 */
const SOLO_LONG = 1.25;
const FOCUS_TOP = 48;
/** Solo, the room above the shots: full screen's tab, then each shot's device caption. */
const SOLO_TOP = 64;

/**
 * The selected tile's ring, drawn in screen pixels over the canvas (see the
 * overlay) rather than on the tile: a line sized in canvas units scales with the
 * zoom, and one sized against it (2px ÷ zoom) is rounded up to a whole pixel by
 * the browser once it drops under one — then magnified into a thick bar.
 */
const RING_PX = 2;
/** The ring's distance from the shot's edge. */
const RING_OFFSET_PX = 2;
/** A tile's corner radius on screen. */
const TILE_RADIUS_PX = 4;
/** Scroll mode's scrollbar track, on screen; the thumb is half of it, edge included. */
const SCROLLBAR_PX = 8;
/**
 * A tile's frame — corner radius, hairline edge, shadow — kept at its screen size
 * whatever the zoom. In canvas units the corners would balloon and the hairline
 * thicken into a band when zoomed in. (A box-shadow's spread isn't rounded up the
 * way a border's width is, so it can go below a canvas pixel.)
 */
function frame(scale: number): React.CSSProperties {
  return {
    borderRadius: TILE_RADIUS_PX / scale,
    boxShadow: `0 0 0 ${1 / scale}px var(--color-tile-ring), 0 ${6 / scale}px ${16 / scale}px var(--color-tile-shadow)`,
  };
}

/** The smallest box around the given shots. */
function spanOf(placed: Placed[]): Pick<Placed, "x" | "y" | "w" | "h"> {
  const x = Math.min(...placed.map((p) => p.x));
  const y = Math.min(...placed.map((p) => p.y));
  const w = Math.max(...placed.map((p) => p.x + p.w)) - x;
  const h = Math.max(...placed.map((p) => p.y + p.h)) - y;
  return { x, y, w, h };
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
  /** Floats under the selected shot, following it as the view moves. */
  selectionBar?: ReactNode;
  /**
   * One shot on its own (full screen): no selection ring, and over each shot only
   * its device, from `devices`, as full screen's tab names the rest.
   */
  solo?: boolean;
  devices?: Device[];
  mode?: ViewMode;
}

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(
  {
    layout,
    selectedId,
    onSelect,
    onScaleChange,
    base,
    showMinimap = true,
    mode = "screen",
    selectionBar,
    solo,
    devices,
  },
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
    takeOver();
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const scale = clamp(Math.min(vp.w / w, vp.h / h) * pad, MIN_SCALE, MAX_SCALE);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    setT({ scale, x: vp.w / 2 - cx * scale, y: vp.h / 2 - cy * scale });
  };

  const zoomAt = (sx: number, sy: number, factor: number) => {
    takeOver();
    setT((cur) => {
      const ns = clamp(cur.scale * factor, MIN_SCALE, MAX_SCALE);
      const wx = (sx - cur.x) / cur.scale;
      const wy = (sy - cur.y) / cur.scale;
      return { scale: ns, x: sx - wx * ns, y: sy - wy * ns };
    });
  };

  /** Centre a world point without changing zoom — used by the minimap and tile nav. */
  const centerOn = (wx: number, wy: number) => {
    takeOver();
    setT((cur) => ({ ...cur, x: vp.w / 2 - wx * cur.scale, y: vp.h / 2 - wy * cur.scale }));
  };

  // A glide eases the view to a transform over a few frames. Anything the person
  // does to the view themselves stops it, and stops following the selection.
  const glideRaf = useRef<number | null>(null);
  const following = useRef(false);
  const stopGlide = () => {
    if (glideRaf.current != null) cancelAnimationFrame(glideRaf.current);
    glideRaf.current = null;
  };
  const takeOver = () => {
    stopGlide();
    following.current = false;
  };
  const glideTo = (to: Transform) => {
    stopGlide();
    const from = tRef.current;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setT(to);
    // Ease the world point at the centre and the zoom (in log space), so the shot
    // doesn't swing off to the side on its way in.
    const centre = (t: Transform) => ({
      x: (vp.w / 2 - t.x) / t.scale,
      y: (vp.h / 2 - t.y) / t.scale,
    });
    const a = centre(from);
    const b = centre(to);
    const start = performance.now();
    const frame = (now: number) => {
      const k = Math.min(1, (now - start) / GLIDE_MS);
      const e = 1 - (1 - k) ** 3;
      const scale = Math.exp(
        Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * e,
      );
      const wx = a.x + (b.x - a.x) * e;
      const wy = a.y + (b.y - a.y) * e;
      setT(k < 1 ? { scale, x: vp.w / 2 - wx * scale, y: vp.h / 2 - wy * scale } : to);
      glideRaf.current = k < 1 ? requestAnimationFrame(frame) : null;
    };
    glideRaf.current = requestAnimationFrame(frame);
  };
  useEffect(() => stopGlide, []);

  /**
   * The view that shows one shot: the whole of it, or for a long page, its width
   * from the top down — fitting all of that would shrink it to a sliver.
   */
  const focusOn = (p: Pick<Placed, "x" | "y" | "w" | "h">): Transform => {
    // With the bar under the shot, the shot takes the room above it.
    const top = solo ? SOLO_TOP : 0;
    const h = Math.max(1, vp.h - top - (selectionBar ? BAR_ROOM_PX : 0));
    const fitW = (vp.w * FOCUS_PAD) / p.w;
    const fitH = (h * FOCUS_PAD) / p.h;
    const long = solo ? fitW > fitH * SOLO_LONG : p.h / p.w > (LONG_PAGE * h) / vp.w;
    // A long page on the canvas stops at 100%; solo, the width is the shots' to fill.
    const byWidth = solo ? fitW : Math.min(fitW, 1);
    const scale = clamp(long ? byWidth : Math.min(fitW, fitH), MIN_SCALE, MAX_SCALE);
    const x = vp.w / 2 - (p.x + p.w / 2) * scale;
    const y =
      p.h * scale <= h * FOCUS_PAD
        ? top + h / 2 - (p.y + p.h / 2) * scale
        : (solo ? SOLO_TOP : FOCUS_TOP) - p.y * scale;
    return { scale, x, y };
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

  // Selecting a shot brings it into focus, and keeps it there while the details
  // panel narrows the canvas — until the person pans or zooms.
  const selectedPlace = layout.placed.find((p) => p.tile.id === selectedId);
  // Where the selection bar was dragged to, or under the shot. Remembered, so it
  // stays out of the way across shots, full screen and reloads.
  const [barAt, setBarAt] = useState<BarAt | null>(readBarAt);
  const moveBar = (at: BarAt | null) => {
    setBarAt(at);
    try {
      if (at) localStorage.setItem(BAR_AT_KEY, JSON.stringify(at));
      else localStorage.removeItem(BAR_AT_KEY);
    } catch {
      // Blocked storage just doesn't remember it.
    }
  };
  // Keyed on the layout too: a relayout (a new mode, a filter) fits the whole canvas
  // first, and the selected shot is then brought back into focus over it.
  const focusedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedPlace || vp.w <= 1) {
      focusedKey.current = null;
      return;
    }
    const key = selectedPlace.tile.id + "|" + layoutKey;
    if (focusedKey.current === key && !following.current) return;
    focusedKey.current = key;
    following.current = true;
    // Solo, the shot sits beside its state on the other devices shown: frame them all.
    // By the shots themselves, not the layout's bounds: those keep room above for the
    // canvas's captions, which solo doesn't draw and would grow with the zoom.
    glideTo(focusOn(solo ? spanOf(layout.placed) : selectedPlace));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlace, vp.w, vp.h]);

  const takeOverRef = useRef(takeOver);
  takeOverRef.current = takeOver;
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
      takeOverRef.current();
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
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    t0: Transform;
    moved: boolean;
  } | null>(null);
  /** Every pointer that is down, by id: one pans, two pinch. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; mid: { x: number; y: number }; t0: Transform } | null>(null);
  const panRaf = useRef<number | null>(null);
  const pendingPan = useRef<Transform | null>(null);
  useEffect(
    () => () => {
      if (panRaf.current != null) cancelAnimationFrame(panRaf.current);
    },
    [],
  );
  const schedule = (next: Transform) => {
    // Coalesce to one setT per frame — pointermove can fire far faster than 60Hz.
    pendingPan.current = next;
    panRaf.current ??= requestAnimationFrame(() => {
      panRaf.current = null;
      if (pendingPan.current) setT(pendingPan.current);
    });
  };
  /** The two fingers of a pinch: how far apart, and the point between them on the canvas. */
  const pinchOf = () => {
    const [a, b] = [...pointers.current.values()];
    const rect = elRef.current?.getBoundingClientRect();
    return {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid: { x: (a.x + b.x) / 2 - (rect?.left ?? 0), y: (a.y + b.y) / 2 - (rect?.top ?? 0) },
    };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    // The primary button only: a right-click opens the browser's menu, which eats
    // the pointerup and would leave the canvas panning with the bare pointer.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Capture on the canvas itself, not the tile under the cursor — a tile can be
    // unmounted by virtualization mid-drag, which would drop the capture and strand
    // the pan (drag.current left non-null, no pointerup).
    elRef.current?.setPointerCapture?.(e.pointerId);
    stopGlide();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      drag.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        t0: tRef.current,
        moved: false,
      };
    } else if (pointers.current.size === 2) {
      // A second finger: the two zoom about the point between them.
      drag.current = null;
      following.current = false;
      pinch.current = { ...pinchOf(), t0: pendingPan.current ?? tRef.current };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = pinch.current;
    if (p && pointers.current.size >= 2) {
      const now = pinchOf();
      const scale = clamp((p.t0.scale * now.dist) / p.dist, MIN_SCALE, MAX_SCALE);
      // The canvas point that was between the fingers stays between them.
      const wx = (p.mid.x - p.t0.x) / p.t0.scale;
      const wy = (p.mid.y - p.t0.y) / p.t0.scale;
      schedule({ ...p.t0, scale, x: now.mid.x - wx * scale, y: now.mid.y - wy * scale });
      return;
    }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // The button came up somewhere this element never heard of it.
    if (e.pointerType === "mouse" && e.buttons === 0) {
      endPointer(e.pointerId);
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) > 3) {
      d.moved = true;
      following.current = false;
    }
    if (!d.moved) return;
    schedule({ ...d.t0, x: d.t0.x + dx, y: d.t0.y + dy });
  };
  /** A pointer is gone, by lifting or by the browser taking it. Returns the drag it ended. */
  const endPointer = (id: number) => {
    const d = drag.current?.id === id ? drag.current : null;
    pointers.current.delete(id);
    if (d) drag.current = null;
    if (pinch.current) {
      pinch.current = null;
      // One finger left: it carries on as a pan from where the pinch ended, and its
      // release is not a tap.
      const [rest] = [...pointers.current.entries()];
      if (rest) {
        drag.current = {
          id: rest[0],
          x: rest[1].x,
          y: rest[1].y,
          t0: pendingPan.current ?? tRef.current,
          moved: true,
        };
      }
    }
    return d;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = endPointer(e.pointerId);
    if (d && !d.moved) {
      // Hit-test by coordinate, not `e.target`: the pointer capture above retargets
      // every event to the canvas, so the tile under the cursor is only findable here.
      const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const tileEl = hit?.closest("[data-tile-id]") as HTMLElement | null;
      onSelect(tileEl?.dataset.tileId ?? null);
    }
  };
  /** Taken away (a system gesture, the capture lost): ends the pan, selects nothing. */
  const onPointerCancel = (e: React.PointerEvent) => void endPointer(e.pointerId);

  /** Move the selection one tile in a direction; the focus effect brings it on screen. */
  const stepSelection = (dx: -1 | 0 | 1, dy: -1 | 0 | 1) => {
    const id = nextTileId(layout.placed, selectedId, dx, dy);
    if (!id) return;
    onSelect(id);
  };

  // keyboard: arrows pan, shift+arrows walk tiles, +/- zoom, 0 fits, Escape clears
  const onKeyDown = (e: React.KeyboardEvent) => {
    const PAN = 90;
    // The browser's own: Cmd/Ctrl +, - and 0 zoom the page, Alt/Cmd + arrows go back.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.startsWith("Arrow") && !e.shiftKey) takeOver();
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
      className="absolute inset-0 cursor-grab touch-none overflow-hidden select-none bg-canvas bg-[radial-gradient(var(--color-grid-dot)_1px,transparent_1px)] bg-size-[22px_22px] focus-visible:-outline-offset-2 active:cursor-grabbing"
      role="application"
      aria-label="Screenshot canvas — arrow keys pan, shift+arrows move between shots, plus and minus zoom, 0 fits all"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onKeyDown={onKeyDown}
    >
      <div
        className={cx("absolute top-0 left-0 origin-top-left", moving && "will-change-transform")}
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})` }}
      >
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
              {!failed && src && p.page && mode === "scroll" ? (
                <ScrollTile
                  p={p}
                  src={base + src}
                  active={selected}
                  scale={t.scale}
                  saved={scrolled.current}
                />
              ) : !failed && src && p.page ? (
                <div className="relative size-full overflow-hidden bg-paper" style={frame(t.scale)}>
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
                <div className="relative size-full">
                  {Array.from({ length: p.screensShown ?? 1 }, (_, i) => (
                    <div
                      key={i}
                      className="absolute inset-x-0 overflow-hidden bg-paper"
                      style={{
                        ...frame(t.scale),
                        top: i * (p.screenH! + SCREEN_GAP),
                        height: p.screenH,
                      }}
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
                    "size-full overflow-hidden bg-paper",
                    failed && "outline-1 -outline-offset-1 outline-amber outline-dashed",
                  )}
                  style={frame(t.scale)}
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
      {/* Captions and the selection ring live outside the zoomed world, in screen
          pixels: the same size at any zoom. Over the canvas, never catching the pointer. */}
      <div className="pointer-events-none absolute inset-0">
        {labelsVisible.map((l) => (
          <RouteHeader key={l.routeId} l={l} t={t} first={l.y <= layout.bounds.minY} />
        ))}
        {visible.map((p) =>
          !solo && p.tile.id === selectedId && p.tile.error === undefined ? (
            <SelectionRing key="ring" p={p} t={t} />
          ) : null,
        )}
        {showTileLabels &&
          !solo &&
          visible.map((p) => {
            const place = captionPlace(p, t, mode);
            return place ? <TileCaption key={p.tile.id} p={p} place={place} /> : null;
          })}
        {solo &&
          visible.map((p) => (
            <DeviceCaption
              key={p.tile.id}
              p={p}
              t={t}
              device={devices?.find((d) => d.name === p.tile.device)}
            />
          ))}
      </div>
      {selectionBar && selectedPlace && (
        <SelectionBar p={selectedPlace} t={t} vp={vp} at={barAt} onMove={moveBar}>
          {selectionBar}
        </SelectionBar>
      )}
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

/**
 * Clear space between a caption and its shot, on screen. More than the selection
 * ring takes (it sits outside the shot: offset plus width), so the ring never runs
 * into the badges.
 */
const CAPTION_GAP_PX = RING_OFFSET_PX + RING_PX + 6;
/** A caption's full height on screen: the name row, the badge row, the gap under them. */
const CAPTION_FULL_PX = 35 + CAPTION_GAP_PX;
/** The name row alone, for when the row gap has no room for the badges. */
const CAPTION_NAME_PX = 16 + CAPTION_GAP_PX;
/** How far a pinned caption sits from the canvas's top edge. */
const PIN_INSET_PX = 8;
/** A pinned caption may run wider than a phone-width shot: it has the canvas to itself. */
const PIN_MIN_W_PX = 280;
/** A pinned caption's height, so it can slide off with the bottom of its shot. */
const PIN_H_PX = 26;

interface CaptionPlace {
  left: number;
  top: number;
  width: number;
  /** Name only: the row gap is too short for the badges at this zoom. */
  compact: boolean;
  /** Pinned to the canvas's top edge while the shot's own top is scrolled away. */
  pinned: boolean;
  /** In a pinned caption, the screen of a stacked shot at the top of the canvas. */
  screen?: { at: number; of: number };
}

/**
 * Where a tile's caption goes on screen, or nothing. Above the shot, in the row
 * gap — never over the page it describes — at a fixed pixel size. Zoomed out, the
 * gap shrinks and the caption doesn't, so it drops to the name, then disappears
 * rather than cover the shot above. Zoomed in on a tall shot whose top has left
 * the screen, it pins to the canvas's top edge until the shot's bottom pushes it
 * off — always saying which shot you are reading.
 */
function captionPlace(p: Placed, t: Transform, mode: ViewMode): CaptionPlace | null {
  const gap = ROW_GAP * t.scale;
  if (gap < CAPTION_NAME_PX) return null;
  const compact = gap < CAPTION_FULL_PX;
  const left = p.x * t.scale + t.x;
  const top = p.y * t.scale + t.y;
  const bottom = top + p.h * t.scale;
  const width = Math.max(p.w * t.scale, CAPTION_MIN_W * Math.min(1, t.scale));
  const height = compact ? CAPTION_NAME_PX : CAPTION_FULL_PX;
  if (top - height >= 0 || bottom < PIN_INSET_PX + PIN_H_PX + 40) {
    // `top` is where the caption's BOTTOM goes: it is lifted by its own height.
    return { left, top: top - CAPTION_GAP_PX, width, compact, pinned: false };
  }
  const pinTop = Math.min(PIN_INSET_PX, bottom - PIN_H_PX - PIN_INSET_PX);
  let screen: CaptionPlace["screen"];
  if (mode === "screen" && p.screenH && p.tile.screens && p.tile.screens > 1) {
    const pitch = (p.screenH + SCREEN_GAP) * t.scale;
    const at = Math.min(p.screensShown ?? p.tile.screens, Math.floor(-top / pitch) + 1);
    screen = { at: Math.max(1, at), of: p.tile.screens };
  }
  // Inset from the shot's left edge — or the canvas's, when that edge is panned
  // away — and never past the shot's right side.
  const right = left + p.w * t.scale;
  const pinLeft = Math.min(Math.max(left, 0) + PIN_INSET_PX, right - PIN_INSET_PX - PIN_H_PX * 4);
  return { left: Math.max(pinLeft, left), top: pinTop, width, compact, pinned: true, screen };
}

/** The selected tile's outline, on screen: a fixed 2px line just outside the shot. */
function SelectionRing({ p, t }: { p: Placed; t: Transform }) {
  const out = RING_OFFSET_PX + RING_PX;
  return (
    <div
      className="absolute border-solid border-accent"
      style={{
        left: p.x * t.scale + t.x - out,
        top: p.y * t.scale + t.y - out,
        width: p.w * t.scale + out * 2,
        height: p.h * t.scale + out * 2,
        borderWidth: RING_PX,
        borderRadius: TILE_RADIUS_PX + out,
      }}
    />
  );
}

/** The selection bar's height on screen, and its clearance from the shot and the canvas edges. */
const BAR_H_PX = 42;
const BAR_GAP_PX = 12;
const BAR_EDGE_PX = 16;
/** The lowest the bar goes: clear of the zoom controls along the canvas's foot. */
const BAR_FOOT_PX = 68;
/** The room a focused shot leaves under itself for the bar. */
const BAR_ROOM_PX = BAR_GAP_PX + BAR_H_PX + BAR_FOOT_PX;

/** Where a dragged bar sits: its centre and top, as fractions of the canvas. */
interface BarAt {
  x: number;
  y: number;
}
const BAR_AT_KEY = "visualice.selection-bar";
function readBarAt(): BarAt | null {
  try {
    const at = JSON.parse(localStorage.getItem(BAR_AT_KEY) ?? "null") as BarAt | null;
    return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : null;
  } catch {
    return null;
  }
}
/** The least room between a dragged bar and the canvas's edges. */
const BAR_INSET_PX = 8;
/** How far an arrow key moves the bar, on screen. */
const BAR_NUDGE_PX = 24;

/**
 * The bar under the selected shot. It follows the shot, and when the shot's foot
 * is off screen — a long page — it stays at the canvas's foot instead; once the
 * shot itself is out of view, it goes.
 *
 * Dragged by its grip, it stays where it's put instead, for whichever shot is
 * selected, until a double-click on the grip (or Home) sends it back under the shot.
 * Kept as fractions of the canvas, so a resize can't strand it off screen.
 */
function SelectionBar({
  p,
  t,
  vp,
  at,
  onMove,
  children,
}: {
  p: Placed;
  t: Transform;
  vp: { w: number; h: number };
  at: BarAt | null;
  onMove: (at: BarAt | null) => void;
  children: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const left = p.x * t.scale + t.x;
  const top = p.y * t.scale + t.y;
  const right = left + p.w * t.scale;
  const bottom = top + p.h * t.scale;
  const half = (bar.current?.offsetWidth ?? 0) / 2;
  /** A centre and top kept on the canvas, the whole bar in view. */
  const clamp = (x: number, y: number) => ({
    x: Math.max(Math.min(half + BAR_INSET_PX, vp.w / 2), Math.min(x, vp.w - half - BAR_INSET_PX)),
    y: Math.max(BAR_INSET_PX, Math.min(y, vp.h - BAR_H_PX - BAR_INSET_PX)),
  });
  if (!at && (right < 0 || left > vp.w || bottom < 0 || top > vp.h)) return null;
  const { x, y } = at
    ? clamp(at.x * vp.w, at.y * vp.h)
    : {
        x: Math.max(BAR_EDGE_PX, Math.min((left + right) / 2, vp.w - BAR_EDGE_PX)),
        y: Math.max(BAR_EDGE_PX, Math.min(bottom + BAR_GAP_PX, vp.h - BAR_H_PX - BAR_FOOT_PX)),
      };
  const place = (cx: number, cy: number) => {
    const c = clamp(cx, cy);
    onMove({ x: c.x / vp.w, y: c.y / vp.h });
  };

  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label="Shot actions"
      className={cx(
        "absolute z-4 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-line bg-overlay p-[4px] backdrop-blur-sm",
        dragging ? "shadow-pop" : "shadow-float",
      )}
      style={{ left: x, top: y, height: BAR_H_PX }}
      // The canvas takes the pointer for panning and selecting; the bar's buttons
      // keep it, and its keys aren't the canvas's shortcuts.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Move the bar: drag, or use the arrow keys; double-click or Home puts it back"
        title="Drag to move · double-click to put back"
        className={cx(
          "flex h-full w-5 shrink-0 touch-none items-center justify-center rounded-lg border-0 bg-transparent text-dim hover:bg-hover hover:text-fg",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { dx: e.clientX - x, dy: e.clientY - y };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) place(e.clientX - d.dx, e.clientY - d.dy);
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onDoubleClick={() => onMove(null)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? BAR_NUDGE_PX * 4 : BAR_NUDGE_PX;
          const move: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
          };
          if (e.key === "Home") onMove(null);
          else if (move[e.key]) place(x + move[e.key][0], y + move[e.key][1]);
          else return;
          e.preventDefault();
        }}
      >
        <Icon name="grip" size={14} />
      </button>
      {children}
    </div>
  );
}

/** A tile's caption: the state name, then its kind / device / warning badges. */
/** A route header's rows on screen: badge, title and count; then the path alone. */
const HEADER_FULL_PX = 30;
const HEADER_NAME_PX = 22;
/** Narrower than this on screen, a header has no room to say anything. */
const HEADER_MIN_W_PX = 40;
/** How wide a header has to be on screen for the title beside the path, then the count. */
const HEADER_TITLE_W_PX = 220;
const HEADER_COUNT_W_PX = 320;

/**
 * A route's header, at a fixed screen size like the tile captions. It sits on the
 * bottom of its band, so it grows upward into the gap after the section above; zoomed
 * out until that room is shorter than the header, it drops to the path, then hides
 * rather than cover the shots above. The top section has the canvas edge above it.
 * As its column narrows it gives up the count, then the title, keeping the path.
 */
function RouteHeader({ l, t, first }: { l: GroupLabel; t: Transform; first: boolean }) {
  const room = (HEADER_BAND + (first ? Infinity : SECTION_GAP)) * t.scale;
  // A section panned partly off the left edge keeps its header in view, sliding in
  // with it like a pinned caption, until there's too little of the section left.
  const x = t.x + l.x * t.scale;
  const left = Math.max(x, PIN_INSET_PX);
  const width = l.w * t.scale - (left - x);
  if (room < HEADER_NAME_PX || width < HEADER_MIN_W_PX) return null;
  const compact = room < HEADER_FULL_PX;
  const h = compact ? HEADER_NAME_PX : HEADER_FULL_PX;
  const showTitle = !l.path || (!compact && width >= HEADER_TITLE_W_PX);
  const showCount = !compact && width >= HEADER_COUNT_W_PX;
  // Centred on the band while it's tall enough, else resting on its bottom edge.
  const band = HEADER_BAND * t.scale;
  const top = t.y + l.y * t.scale + (band >= h ? (band - h) / 2 : band - h);
  return (
    <div
      className="absolute flex items-center gap-2.5 overflow-hidden whitespace-nowrap"
      style={{ left, top, width, height: h }}
    >
      {l.path && (
        <span className="flex min-w-0">
          <RouteBadge path={l.path} size={compact ? "sm" : "md"} />
        </span>
      )}
      {showTitle && (
        // Gives way first, so the path stays whole for as long as it can.
        <span className="min-w-0 shrink-[100] truncate text-[15px] font-semibold text-fg">
          {l.title}
        </span>
      )}
      {showCount && <span className="shrink-0 text-[13px] text-dim">{l.subtitle}</span>}
    </div>
  );
}

function TileCaption({ p, place }: { p: Placed; place: CaptionPlace }) {
  const tile = p.tile;
  if (place.pinned) {
    return (
      <div
        data-caption-for={tile.id}
        className="absolute flex items-center gap-1.5 overflow-hidden rounded-md border border-line-strong bg-chip px-2 py-1 whitespace-nowrap shadow-tile backdrop-blur-sm"
        style={{ left: place.left, top: place.top, maxWidth: Math.max(place.width, PIN_MIN_W_PX) }}
      >
        <span className="truncate text-[12px] leading-[16px] font-medium text-fg">
          {tile.stateLabel}
        </span>
        <TileBadge>{tile.device}</TileBadge>
        {tile.updated && <TileBadge accent>updated</TileBadge>}
        {place.screen && (
          <span className="font-mono text-[10px] leading-[15px] text-dim">
            {`${place.screen.at} / ${place.screen.of}`}
          </span>
        )}
      </div>
    );
  }
  return (
    <div
      className="absolute flex -translate-y-full flex-col gap-0.5"
      data-caption-for={tile.id}
      style={{ left: place.left, top: place.top, width: place.width }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate text-[12px] leading-[16px] font-medium text-fg">
          {tile.stateLabel}
        </span>
        {/* With room for one line only, warnings still show beside the name. */}
        {place.compact && tile.updated ? (
          <span className="shrink-0">
            <TileBadge accent>updated</TileBadge>
          </span>
        ) : null}
        {place.compact && tile.a11y ? (
          <span className="shrink-0">
            <TileBadge warn>{`a11y ${tile.a11y}`}</TileBadge>
          </span>
        ) : null}
      </div>
      {!place.compact && (
        <div className="flex items-center gap-1 overflow-hidden">
          {/* Short of room, the kind gives way first: the warnings matter more. */}
          {tile.updated && <TileBadge accent>updated</TileBadge>}
          <TileBadge yields>{tile.stateKind}</TileBadge>
          <TileBadge>{tile.device}</TileBadge>
          {p.page ? (
            p.cropped && <TileBadge warn>tall</TileBadge>
          ) : tile.screens ? (
            <TileBadge warn={p.cropped}>
              {p.cropped ? `${p.screensShown}/${tile.screens} screens` : `${tile.screens} screens`}
            </TileBadge>
          ) : (
            p.cropped && <TileBadge warn>tall</TileBadge>
          )}
          {tile.clamped && <TileBadge warn>cropped</TileBadge>}
          {tile.a11y ? <TileBadge warn>{`a11y ${tile.a11y}`}</TileBadge> : null}
        </div>
      )}
    </div>
  );
}

/** Solo, a shot's caption: its device and width, left-aligned over it. */
function DeviceCaption({ p, t, device }: { p: Placed; t: Transform; device?: Device }) {
  return (
    <div
      data-caption-for={p.tile.id}
      className="absolute flex -translate-y-full items-center gap-1.5 pb-2 text-[12.5px] font-medium whitespace-nowrap text-fg"
      style={{ left: p.x * t.scale + t.x, top: p.y * t.scale + t.y }}
    >
      <span className="flex text-accent">
        <Icon name={deviceIcon(device)} size={14} />
      </span>
      {p.tile.device}
      {device && <span className="font-mono text-[11px] text-dim">{device.width}</span>}
    </div>
  );
}

/**
 * A tile's kind / device / warning tag, in the caption above it. Its text keeps
 * one size at any zoom while the caption narrows with the tile, so the tag that
 * yields ends in an ellipsis rather than any being sliced off mid-letter.
 */
function TileBadge({
  children,
  warn,
  accent,
  yields,
}: {
  children: string;
  warn?: boolean;
  /** Shot by this (partial) run, where the rest was carried over. */
  accent?: boolean;
  /** The one that gives up its room when there isn't enough; the others keep theirs. */
  yields?: boolean;
}) {
  return (
    <span
      title={children}
      className={cx(
        "truncate rounded-[4px] border bg-chip px-1 font-mono text-[10px] leading-[15px] whitespace-nowrap",
        yields ? "min-w-[2.5ch]" : "shrink-0",
        warn
          ? "border-amber-line text-amber"
          : accent
            ? "border-accent-line bg-accent-soft font-semibold text-accent"
            : "border-line-strong text-dim",
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
      className="relative size-full overflow-hidden bg-paper"
      style={frame(scale)}
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
