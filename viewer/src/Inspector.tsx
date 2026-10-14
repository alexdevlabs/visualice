import { useEffect, useMemo, useState } from "react";
import { parseViolations, type ShotViolation } from "./load";
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
export function Inspector({ data, tile, base, onSelect, onStep, phone }: Props) {
  const [copied, setCopied] = useState(false);
  const device: Device | undefined = data.devices.find((d) => d.name === tile.device);

  // The same state on each device.
  const byDevice = useMemo(() => {
    const byDevice = new Map<string, ViewerTile>();
    for (const t of data.tiles) {
      if (t.routeId === tile.routeId && t.stateId === tile.stateId) byDevice.set(t.device, t);
    }
    return byDevice;
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

  const preview = tile.mid ?? tile.full;
  const fileName = tile.full
    ? `${tile.routePath.replace(/[^a-zA-Z0-9._-]+/g, "-")}--${tile.stateId}--${tile.device}.${tile.full.split(".").pop()}`
    : undefined;
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
        {tile.full && (
          <a className={cx(ACTION, SECONDARY)} href={base + tile.full} download={fileName}>
            <Icon name="download" size={14} />
            <span>Download</span>
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
                {tile.width} × {tile.height} px
                {tile.screens ? ` · ${tile.screens} screens` : ""}
                {tile.clamped ? " (cropped)" : ""}
              </dd>
            </>
          )}
          <dt>URL</dt>
          <dd className="font-mono text-[11.5px]">{tile.routeUrl}</dd>
          <dt>Captured</dt>
          <dd>{runLabel(data.site.runId)} UTC</dd>
          {tile.a11y === 0 && (
            <>
              <dt>Accessibility</dt>
              <dd>No violations found</dd>
            </>
          )}
        </dl>
        <div className="flex flex-col items-start gap-1.5 text-[12.5px]">
          {tile.viewport && (
            <a href={base + tile.viewport} target="_blank" rel="noreferrer">
              Viewport crop ↗
            </a>
          )}
        </div>
      </section>

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
    </aside>
  );
}
