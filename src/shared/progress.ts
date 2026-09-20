/**
 * Progress + ETA for the capture phase.
 *
 * A crawl of a real site runs for minutes with nothing but a stream of per-shot
 * lines, so there's no way to tell "halfway" from "stuck". This reports position,
 * percentage and a projected remaining time, rate-limited so it never becomes the
 * noise it's meant to cut through.
 */

export interface Progress {
  /** Count one completed unit of work (a captured or failed shot). */
  tick: () => void;
  /** Final line, with the elapsed total. */
  done: () => void;
}

export interface ProgressOptions {
  total: number;
  log: (msg: string) => void;
  /** Minimum gap between lines. Default 5s. */
  everyMs?: number;
  now?: () => number;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * ETA from the average rate so far. Deliberately naive: early estimates on a
 * warming browser are wrong in a way no smoothing would fix, so the number is
 * presented as approximate rather than dressed up.
 */
export function estimateRemaining(elapsedMs: number, done: number, total: number): number {
  if (done <= 0 || done >= total) return 0;
  return (elapsedMs / done) * (total - done);
}

export function createProgress(opts: ProgressOptions): Progress {
  const now = opts.now ?? (() => Date.now());
  const everyMs = opts.everyMs ?? 5000;
  const started = now();
  let done = 0;
  let lastReport = started;

  return {
    tick() {
      done++;
      const t = now();
      // Report on a timer, plus always on the last unit so the run ends on a
      // complete line rather than at whatever the timer last caught.
      if (t - lastReport < everyMs && done < opts.total) return;
      lastReport = t;
      const pct = opts.total ? Math.round((done / opts.total) * 100) : 100;
      const remaining = estimateRemaining(t - started, done, opts.total);
      const eta = remaining > 0 ? ` · ~${formatDuration(remaining)} left` : "";
      opts.log(`  … ${done}/${opts.total} (${pct}%)${eta}`);
    },
    done() {
      opts.log(`  … ${done}/${opts.total} in ${formatDuration(now() - started)}`);
    },
  };
}
