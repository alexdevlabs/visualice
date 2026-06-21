import http from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { StaticServer } from "./shared/static-server";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function tryServe(res: http.ServerResponse, root: string, rel: string): Promise<boolean> {
  const filePath = path.normalize(path.join(root, rel));
  if (!filePath.startsWith(root)) return false;
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return false;
  res.setHeader("Content-Type", contentType(filePath));
  res.setHeader("Cache-Control", "no-store");
  await new Promise<void>((resolve) => {
    createReadStream(filePath)
      .on("error", () => {
        res.statusCode = 500;
        res.end("error");
        resolve();
      })
      .on("end", resolve)
      .pipe(res);
  });
  return true;
}

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

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith("/data/")) {
        const rel = pathname.slice("/data/".length) || "viewer-data.json";
        if (await tryServe(res, runDir, rel)) return;
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      // viewer asset, or SPA fallback to index.html
      const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
      if (await tryServe(res, viewerDist, rel)) return;
      if (await tryServe(res, viewerDist, "index.html")) return;
      res.statusCode = 404;
      res.end("not found");
    } catch {
      res.statusCode = 500;
      res.end("error");
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : (opts.port ?? 0));
    });
  });

  return {
    url: `http://localhost:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
