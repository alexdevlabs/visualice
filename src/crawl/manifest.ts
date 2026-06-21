import { promises as fs } from "node:fs";
import path from "node:path";
import type { Manifest, InputManifest } from "../shared/types";

export async function loadManifest(file: string): Promise<Manifest> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Manifest;
}

export async function loadInputManifest(file: string): Promise<InputManifest> {
  return JSON.parse(await fs.readFile(file, "utf8")) as InputManifest;
}

export async function saveJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}
