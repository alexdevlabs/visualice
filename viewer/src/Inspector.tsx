import { useEffect, useMemo, useState } from "react";
import { parseViolations, type ShotViolation } from "./load";
import type { Device, ViewerData, ViewerTile } from "./types";
import { runLabel } from "./format";
import { routePath } from "./layout";
import { ShotActions } from "./ShotActions";
import { Caption, cx, deviceIcon, Icon, KindTag } from "./ui";

interface Props {
  data: ViewerData;
  tile: ViewerTile;
  /** URL prefix for the run's files. */
  base: string;
  onSelect: (id: string | null) => void;
  /** Step through the shots in canvas order. */
  onStep: (dir: -1 | 1) => void;
  /** Phone layout: a sheet over the canvas instead of a side panel. */
  phone?: boolean;
  /** Closing: slide out, then `onClosed` unmounts it. */
  closing?: boolean;
  onClosed?: () => void;
  /** Where this shot sits in the canvas order, 1-based. */
  position?: { index: number; total: number };
  /** Open this shot full screen. */
  onFullScreen?: () => void;
}

/** The label/value grid the details (and the shortcuts popover) use. */
export const DL = "grid gap-x-3 gap-y-2 text-[12.5px] [&>dd]:wrap-anywhere [&>dt]:text-dim";

/** A fact about the shot, as a label and value in one chip. */
const FACT =
  "flex min-w-0 items-center gap-1.5 rounded-full bg-app px-2.5 py-1 text-[12px] text-fg";

const SECTION = "flex flex-col gap-2.5 border-t border-line px-[18px] py-4";

/**
 * The details panel for one shot.
 *
 * Everything here answers a question someone has after clicking a tile: which
 * route and state this is, what it looks like on the other device, and where the
 * full-size image lives.
 */
export function Inspector({
  data,
  tile,
  base,
  onSelect,
  onStep,
  phone,
  closing,
  onClosed,
  position,
  onFullScreen,
}: Props) {
  const device: Device | undefined = data.devices.find((d) => d.name === tile.device);

  // The same state on each device.
  const byDevice = useMemo(() => {
    const byDevice = new Map<string, ViewerTile>();
    for (const t of data.tiles) {
      if (t.routeId === tile.routeId && t.stateId === tile.stateId) byDevice.set(t.device, t);
    }
    return byDevice;
  }, [data, tile]);

  // The elements behind the count live in the shot's sidecar; fetch it only when
  // there is something to list.
  const [violations, setViolations] = useState<ShotViolation[] | null>(null);
  const sidecar = tile.a11y && tile.meta ? base + tile.meta : null;
  useEffect(() => {
    setViolations(null);
    if (!sidecar) return;
    let live = true;
    fetch(sidecar)
      .then((r) => (r.ok ? r.json() : null))
      .then((raw: unknown) => live && setViolations(parseViolations(raw)))
      .catch(() => live && setViolations([]));
    return () => {
      live = false;
    };
  }, [sidecar]);

  const navSize = phone ? 40 : 32;

  return (
    <aside
      className={cx(
        "flex flex-col overflow-hidden bg-panel",
        phone
          ? "fixed inset-x-0 top-[72px] bottom-0 z-15 rounded-t-2xl border-t border-line-strong shadow-sheet"
          : "w-[380px] shrink-0 border-l border-line",
        phone
          ? closing
            ? "animate-sheet-out"
            : "animate-sheet-in"
          : closing
            ? "animate-panel-out"
            : "animate-panel-in",
        // Still an animation, so `onAnimationEnd` fires and the panel goes.
        "motion-reduce:[animation-duration:1ms]",
      )}
      aria-label="Shot details"
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) onClosed?.();
      }}
    >
      <div className="flex min-h-0 flex-auto flex-col overflow-y-auto">
        <div className="flex flex-col gap-3 px-4 pt-3.5 pb-1">
          <div className="flex items-center gap-1.5">
            {data.devices.length > 1 && (
              <div
                role="radiogroup"
                aria-label="Device"
                className="flex gap-0.5 rounded-[10px] bg-app p-[3px]"
              >
                {data.devices.map((d) => {
                  const other = byDevice.get(d.name);
                  return (
                    <button
                      key={d.name}
                      type="button"
                      role="radio"
                      aria-checked={d.name === tile.device}
                      aria-label={d.name}
                      disabled={!other}
                      title={other ? `${d.name} · ${d.width}px wide` : `Not captured on ${d.name}`}
                      onClick={() => other && onSelect(other.id)}
                      className="flex h-[26px] items-center gap-1.5 rounded-[7px] border-0 bg-transparent px-2 text-[11.5px] font-semibold text-dim enabled:hover:text-fg aria-checked:bg-fg aria-checked:text-app"
                    >
                      <Icon name={deviceIcon(d)} size={13} />
                      <span className="font-mono">{d.width}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <span className="flex-auto" />
            {(
              [
                ["left", "Previous shot", () => onStep(-1)],
                ["right", "Next shot", () => onStep(1)],
                ["x", "Close details", () => onSelect(null)],
              ] as const
            ).map(([icon, label, onClick]) => (
              <button
                key={icon}
                type="button"
                aria-label={label}
                title={label}
                onClick={onClick}
                className="flex shrink-0 items-center justify-center rounded-[9px] border border-line bg-panel p-0 text-fg hover:border-line-strong hover:text-accent"
                style={{ width: navSize, height: navSize }}
              >
                <Icon name={icon} size={15} />
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-mono text-[11.5px] text-dim">
              {routePath(tile.routePath)} · {tile.stateId}
            </span>
            <h2 className="truncate text-[22px] leading-7 font-bold tracking-[-0.01em]">
              {tile.stateLabel}
            </h2>
          </div>
          {tile.error && (
            <div
              className="flex flex-col gap-1.5 rounded-lg border border-amber-line bg-amber-soft p-3 text-[12px]"
              role="alert"
            >
              <strong className="flex items-center gap-1.5 text-amber">
                <Icon name="alert" size={14} /> Capture failed
              </strong>
              <code className="[word-break:break-word]">{tile.error}</code>
              <span className="text-dim">
                A failing state usually means its recipe needs a tweak — a stale selector, a changed
                trigger, or an auth wall.
              </span>
            </div>
          )}
        </div>

        <ul
          className="m-0 flex list-none flex-wrap gap-1.5 border-t border-line px-4 py-3.5"
          aria-label="Details"
        >
          {device && (
            <li className={FACT}>
              <span className="text-dim">Viewport</span>
              {device.width}×{device.height} @{device.dpr}x
            </li>
          )}
          {tile.width && !tile.error && (
            <li className={FACT}>
              <span className="text-dim">Image</span>
              <span className="font-mono text-[11.5px]">
                {tile.width}×{tile.height}
                {tile.clamped ? " (cropped)" : ""}
              </span>
            </li>
          )}
          {tile.screens ? (
            <li className={FACT}>
              <span className="text-dim">Screens</span>
              {tile.screens}
            </li>
          ) : null}
          <li className={cx(FACT, "max-w-full")}>
            <span className="text-dim">URL</span>
            <span className="truncate font-mono text-[11.5px]">{tile.routeUrl}</span>
          </li>
          {tile.viewport && (
            <li className={FACT}>
              <a href={base + tile.viewport} target="_blank" rel="noreferrer">
                Viewport crop ↗
              </a>
            </li>
          )}
        </ul>

        {tile.a11y ? (
          <section className={SECTION} aria-label="Accessibility">
            <div className="flex items-center gap-2">
              <Caption>Accessibility</Caption>
              <span className="rounded-[4px] border border-amber-line bg-amber-soft px-[5px] font-mono text-[11px] leading-[17px] text-amber">
                {tile.a11y} {tile.a11y === 1 ? "rule" : "rules"} broken
              </span>
            </div>
            {violations === null ? (
              <span className="text-[12.5px] text-dim">Loading…</span>
            ) : violations.length === 0 ? (
              <span className="text-[12.5px] text-dim">
                The details for this shot couldn’t be read.
              </span>
            ) : (
              <ul className="flex flex-col gap-2.5 text-[12.5px]">
                {violations.map((v) => (
                  <li key={v.id} className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {v.impact && <KindTag>{v.impact}</KindTag>}
                      {v.helpUrl ? (
                        <a href={v.helpUrl} target="_blank" rel="noreferrer">
                          {v.help}
                        </a>
                      ) : (
                        <span>{v.help}</span>
                      )}
                    </span>
                    <span className="text-dim">
                      {v.count} {v.count === 1 ? "element" : "elements"}
                      {v.targets[0] && (
                        <>
                          {" · "}
                          <code className="wrap-anywhere">{v.targets[0]}</code>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
      {/* Pinned to the foot, where the hand ends up after reading. */}
      <div className="grid shrink-0 grid-cols-5 gap-1.5 border-t border-line px-4 py-3.5">
        <ShotActions
          data={data}
          tile={tile}
          base={base}
          variant="tiles"
          onFullScreen={onFullScreen}
        />
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-4 py-3 text-[12px] text-dim">
        <span>Captured {runLabel(data.site.runId)} UTC</span>
        {position && (
          <span className="tabular-nums">
            Shot {position.index} of {position.total}
          </span>
        )}
      </div>
    </aside>
  );
}
