import { useMemo, useState } from "react";
import type { Device, ViewerData, ViewerTile } from "./types";
import { runLabel } from "./format";
import { routePath } from "./layout";
import { Caption, deviceIcon, Icon, IconButton, KindTag, RouteBadge, Segmented } from "./ui";

interface Props {
  data: ViewerData;
  tile: ViewerTile;
  /** URL prefix for the run's files. */
  base: string;
  onSelect: (id: string | null) => void;
  /** Step through the shots in canvas order. */
  onStep: (dir: -1 | 1) => void;
  onCompareDevices: () => void;
}

/**
 * The details panel for one shot.
 *
 * Everything here answers a question someone has after clicking a tile: which
 * route and state this is, what it looks like on the other device, where the
 * full-size image lives, and what the route's other states look like.
 */
export function Inspector({ data, tile, base, onSelect, onStep, onCompareDevices }: Props) {
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

  return (
    <aside className="vc-inspector" aria-label="Shot details">
      <div className="vc-insp-head">
        <div className="vc-insp-heading">
          <div className="vc-crumb">
            <RouteBadge path={routePath(tile.routePath)} active />
            <span aria-hidden="true">›</span>
            <span className="vc-mono">{tile.stateId}</span>
          </div>
          <div className="vc-insp-title">
            <h2>{tile.stateLabel}</h2>
            <KindTag>{tile.stateKind}</KindTag>
          </div>
        </div>
        <div className="vc-insp-nav">
          <IconButton icon="left" label="Previous shot" size={28} onClick={() => onStep(-1)} />
          <IconButton icon="right" label="Next shot" size={28} onClick={() => onStep(1)} />
          <IconButton icon="x" label="Close details" size={28} onClick={() => onSelect(null)} />
        </div>
      </div>

      {data.devices.length > 1 && (
        <div className="vc-insp-pad">
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

      <div className="vc-insp-pad">
        {tile.error ? (
          <div className="vc-insp-error" role="alert">
            <strong>
              <Icon name="alert" size={14} /> Capture failed
            </strong>
            <code>{tile.error}</code>
            <span className="vc-dim">
              A failing state usually means its recipe needs a tweak — a stale selector, a changed
              trigger, or an auth wall.
            </span>
          </div>
        ) : (
          preview && (
            <a
              className="vc-insp-preview"
              href={base + (tile.full ?? preview)}
              target="_blank"
              rel="noreferrer"
            >
              <img src={base + preview} alt={`${tile.stateLabel}, ${tile.device}`} />
            </a>
          )
        )}
      </div>

      <div className="vc-insp-actions">
        {tile.full && (
          <a
            className="vc-action is-primary"
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
            className="vc-action"
            href={new URL(tile.routeUrl, data.site.baseUrl).href}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="ext" size={14} />
            <span>Live page</span>
          </a>
        )}
        <button type="button" className="vc-action" onClick={copyLink}>
          <Icon name={copied ? "check" : "link"} size={14} />
          <span>{copied ? "Copied" : "Copy link"}</span>
        </button>
      </div>

      <section className="vc-insp-section">
        <Caption>Details</Caption>
        <dl className="vc-dl">
          <dt>Device</dt>
          <dd>
            {tile.device}
            {device && (
              <span className="vc-dim">
                {" "}
                · {device.width}×{device.height} @{device.dpr}x
              </span>
            )}
          </dd>
          {tile.width && !tile.error && (
            <>
              <dt>Image</dt>
              <dd className="vc-mono">
                {tile.width} × {tile.height} px{tile.clamped ? " (cropped)" : ""}
              </dd>
            </>
          )}
          <dt>URL</dt>
          <dd className="vc-mono">{tile.routeUrl}</dd>
          <dt>Captured</dt>
          <dd>{runLabel(data.site.runId)} UTC</dd>
        </dl>
        <div className="vc-insp-links">
          {tile.viewport && (
            <a href={base + tile.viewport} target="_blank" rel="noreferrer">
              Viewport crop ↗
            </a>
          )}
          {data.devices.length > 1 && (
            <button type="button" className="vc-link" onClick={onCompareDevices}>
              Compare devices side by side →
            </button>
          )}
        </div>
      </section>

      {siblings.length > 1 && (
        <section className="vc-insp-section">
          <Caption>Other states of {routePath(tile.routePath)}</Caption>
          <div className="vc-siblings">
            {siblings.map((s) => (
              <button
                key={s.id}
                type="button"
                className={"vc-sibling" + (s.id === tile.id ? " on" : "")}
                aria-current={s.id === tile.id}
                onClick={() => onSelect(s.id)}
              >
                <span className="vc-sibling-img">
                  {s.thumb || s.full ? (
                    <img src={base + (s.thumb ?? s.full)} alt="" loading="lazy" />
                  ) : (
                    <span className="vc-sibling-failed">!</span>
                  )}
                </span>
                <span>{s.stateLabel}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
