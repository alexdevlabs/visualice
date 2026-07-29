import type { Manifest } from "../shared/types";

export function renderReport(m: Manifest): string {
  const lines: string[] = [];
  lines.push(`# Crawl report — ${m.site.title ?? m.site.origin}`);
  lines.push("");
  lines.push(`- **Site:** ${m.site.baseUrl}`);
  lines.push(`- **Run:** \`${m.site.runId}\` (${m.site.generatedAt})`);
  if (m.stats) {
    const failed = m.stats.failed ? ` · **${m.stats.failed} failed**` : "";
    lines.push(
      `- **Totals:** ${m.stats.routes} routes · ${m.stats.states} states · ${m.stats.shots} shots${failed} · ${(
        m.stats.durationMs / 1000
      ).toFixed(1)}s`,
    );
  }
  lines.push(
    `- **Devices:** ${m.devices.map((d) => `${d.name} ${d.width}×${d.height}@${d.dpr}`).join(", ")}`,
  );
  lines.push("");
  lines.push(`## Routes`);
  lines.push("");
  lines.push(`| Path | Title | States | Shots | Failed |`);
  lines.push(`|---|---|---|---|---|`);
  for (const r of m.routes) {
    const refs = r.states.flatMap((s) => Object.values(s.shots));
    const shots = refs.filter((ref) => ref.full).length;
    const failed = refs.filter((ref) => ref.error).length;
    const states = r.states.map((s) => s.id).join(", ");
    lines.push(`| \`${r.url}\` | ${r.title ?? ""} | ${states} | ${shots} | ${failed || ""} |`);
  }
  lines.push("");

  const failures = m.stats?.failures ?? [];
  if (failures.length) {
    lines.push(`## Failures`);
    lines.push("");
    lines.push(
      `${failures.length} capture(s) failed after retries. A failing state usually means its`,
      `recipe needs an Explore-mode tweak (stale selector, changed trigger, auth wall).`,
    );
    lines.push("");
    lines.push(`| Path | State | Device | Error |`);
    lines.push(`|---|---|---|---|`);
    for (const f of failures) {
      lines.push(
        `| \`${f.route}\` | ${f.state} | ${f.device} | ${f.error.replace(/\|/g, "\\|")} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
