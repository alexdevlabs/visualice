import type { ReactNode } from "react";

/**
 * The small pieces every screen is built from. Kept here rather than in the
 * components that use them so a route path, a device toggle or a state pill looks
 * the same wherever it appears. Styling is Tailwind; the theme tokens behind the
 * colour names (`bg-panel`, `text-dim`, …) live in index.css.
 */

/** Join class names, skipping the falsy ones a condition left behind. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** A text-style button or link in the accent colour. */
export const LINK = "border-0 bg-transparent p-0 text-[12.5px] text-accent hover:text-accent-hover";

/** A full-screen centred message: the boot loader, a load error, a crash. */
export const EMPTY =
  "flex h-full flex-col items-center justify-center gap-2.5 p-6 text-center text-accent";

/** A bordered text button (the inspector's actions, the crash screen's Reload). */
export const ACTION =
  "flex h-[30px] items-center gap-1.5 rounded-[7px] border px-2.5 text-[12.5px] font-medium";

/** The row transitions every hoverable control shares. */
export const EASE = "motion-safe:transition-colors motion-safe:duration-120";

/** A vertical divider between toolbar and header groups. */
export const DIVIDER = "h-[22px] w-px shrink-0 bg-line";

// The routes sidebar's frame and row styling. Rows are fixed-height: the virtual
// list pins them to `SIDEBAR_ROW_H` (App.tsx).
export const SIDEBAR = "flex min-h-0 flex-col bg-panel";
export const SIDE_HEAD = "flex items-center gap-2 px-4 pt-3.5 pb-2";
export const SIDE_EMPTY = "px-4 py-2 text-[12px] text-dim";
export const SIDE_LIST = "min-h-0 flex-1 overflow-y-auto px-2 pb-2";
export const ROW_MAIN = "flex min-w-0 flex-1 flex-col gap-1";
export const row = (on: boolean) =>
  cx(
    "flex w-full items-center gap-2.5 overflow-hidden rounded-lg border-0 px-2.5 py-2 text-left text-fg",
    EASE,
    on ? "bg-raised" : "bg-transparent hover:bg-hover",
  );

const ICONS = {
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  kbd: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h1M10.5 10h1M14.5 10h1M7 14h10"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 9"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  sliders:
    '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/>',
  map: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="12" y="12" width="6" height="5" rx="1"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  collapse: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  stroke = 1.6,
  className,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  return (
    <svg
      className={cx("block shrink-0", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

/** A device's icon: a phone for anything configured as mobile or narrow, a monitor otherwise. */
export function deviceIcon(d: { mobile?: boolean; width?: number } | undefined): IconName {
  return d && (d.mobile || (d.width ?? 1000) < 700) ? "phone" : "monitor";
}

const ROUTE_SIZE = {
  sm: "rounded-md px-[7px] py-px text-[11px] leading-[18px]",
  md: "rounded-md px-[7px] py-px text-[12px] leading-[18px]",
  /** The canvas's route headers: drawn in world space, so sized for a zoomed-out view. */
  lg: "shrink min-w-0 rounded-lg px-2.5 py-px text-[18px] leading-7",
};

/** The one way a route path is shown: a mono pill, accent-tinted when its route is selected. */
export function RouteBadge({
  path,
  active,
  size = "md",
}: {
  path: string;
  active?: boolean;
  size?: keyof typeof ROUTE_SIZE;
}) {
  return (
    <span
      className={cx(
        "inline-flex max-w-full items-center self-start border font-medium",
        ROUTE_SIZE[size],
        active
          ? "border-accent-line bg-accent-soft text-accent-ink"
          : "border-line-strong bg-raised text-fg",
      )}
      title={path}
    >
      <span className="truncate">{path}</span>
    </span>
  );
}

export function KindTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-[4px] border border-line-strong px-1 font-mono text-[10px] leading-[15px] whitespace-nowrap text-dim">
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "rounded-[4px] border border-b-2 border-line-strong bg-raised px-[5px] font-mono text-[11px] leading-4 text-dim",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "text-[11px] font-medium tracking-[0.06em] whitespace-nowrap text-dim uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Count({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11px] text-dim">{children}</span>;
}

export interface SegmentItem<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  extra?: ReactNode;
  disabled?: boolean;
  title?: string;
}

export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  small,
  fill,
}: {
  items: SegmentItem<T>[];
  value: T | null;
  onChange: (v: T) => void;
  label: string;
  small?: boolean;
  /** Stretch the segments to share the full width (the phone layout). */
  fill?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(
        "gap-0.5 rounded-[9px] border border-line bg-canvas p-[3px]",
        fill ? "grid auto-cols-[minmax(0,1fr)] grid-flow-col" : "flex",
      )}
    >
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="radio"
          aria-checked={it.value === value}
          disabled={it.disabled}
          title={it.title}
          onClick={() => onChange(it.value)}
          className={cx(
            "flex items-center justify-center gap-1.5 rounded-md border-0 bg-transparent text-[12.5px] font-medium whitespace-nowrap text-dim enabled:hover:text-fg aria-checked:bg-raised aria-checked:font-semibold aria-checked:text-fg aria-checked:shadow-seg",
            EASE,
            fill ? "h-[38px] px-1.5" : small ? "h-[22px] px-2.5" : "h-6 px-2.5",
          )}
        >
          {it.icon && <Icon name={it.icon} size={14} />}
          <span>{it.label}</span>
          {it.extra}
        </button>
      ))}
    </div>
  );
}

/** A device on/off toggle, reading as a checkbox so it can't be mistaken for a state. */
export function DeviceToggle({
  name,
  width,
  icon,
  on,
  onToggle,
  card,
  single,
  disabled,
}: {
  name: string;
  width: number;
  icon: IconName;
  on: boolean;
  onToggle: () => void;
  /** The larger, two-line version the phone filter sheet uses. */
  card?: boolean;
  /** One of the devices, not any of them (full screen): a radio, not a checkbox. */
  single?: boolean;
  /** Can't be picked, and why. */
  disabled?: string;
}) {
  return (
    <button
      type="button"
      role={single ? "radio" : "checkbox"}
      aria-checked={on}
      disabled={!!disabled}
      className={cx(
        "flex items-center border text-[12.5px] font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45",
        EASE,
        card ? "h-14 gap-2.5 rounded-[10px] px-3" : "h-[30px] gap-[7px] rounded-[7px] pr-2.5 pl-2",
        on
          ? "border-accent bg-accent-soft text-fg"
          : card
            ? "border-line-strong bg-transparent text-dim"
            : "border-line bg-panel text-dim",
      )}
      onClick={onToggle}
      title={disabled ?? `${name} · ${width}px wide`}
    >
      {!card && (
        <span
          className={cx(
            "flex size-3.5 items-center justify-center border",
            single ? "rounded-full" : "rounded-[4px]",
            on ? "border-accent bg-accent text-app" : "border-line-strong",
          )}
          aria-hidden="true"
        >
          {on && <Icon name="check" size={11} stroke={2.4} />}
        </span>
      )}
      <span className={cx("flex", on ? "text-accent" : "text-dim")}>
        <Icon name={icon} size={card ? 20 : 15} />
      </span>
      {card ? (
        <span className="flex flex-col items-start text-[13px] leading-[1.25] text-fg">
          <span>{name}</span>
          <span className="font-mono text-[11.5px] text-dim">{width} px wide</span>
        </span>
      ) : (
        <>
          <span>{name}</span>
          <span className="font-mono text-[11.5px] text-dim">{width}</span>
        </>
      )}
    </button>
  );
}

export function Pill({
  children,
  count,
  on,
  big,
  onClick,
  title,
}: {
  children: ReactNode;
  count?: number;
  on: boolean;
  /** The taller, touch-sized version the phone filter sheet uses. */
  big?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={cx(
        "flex items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium whitespace-nowrap",
        EASE,
        big ? "h-[34px]" : "h-[26px]",
        on
          ? "border-fg bg-fg text-app"
          : "border-line-strong bg-transparent text-fg hover:border-dim",
      )}
      onClick={onClick}
      title={title}
    >
      <span>{children}</span>
      {count !== undefined && <span className="font-mono text-[11px] opacity-70">{count}</span>}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  size,
  disabled,
  pressed,
  ghost,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  size?: number;
  disabled?: boolean;
  pressed?: boolean;
  /** No border or fill until hovered — for buttons inside a toast or popover. */
  ghost?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(
        "flex size-8 shrink-0 items-center justify-center rounded-lg p-0 text-dim enabled:hover:bg-raised enabled:hover:text-fg aria-pressed:bg-raised aria-pressed:text-fg",
        EASE,
        ghost
          ? "border-0 bg-transparent"
          : "border border-line bg-panel enabled:hover:border-line-strong aria-pressed:border-line-strong",
      )}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      style={size ? { width: size, height: size } : undefined}
    >
      <Icon name={icon} />
    </button>
  );
}
