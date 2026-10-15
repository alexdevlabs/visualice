import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Logo } from "./brand";
import { runLabel } from "./format";
import { openingRun, runBase, runHref, type SiteEntry, type SiteList } from "./sites";
import { applyTheme, readTheme, type Theme } from "./theme";
import { cx, Icon, IconButton, Segmented } from "./ui";

const PREVIEWS_KEY = "visualice:previews";
const ADD_COMMAND = "visualice crawl <url>";

/** Previews show unless this browser hid them before — remembered like the theme. */
function readPreviewsHidden(): boolean {
  try {
    return localStorage.getItem(PREVIEWS_KEY) === "hidden";
  } catch {
    return false;
  }
}

function writePreviewsHidden(hidden: boolean) {
  try {
    localStorage.setItem(PREVIEWS_KEY, hidden ? "hidden" : "shown");
  } catch {
    // Private windows and blocked storage just don't remember it.
  }
}

type Sort = "recent" | "name";

/** A plain left click opens in place; anything else (new tab, copy link) is the browser's. */
const plainClick = (e: MouseEvent) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The landing page when the output directory holds more than one site: a card per
 * site with its latest run at a glance, each opening that run in the viewer.
 */
export function Dashboard({
  list,
  onOpen,
}: {
  list: SiteList;
  onOpen: (site: string, run: string) => void;
}) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [hidden, setHidden] = useState(readPreviewsHidden);
  const [sort, setSort] = useState<Sort>("recent");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => writePreviewsHidden(hidden), [hidden]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const sites = useMemo(() => {
    const q = query.trim().toLowerCase();
    const found = list.sites.filter(
      (s) => !q || s.key.includes(q) || (s.summary?.title ?? "").toLowerCase().includes(q),
    );
    // Run ids are timestamps, so the newest sorts last as a string too.
    return found.sort((a, b) =>
      sort === "name"
        ? a.key.localeCompare(b.key)
        : (openingRun(b) ?? "").localeCompare(openingRun(a) ?? ""),
    );
  }, [list, query, sort]);

  const versions = list.sites.reduce((n, s) => n + s.runs.length, 0);
  const shots = list.sites.reduce((n, s) => n + (s.summary?.shots ?? 0), 0);

  const copy = () => {
    navigator.clipboard?.writeText(ADD_COMMAND).then(
      () => setCopied(true),
      () => {},
    );
  };

  return (
    <div className="h-full overflow-y-auto bg-app">
      <header className="flex min-h-[52px] flex-wrap items-center gap-3.5 border-b border-line bg-panel px-4 py-2">
        <Logo />
        <span className="flex-auto" />
        <label className="flex h-8 w-70 max-w-full items-center gap-2 rounded-lg border border-line bg-panel pr-2 pl-2.5 text-dim focus-within:border-accent">
          <Icon name="search" size={15} />
          <input
            className="min-w-0 flex-auto border-0 bg-transparent px-0.5 py-px text-[12.5px] text-fg outline-none placeholder:text-dim"
            type="search"
            placeholder="Search sites"
            aria-label="Search sites"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <IconButton
          icon={theme === "dark" ? "sun" : "moon"}
          label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        />
      </header>

      <main className="mx-auto flex max-w-[1280px] flex-col gap-6 px-4 pt-8 pb-12 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[28px] leading-[34px] font-bold tracking-[-0.01em] text-fg">
              Sites
            </h1>
            <p className="m-0 text-[14px] text-dim">
              {plural(list.sites.length, "site")} · {plural(versions, "version")} ·{" "}
              {plural(shots, "shot")} in the latest runs
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {/* On: the eye reads normally. Off: the same eye, faded — never slashed. */}
            <button
              type="button"
              aria-label="Previews"
              title={hidden ? "Show previews" : "Hide previews"}
              aria-pressed={!hidden}
              onClick={() => setHidden((h) => !h)}
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-panel p-0 text-dim/45 transition-colors hover:border-line-strong hover:text-dim aria-pressed:border-line-strong aria-pressed:text-fg"
            >
              <Icon name="eye" />
            </button>
            <Segmented
              label="Sort"
              value={sort}
              onChange={setSort}
              items={[
                { value: "recent", label: "Last crawled" },
                { value: "name", label: "Name" },
              ]}
            />
            <div className="flex h-8 items-center gap-2 rounded-lg border border-dashed border-line-strong bg-panel pr-1 pl-3">
              <span className="text-[12px] text-dim">Add a site</span>
              <code className="font-mono text-[12px] text-fg">{ADD_COMMAND}</code>
              <button
                type="button"
                className="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-canvas text-dim hover:text-fg"
                aria-label={copied ? "Copied" : "Copy command"}
                title={copied ? "Copied" : "Copy command"}
                onClick={copy}
              >
                <Icon name={copied ? "check" : "copy"} size={14} />
              </button>
            </div>
          </div>
        </div>

        {sites.length ? (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-5 p-0">
            {sites.map((s) => (
              <li key={s.key} className="flex">
                <SiteCard site={s} hidden={hidden} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-[14px] text-dim">No site matches “{query}”.</p>
        )}
      </main>
    </div>
  );
}

function SiteCard({
  site,
  hidden,
  onOpen,
}: {
  site: SiteEntry;
  hidden: boolean;
  onOpen: (site: string, run: string) => void;
}) {
  const run = openingRun(site);
  const sum = site.summary;
  const thumb = run && sum?.thumb ? runBase(site.key, run) + sum.thumb : undefined;
  // Oldest → newest, so the latest (highlighted) sits at the end.
  const bars = [...site.runs].reverse();

  return (
    <a
      href={run ? runHref(site.key, run) : undefined}
      onClick={(e) => {
        if (!run || !plainClick(e)) return;
        e.preventDefault();
        onOpen(site.key, run);
      }}
      data-site={site.key}
      className="flex w-full flex-col overflow-hidden rounded-xl border border-line bg-panel text-fg no-underline shadow-[0_1px_2px_var(--color-tile-ring)] transition-[border-color,box-shadow] hover:border-line-strong hover:text-fg hover:shadow-float"
    >
      <div className="relative h-44 overflow-hidden border-b border-line bg-canvas">
        {thumb && !hidden ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="block size-full object-cover object-top"
          />
        ) : (
          <div
            className="flex size-full flex-col items-center justify-center gap-2 bg-[repeating-linear-gradient(135deg,var(--color-hover)_0_8px,transparent_8px_16px)] text-dim"
            data-placeholder
          >
            <svg
              width="40"
              height="32"
              viewBox="0 0 40 32"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <rect x="1" y="1" width="38" height="30" rx="4" />
              <path d="M1 8h38M8 15h16M8 20h24M8 25h12" />
              <circle cx="5.5" cy="4.5" r="1" />
              <circle cx="9.5" cy="4.5" r="1" />
            </svg>
          </div>
        )}
        <span className="absolute top-2.5 left-2.5 rounded-full border border-line-strong bg-chip px-2 py-px font-mono text-[10.5px] text-dim">
          {plural(site.runs.length, "version")}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 pt-3.5 pb-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-[11.5px] text-dim">{site.key}</span>
          <span className="truncate text-[15px] leading-5 font-semibold">
            {sum?.title || site.key}
          </span>
        </div>
        {sum && (
          <dl className="m-0 grid grid-cols-3 gap-2">
            {(
              [
                ["routes", sum.routes],
                ["states", sum.states],
                ["shots", sum.shots],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="flex flex-col-reverse gap-px">
                <dt className="text-[11.5px] text-dim">{label}</dt>
                <dd className="m-0 text-[18px] font-semibold tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="flex items-end justify-between gap-3 border-t border-line pt-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-dim">Latest</span>
            <span className="text-[12.5px] font-medium">{run ? runLabel(run) : "—"}</span>
          </div>
          <span
            role="img"
            aria-label={`${plural(site.runs.length, "version")}, the latest highlighted`}
            className="flex h-7 items-center gap-[3px]"
          >
            {bars.map((id, i) => (
              <span
                key={id}
                className={cx(
                  "block h-5 w-1.5 rounded-[3px]",
                  i === bars.length - 1 ? "bg-accent" : "bg-mini-tile",
                )}
              />
            ))}
          </span>
        </div>
        {sum && (
          <div
            className={cx(
              "flex items-center gap-1.5 text-[12px]",
              sum.failed ? "text-amber" : "text-ok",
            )}
          >
            <Icon name={sum.failed ? "alert" : "check"} size={14} />
            <span>
              {sum.failed
                ? `${plural(sum.failed, "shot")} failed`
                : `All ${sum.shots} shots captured`}
            </span>
          </div>
        )}
      </div>
    </a>
  );
}
