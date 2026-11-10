import { useEffect, useRef, useState } from "react";
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

/** The banner's actions: small pill badges, right after the message. */
const BADGE = cx(
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-accent-line bg-panel px-2.5 text-[12px] font-medium text-accent no-underline hover:bg-accent-soft",
  EASE,
);

/** The update steps, in a modal: one way per kind of install, each command copyable. */
function UpdateSteps({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="update-steps-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself, not its contents.
      onClick={(e) => e.target === ref.current && ref.current?.close()}
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-xl border border-line-strong bg-panel p-0 text-[12.5px] text-fg shadow-pop backdrop:bg-scrim"
    >
      <div className="flex items-start gap-3 px-5 pt-4 pb-2">
        <div className="min-w-0 flex-1">
          <h2 id="update-steps-title" className="m-0 text-[15px] font-semibold">
            Update to visualice {info.latest}
          </h2>
          <p className="m-0 mt-0.5 text-dim">You have {info.current}.</p>
        </div>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          aria-label="Close"
          className={cx(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-dim hover:bg-hover hover:text-fg",
            EASE,
          )}
        >
          <Icon name="x" size={15} />
        </button>
      </div>
      <div className="flex flex-col gap-4 px-5 pt-2 pb-5">
        <section className="flex min-w-0 flex-col gap-1.5">
          <h3 className="m-0 text-[12.5px] font-semibold">With Claude Code (the plugin)</h3>
          <Command text="claude plugin update visualice@visualice" />
          <p className="m-0 text-[12px] text-dim">
            Then restart Claude Code, or run <code className="font-mono">/reload-plugins</code>. To
            get every update on its own: <code className="font-mono">/plugin</code> → Marketplaces →
            visualice → Enable auto-update.
          </p>
        </section>
        <section className="flex min-w-0 flex-col gap-1.5">
          <h3 className="m-0 text-[12.5px] font-semibold">With the CLI on its own</h3>
          <Command text="npm i -g visualice@latest" />
          <p className="m-0 text-[12px] text-dim">
            With <code className="font-mono">npx visualice</code>, the next run already uses{" "}
            {info.latest}. Restart <code className="font-mono">visualice serve</code> afterwards.
          </p>
        </section>
        <a
          className={cx(LINK, "inline-flex items-center gap-1 self-start")}
          href={`${RELEASES}${info.latest}`}
          target="_blank"
          rel="noreferrer"
        >
          What's new in {info.latest} <Icon name="ext" size={12} />
        </a>
      </div>
    </dialog>
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
    <>
      <div
        role="status"
        className="flex shrink-0 items-center gap-3 border-b border-accent-line bg-accent-soft px-4 py-2 text-[12.5px] text-fg"
      >
        {/* Message and actions together on the left, where the eye starts. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="min-w-0">
            <strong className="font-semibold">visualice {info.latest} is available</strong>
            <span className="text-dim"> · you have {info.current}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <button type="button" className={BADGE} onClick={() => setOpen(true)}>
              How to update
            </button>
            <a
              className={BADGE}
              href={`${RELEASES}${info.latest}`}
              target="_blank"
              rel="noreferrer"
            >
              What's new <Icon name="ext" size={11} />
            </a>
          </span>
        </div>
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
      {open && <UpdateSteps info={info} onClose={() => setOpen(false)} />}
    </>
  );
}
