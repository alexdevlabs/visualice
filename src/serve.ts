import path from "node:path";
import { startServer, serveFileFromRoot, type StaticServer } from "./shared/file-serve";
import { listRuns } from "./crawl/runs";

/**
 * Serve the built viewer at `/` and run data underneath it.
 *
 * - `/data/…`        the run that was asked for (what the viewer loads by default)
 * - `/runs/<id>/…`   any other run in the same output directory
 * - `/runs.json`     the run list, so the viewer can offer a switcher
 *
 * Exposing the sibling runs is what lets the viewer change runs without restarting
 * the server; `outRoot` stays optional so a bare run directory still serves.
 */
export async function serveViewer(opts: {
  runDir: string;
  viewerDist: string;
  /** The output root (the directory holding `runs/`). Enables `/runs/…` and the switcher. */
  outRoot?: string;
  /** Run id shown as current in `/runs.json`. */
  runId?: string;
  port?: number;
}): Promise<StaticServer> {
  const runDir = path.resolve(opts.runDir);
  const viewerDist = path.resolve(opts.viewerDist);
  const outRoot = opts.outRoot ? path.resolve(opts.outRoot) : undefined;
  // Run directories live under `<outRoot>/runs`, which is what `/runs/<id>/…` maps to.
  const runsDir = outRoot ? path.join(outRoot, "runs") : undefined;

  return startServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === "/runs.json") {
        const runs = outRoot ? await listRuns(outRoot) : [];
        res.setHeader("content-type", "application/json; charset=utf-8");
        // Never cached: the point of the list is to reflect runs added since load.
        res.setHeader("cache-control", "no-store");
        res.end(
          JSON.stringify({
            current: opts.runId ?? path.basename(runDir),
            runs: [...runs].reverse(), // newest first, which is how they're offered
          }),
        );
        return;
      }

      if (pathname.startsWith("/data/")) {
        const rel = pathname.slice("/data/".length) || "viewer-data.json";
        if (await serveFileFromRoot(res, runDir, rel)) return;
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      if (runsDir && pathname.startsWith("/runs/")) {
        // `serveFileFromRoot` confines the path to the root, so a `..` in the run id
        // can't escape the runs directory.
        const rel = pathname.slice("/runs/".length);
        if (rel && (await serveFileFromRoot(res, runsDir, rel))) return;
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      const rel = pathname === "/" ? "index.html" : pathname;
      if (await serveFileFromRoot(res, viewerDist, rel)) return;
      if (await serveFileFromRoot(res, viewerDist, "index.html")) return; // SPA fallback
      res.statusCode = 404;
      res.end("not found");
    } catch {
      res.statusCode = 500;
      res.end("error");
    }
  }, opts.port);
}
