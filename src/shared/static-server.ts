import path from "node:path";
import { startServer, serveFileFromRoot, type StaticServer } from "./file-serve";

export type { StaticServer };

export interface ServeDirectoryOptions {
  port?: number;
  /**
   * Serve the directory under this path ("/visualice/"), as a static host would at a
   * subpath. Requests outside it are redirected to it.
   */
  base?: string;
  /** A file in the directory to answer unknown paths with, as a 404. */
  notFound?: string;
}

/** Minimal static file server. Falls back to `<path>.html` and `<path>/index.html`. */
export async function serveDirectory(
  dir: string,
  opts: ServeDirectoryOptions = {},
): Promise<StaticServer> {
  const root = path.resolve(dir);
  const base = opts.base ? `/${opts.base.replace(/^\/+|\/+$/g, "")}/` : "/";
  return startServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith(base)) {
        res.writeHead(302, { location: base }).end();
        return;
      }
      let rel: string;
      try {
        rel = decodeURIComponent(url.pathname.slice(base.length - 1));
      } catch {
        res.statusCode = 400;
        res.end("Bad request");
        return;
      }
      if (rel.endsWith("/")) rel += "index.html";

      if (await serveFileFromRoot(res, root, rel, req)) return;
      if (!path.extname(rel)) {
        if (await serveFileFromRoot(res, root, `${rel}.html`, req)) return;
        if (await serveFileFromRoot(res, root, path.posix.join(rel, "index.html"), req)) return;
      }
      res.statusCode = 404;
      if (opts.notFound && (await serveFileFromRoot(res, root, opts.notFound, req))) return;
      res.end("Not found");
    } catch {
      res.statusCode = 500;
      res.end("Server error");
    }
  }, opts.port);
}
