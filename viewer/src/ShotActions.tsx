import { useState } from "react";
import type { ViewerData, ViewerTile } from "./types";
import { liveUrl } from "./format";
import { Icon } from "./ui";

/** The panel's version: a grid of tiles, an icon over each name. */
const TILE =
  "flex flex-col items-center gap-1.5 rounded-[10px] border-0 bg-app px-1 py-2.5 text-[11.5px] font-medium text-fg no-underline hover:bg-canvas hover:text-fg hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)] motion-safe:transition-[background-color,box-shadow,color] motion-safe:duration-120 active:translate-y-px";

/** The floating bar's version: a row of buttons, the icon beside each name. */
const BAR =
  "flex h-8 items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5 text-[12.5px] font-medium whitespace-nowrap text-fg no-underline hover:bg-hover hover:text-fg motion-safe:transition-colors motion-safe:duration-120 active:translate-y-px";

/**
 * What can be done with a shot: see it full screen, visit the live page, copy a
 * link here, download or open the full image.
 *
 * The details panel's buttons and the floating bar under the selected shot are the
 * same set, 1:1 — same actions, same order, same names. Both render this component
 * so they can't drift: add, remove or rename an action here, never in one place
 * only. Only the look differs, by `variant`. The viewer's integration test checks it.
 */
export function ShotActions({
  data,
  tile,
  base,
  variant,
  full,
  onFullScreen,
}: {
  data: ViewerData;
  tile: ViewerTile;
  /** URL prefix for the run's files. */
  base: string;
  variant: "tiles" | "bar";
  /** In full screen: the first action leaves it instead of entering it. */
  full?: boolean;
  onFullScreen?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    navigator.clipboard?.writeText(location.href).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  };

  const fileName = tile.full
    ? `${tile.routePath.replace(/[^a-zA-Z0-9._-]+/g, "-")}--${tile.stateId}--${tile.device}.${tile.full.split(".").pop()}`
    : undefined;
  const bar = variant === "bar";
  const plain = bar ? BAR : TILE;
  const size = bar ? 15 : undefined;

  return (
    <>
      {onFullScreen && (
        <>
          <button
            type="button"
            className={plain}
            onClick={onFullScreen}
            title={full ? "Exit full screen (Esc)" : "Full screen (F)"}
          >
            <Icon name={full ? "collapse" : "expand"} size={size} />
            <span>{full ? "Exit full screen" : "Full screen"}</span>
          </button>
          {bar && <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />}
        </>
      )}
      {(data.site.liveBase || data.site.baseUrl) && (
        <a
          className={plain}
          href={liveUrl(tile.routeUrl, data.site)}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="ext" size={size} />
          <span>Live page</span>
        </a>
      )}
      <button type="button" className={plain} onClick={copyLink}>
        <Icon name={copied ? "check" : "link"} size={size} />
        <span>{copied ? "Copied" : "Copy link"}</span>
      </button>
      {tile.full && (
        <a className={plain} href={base + tile.full} download={fileName}>
          <Icon name="download" size={size} />
          <span>Download</span>
        </a>
      )}
      {tile.full && (
        <a className={plain} href={base + tile.full} target="_blank" rel="noreferrer">
          <Icon name="image" size={size} />
          <span>Full image</span>
        </a>
      )}
    </>
  );
}
