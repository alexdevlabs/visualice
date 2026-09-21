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

export async function startServer(
  handler: http.RequestListener,
  port?: number,
): Promise<StaticServer> {
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

/** What a `Range` header asks for, once checked against the file's size. */
export type RangeResult =
  | { kind: "full" }
  /** Inclusive byte offsets, as `Content-Range` states them. */
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

/**
 * Interpret a `Range` header against a known size (RFC 9110 §14).
 *
 * Anything this doesn't handle resolves to `full` rather than an error: a range
 * request is an optimisation, and a server is always allowed to answer it with the
 * whole body. That covers unknown units, malformed specs, and multi-range requests
 * — the last of which needs a `multipart/byteranges` body, and answering one with a
 * single 206 range would be a wrong answer rather than a partial one.
 *
 * `unsatisfiable` is reserved for a syntactically fine range that lies outside the
 * file, which has to be a 416: a client asking for byte 5000 of a 100-byte file has
 * stale information, and silently handing it the first 100 bytes would corrupt
 * whatever it is assembling.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: "full" };
  const unit = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!unit) return { kind: "full" };
  const specs = unit[1].split(",");
  if (specs.length !== 1) return { kind: "full" };
  const spec = /^\s*(\d*)\s*-\s*(\d*)\s*$/.exec(specs[0]);
  if (!spec) return { kind: "full" };

  const [, rawStart, rawEnd] = spec;
  if (rawStart === "" && rawEnd === "") return { kind: "full" }; // "bytes=-" says nothing
  let start: number;
  let end: number;
  if (rawStart === "") {
    // A suffix range: the last N bytes, clamped to the whole file if N overshoots.
    const wanted = Number(rawEnd);
    if (wanted === 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - wanted);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: "full" };
  if (start >= size || start > end) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end };
}

/** The parts of a request the file server reads, so callers can pass a real one. */
export type ServableRequest = Pick<http.IncomingMessage, "headers" | "method">;

export interface ServeOptions {
  /**
   * The URL names content that can never change, so images and fonts may be cached
   * for a year without asking again. Only true for a path that names one run by its
   * id: `/data/…` and `runs/latest/…` are aliases for whichever run is newest, and a
   * re-crawl puts different pixels behind the very same URL.
   */
  immutable?: boolean;
}

/** Media the viewer loads by the hundred, and so the only files worth caching. */
const CACHEABLE = new Set([".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2", ".ico"]);

/** A validator that changes whenever the file is rewritten. */
function etagFor(stat: { size: number; mtimeMs: number }): string {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/** Does an `If-None-Match` header already name this version of the file? */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const weak = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || weak(t) === weak(etag));
}

/**
 * Serve a file confined to `root`. Returns false (caller decides 404) if the
 * resolved path escapes root or isn't a regular file.
 *
 * The containment check uses `root + path.sep` (not a bare `startsWith`) so a
 * sibling directory sharing the name as a prefix — e.g. `runs/latest-evil` vs
 * `runs/latest` — cannot be reached, including via percent-encoded `..`.
 *
 * Pass `req` to get conditional-range behaviour: `Range` is honoured with a 206 and
 * `HEAD` returns the headers alone. Without it the whole file is streamed, which is
 * what every internal caller wanted before and still gets.
 *
 * Images and fonts are cached one of two ways. Under `immutable` the browser keeps
 * them for a year without asking; otherwise it keeps them but revalidates, and an
 * unchanged file costs a 304 rather than its bytes. The second is the default
 * because it is the one that is never wrong: a path is only immutable if the caller
 * knows it names one run, and guessing wrong shows the previous run's pixels with
 * no error anywhere.
 */
export async function serveFileFromRoot(
  res: http.ServerResponse,
  root: string,
  rel: string,
  req?: ServableRequest,
  opts: ServeOptions = {},
): Promise<boolean> {
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(resolvedRoot, rel.replace(/^\/+/, ""));
  if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) return false;

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return false;

  res.setHeader("Content-Type", contentType(filePath));
  // Advertised unconditionally: a client that sees this may skip a probe request.
  res.setHeader("Accept-Ranges", "bytes");
  // Re-panning over a region must not re-download multi-MB PNGs, so media is always
  // cacheable — for good when the URL is pinned to a run, and otherwise only until
  // the file changes. HTML/JSON/JS are never cached, so `latest` serves fresh data.
  const ext = path.extname(filePath).toLowerCase();
  if (!CACHEABLE.has(ext)) {
    res.setHeader("Cache-Control", "no-store");
  } else if (opts.immutable) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    const etag = etagFor(stat);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("ETag", etag);
    res.setHeader("Last-Modified", stat.mtime.toUTCString());
    if (matchesEtag(req?.headers["if-none-match"], etag)) {
      res.statusCode = 304;
      res.end();
      return true;
    }
  }

  const range = parseRange(req?.headers.range, stat.size);
  if (range.kind === "unsatisfiable") {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${stat.size}`);
    res.setHeader("Content-Length", "0");
    res.end();
    return true;
  }

  const start = range.kind === "partial" ? range.start : 0;
  const end = range.kind === "partial" ? range.end : stat.size - 1;
  if (range.kind === "partial") {
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  }
  res.setHeader("Content-Length", String(end - start + 1));

  // A HEAD answer carries the headers of the GET and none of its body.
  if (req?.method === "HEAD") {
    res.end();
    return true;
  }

  await new Promise<void>((resolve) => {
    const stream = createReadStream(filePath, range.kind === "partial" ? { start, end } : {});
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
