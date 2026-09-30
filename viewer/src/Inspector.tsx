import { useMemo, useState } from "react";
import type { Device, ViewerData, ViewerTile } from "./types";
import { runLabel } from "./format";
import { routePath } from "./layout";
import {
  ACTION,
  Caption,
  cx,
  deviceIcon,
  Icon,
  IconButton,
  KindTag,
  LINK,
  RouteBadge,
  Segmented,
} from "./ui";

interface Props {
  data: ViewerData;
  tile: ViewerTile;
  /** URL prefix for the run's files. */
  base: string;
  onSelect: (id: string | null) => void;
  /** Step through the shots in canvas order. */
  onStep: (dir: -1 | 1) => void;
  onCompareDevices: () => void;
  /** Phone layout: a sheet over the canvas instead of a side panel. */
  phone?: boolean;
}

/** The label/value grid the details (and the shortcuts popover) use. */
export const DL = "grid gap-x-3 gap-y-2 text-[12.5px] [&>dd]:wrap-anywhere [&>dt]:text-dim";

const PRIMARY = "border-accent bg-accent text-on-accent hover:bg-accent-hover hover:text-on-accent";
const SECONDARY = "border-line-strong bg-raised text-fg hover:border-dim hover:text-fg";

const SECTION = "flex flex-col gap-2.5 border-t border-line px-[18px] py-4";

/**
 * The details panel for one shot.
 *
 * Everything here answers a question someone has after clicking a tile: which
 * route and state this is, what it looks like on the other device, where the
 * full-size image lives, and what the route's other states look like.
 */
export function Inspector({ data, tile, base, onSelect, onStep, onCompareDevices, phone }: Props) {
  const [copied, setCopied] = useState(false);
  const device: Device | undefined = data.devices.find((d) => d.name === tile.device);

  // Same state on each device, and the route's other states on this device.
  const { byDevice, siblings } = useMemo(() => {
    const byDevice = new Map<string, ViewerTile>();
    const siblings: ViewerTile[] = [];
    for (const t of data.tiles) {
      if (t.routeId !== tile.routeId) continue;
      if (t.stateId === tile.stateId) byDevice.set(t.device, t);
      if (t.device === tile.device) siblings.push(t);
    }
    return { byDevice, siblings };
  }, [data, tile]);

  const copyLink = () => {
    navigator.clipboard?.writeText(location.href).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  };

  const preview = tile.mid ?? tile.full;
  const navSize = phone ? 40 : 28;

  return (
    <aside
      className={cx(
        "flex flex-col overflow-y-auto bg-panel",
        phone
          ? "fixed inset-x-0 top-[72px] bottom-0 z-15 rounded-t-2xl border-t border-line-strong shadow-sheet"
          : "w-[380px] shrink-0 border-l border-line",
      )}
      aria-label="Shot details"
    >
      <div className="flex items-start gap-2.5 pt-4 pr-3.5 pb-3.5 pl-[18px]">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-dim">
            <RouteBadge path={routePath(tile.routePath)} active />
            <span aria-hidden="true">›</span>
            <span className="truncate font-mono text-[12px]">{tile.stateId}</span>
          </div>
          <div className="flex items-center gap-2">
            <h2 className="text-[18px] font-semibold tracking-[-0.01em]">{tile.stateLabel}</h2>
            <KindTag>{tile.stateKind}</KindTag>
          </div>
        </div>
        <div className="flex gap-1">
          <IconButton icon="left" label="Previous shot" size={navSize} onClick={() => onStep(-1)} />
          <IconButton icon="right" label="Next shot" size={navSize} onClick={() => onStep(1)} />
          <IconButton
            icon="x"
            label="Close details"
            size={navSize}
            onClick={() => onSelect(null)}
          />
        </div>
      </div>

      {data.devices.length > 1 && (
        <div className="px-[18px] pb-3.5">
          <Segmented
            small
            label="Device"
            value={tile.device}
            onChange={(name) => {
              const other = byDevice.get(name);
              if (other) onSelect(other.id);
            }}
            items={data.devices.map((d) => ({
              value: d.name,
              label: d.name,
              icon: deviceIcon(d),
              disabled: !byDevice.has(d.name),
              title: byDevice.has(d.name) ? undefined : `Not captured on ${d.name}`,
            }))}
          />
        </div>
      )}

      <div className="px-[18px] pb-3.5">
        {tile.error ? (
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
        ) : (
          preview && (
            <a
              className="block max-h-80 overflow-hidden rounded-lg bg-paper shadow-[0_0_0_1px_var(--color-line-strong)]"
              href={base + (tile.full ?? preview)}
              target="_blank"
              rel="noreferrer"
            >
              <img
                className="block w-full"
                src={base + preview}
                alt={`${tile.stateLabel}, ${tile.device}`}
              />
            </a>
          )
        )}
      </div>

      <div className="flex flex-wrap gap-2 px-[18px] pb-4">
        {tile.full && (
          <a
            className={cx(ACTION, PRIMARY)}
            href={base + tile.full}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="image" size={14} />
            <span>Full image</span>
          </a>
        )}
        {data.site.baseUrl && (
          <a
            className={cx(ACTION, SECONDARY)}
            href={new URL(tile.routeUrl, data.site.baseUrl).href}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="ext" size={14} />
            <span>Live page</span>
          </a>
        )}
        <button type="button" className={cx(ACTION, SECONDARY)} onClick={copyLink}>
          <Icon name={copied ? "check" : "link"} size={14} />
          <span>{copied ? "Copied" : "Copy link"}</span>
        </button>
      </div>

      <section className={SECTION}>
        <Caption>Details</Caption>
        <dl className={cx(DL, "grid-cols-[96px_minmax(0,1fr)]")}>
          <dt>Device</dt>
          <dd>
            {tile.device}
            {device && (
              <span className="text-dim">
                {" "}
                · {device.width}×{device.height} @{device.dpr}x
              </span>
            )}
          </dd>
          {tile.width && !tile.error && (
            <>
              <dt>Image</dt>
              <dd className="font-mono text-[11.5px]">
                {tile.width} × {tile.height} px{tile.clamped ? " (cropped)" : ""}
              </dd>
            </>
          )}
          <dt>URL</dt>
          <dd className="font-mono text-[11.5px]">{tile.routeUrl}</dd>
          <dt>Captured</dt>
          <dd>{runLabel(data.site.runId)} UTC</dd>
        </dl>
        <div className="flex flex-col items-start gap-1.5 text-[12.5px]">
          {tile.viewport && (
            <a href={base + tile.viewport} target="_blank" rel="noreferrer">
              Viewport crop ↗
            </a>
          )}
          {data.devices.length > 1 && (
            <button type="button" className={LINK} onClick={onCompareDevices}>
              Compare devices side by side →
            </button>
          )}
        </div>
      </section>

      {siblings.length > 1 && (
        <section className={SECTION}>
          <Caption>Other states of {routePath(tile.routePath)}</Caption>
          <div className="flex gap-2.5 overflow-x-auto px-0.5 pt-0.5 pb-1">
            {siblings.map((s) => (
              <button
                key={s.id}
                type="button"
                className={cx(
                  "flex w-[98px] shrink-0 flex-col gap-[5px] border-0 bg-transparent p-0 text-left text-[11.5px] hover:text-fg",
                  s.id === tile.id ? "text-fg" : "text-dim",
                )}
                aria-current={s.id === tile.id}
                onClick={() => onSelect(s.id)}
              >
                <span
                  className={cx(
                    "h-[62px] overflow-hidden rounded-[5px] bg-paper",
                    s.id === tile.id
                      ? "shadow-[0_0_0_2px_var(--color-accent)]"
                      : "shadow-[0_0_0_1px_var(--color-line-strong)]",
                  )}
                >
                  {s.thumb || s.full ? (
                    <img
                      className="block w-full"
                      src={base + (s.thumb ?? s.full)}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="flex h-full items-center justify-center bg-hatch-b font-bold text-amber">
                      !
                    </span>
                  )}
                </span>
                <span className="truncate">{s.stateLabel}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
