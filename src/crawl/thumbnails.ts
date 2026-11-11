import sharp from "sharp";
import { promises as fs } from "node:fs";
import type { Config } from "../shared/config";

// sharp's cache keeps the files it read open. On Windows an open file can't be deleted,
// so pruning old runs or deleting a site would fail with EBUSY. Each shot is read
// about once anyway; keep the memory cache, drop the open files.
sharp.cache({ files: 0 });

type Thumb = Config["screenshot"]["thumbnail"];
type Format = "png" | "jpeg" | "webp";

/**
 * The tallest image each format can hold, in pixels. A long page captured on a
 * high-density phone runs to tens of thousands of pixels: PNG holds it, but a WebP
 * stops at 16383 and a JPEG at 65535, and sharp then throws instead of writing.
 */
export const MAX_SIDE: Record<Format, number> = { webp: 16383, jpeg: 65535, png: Infinity };

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
    const { width = 0, height = 0 } = await sharp(buf, { limitInputPixels: false }).metadata();
    if (Math.max(width, height) > MAX_SIDE.webp) {
      throw new Error(
        `the page is ${height}px tall, and a WebP image holds at most ${MAX_SIDE.webp}px: ` +
          `set screenshot.format to "png", or lower screenshot.maxHeight`,
      );
    }
    await sharp(buf, { limitInputPixels: false }).webp({ quality }).toFile(destPath);
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
  // A very long page would come out taller than the format holds at this width: it
  // is scaled down further to fit, keeping its shape, so the whole page still shows
  // (just softer) rather than the shot failing over a preview image.
  const max = MAX_SIDE[thumb.format];
  const img = sharp(buf, { limitInputPixels: false }).resize({
    width,
    ...(Number.isFinite(max) ? { height: max, fit: "inside" as const } : {}),
    withoutEnlargement: true,
  });
  await encode(img, thumb.format, thumb.quality).toFile(destPath);
}

export async function imageSize(buf: Buffer): Promise<{ width?: number; height?: number }> {
  const m = await sharp(buf, { limitInputPixels: false }).metadata();
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
  // A long page is past sharp's default pixel limit; the crop itself is one screen.
  const img = sharp(buf, { limitInputPixels: false }).extract({ left: 0, top: 0, width, height });
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
