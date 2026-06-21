import { promises as fs } from "node:fs";

/** True if the path exists (file, dir, or symlink). */
export async function pathExists(p: string): Promise<boolean> {
  return !!(await fs.stat(p).catch(() => null));
}
