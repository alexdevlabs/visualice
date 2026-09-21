import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveDirectory } from "../../src/shared/static-server";
import type { StaticServer } from "../../src/shared/file-serve";

export const FIXTURE_DIR = path.resolve(import.meta.dirname, "..", "fixture");

/**
 * A throwaway output/site directory that the caller is expected to clean up.
 *
 * `VISUALICE_TEST_TMP` overrides the parent so CI can put these somewhere it can
 * collect afterwards: the OS temp directory is in a different place on every
 * runner, and a crashed test that skips its own cleanup is exactly the case where
 * the leftovers are worth uploading.
 */
export async function tempDir(prefix: string): Promise<string> {
  const parent = process.env.VISUALICE_TEST_TMP || os.tmpdir();
  await fs.mkdir(parent, { recursive: true });
  return fs.mkdtemp(path.join(parent, `vc-${prefix}-`));
}

/** Write `{ "index.html": "<html>…" }` to a temp dir and serve it. */
export async function serveFiles(
  files: Record<string, string>,
): Promise<{ server: StaticServer; dir: string }> {
  const dir = await tempDir("site");
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return { server: await serveDirectory(dir), dir };
}

export const silent = () => {};

/** Every file under `dir`, as paths relative to it. */
export async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath, e.name);
    out.push(path.relative(dir, abs).split(path.sep).join("/"));
  }
  return out.sort();
}
