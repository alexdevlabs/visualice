import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type http from "node:http";
import { Writable } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MIME,
  contentType,
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
    if (await serveFileFromRoot(res, root, rel)) return;
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
