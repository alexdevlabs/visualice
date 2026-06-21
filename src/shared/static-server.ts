import path from "node:path";
import { startServer, serveFileFromRoot, type StaticServer } from "./file-serve";

export type { StaticServer };

/** Minimal static file server. Falls back to `<path>.html` and `<path>/index.html`. */
export async function serveDirectory(dir: string, opts: { port?: number } = {}): Promise<StaticServer> {
  const root = path.resolve(dir);
  return startServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";

      if (await serveFileFromRoot(res, root, rel)) return;
      if (!path.extname(rel)) {
        if (await serveFileFromRoot(res, root, `${rel}.html`)) return;
        if (await serveFileFromRoot(res, root, path.posix.join(rel, "index.html"))) return;
      }
      res.statusCode = 404;
      res.end("Not found");
    } catch {
      res.statusCode = 500;
      res.end("Server error");
    }
  }, opts.port);
}
