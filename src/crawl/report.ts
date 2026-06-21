import type { Manifest } from "../shared/types";

export function renderReport(m: Manifest): string {
  const lines: string[] = [];
  lines.push(`# Crawl report — ${m.site.title ?? m.site.origin}`);
  lines.push("");
  lines.push(`- **Site:** ${m.site.baseUrl}`);
  lines.push(`- **Run:** \`${m.site.runId}\` (${m.site.generatedAt})`);
  if (m.stats) {
    lines.push(
      `- **Totals:** ${m.stats.routes} routes · ${m.stats.states} states · ${m.stats.shots} shots · ${(
        m.stats.durationMs / 1000
      ).toFixed(1)}s`,
    );
  }
  lines.push(`- **Devices:** ${m.devices.map((d) => `${d.name} ${d.width}×${d.height}@${d.dpr}`).join(", ")}`);
  lines.push("");
  lines.push(`## Routes`);
  lines.push("");
  lines.push(`| Path | Title | States | Shots |`);
  lines.push(`|---|---|---|---|`);
  for (const r of m.routes) {
    const shots = r.states.reduce((n, s) => n + Object.keys(s.shots).length, 0);
    const states = r.states.map((s) => s.id).join(", ");
    lines.push(`| \`${r.url}\` | ${r.title ?? ""} | ${states} | ${shots} |`);
  }
  lines.push("");
  return lines.join("\n");
}
