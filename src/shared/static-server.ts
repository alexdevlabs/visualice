import http from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

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
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Minimal, dependency-free static file server. Tries `<path>.html` as a fallback. */
export async function serveDirectory(dir: string, opts: { port?: number } = {}): Promise<StaticServer> {
  const root = path.resolve(dir);
  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      let rel = decodeURIComponent(reqUrl.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      let filePath = path.normalize(path.join(root, rel));
      if (!filePath.startsWith(root)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      let stat = await fs.stat(filePath).catch(() => null);
      if (!stat) {
        const asHtml = await fs.stat(`${filePath}.html`).catch(() => null);
        if (asHtml) {
          filePath += ".html";
          stat = asHtml;
        }
      }
      if (!stat) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      createReadStream(filePath).on("error", () => {
        res.statusCode = 404;
        res.end("Not found");
      }).pipe(res);
    } catch {
      res.statusCode = 500;
      res.end("Server error");
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
