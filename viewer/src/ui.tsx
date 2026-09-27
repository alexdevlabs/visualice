import type { ReactNode } from "react";

/**
 * The small pieces every screen is built from. Kept here rather than in the
 * components that use them so a route path, a device toggle or a state pill looks
 * the same wherever it appears.
 */

const ICONS = {
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  kbd: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h1M10.5 10h1M14.5 10h1M7 14h10"/>',
  grouped:
    '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  bydevice:
    '<rect x="2.5" y="5" width="12" height="9" rx="1.5"/><rect x="16.5" y="5" width="5" height="14" rx="1.5"/><path d="M6 18h5"/>',
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
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  sliders:
    '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  cursor: '<path d="M5 3l14 7-6 2-2 6z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  grip: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  stroke = 1.6,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
}) {
  return (
    <svg
      className="vc-icon"
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

/** The one way a route path is shown: a mono pill, accent-tinted when its route is selected. */
export function RouteBadge({
  path,
  active,
  small,
}: {
  path: string;
  active?: boolean;
  small?: boolean;
}) {
  return (
    <span
      className={"vc-route" + (active ? " is-active" : "") + (small ? " is-small" : "")}
      title={path}
    >
      <span>{path}</span>
    </span>
  );
}

export function KindTag({ children }: { children: ReactNode }) {
  return <span className="vc-kind">{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="vc-kbd">{children}</kbd>;
}

export function Caption({ children }: { children: ReactNode }) {
  return <span className="vc-caption">{children}</span>;
}

export function Count({ children }: { children: ReactNode }) {
  return <span className="vc-count">{children}</span>;
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
      className={"vc-seg" + (small ? " is-small" : "") + (fill ? " is-fill" : "")}
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
}: {
  name: string;
  width: number;
  icon: IconName;
  on: boolean;
  onToggle: () => void;
  /** The larger, two-line version the phone filter sheet uses. */
  card?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      className={"vc-device" + (on ? " on" : "") + (card ? " is-card" : "")}
      onClick={onToggle}
      title={`${name} · ${width}px wide`}
    >
      {!card && (
        <span className="vc-check" aria-hidden="true">
          {on && <Icon name="check" size={11} stroke={2.4} />}
        </span>
      )}
      <span className="vc-device-icon">
        <Icon name={icon} size={card ? 20 : 15} />
      </span>
      {card ? (
        <span className="vc-device-text">
          <span>{name}</span>
          <span className="vc-mono vc-dim">{width} px wide</span>
        </span>
      ) : (
        <>
          <span>{name}</span>
          <span className="vc-mono vc-dim">{width}</span>
        </>
      )}
    </button>
  );
}

export function Pill({
  children,
  count,
  on,
  dot,
  tone = "neutral",
  onClick,
  title,
}: {
  children: ReactNode;
  count?: number;
  on: boolean;
  dot?: string;
  /** `amber` is the compare screen's status filter; `neutral` the catalog's state filter. */
  tone?: "neutral" | "amber";
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`vc-pill is-${tone}` + (on ? " on" : "")}
      onClick={onClick}
      title={title}
    >
      {dot && <span className="vc-dot" style={{ background: dot }} />}
      <span>{children}</span>
      {count !== undefined && <span className="vc-mono vc-pill-count">{count}</span>}
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
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  size?: number;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className="vc-icon-btn"
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
