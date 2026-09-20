import type { RunDiff, ShotDiff } from "./index";

const pct = (ratio: number): string => {
  const v = ratio * 100;
  if (v === 0) return "0%";
  if (v < 0.01) return "<0.01%";
  return `${v.toFixed(v < 1 ? 2 : 1)}%`;
};

const size = (d?: { width: number; height: number }): string =>
  d ? `${d.width}×${d.height}` : "—";

function changedTable(shots: ShotDiff[]): string[] {
  const lines: string[] = [];
  lines.push(`| Path | State | Device | Changed | Size | Diff |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const s of shots) {
    const sizeCell = s.sizeChanged ? `${size(s.fromSize)} → ${size(s.toSize)}` : size(s.toSize);
    const image = s.image ? `[view](${s.image})` : "";
    lines.push(
      `| \`${s.route}\` | ${s.state} | ${s.device} | ${pct(s.ratio ?? 0)} | ${sizeCell} | ${image} |`,
    );
  }
  return lines;
}

function simpleTable(shots: ShotDiff[], noteHeader?: string): string[] {
  const lines: string[] = [];
  lines.push(`| Path | State | Device |${noteHeader ? ` ${noteHeader} |` : ""}`);
  lines.push(`|---|---|---|${noteHeader ? "---|" : ""}`);
  for (const s of shots) {
    const note = noteHeader ? ` ${(s.note ?? "").replace(/\|/g, "\\|")} |` : "";
    lines.push(`| \`${s.route}\` | ${s.state} | ${s.device} |${note}`);
  }
  return lines;
}

/** The human-readable side of a run diff; `diff.json` carries the same data. */
export function renderDiffReport(diff: RunDiff): string {
  const { summary } = diff;
  const lines: string[] = [];
  lines.push(`# Visual diff — \`${diff.from.runId}\` → \`${diff.to.runId}\``);
  lines.push("");
  lines.push(`- **Baseline:** \`${diff.from.runId}\``);
  lines.push(`- **New run:** \`${diff.to.runId}\``);
  lines.push(
    `- **Totals:** ${summary.changed} changed · ${summary.added} added · ${summary.removed} removed · ${summary.unchanged} unchanged` +
      (summary.uncomparable ? ` · ${summary.uncomparable} uncomparable` : ""),
  );
  if (diff.minRatio > 0) {
    lines.push(`- **Threshold:** a shot counts as changed above ${pct(diff.minRatio)} of pixels`);
  }
  lines.push("");

  if (!summary.changed && !summary.added && !summary.removed) {
    lines.push(`No visual differences.`);
    lines.push("");
  }

  if (diff.routes.added.length || diff.routes.removed.length) {
    lines.push(`## Routes`);
    lines.push("");
    for (const r of diff.routes.added) lines.push(`- **added** \`${r}\``);
    for (const r of diff.routes.removed) lines.push(`- **removed** \`${r}\``);
    lines.push("");
  }

  // Loudest first: the biggest pixel deltas are the ones worth eyeballing.
  const changed = diff.shots
    .filter((s) => s.status === "changed")
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
  if (changed.length) {
    lines.push(`## Changed`);
    lines.push("");
    lines.push(
      `Magenta marks every differing pixel in the linked image. A size change means the`,
      `page's height moved — only the overlapping region was compared.`,
    );
    lines.push("");
    lines.push(...changedTable(changed));
    lines.push("");
  }

  const added = diff.shots.filter((s) => s.status === "added");
  if (added.length) {
    lines.push(`## Added`);
    lines.push("");
    lines.push(...simpleTable(added));
    lines.push("");
  }

  const removed = diff.shots.filter((s) => s.status === "removed");
  if (removed.length) {
    lines.push(`## Removed`);
    lines.push("");
    lines.push(...simpleTable(removed));
    lines.push("");
  }

  const uncomparable = diff.shots.filter((s) => s.status === "uncomparable");
  if (uncomparable.length) {
    lines.push(`## Uncomparable`);
    lines.push("");
    lines.push(`These states exist in both runs but couldn't be compared pixel-for-pixel.`);
    lines.push("");
    lines.push(...simpleTable(uncomparable, "Why"));
    lines.push("");
  }

  return lines.join("\n");
}
