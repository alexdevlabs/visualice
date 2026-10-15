import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx, Icon } from "./ui";

export interface DropdownOption {
  value: string;
  label: ReactNode;
  /** Quiet text on the right: a count, a date. */
  hint?: ReactNode;
  /** A pill after the label, e.g. "latest". */
  badge?: string;
}

/**
 * A select with the viewer's own look: a button that opens a listbox under it.
 *
 * Follows the ARIA listbox pattern — the trigger says it has a popup, focus moves
 * into the list, arrows and Home/End move the highlight, Enter or Space picks,
 * Escape and Tab close — so it keeps what the native select gave keyboard and
 * screen-reader users. `children` is the trigger's face.
 */
export function Dropdown({
  label,
  value,
  options,
  onChange,
  className,
  children,
  align = "start",
}: {
  /** Names the control for assistive tech ("Site", "Version"). */
  label: string;
  value: string | undefined;
  options: DropdownOption[];
  onChange: (value: string) => void;
  className?: string;
  children: ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  const show = () => {
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (i: number) => {
    const o = options[i];
    close();
    if (o && o.value !== value) onChange(o.value);
  };

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    // A press anywhere else closes it, without stealing that press's focus.
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  // Keep the highlighted option in view in a long list.
  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onListKey = (e: KeyboardEvent) => {
    const last = options.length - 1;
    const move: Record<string, number> = {
      ArrowDown: Math.min(active + 1, last),
      ArrowUp: Math.max(active - 1, 0),
      Home: 0,
      End: last,
    };
    if (e.key in move) {
      e.preventDefault();
      setActive(move[e.key]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      show();
    }
  };

  return (
    <div ref={root} className="relative flex min-w-0">
      <button
        ref={trigger}
        type="button"
        className={cx("cursor-pointer", className)}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={onTriggerKey}
      >
        {children}
        <Icon
          name="chev"
          size={14}
          className={cx("shrink-0 text-dim transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          aria-activedescendant={`${id}-${active}`}
          tabIndex={-1}
          onKeyDown={onListKey}
          className={cx(
            "absolute top-[calc(100%+6px)] z-40 m-0 max-h-[min(360px,70vh)] min-w-full list-none overflow-y-auto rounded-xl border border-line-strong bg-panel p-1 shadow-pop outline-none",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {options.map((o, i) => {
            const selected = o.value === value;
            return (
              <li
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={selected}
                onPointerMove={() => setActive(i)}
                onClick={() => pick(i)}
                className={cx(
                  "flex h-9 cursor-pointer items-center gap-2 rounded-lg pr-2.5 pl-2 text-[12.5px] whitespace-nowrap text-fg",
                  i === active && "bg-hover",
                  selected && "font-semibold",
                )}
              >
                <Icon
                  name="check"
                  size={14}
                  className={cx("shrink-0 text-accent", !selected && "invisible")}
                />
                <span className="min-w-0 flex-auto truncate">{o.label}</span>
                {o.badge && (
                  <span className="rounded-full bg-accent-soft px-[7px] py-px text-[10.5px] font-semibold text-accent">
                    {o.badge}
                  </span>
                )}
                {o.hint !== undefined && (
                  <span className="pl-3 font-mono text-[11px] font-normal text-dim">{o.hint}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
