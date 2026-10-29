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
  if (m.site.framework) lines.push(`- **Framework:** ${m.site.framework}`);
  const hints = m.hints;
  if (
    hints?.flakyRegions?.length ||
    hints?.stableSelectors?.length ||
    hints?.skipTriggers?.length
  ) {
    const applied = [
      hints.flakyRegions?.length ? `${hints.flakyRegions.length} masked region(s)` : undefined,
      hints.stableSelectors?.length
        ? `${hints.stableSelectors.length} awaited selector(s)`
        : undefined,
      hints.skipTriggers?.length ? `${hints.skipTriggers.length} skipped trigger(s)` : undefined,
    ].filter(Boolean);
    lines.push(`- **Hints applied:** ${applied.join(", ")}`);
  }
  const clamped = m.routes.flatMap((r) =>
    r.states.flatMap((s) => Object.entries(s.shots).filter(([, ref]) => ref.clamped)),
  ).length;
  if (clamped) {
    lines.push(
      `- **Clamped:** ${clamped} shot(s) hit the \`screenshot.maxHeight\` limit and were cut off`,
    );
  }
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

  const a11y = m.stats?.accessibility;
  if (a11y) {
    lines.push(`## Accessibility`);
    lines.push("");
    if (!a11y.length) {
      lines.push(`No violations found by axe-core in any captured state.`);
    } else {
      lines.push(
        `axe-core found ${a11y.length} rule(s) broken across the captured states. Each shot's`,
        `sidecar JSON lists the elements; the viewer shows them beside the shot.`,
      );
      lines.push("");
      lines.push(`| Rule | Impact | Shots | Elements | What |`);
      lines.push(`|---|---|---|---|---|`);
      for (const r of a11y) {
        const rule = r.helpUrl ? `[\`${r.id}\`](${r.helpUrl})` : `\`${r.id}\``;
        lines.push(
          `| ${rule} | ${r.impact ?? ""} | ${r.shots} | ${r.elements} | ${r.help.replace(/\|/g, "\\|")} |`,
        );
      }
    }
    lines.push("");
  }

  const wanted = m.stats?.wanted ?? [];
  if (wanted.length) {
    lines.push(`## Wanted`);
    lines.push("");
    lines.push(
      `${wanted.length} state(s) requested in the routes file have no recipe yet.`,
      `Author them via Explore mode (add the recipe to the cache under the same state id),`,
      `or rerun discovery if the trigger is heuristic-reachable.`,
    );
    lines.push("");
    lines.push(`| Path | State | Description |`);
    lines.push(`|---|---|---|`);
    for (const w of wanted) {
      lines.push(
        `| \`${w.route}\` | ${w.state} | ${(w.description ?? "").replace(/\|/g, "\\|")} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
