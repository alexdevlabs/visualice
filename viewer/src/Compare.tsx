import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { RunDiff, ShotDiff, ShotStatus } from "./diff-types";
import type { Device } from "./types";
import { describe, ignoreRule, routeOf, type Region } from "./diff-layout";
import { diffSources } from "./load";
import { heightDelta, percent, runLabel } from "./format";
import { VirtualList } from "./VirtualList";
import {
  ACTION,
  Caption,
  Count,
  cx,
  deviceIcon,
  Icon,
  IconButton,
  KindTag,
  ROW_MAIN,
  ROW_SUB,
  RouteBadge,
  row,
  Segmented,
  SIDE_EMPTY,
  SIDE_HEAD,
  SIDE_LIST,
  SIDEBAR,
} from "./ui";

/** Must match the rows' `h-[58px]` below — the virtual list pins rows to it. */
const CHANGE_ROW_H = 58;

/** Theme tokens from index.css, so each status reads on both backgrounds. */
export const STATUS_COLOR: Record<ShotStatus, string> = {
  changed: "var(--color-st-changed)",
  added: "var(--color-st-added)",
  removed: "var(--color-st-removed)",
  unchanged: "var(--color-st-unchanged)",
  uncomparable: "var(--color-st-uncomparable)",
};

export type ReviewMode = "swipe" | "side" | "overlay" | "diff";

interface ListProps {
  shots: ShotDiff[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  devices: Device[];
  /** Phone layout: the list sits under the review instead of beside it. */
  phone?: boolean;
}

/** Every shot the filters let through, most-changed first — the review queue. */
export function ChangeList({ shots, selectedKey, onSelect, devices, phone }: ListProps) {
  const max = Math.max(1e-9, ...shots.map((s) => s.ratio ?? 0));
  return (
    <nav
      className={cx(
        SIDEBAR,
        phone ? "flex-[0_0_38%] border-t border-line" : "w-80 shrink-0 border-r border-line",
      )}
      aria-label="Changed shots"
    >
      <div className={SIDE_HEAD}>
        <Caption>Shots</Caption>
        <Count>{shots.length}</Count>
        <span className="flex-auto" />
        <span className="text-[12px] text-dim">Largest first</span>
      </div>
      {shots.length === 0 ? (
        <p className={SIDE_EMPTY}>Nothing matches these filters.</p>
      ) : (
        <VirtualList
          className={SIDE_LIST}
          items={shots}
          rowHeight={CHANGE_ROW_H}
          children={(s) => {
            const on = s.key === selectedKey;
            const delta = heightDelta(s.fromSize, s.toSize);
            return (
              <li key={s.key}>
                <button
                  type="button"
                  className={cx(row(on), "h-[58px]")}
                  aria-current={on}
                  onClick={() => onSelect(s.key)}
                >
                  <span className="flex text-dim">
                    <Icon name={deviceIcon(devices.find((d) => d.name === s.device))} size={15} />
                  </span>
                  <span className={ROW_MAIN}>
                    <span className="truncate text-[12.5px] font-medium">{s.stateLabel}</span>
                    <span className={ROW_SUB}>
                      <RouteBadge path={routeOf(s)} active={on} size="sm" />
                      {delta && <span className="text-dim">page {delta}</span>}
                    </span>
                  </span>
                  {s.status === "changed" ? (
                    <span className="flex flex-col items-end gap-1">
                      <span className="font-mono text-[11.5px] text-amber">{percent(s.ratio)}</span>
                      <span className="h-[3px] w-16 rounded-[2px] bg-line">
                        <span
                          className="block h-[3px] rounded-[2px] bg-amber"
                          style={{ width: `${Math.max(5, ((s.ratio ?? 0) / max) * 100)}%` }}
                        />
                      </span>
                    </span>
                  ) : (
                    <span
                      className="text-[11.5px] font-medium"
                      style={{ color: STATUS_COLOR[s.status] }}
                    >
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
  phone?: boolean;
}

const REVIEW = "flex min-w-0 flex-1 flex-col bg-canvas";
const FRAME = "relative overflow-hidden rounded-lg bg-white shadow-frame select-none";
const FRAME_TAG =
  "pointer-events-none absolute top-3 rounded-md bg-chip px-2 py-[3px] text-[11.5px] font-medium text-fg";

/**
 * Paint a shot's small preview behind the full image while that loads.
 *
 * A full-page PNG is megabytes; stepping through a long list of changes would
 * otherwise show a blank frame for each one. The preview is the background of the
 * very element the full image decodes into, so there is nothing to swap and no
 * second layout — the sharp picture simply arrives over the soft one.
 */
function over(preview: string | undefined, extra?: CSSProperties): CSSProperties | undefined {
  if (!preview) return extra;
  return { backgroundImage: `url("${preview}")`, backgroundSize: "100% 100%", ...extra };
}

/** A centred placeholder in the review pane, also used while a comparison loads. */
export function ReviewEmpty({ children }: { children: string }) {
  return (
    <section className={cx(REVIEW, "items-center justify-center")}>
      <p className="text-dim">{children}</p>
    </section>
  );
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
  phone,
}: ReviewProps) {
  const [split, setSplit] = useState(50);
  const [opacity, setOpacity] = useState(50);
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // Marking an ignore region: drag a box over the shot, get the rule to paste.
  const [marking, setMarking] = useState(false);
  const [region, setRegion] = useState<Region | null>(null);
  const [copied, setCopied] = useState(false);
  // True mid-drag: the rule is held back until release, so the panel showing it
  // doesn't grow and push the image out from under the pointer.
  const [drawing, setDrawing] = useState(false);
  const markFrame = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ x: number; y: number } | null>(null);
  // A region belongs to the shot it was drawn on.
  const shotKey = shot?.key;
  useEffect(() => {
    setRegion(null);
    setCopied(false);
  }, [shotKey]);

  if (!shot) {
    return <ReviewEmpty>Pick a shot on the left to review it.</ReviewEmpty>;
  }

  const src = diffSources(diff, diffId);
  const before = src.from(shot.fromShot);
  const after = src.to(shot.toShot);
  const diffImg = src.diff(shot.image);
  const beforeSoft = src.from(shot.fromPreview);
  const afterSoft = src.to(shot.toPreview);
  const diffSoft = src.diff(shot.imageThumb);
  const paired = Boolean(before && after);
  // A shot that exists on one side only has nothing to swipe against.
  const effective: ReviewMode = !paired ? "side" : mode === "diff" && !diffImg ? "side" : mode;
  const beforeLabel = diff.from.baseline
    ? `Baseline · ${runLabel(diff.from.runId)}`
    : `Before · ${runLabel(diff.from.runId)}`;
  const afterLabel = `After · ${runLabel(diff.to.runId)}`;
  const delta = heightDelta(shot.fromSize, shot.toSize);
  const cssWidth = Math.min(1100, device?.width ?? 1100);

  const canMark = Boolean(after && shot.toSize);
  const isMarking = marking && canMark;
  const rule =
    isMarking && !drawing && region && region.w > 0.002 && region.h > 0.0005 && shot.toSize
      ? ignoreRule(shot, region, shot.toSize, device?.dpr ?? 1)
      : null;
  const pointIn = (e: { clientX: number; clientY: number }) => {
    const r = markFrame.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return null;
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  const dragTo = (e: { clientX: number; clientY: number }) => {
    const p = pointIn(e);
    const a = anchor.current;
    if (!p || !a) return;
    setRegion({
      x: Math.min(a.x, p.x),
      y: Math.min(a.y, p.y),
      w: Math.abs(p.x - a.x),
      h: Math.abs(p.y - a.y),
    });
  };
  const copyRule = () => {
    if (!rule) return;
    navigator.clipboard?.writeText(rule).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  };

  const setFromPointer = (clientX: number) => {
    const r = frame.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    setSplit(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };

  return (
    <section className={REVIEW} aria-label="Review">
      <div
        className={cx(
          "flex flex-wrap items-center gap-x-3.5 gap-y-2.5 border-b border-line bg-app",
          phone ? "px-3 py-2.5" : "px-5 py-3",
        )}
      >
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div className={ROW_SUB}>
            <RouteBadge path={routeOf(shot)} />
            <strong className="truncate text-[14px] font-semibold">{shot.stateLabel}</strong>
            <KindTag>{shot.device}</KindTag>
          </div>
          <span className="text-[12px] text-dim">
            {shot.status === "changed" ? (
              <>
                <span className="font-mono text-[11.5px] text-amber">{percent(shot.ratio)}</span> of
                pixels changed
                {delta && shot.fromSize && shot.toSize && (
                  <>
                    {" "}
                    · page {delta.startsWith("+") ? "grew" : "shrank"}{" "}
                    <span className="font-mono text-[11.5px]">
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
        <span className="flex-auto" />
        {effective === "overlay" && (
          <label className="flex items-center gap-2">
            <span className="text-[12px] text-dim">After</span>
            <input
              className="w-[110px] accent-accent"
              type="range"
              min={0}
              max={100}
              value={opacity}
              onChange={(e) => setOpacity(+e.target.value)}
              aria-label="Opacity of the after image"
            />
          </label>
        )}
        <IconButton
          icon="region"
          label={isMarking ? "Stop marking" : "Mark a region to ignore in future diffs"}
          pressed={isMarking}
          disabled={!canMark}
          onClick={() => setMarking((v) => !v)}
        />
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
        <div className="flex items-center gap-1.5">
          <IconButton
            icon="left"
            label="Previous change (←)"
            onClick={() => onStep(-1)}
            disabled={index <= 0}
          />
          <span className="min-w-11 text-center font-mono text-[12px] text-dim">
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

      {isMarking && (
        <div
          className={cx(
            "flex flex-wrap items-start gap-3 border-b border-line bg-panel text-[12.5px]",
            phone ? "px-3 py-2.5" : "px-5 py-3",
          )}
        >
          {rule ? (
            <>
              <pre className="max-h-40 min-w-0 flex-1 overflow-auto rounded-md border border-line bg-app px-3 py-2 font-mono text-[11.5px]">
                {rule}
              </pre>
              <div className="flex max-w-[260px] flex-col items-start gap-2">
                <button
                  type="button"
                  className={cx(
                    ACTION,
                    "border-accent bg-accent text-on-accent hover:bg-accent-hover",
                  )}
                  onClick={copyRule}
                >
                  <Icon name={copied ? "check" : "link"} size={14} />
                  <span>{copied ? "Copied" : "Copy rule"}</span>
                </button>
                <span className="text-dim">
                  Add it to <code>diff.rules</code> in your config, then run{" "}
                  <code>visualice diff</code> again. No re-crawl needed.
                </span>
              </div>
            </>
          ) : (
            <span className="text-dim">
              Drag a box over the part of the page that should not count as a change — a timestamp,
              an ad, a carousel.
            </span>
          )}
        </div>
      )}

      <div className={cx("min-h-0 flex-1 overflow-auto", phone ? "p-3" : "p-5")}>
        {isMarking ? (
          <div
            ref={markFrame}
            className={cx(FRAME, "mx-auto cursor-crosshair touch-none")}
            style={{ maxWidth: cssWidth }}
            onPointerDown={(e) => {
              const p = pointIn(e);
              if (!p) return;
              anchor.current = p;
              setDrawing(true);
              e.currentTarget.setPointerCapture(e.pointerId);
              setRegion({ ...p, w: 0, h: 0 });
            }}
            onPointerMove={(e) => anchor.current && dragTo(e)}
            onPointerUp={() => {
              anchor.current = null;
              setDrawing(false);
            }}
            onPointerCancel={() => {
              anchor.current = null;
              setDrawing(false);
            }}
          >
            <img
              className="block w-full"
              src={after!}
              alt={afterLabel}
              draggable={false}
              width={shot.toSize?.width}
              height={shot.toSize?.height}
              style={over(afterSoft)}
            />
            {region && (
              <div
                className="pointer-events-none absolute border-2 border-accent bg-accent-soft"
                data-testid="ignore-region"
                style={{
                  left: `${region.x * 100}%`,
                  top: `${region.y * 100}%`,
                  width: `${region.w * 100}%`,
                  height: `${region.h * 100}%`,
                }}
              />
            )}
            <span className={cx(FRAME_TAG, "left-3")}>{afterLabel}</span>
          </div>
        ) : effective === "side" ? (
          <div
            className="mx-auto grid auto-cols-[minmax(0,1fr)] grid-flow-col items-start gap-5"
            style={{ maxWidth: cssWidth * 2 + 20 }}
          >
            {[
              {
                label: beforeLabel,
                src: before,
                soft: beforeSoft,
                size: shot.fromSize,
                missing: "Before: not in the old run",
              },
              {
                label: afterLabel,
                src: after,
                soft: afterSoft,
                size: shot.toSize,
                missing: "After: gone from the new run",
              },
            ].map(({ label, src, soft, size, missing }) =>
              src ? (
                <figure key={label} className={FRAME}>
                  <img
                    className="block w-full"
                    src={src}
                    alt={label}
                    width={size?.width}
                    height={size?.height}
                    style={over(soft)}
                  />
                  <figcaption className={cx(FRAME_TAG, "left-3")}>{label}</figcaption>
                </figure>
              ) : (
                <div
                  key={label}
                  className="flex min-h-60 items-center justify-center rounded-lg border border-dashed border-line-strong"
                >
                  <span className="text-dim">{missing}</span>
                </div>
              ),
            )}
          </div>
        ) : effective === "diff" ? (
          <figure className={cx(FRAME, "mx-auto")} style={{ maxWidth: cssWidth }}>
            <img
              className="block w-full"
              src={diffImg!}
              alt="Changed pixels highlighted"
              style={over(diffSoft)}
            />
            <figcaption className={cx(FRAME_TAG, "left-3")}>Changed pixels</figcaption>
          </figure>
        ) : (
          <div
            ref={frame}
            className={cx(
              FRAME,
              "mx-auto",
              effective === "swipe" && "cursor-ew-resize touch-pan-y",
            )}
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
              className="block w-full"
              src={effective === "swipe" ? after! : before!}
              alt={effective === "swipe" ? afterLabel : beforeLabel}
              draggable={false}
              style={over(effective === "swipe" ? afterSoft : beforeSoft)}
            />
            <img
              className="absolute top-0 left-0 block w-full"
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
              <div
                className="absolute top-0 bottom-0 -ml-px w-0.5 bg-accent"
                style={{ left: `${split}%` }}
              >
                <div
                  className="sticky top-[180px] mt-[180px] -ml-[17px] flex size-9 items-center justify-center rounded-full bg-accent text-on-accent shadow-float"
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
            <span className={cx(FRAME_TAG, "left-3")}>
              {effective === "swipe" ? beforeLabel : `${afterLabel} at ${opacity}% over before`}
            </span>
            {effective === "swipe" && (
              <span className={cx(FRAME_TAG, "right-3")}>{afterLabel}</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
