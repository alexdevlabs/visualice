import sharp from "sharp";
import { promises as fs } from "node:fs";
import type { Config } from "../shared/config";

type Thumb = Config["screenshot"]["thumbnail"];
type Format = "png" | "jpeg" | "webp";

function encode(img: sharp.Sharp, format: Format, quality: number): sharp.Sharp {
  if (format === "webp") return img.webp({ quality });
  if (format === "jpeg") return img.jpeg({ quality });
  return img.png();
}

/** Write the full-resolution shot. Playwright gives us png/jpeg buffers; webp is transcoded. */
export async function writeFull(
  buf: Buffer,
  destPath: string,
  format: Format,
  quality: number,
): Promise<void> {
  if (format === "webp") {
    await sharp(buf).webp({ quality }).toFile(destPath);
  } else {
    await fs.writeFile(destPath, buf); // already encoded as png/jpeg by Playwright
  }
}

export async function makeThumb(
  buf: Buffer,
  destPath: string,
  thumb: Thumb,
  width = thumb.width,
): Promise<void> {
  const img = sharp(buf).resize({ width, withoutEnlargement: true });
  await encode(img, thumb.format, thumb.quality).toFile(destPath);
}

export async function imageSize(buf: Buffer): Promise<{ width?: number; height?: number }> {
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height };
}

/** Crop the top-left region (the viewport) out of an already-captured full-page buffer. */
export async function writeViewportCrop(
  buf: Buffer,
  destPath: string,
  format: Format,
  quality: number,
  width: number,
  height: number,
): Promise<void> {
  const img = sharp(buf).extract({ left: 0, top: 0, width, height });
  await encode(img, format, quality).toFile(destPath);
}
