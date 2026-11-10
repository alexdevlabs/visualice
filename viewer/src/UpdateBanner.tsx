import { useEffect, useState } from "react";
import { Icon, LINK, cx, EASE } from "./ui";

/**
 * "A newer visualice is out" across the top of the page, with how to update.
 *
 * `visualice serve` answers `/update.json` from the CLI's once-a-day check, so the
 * page itself never contacts npm. A shared export has no such endpoint and never
 * shows the banner. Dismissing it hides it for that version: the next release
 * brings it back.
 */

interface UpdateInfo {
  current: string;
  latest: string;
}

const DISMISS_KEY = "visualice:update-dismissed";
const RELEASES = "https://github.com/alexdevlabs/visualice/releases/tag/v";

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

async function fetchUpdate(): Promise<UpdateInfo | undefined> {
  try {
    const r = await fetch("./update.json", { cache: "no-store" });
    if (!r.ok) return undefined;
    const body = (await r.json()) as Partial<UpdateInfo>;
    return typeof body.latest === "string" && typeof body.current === "string"
      ? { current: body.current, latest: body.latest }
      : undefined;
  } catch {
    return undefined; // an export, or an older server: no banner
  }
}

/** A command with a copy button. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-app py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{text}</code>
      <button
        type="button"
        onClick={copy}
        title={copied ? "Copied" : "Copy"}
        aria-label={copied ? "Copied" : `Copy ${text}`}
        className={cx(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded border-0 bg-transparent text-dim hover:bg-hover hover:text-fg",
          EASE,
        )}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
      </button>
    </span>
  );
}

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo>();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    void fetchUpdate().then((u) => {
      if (u && dismissedVersion() !== u.latest) setInfo(u);
    });
  }, []);

  if (!info || hidden) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, info.latest);
    } catch {
      // private window: hidden for this page load only
    }
    setHidden(true);
  };

  return (
    <div
      role="status"
      className="shrink-0 border-b border-accent-line bg-accent-soft text-[12.5px] text-fg"
    >
      <div className="flex items-center gap-3 px-4 py-2">
        <span className="min-w-0 flex-1">
          <strong className="font-semibold">visualice {info.latest} is available</strong>
          <span className="text-dim"> · you have {info.current}</span>
        </span>
        <button
          type="button"
          className={cx(LINK, "shrink-0 font-medium")}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide steps" : "How to update"}
        </button>
        <a
          className={cx(LINK, "hidden shrink-0 items-center gap-1 sm:flex")}
          href={`${RELEASES}${info.latest}`}
          target="_blank"
          rel="noreferrer"
        >
          What's new <Icon name="ext" size={12} />
        </a>
        <button
          type="button"
          onClick={dismiss}
          title="Dismiss until the next version"
          aria-label="Dismiss until the next version"
          className={cx(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded border-0 bg-transparent text-dim hover:bg-hover hover:text-fg",
            EASE,
          )}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      {open && (
        <div className="grid gap-3 px-4 pt-1 pb-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="font-medium">With Claude Code (the plugin)</span>
            <Command text="claude plugin update visualice@visualice" />
            <span className="text-[12px] text-dim">
              Then restart Claude Code, or run <code className="font-mono">/reload-plugins</code>.
              To get updates on their own: <code className="font-mono">/plugin</code> → Marketplaces
              → visualice → Enable auto-update.
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="font-medium">With the CLI on its own</span>
            <Command text="npm i -g visualice@latest" />
            <span className="text-[12px] text-dim">
              With <code className="font-mono">npx visualice</code>, the next run already uses{" "}
              {info.latest}. Restart <code className="font-mono">visualice serve</code> afterwards.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
