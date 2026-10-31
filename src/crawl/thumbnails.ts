import sharp from "sharp";
import { promises as fs } from "node:fs";
import type { Config } from "../shared/config";

// sharp's cache keeps the files it read open. On Windows an open file can't be deleted,
// so pruning old runs or deleting a site would fail with EBUSY. Each shot is read
// about once anyway; keep the memory cache, drop the open files.
sharp.cache({ files: 0 });

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

/**
 * Stack equally sized screens into one image, top to bottom, in the encoding
 * Playwright would have produced — so the result drops in where a single
 * full-page buffer went.
 */
export async function stackScreens(
  frames: Buffer[],
  type: "png" | "jpeg",
  quality: number,
): Promise<Buffer> {
  if (frames.length === 1) return frames[0];
  const { width = 1, height = 1 } = await sharp(frames[0]).metadata();
  const img = sharp({
    create: {
      width,
      height: height * frames.length,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
    // A long phone page stacks past sharp's default pixel limit.
    limitInputPixels: false,
  }).composite(frames.map((input, i) => ({ input, top: i * height, left: 0 })));
  return (type === "jpeg" ? img.jpeg({ quality }) : img.png()).toBuffer();
}
