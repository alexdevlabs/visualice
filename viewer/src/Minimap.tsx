import { useMemo } from "react";
import type { Layout } from "./layout";
import type { Transform, Viewport } from "./lod";
import { cx } from "./ui";

/**
 * Overview of the whole canvas with the current viewport drawn on it.
 *
 * Zoomed in on a big run there is no way to tell where you are, and panning by
 * dragging is a slow way to cross the layout. This draws every tile as a rectangle
 * (cheap enough to redraw with the DOM at these sizes) and turns a click into a
 * jump. Rendering is capped: past a few thousand rectangles the minimap itself
 * becomes the expensive part of a frame.
 */

const MAX_W = 190;
const MAX_H = 150;
const MAX_RECTS = 1500;

interface Props {
  layout: Layout;
  transform: Transform;
  viewport: Viewport;
  selectedId: string | null;
  /** Centre the canvas on this world coordinate. */
  onJump: (worldX: number, worldY: number) => void;
}

export function Minimap({ layout, transform, viewport, selectedId, onJump }: Props) {
  const { bounds, placed } = layout;
  const worldW = Math.max(1, bounds.maxX - bounds.minX);
  const worldH = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(MAX_W / worldW, MAX_H / worldH);
  const w = Math.max(1, Math.round(worldW * scale));
  const h = Math.max(1, Math.round(worldH * scale));

  // Sampled evenly rather than truncated, so the shape of the whole layout survives.
  const rects = useMemo(() => {
    const step = Math.max(1, Math.ceil(placed.length / MAX_RECTS));
    const out = [];
    for (let i = 0; i < placed.length; i += step) out.push(placed[i]);
    if (selectedId) {
      const sel = placed.find((p) => p.tile.id === selectedId);
      if (sel && !out.includes(sel)) out.push(sel);
    }
    return out;
  }, [placed, selectedId]);

  if (!placed.length) return null;

  // The viewport rectangle in world space, clamped to the minimap's box.
  const viewX = (-transform.x / transform.scale - bounds.minX) * scale;
  const viewY = (-transform.y / transform.scale - bounds.minY) * scale;
  const viewW = (viewport.w / transform.scale) * scale;
  const viewH = (viewport.h / transform.scale) * scale;

  const jump = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onJump(
      bounds.minX + ((e.clientX - rect.left) / scale || 0),
      bounds.minY + ((e.clientY - rect.top) / scale || 0),
    );
  };

  return (
    <div
      className="absolute right-4 bottom-4 z-5 cursor-crosshair overflow-hidden rounded-[10px] border border-line bg-overlay"
      style={{ width: w, height: h }}
      onClick={jump}
      onPointerDown={(e) => e.stopPropagation()} // never start a canvas pan
      onPointerUp={(e) => e.stopPropagation()}
      role="presentation"
      data-testid="minimap"
      title="Click to jump"
    >
      {rects.map((p) => (
        <div
          key={p.tile.id}
          className={cx(
            "absolute rounded-[1px]",
            p.tile.error !== undefined
              ? "bg-amber"
              : p.tile.id === selectedId
                ? "bg-accent"
                : "bg-mini-tile",
          )}
          style={{
            left: (p.x - bounds.minX) * scale,
            top: (p.y - bounds.minY) * scale,
            width: Math.max(1, p.w * scale),
            height: Math.max(1, p.h * scale),
          }}
        />
      ))}
      <div
        className="pointer-events-none absolute rounded-[3px] border-[1.5px] border-accent bg-accent-soft"
        style={{
          left: Math.max(0, viewX),
          top: Math.max(0, viewY),
          width: Math.min(w, viewW),
          height: Math.min(h, viewH),
        }}
      />
    </div>
  );
}
