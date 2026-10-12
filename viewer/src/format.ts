/**
 * Display formatting shared by the header and the inspector.
 *
 * Run ids are ISO timestamps with `:`/`.` swapped for `-` (see `makeRunId`), which
 * is precise and unreadable. The run pickers show them as a date people recognise
 * and keep the raw id for the tooltip.
 */

const RUN_ID_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 21, 01:49" for a generated run id (UTC, as the id records it); anything else as-is. */
export function runLabel(id: string): string {
  const m = RUN_ID_RE.exec(id);
  if (!m) return id;
  const [, , mo, d, h, mi] = m;
  const month = MONTHS[+mo - 1];
  return month ? `${month} ${+d}, ${h}:${mi}` : id;
}
