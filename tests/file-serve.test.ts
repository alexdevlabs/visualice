import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type http from "node:http";
import { Writable } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MIME,
  contentType,
  parseRange,
  serveFileFromRoot,
  startServer,
  type StaticServer,
} from "../src/shared/file-serve";

/** A 256 KiB body, big enough that it is streamed in several chunks. */
const BINARY = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => (i * 37) % 256));

let tmp: string;
let root: string;
let server: StaticServer;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vc-fileserve-"));
  root = path.join(tmp, "runs", "latest");
  await fs.mkdir(path.join(root, "screenshots"), { recursive: true });
  await fs.mkdir(path.join(tmp, "runs", "latest-evil"), { recursive: true });
  await fs.writeFile(path.join(root, "viewer-data.json"), '{"tiles":[]}');
  await fs.writeFile(path.join(root, "index.html"), "<!doctype html><title>v</title>");
  await fs.writeFile(path.join(root, "screenshots", "home.png"), BINARY);
  await fs.writeFile(path.join(root, "font.woff2"), "not really a font");
  await fs.writeFile(path.join(tmp, "outside.txt"), "TOP SECRET");
  await fs.writeFile(path.join(tmp, "runs", "latest-evil", "secret.txt"), "TOP SECRET");

  server = await startServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    if (await serveFileFromRoot(res, root, rel, req)) return;
    res.statusCode = 404;
    res.end("not found");
  });
});

afterAll(async () => {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

/**
 * A response the file server can actually write into, for the cases that are about
 * which path it resolves rather than what comes back over the wire. Real enough that
 * `stream.pipe(res)` completes: a `Writable` emits "close" once it finishes.
 */
function fakeRes(): http.ServerResponse & { body: () => Buffer } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as unknown as http.ServerResponse & { body: () => Buffer };
  res.setHeader = () => res;
  res.body = () => Buffer.concat(chunks);
  return res;
}

/** Did the file server agree to serve `rel` out of `root`? */
const serves = (rel: string) => serveFileFromRoot(fakeRes(), root, rel);

describe("contentType", () => {
  it("maps every extension the viewer actually serves", () => {
    expect(contentType("a.html")).toBe("text/html; charset=utf-8");
    expect(contentType("a.css")).toBe("text/css; charset=utf-8");
    expect(contentType("a.js")).toBe("text/javascript; charset=utf-8");
    expect(contentType("a.mjs")).toBe("text/javascript; charset=utf-8");
    expect(contentType("a.json")).toBe("application/json; charset=utf-8");
    expect(contentType("a.js.map")).toBe("application/json; charset=utf-8");
    expect(contentType("a.png")).toBe("image/png");
    expect(contentType("a.jpg")).toBe("image/jpeg");
    expect(contentType("a.jpeg")).toBe("image/jpeg");
    expect(contentType("a.webp")).toBe("image/webp");
    expect(contentType("a.svg")).toBe("image/svg+xml");
    expect(contentType("a.ico")).toBe("image/x-icon");
    expect(contentType("a.woff")).toBe("font/woff");
    expect(contentType("a.woff2")).toBe("font/woff2");
    expect(contentType("a.txt")).toBe("text/plain; charset=utf-8");
  });

  it("declares a charset on every text type, so the browser doesn't guess", () => {
    for (const [ext, type] of Object.entries(MIME)) {
      if (type.startsWith("text/") || type.startsWith("application/json")) {
        expect(type, ext).toContain("charset=utf-8");
      }
    }
  });

  it("ignores the case of the extension", () => {
    expect(contentType("SHOT.PNG")).toBe("image/png");
    expect(contentType("Index.HTML")).toBe("text/html; charset=utf-8");
  });

  it("falls back to octet-stream for anything it doesn't know", () => {
    expect(contentType("archive.tar.gz")).toBe("application/octet-stream");
    expect(contentType("LICENSE")).toBe("application/octet-stream");
    expect(contentType(".gitignore")).toBe("application/octet-stream");
  });

  it("goes by the last extension, not the first", () => {
    expect(contentType("shot.png.txt")).toBe("text/plain; charset=utf-8");
  });
});

describe("serveFileFromRoot", () => {
  it("streams a binary file back byte-for-byte with its media type", async () => {
    const res = await fetch(`${server.url}/screenshots/home.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BINARY);
  });

  it("lets the browser cache images and fonts for the life of the run", async () => {
    for (const file of ["/screenshots/home.png", "/font.woff2"]) {
      const res = await fetch(server.url + file);
      expect(res.headers.get("cache-control"), file).toBe("public, max-age=31536000, immutable");
      await res.arrayBuffer();
    }
  });

  it("never caches the run data or the viewer shell, so `latest` stays fresh", async () => {
    for (const file of ["/viewer-data.json", "/index.html"]) {
      const res = await fetch(server.url + file);
      expect(res.headers.get("cache-control"), file).toBe("no-store");
      await res.text();
    }
  });

  it("reports a missing file as not-found rather than erroring", async () => {
    expect((await fetch(`${server.url}/nope.png`)).status).toBe(404);
  });

  it("refuses to serve a directory", async () => {
    expect(await serves("screenshots")).toBe(false);
    expect(await serves("")).toBe(false); // the root itself
  });

  it("refuses a relative path that climbs out of the root", async () => {
    expect(await serves("../../outside.txt")).toBe(false);
    expect(await serves("screenshots/../../../outside.txt")).toBe(false);
  });

  it("refuses a sibling directory that merely shares the root's name prefix", async () => {
    expect(await serves("../latest-evil/secret.txt")).toBe(false);
  });

  it("strips leading slashes, so an absolute-looking path stays inside the root", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "inside");
    expect(await serves("/a.txt")).toBe(true);
    expect(await serves("///a.txt")).toBe(true);
    // …and the same stripping means a real absolute path can never reach the real file.
    expect(await serves(path.join(tmp, "outside.txt"))).toBe(false);
  });

  it("writes the file's bytes into the response it was handed", async () => {
    const res = fakeRes();
    expect(await serveFileFromRoot(res, root, "viewer-data.json")).toBe(true);
    expect(res.body().toString()).toBe('{"tiles":[]}');
  });
});

describe("parseRange", () => {
  it("passes through when nothing was asked for", () => {
    expect(parseRange(undefined, 1000)).toEqual({ kind: "full" });
  });

  it("reads a closed range, inclusive at both ends", () => {
    expect(parseRange("bytes=0-499", 1000)).toEqual({ kind: "partial", start: 0, end: 499 });
    expect(parseRange("bytes=500-999", 1000)).toEqual({ kind: "partial", start: 500, end: 999 });
    expect(parseRange("bytes=7-7", 1000)).toEqual({ kind: "partial", start: 7, end: 7 });
  });

  it("reads an open range as 'to the end of the file'", () => {
    expect(parseRange("bytes=900-", 1000)).toEqual({ kind: "partial", start: 900, end: 999 });
  });

  it("reads a suffix range as 'the last N bytes'", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ kind: "partial", start: 900, end: 999 });
  });

  it("clamps an end past the file rather than rejecting it", () => {
    // A client that asks for more than there is gets what there is — a 416 here
    // would break the common "give me the next megabyte" read pattern.
    expect(parseRange("bytes=900-99999", 1000)).toEqual({ kind: "partial", start: 900, end: 999 });
    expect(parseRange("bytes=-99999", 1000)).toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("tolerates the whitespace the grammar allows", () => {
    expect(parseRange("bytes = 10 - 20 ", 1000)).toEqual({ kind: "partial", start: 10, end: 20 });
    expect(parseRange("BYTES=10-20", 1000)).toEqual({ kind: "partial", start: 10, end: 20 });
  });

  it("calls a range that starts past the end unsatisfiable", () => {
    expect(parseRange("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=5000-6000", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("falls back to the whole body for anything it doesn't implement", () => {
    expect(parseRange("items=0-10", 1000)).toEqual({ kind: "full" }); // not bytes
    expect(parseRange("bytes=0-10, 20-30", 1000)).toEqual({ kind: "full" }); // multipart
    expect(parseRange("bytes=abc-def", 1000)).toEqual({ kind: "full" });
    expect(parseRange("bytes=-", 1000)).toEqual({ kind: "full" });
    expect(parseRange("", 1000)).toEqual({ kind: "full" });
  });

  it("refuses to trust a number too large to be an offset", () => {
    expect(parseRange("bytes=99999999999999999999-", 1000)).toEqual({ kind: "full" });
  });
});

describe("range requests", () => {
  const get = (range?: string) =>
    fetch(`${server.url}/screenshots/home.png`, range ? { headers: { range } } : undefined);

  it("advertises range support and the length on an ordinary response", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(BINARY.length));
    await res.arrayBuffer();
  });

  it("returns exactly the requested slice as a 206", async () => {
    const res = await get("bytes=100-199");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${BINARY.length}`);
    expect(res.headers.get("content-length")).toBe("100");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BINARY.subarray(100, 200));
  });

  it("returns the tail for an open range", async () => {
    const from = BINARY.length - 10;
    const res = await get(`bytes=${from}-`);
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BINARY.subarray(from));
  });

  it("reassembles byte-for-byte from consecutive slices", async () => {
    const chunk = 100 * 1024;
    const parts: Buffer[] = [];
    for (let at = 0; at < BINARY.length; at += chunk) {
      const res = await get(`bytes=${at}-${at + chunk - 1}`);
      expect(res.status).toBe(206);
      parts.push(Buffer.from(await res.arrayBuffer()));
    }
    expect(Buffer.concat(parts)).toEqual(BINARY);
  });

  it("answers an unsatisfiable range with 416 and the real size", async () => {
    const res = await get("bytes=99999999-");
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${BINARY.length}`);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("serves the whole body when the range is one it doesn't implement", async () => {
    const res = await get("bytes=0-10, 50-60");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BINARY);
  });

  it("answers HEAD with the headers of the GET and no body", async () => {
    const res = await fetch(`${server.url}/screenshots/home.png`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(BINARY.length));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });
});

describe("startServer", () => {
  it("binds an ephemeral port and reports a url that matches it", async () => {
    const s = await startServer((_req, res) => res.end("ok"));
    try {
      expect(s.port).toBeGreaterThan(0);
      expect(s.url).toBe(`http://localhost:${s.port}`);
      expect(await (await fetch(s.url)).text()).toBe("ok");
    } finally {
      await s.close();
    }
  });

  it("stops answering once closed", async () => {
    const s = await startServer((_req, res) => res.end("ok"));
    const url = s.url;
    await s.close();
    await expect(fetch(url)).rejects.toThrow();
  });
});
