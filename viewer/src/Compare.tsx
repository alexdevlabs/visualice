import { useEffect, useState } from "react";
import { fetchViewerData } from "./load";
import { runLabel } from "./format";
import type { ViewerData, ViewerTile } from "./types";
import { Caption, cx } from "./ui";

/** Other versions of the site this shot can be compared with. */
export interface CompareRuns {
  /** Run ids, newest first, without the one on screen. */
  runs: string[];
  /** Where a run's files are served. */
  baseFor: (run: string) => string;
  /** The run on screen. */
  current: string;
}

/** Each run's data, fetched once: stepping through shots compares against the same run. */
const cache = new Map<string, Promise<ViewerData>>();
function loadRun(url: string): Promise<ViewerData> {
  let hit = cache.get(url);
  if (!hit) {
    hit = fetchViewerData(url);
    hit.catch(() => cache.delete(url));
    cache.set(url, hit);
  }
  return hit;
}

/** The run a shot was really taken in: its own run, or the one it was carried from. */
const takenIn = (tile: ViewerTile, run: string): string => tile.carried?.runId ?? run;

/**
 * The same shot in another version of the site, side by side with this one. Shots
 * match by id (route, state and device), which stays put across runs. Two shots
 * taken in the same run are the same image: a partial run carried it over.
 */
export function Compare({
  tile,
  base,
  compare,
}: {
  tile: ViewerTile;
  base: string;
  compare: CompareRuns;
}) {
  // The version before this one by default: what "what changed?" usually means.
  const older = compare.runs.find((r) => r < compare.current);
  const [other, setOther] = useState(older ?? compare.runs[0]);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    { run: string; tile?: ViewerTile; error?: string } | undefined
  >();

  // A string, not `compare`: the parent builds that object afresh on every render.
  const otherBase = other ? compare.baseFor(other) : "";
  useEffect(() => {
    if (!open || !other) return;
    let live = true;
    setState(undefined);
    loadRun(otherBase + "viewer-data.json")
      .then(
        (data) => live && setState({ run: other, tile: data.tiles.find((t) => t.id === tile.id) }),
      )
      .catch((e: Error) => live && setState({ run: other, error: e.message }));
    return () => {
      live = false;
    };
  }, [open, other, otherBase, tile.id]);

  const theirs = state?.tile;
  const same = theirs && takenIn(theirs, other) === takenIn(tile, compare.current);

  return (
    <details
      className="group border-t border-line"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-[18px] py-3.5 select-none [&::-webkit-details-marker]:hidden">
        <Caption>Compare with another version</Caption>
        <span className="text-[11px] text-dim group-open:rotate-180 motion-safe:transition-transform">
          ▾
        </span>
      </summary>
      <div className="flex flex-col gap-3 px-[18px] pb-4">
        <label className="flex items-center gap-2 text-[12.5px] text-dim">
          Version
          <select
            className="h-8 min-w-0 flex-auto rounded-lg border border-line bg-panel px-2 text-[12.5px] text-fg"
            value={other}
            onChange={(e) => setOther(e.target.value)}
          >
            {compare.runs.map((r) => (
              <option key={r} value={r}>
                {runLabel(r)}
                {r < compare.current ? "" : " (newer)"}
              </option>
            ))}
          </select>
        </label>
        {!state ? (
          <span className="text-[12.5px] text-dim">Loading…</span>
        ) : state.error ? (
          <span className="text-[12.5px] text-dim">
            That version couldn’t be read: {state.error}
          </span>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Side label="This version" tile={tile} base={base} />
              <Side label={runLabel(other)} tile={theirs} base={otherBase} />
            </div>
            <span className={cx("text-[12px]", same ? "text-dim" : "text-fg")}>
              {!theirs
                ? "This shot isn’t in that version: the page or state is new since."
                : same
                  ? "The same shot: it was carried over unchanged, not taken again."
                  : "Taken separately in each version."}
            </span>
          </>
        )}
      </div>
    </details>
  );
}

function Side({ label, tile, base }: { label: string; tile?: ViewerTile; base: string }) {
  const src = tile?.mid ?? tile?.thumb ?? tile?.full;
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <figcaption className="truncate text-[11.5px] font-medium text-dim">{label}</figcaption>
      {tile && src && !tile.error ? (
        <a
          href={base + (tile.full ?? src)}
          target="_blank"
          rel="noreferrer"
          className="block max-h-[320px] overflow-hidden rounded-md border border-line bg-app"
          title="Open the full image"
        >
          <img src={base + src} alt={label} className="block w-full" loading="lazy" />
        </a>
      ) : (
        <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-line text-[11.5px] text-dim">
          {tile?.error ? "Capture failed" : "Not captured"}
        </div>
      )}
    </figure>
  );
}
