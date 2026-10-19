import { useEffect, useMemo } from "react";
import { Canvas } from "./Canvas";
import { computeLayout, type ViewMode } from "./layout";
import { ShotActions } from "./ShotActions";
import type { ViewerData, ViewerTile } from "./types";
import { Icon, IconButton, Kbd } from "./ui";

interface Props {
  data: ViewerData;
  /** The selected shot, one of `shown`. */
  tile: ViewerTile;
  /** Its state on each device Devices has on, side by side. */
  shown: ViewerTile[];
  /** URL prefix for the run's files. */
  base: string;
  mode: ViewMode;
  onSelect: (id: string) => void;
  /** The D key: on to the shot's state on the next device. */
  onCycleDevice: (dir: -1 | 1) => void;
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
 * there, Devices picks which devices it's seen on, as on the canvas. The canvas
 * holds nothing but that state on those devices, framed in the accent, with a tab
 * saying where you are and the way out.
 */
export function FullScreen({
  data,
  tile,
  shown,
  base,
  mode,
  onSelect,
  onCycleDevice,
  onStep,
  onExit,
  position,
}: Props) {
  const layout = useMemo(
    () =>
      computeLayout(
        { ...data, tiles: shown },
        {
          devices: new Set(shown.map((t) => t.device)),
          routeId: tile.routeId,
          mode,
          uncapped: true,
        },
      ),
    [data, shown, tile.routeId, mode],
  );

  // Ahead of the canvas's own keys: the arrows step here rather than pan.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      let handled = true;
      if (e.key === "Escape" || e.key === "f") onExit();
      else if (e.key === "ArrowLeft") onStep(-1);
      else if (e.key === "ArrowRight") onStep(1);
      else if (e.key.toLowerCase() === "d") onCycleDevice(e.shiftKey ? -1 : 1);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCycleDevice, onStep, onExit]);

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
        devices={data.devices}
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
        <span className="h-4 w-px shrink-0 bg-on-accent/35" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium">{tile.stateLabel}</span>
        {position && (
          <span className="flex h-[22px] shrink-0 items-center rounded-full bg-on-accent/18 px-2 font-mono text-[11.5px]">
            {position.index} of {position.total}
          </span>
        )}
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
