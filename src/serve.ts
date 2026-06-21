import path from "node:path";
import { startServer, serveFileFromRoot, type StaticServer } from "./shared/file-serve";

/**
 * Serve the built viewer at `/` and a run directory under `/data/`.
 * The viewer fetches `./data/viewer-data.json` and images at `./data/<shot path>`.
 */
export async function serveViewer(opts: {
  runDir: string;
  viewerDist: string;
  port?: number;
}): Promise<StaticServer> {
  const runDir = path.resolve(opts.runDir);
  const viewerDist = path.resolve(opts.viewerDist);

  return startServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith("/data/")) {
        const rel = pathname.slice("/data/".length) || "viewer-data.json";
        if (await serveFileFromRoot(res, runDir, rel)) return;
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
