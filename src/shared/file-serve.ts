import http from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
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

export function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export interface StaticServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(handler: http.RequestListener, port?: number): Promise<StaticServer> {
  const server = http.createServer(handler);
  const bound = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port ?? 0, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : (port ?? 0));
    });
  });
  return {
    url: `http://localhost:${bound}`,
    port: bound,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Serve a file confined to `root`. Returns false (caller decides 404) if the
 * resolved path escapes root or isn't a regular file.
 *
 * The containment check uses `root + path.sep` (not a bare `startsWith`) so a
 * sibling directory sharing the name as a prefix — e.g. `runs/latest-evil` vs
 * `runs/latest` — cannot be reached, including via percent-encoded `..`.
 */
export async function serveFileFromRoot(
  res: http.ServerResponse,
  root: string,
  rel: string,
): Promise<boolean> {
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(resolvedRoot, rel.replace(/^\/+/, ""));
  if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) return false;

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return false;

  res.setHeader("Content-Type", contentType(filePath));
  res.setHeader("Cache-Control", "no-store");
  await new Promise<void>((resolve) => {
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
      resolve();
    });
    res.on("close", resolve);
    stream.pipe(res);
  });
  return true;
}
