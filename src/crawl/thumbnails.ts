import sharp from "sharp";
import { promises as fs } from "node:fs";
import type { Config } from "../shared/config";

type Thumb = Config["screenshot"]["thumbnail"];

/** Write the full-resolution shot. Playwright gives us png/jpeg buffers; webp is transcoded. */
export async function writeFull(
  buf: Buffer,
  destPath: string,
  format: "png" | "jpeg" | "webp",
  quality: number,
): Promise<void> {
  if (format === "webp") {
    await sharp(buf).webp({ quality }).toFile(destPath);
  } else {
    await fs.writeFile(destPath, buf); // already encoded as png/jpeg by Playwright
  }
}

export async function makeThumb(buf: Buffer, destPath: string, thumb: Thumb): Promise<void> {
  let img = sharp(buf).resize({ width: thumb.width, withoutEnlargement: true });
  if (thumb.format === "webp") img = img.webp({ quality: thumb.quality });
  else if (thumb.format === "jpeg") img = img.jpeg({ quality: thumb.quality });
  else img = img.png();
  await img.toFile(destPath);
}

export async function imageSize(buf: Buffer): Promise<{ width?: number; height?: number }> {
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height };
}

/** Crop the top-left region (the viewport) out of an already-captured full-page buffer. */
export async function writeViewportCrop(
  buf: Buffer,
  destPath: string,
  format: "png" | "jpeg" | "webp",
  quality: number,
  width: number,
  height: number,
): Promise<void> {
  let img = sharp(buf).extract({ left: 0, top: 0, width, height });
  if (format === "webp") img = img.webp({ quality });
  else if (format === "jpeg") img = img.jpeg({ quality });
  else img = img.png();
  await img.toFile(destPath);
}
