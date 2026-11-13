import type { Manifest } from "../shared/types";

/** Text for a Markdown table cell: a `|` would end the cell, a backslash would undo the escape. */
const cell = (text: string): string => text.replace(/[\\|]/g, "\\$&");

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
  if (m.partial?.unmatched?.length) {
    lines.push(
      `- **Not shot:** \`--only\` matched no page for ${m.partial.unmatched.map((p) => `\`${p}\``).join(", ")}`,
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
    const title = cell(r.title ?? "").replace(/\s+/g, " ");
    lines.push(`| \`${r.url}\` | ${title} | ${states} | ${shots} | ${failed || ""} |`);
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

  const generated = m.hints?.unstableIds ?? [];
  if (generated.length) {
    lines.push(`## Generated ids`);
    lines.push("");
    lines.push(
      `Ids that changed between two loads of a page, or between two openings of the same`,
      `dialog, so the site generates them at render time. Recipes and state signatures`,
      `don't use them. Crawls remember them in the cached model; to keep them for good`,
      `(and share them with the project), add them to \`discovery.unstableIds\` in the config:`,
    );
    lines.push("");
    for (const p of generated) lines.push(`- \`${p}\``);
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

  const wrote = m.stats?.wrote ?? [];
  if (wrote.length) {
    const blocked = wrote.every((w) => w.blocked);
    lines.push(`## Wrote to the server, left out`);
    lines.push("");
    lines.push(
      `Clicking these sent a request that changes data on the site (${blocked ? "stopped before it reached the server" : "it reached the server"}).`,
      `A capture would make it again every run, so none is a state. Add the label to`,
      `\`discovery.interactions.denyLabels\` so it isn't clicked at all, or, for an analytics or`,
      `logging endpoint, its path to \`allowWrites\`. A state you do want behind one is`,
      `authored by hand (Explore mode), marked \`isolate\`, against data you can reset.`,
    );
    lines.push("");
    lines.push(`| Path | Trigger | Requests |`);
    lines.push(`|---|---|---|`);
    for (const w of wrote) {
      const where = w.device ? `\`${w.route}\` (${w.device})` : `\`${w.route}\``;
      const requests = w.requests.map((r) => `\`${r}\``).join(", ");
      lines.push(`| ${where} | ${cell(w.trigger)} | ${requests}${w.blocked ? " (blocked)" : ""} |`);
    }
    lines.push("");
  }

  const quiet = m.stats?.quiet ?? [];
  if (quiet.length) {
    const busy = quiet.filter((q) => q.result === "busy");
    const failed = quiet.filter((q) => q.result === "click failed");
    const dialogs = quiet.filter((q) => q.result === "browser dialog");
    lines.push(`## Clicked, nothing opened`);
    lines.push("");
    lines.push(
      `Discovery clicked ${quiet.length} trigger(s) that showed nothing it could record. Most`,
      `do nothing visible by design (sorting, refresh, pagination). Worth a look:`,
    );
    lines.push("");
    lines.push(
      `- **still loading** (${busy.length}): the page was still busy when discovery stopped`,
      `  looking, so a slow server may have hidden a state there. Raise`,
      `  \`discovery.interactions.patienceMs\`, or author the state (Explore mode).`,
      `- **click failed** (${failed.length}): covered, disabled or gone before the click landed.`,
      `- **browser dialog** (${dialogs.length}): opened the browser's own \`alert\`, \`confirm\` or`,
      `  \`prompt\`, which is drawn outside the page and can't be shot. It was dismissed, so`,
      `  what a \`confirm\` guarded didn't happen.`,
    );
    lines.push("");
    lines.push(`| Path | Trigger | Result |`);
    lines.push(`|---|---|---|`);
    const rank = { busy: 0, "browser dialog": 1, "click failed": 2, "no change": 3 } as const;
    const label = {
      busy: "**still loading**",
      "browser dialog": "browser dialog",
      "click failed": "click failed",
      "no change": "no change",
    };
    for (const q of [...quiet].sort((a, b) => rank[a.result] - rank[b.result])) {
      const where = q.device ? `\`${q.route}\` (${q.device})` : `\`${q.route}\``;
      lines.push(`| ${where} | ${cell(q.trigger)} | ${label[q.result]} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
