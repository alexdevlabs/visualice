import { useRef, useState } from "react";
import type { RunDiff, ShotDiff, ShotStatus } from "./diff-types";
import type { Device } from "./types";
import { describe } from "./diff-layout";
import { heightDelta, percent, runLabel } from "./format";
import { VirtualList } from "./VirtualList";
import { Caption, Count, deviceIcon, Icon, IconButton, KindTag, RouteBadge, Segmented } from "./ui";

/** Must match `.vc-change-row` in styles.css — the virtual list pins rows to it. */
const CHANGE_ROW_H = 58;

/** Theme tokens from styles.css, so each status reads on both backgrounds. */
export const STATUS_COLOR: Record<ShotStatus, string> = {
  changed: "var(--st-changed)",
  added: "var(--st-added)",
  removed: "var(--st-removed)",
  unchanged: "var(--st-unchanged)",
  uncomparable: "var(--st-uncomparable)",
};

export type ReviewMode = "swipe" | "side" | "overlay" | "diff";

const routeOf = (s: ShotDiff) => s.routeUrl ?? (s.route === "home" ? "/" : "/" + s.route);

interface ListProps {
  shots: ShotDiff[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  devices: Device[];
}

/** Every shot the filters let through, most-changed first — the review queue. */
export function ChangeList({ shots, selectedKey, onSelect, devices }: ListProps) {
  const max = Math.max(1e-9, ...shots.map((s) => s.ratio ?? 0));
  return (
    <nav className="vc-sidebar is-wide" aria-label="Changed shots">
      <div className="vc-side-head">
        <Caption>Shots</Caption>
        <Count>{shots.length}</Count>
        <span className="vc-grow" />
        <span className="vc-dim vc-small">Largest first</span>
      </div>
      {shots.length === 0 ? (
        <p className="vc-side-empty">Nothing matches these filters.</p>
      ) : (
        <VirtualList
          className="vc-side-list"
          items={shots}
          rowHeight={CHANGE_ROW_H}
          children={(s) => {
            const on = s.key === selectedKey;
            const delta = heightDelta(s.fromSize, s.toSize);
            return (
              <li key={s.key}>
                <button
                  type="button"
                  className={"vc-change-row" + (on ? " on" : "")}
                  aria-current={on}
                  onClick={() => onSelect(s.key)}
                >
                  <span className="vc-row-icon">
                    <Icon name={deviceIcon(devices.find((d) => d.name === s.device))} size={15} />
                  </span>
                  <span className="vc-row-main">
                    <span className="vc-row-title">{s.stateLabel}</span>
                    <span className="vc-row-sub">
                      <RouteBadge path={routeOf(s)} active={on} small />
                      {delta && <span className="vc-dim">page {delta}</span>}
                    </span>
                  </span>
                  {s.status === "changed" ? (
                    <span className="vc-row-metric">
                      <span className="vc-mono vc-amber">{percent(s.ratio)}</span>
                      <span className="vc-bar">
                        <span style={{ width: `${Math.max(5, ((s.ratio ?? 0) / max) * 100)}%` }} />
                      </span>
                    </span>
                  ) : (
                    <span className="vc-row-status" style={{ color: STATUS_COLOR[s.status] }}>
                      {s.status}
                    </span>
                  )}
                </button>
              </li>
            );
          }}
        />
      )}
    </nav>
  );
}

interface ReviewProps {
  diff: RunDiff;
  diffId: string;
  shot: ShotDiff | null;
  index: number;
  total: number;
  onStep: (dir: -1 | 1) => void;
  mode: ReviewMode;
  onMode: (m: ReviewMode) => void;
  device?: Device;
}

/**
 * One shot, before against after.
 *
 * Swipe is the default because it's the fastest way to see what moved: the eye
 * catches the seam crossing a change. Side by side and overlay are there for the
 * cases swipe hides (a shift of the whole page), and the diff image for the pixels
 * the engine actually counted.
 */
export function Review({
  diff,
  diffId,
  shot,
  index,
  total,
  onStep,
  mode,
  onMode,
  device,
}: ReviewProps) {
  const [split, setSplit] = useState(50);
  const [opacity, setOpacity] = useState(50);
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  if (!shot) {
    return (
      <section className="vc-review is-empty">
        <p className="vc-dim">Pick a shot on the left to review it.</p>
      </section>
    );
  }

  const before = shot.fromShot && `./runs/${diff.from.runId}/${shot.fromShot}`;
  const after = shot.toShot && `./runs/${diff.to.runId}/${shot.toShot}`;
  const diffImg = shot.image && `./diffs/${diffId}/${shot.image}`;
  const paired = Boolean(before && after);
  // A shot that exists on one side only has nothing to swipe against.
  const effective: ReviewMode = !paired ? "side" : mode === "diff" && !diffImg ? "side" : mode;
  const beforeLabel = `Before · ${runLabel(diff.from.runId)}`;
  const afterLabel = `After · ${runLabel(diff.to.runId)}`;
  const delta = heightDelta(shot.fromSize, shot.toSize);
  const cssWidth = Math.min(1100, device?.width ?? 1100);

  const setFromPointer = (clientX: number) => {
    const r = frame.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    setSplit(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };

  return (
    <section className="vc-review" aria-label="Review">
      <div className="vc-review-head">
        <div className="vc-review-title">
          <div className="vc-row-sub">
            <RouteBadge path={routeOf(shot)} />
            <strong>{shot.stateLabel}</strong>
            <KindTag>{shot.device}</KindTag>
          </div>
          <span className="vc-dim vc-small">
            {shot.status === "changed" ? (
              <>
                <span className="vc-mono vc-amber">{percent(shot.ratio)}</span> of pixels changed
                {delta && shot.fromSize && shot.toSize && (
                  <>
                    {" "}
                    · page {delta.startsWith("+") ? "grew" : "shrank"}{" "}
                    <span className="vc-mono">
                      {shot.fromSize.height} → {shot.toSize.height} px
                    </span>
                  </>
                )}
              </>
            ) : (
              describe(shot)
            )}
          </span>
        </div>
        <span className="vc-grow" />
        {effective === "overlay" && (
          <label className="vc-opacity">
            <span className="vc-dim vc-small">After</span>
            <input
              type="range"
              min={0}
              max={100}
              value={opacity}
              onChange={(e) => setOpacity(+e.target.value)}
              aria-label="Opacity of the after image"
            />
          </label>
        )}
        <Segmented<ReviewMode>
          small
          label="Review mode"
          value={effective}
          onChange={onMode}
          items={[
            { value: "swipe", label: "Swipe", icon: "swap", disabled: !paired },
            { value: "side", label: "Side by side", icon: "grouped" },
            { value: "overlay", label: "Overlay", icon: "image", disabled: !paired },
            { value: "diff", label: "Diff", icon: "cursor", disabled: !diffImg },
          ]}
        />
        <div className="vc-stepper">
          <IconButton
            icon="left"
            label="Previous change (←)"
            onClick={() => onStep(-1)}
            disabled={index <= 0}
          />
          <span className="vc-mono vc-dim">
            {index + 1} / {total}
          </span>
          <IconButton
            icon="right"
            label="Next change (→)"
            onClick={() => onStep(1)}
            disabled={index >= total - 1}
          />
        </div>
      </div>

      <div className="vc-review-scroll">
        {effective === "side" ? (
          <div className="vc-side-by-side" style={{ maxWidth: cssWidth * 2 + 20 }}>
            {[
              { label: beforeLabel, src: before, missing: "Before: not in the old run" },
              { label: afterLabel, src: after, missing: "After: gone from the new run" },
            ].map(({ label, src, missing }) =>
              src ? (
                <figure key={label} className="vc-frame">
                  <img src={src} alt={label} />
                  <figcaption className="vc-frame-tag">{label}</figcaption>
                </figure>
              ) : (
                <div key={label} className="vc-frame is-missing">
                  <span className="vc-dim">{missing}</span>
                </div>
              ),
            )}
          </div>
        ) : effective === "diff" ? (
          <figure className="vc-frame" style={{ maxWidth: cssWidth }}>
            <img src={diffImg!} alt="Changed pixels highlighted" />
            <figcaption className="vc-frame-tag">Changed pixels</figcaption>
          </figure>
        ) : (
          <div
            ref={frame}
            className={"vc-frame is-stacked" + (effective === "swipe" ? " is-swipe" : "")}
            style={{ maxWidth: cssWidth }}
            onPointerDown={(e) => {
              if (effective !== "swipe") return;
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              setFromPointer(e.clientX);
            }}
            onPointerMove={(e) => dragging.current && setFromPointer(e.clientX)}
            onPointerUp={() => (dragging.current = false)}
          >
            {/* Swipe clips `before` over `after`; overlay fades `after` over `before`. */}
            <img
              src={effective === "swipe" ? after! : before!}
              alt={effective === "swipe" ? afterLabel : beforeLabel}
              draggable={false}
            />
            <img
              className="vc-frame-top"
              src={effective === "swipe" ? before! : after!}
              alt=""
              draggable={false}
              style={
                effective === "swipe"
                  ? { clipPath: `inset(0 ${100 - split}% 0 0)` }
                  : { opacity: opacity / 100 }
              }
            />
            {effective === "swipe" && (
              <div className="vc-swipe-line" style={{ left: `${split}%` }}>
                <div
                  className="vc-swipe-knob"
                  role="slider"
                  tabIndex={0}
                  aria-label="Swipe between before and after"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(split)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      e.preventDefault();
                      e.stopPropagation();
                      setSplit((v) =>
                        Math.max(0, Math.min(100, v + (e.key === "ArrowLeft" ? -5 : 5))),
                      );
                    }
                  }}
                >
                  <Icon name="grip" size={18} stroke={2.2} />
                </div>
              </div>
            )}
            <span className="vc-frame-tag">
              {effective === "swipe" ? beforeLabel : `${afterLabel} at ${opacity}% over before`}
            </span>
            {effective === "swipe" && <span className="vc-frame-tag is-right">{afterLabel}</span>}
          </div>
        )}
      </div>
    </section>
  );
}
