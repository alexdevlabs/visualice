import { useEffect, useMemo } from "react";
import { Canvas } from "./Canvas";
import { computeLayout, type ViewMode } from "./layout";
import { ShotActions } from "./ShotActions";
import type { ViewerData, ViewerTile } from "./types";
import { Icon, IconButton, Kbd } from "./ui";

interface Props {
  data: ViewerData;
  tile: ViewerTile;
  /** URL prefix for the run's files. */
  base: string;
  mode: ViewMode;
  /** The shot's state on each device it was captured on, for the D key. */
  sameState: Map<string, ViewerTile>;
  onSelect: (id: string) => void;
  /** Step through this device's shots in canvas order. */
  onStep: (dir: -1 | 1) => void;
  onExit: () => void;
  /** Where this shot sits among this device's shots, 1-based. */
  position?: { index: number; total: number };
}

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/**
 * One shot, full screen: the body under the viewer's own header and toolbar —
 * there, Devices picks the one device it's seen on. The canvas holds nothing but
 * that shot, framed in the accent, with a tab saying where you are and the way out.
 */
export function FullScreen({
  data,
  tile,
  base,
  mode,
  sameState,
  onSelect,
  onStep,
  onExit,
  position,
}: Props) {
  const layout = useMemo(
    () =>
      computeLayout(
        { ...data, tiles: [tile] },
        { devices: new Set([tile.device]), routeId: tile.routeId, mode, uncapped: true },
      ),
    [data, tile, mode],
  );

  // Ahead of the canvas's own keys: the arrows step here rather than pan.
  useEffect(() => {
    const cycle = (dir: -1 | 1) => {
      const have = data.devices.flatMap((d) => sameState.get(d.name) ?? []);
      const i = have.indexOf(tile);
      const next = have[(i + dir + have.length) % have.length];
      if (next && next !== tile) onSelect(next.id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      let handled = true;
      if (e.key === "Escape" || e.key === "f") onExit();
      else if (e.key === "ArrowLeft") onStep(-1);
      else if (e.key === "ArrowRight") onStep(1);
      else if (e.key.toLowerCase() === "d") cycle(e.shiftKey ? -1 : 1);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [data, sameState, tile, onSelect, onStep, onExit]);

  return (
    <div className="relative min-h-0 flex-auto" role="region" aria-label="Full screen">
      <Canvas
        layout={layout}
        selectedId={tile.id}
        onSelect={(id) => id && onSelect(id)}
        base={base}
        showMinimap={false}
        mode={mode}
        solo
        selectionBar={
          <ShotActions
            data={data}
            tile={tile}
            base={base}
            variant="bar"
            full
            onFullScreen={onExit}
          />
        }
      />
      {/* Drawn over the canvas, not around it: the frame takes no room from the shot. */}
      <div
        className="pointer-events-none absolute inset-0 z-5 shadow-[inset_0_0_0_3px_var(--color-accent)]"
        aria-hidden="true"
      />
      <div className="absolute top-0 left-1/2 z-6 flex h-[34px] max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2.5 rounded-b-xl bg-accent pr-1.5 pl-3.5 text-[12.5px] whitespace-nowrap text-on-accent">
        <Icon name="expand" size={15} />
        <span className="font-semibold">Full screen</span>
        <span className="min-w-0 truncate opacity-85">
          · {tile.stateLabel} · {tile.device}
          {position && ` · ${position.index} of ${position.total}`}
        </span>
        <button
          type="button"
          onClick={onExit}
          title="Exit full screen (Esc)"
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border-0 bg-on-accent/18 px-2 text-[12px] font-medium text-on-accent hover:bg-on-accent/28"
        >
          Exit <Kbd className="border-on-accent/40 bg-transparent text-on-accent">Esc</Kbd>
        </button>
      </div>
      <span className="absolute top-1/2 left-6 z-6 -translate-y-1/2">
        <IconButton icon="left" label="Previous shot (←)" size={40} onClick={() => onStep(-1)} />
      </span>
      <span className="absolute top-1/2 right-6 z-6 -translate-y-1/2">
        <IconButton icon="right" label="Next shot (→)" size={40} onClick={() => onStep(1)} />
      </span>
    </div>
  );
}
