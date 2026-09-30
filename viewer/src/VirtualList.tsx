import { useEffect, useRef, useState, type ReactNode } from "react";
import { rowRange, VIRTUALIZE_ABOVE } from "./virtual-list";

interface Props<T> {
  items: T[];
  /** Fixed row height in px — must match what the CSS gives each row. */
  rowHeight: number;
  children: (item: T, index: number) => ReactNode;
  className?: string;
  /** Rows below this count render in full; virtualizing a short list is pure overhead. */
  threshold?: number;
}

/**
 * A scrolling list that only mounts the rows in view.
 *
 * Short lists render normally, so the common case keeps its natural row heights and
 * nothing about the markup changes. The long case pins rows to `rowHeight` and
 * brackets them with two spacers, which is what keeps the scrollbar the size it
 * would have been.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  children,
  className,
  threshold = VIRTUALIZE_ABOVE,
}: Props<T>) {
  const ref = useRef<HTMLUListElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const virtualize = items.length > threshold;

  useEffect(() => {
    const el = ref.current;
    if (!el || !virtualize) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [virtualize]);

  // A filter that shortens the list can leave the scroll position past the end,
  // which would render the empty tail. Start again from the top.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, [items.length]);

  if (!virtualize) {
    return <ul className={className}>{items.map((item, i) => children(item, i))}</ul>;
  }

  const { start, end, padTop, padBottom } = rowRange(scrollTop, height, rowHeight, items.length);
  return (
    <ul
      ref={ref}
      className={className}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ overflowY: "auto" }}
    >
      {padTop > 0 && <li style={{ height: padTop }} aria-hidden />}
      {items.slice(start, end).map((item, i) => children(item, start + i))}
      {padBottom > 0 && <li style={{ height: padBottom }} aria-hidden />}
    </ul>
  );
}
