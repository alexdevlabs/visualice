import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { serveDirectory, type StaticServer } from "../src/shared/static-server";

let dir: string;
let server: StaticServer;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-static-"));
  const write = async (rel: string, body: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body);
  };
  await write("index.html", "home");
  await write("about.html", "about");
  await write("guide/index.html", "guide");
  await write("404.html", "missing");
  server = await serveDirectory(dir, { base: "/docs/", notFound: "404.html" });
});
afterAll(async () => {
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const get = (p: string) => fetch(server.url + p, { redirect: "manual" });

describe("serveDirectory under a base path", () => {
  it("serves the directory under the base, with the .html and index fallbacks", async () => {
    expect(await (await get("/docs/")).text()).toBe("home");
    expect(await (await get("/docs/about")).text()).toBe("about");
    expect(await (await get("/docs/guide")).text()).toBe("guide");
  });

  it("redirects requests outside the base to it", async () => {
    const res = await get("/about");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/docs/");
  });

  it("answers an unknown path with the 404 page", async () => {
    const res = await get("/docs/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("missing");
  });

  it("rejects a malformed path instead of crashing", async () => {
    expect((await get("/docs/%E0")).status).toBe(400);
    // …and keeps serving.
    expect((await get("/docs/")).status).toBe(200);
  });
});
