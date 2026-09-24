import sharp from "sharp";
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Pixel comparison for two screenshots of the same state. Full-page shots are tall
 * and often differ in height between runs (content grew), so this compares the
 * overlapping region and reports the size change separately rather than calling the
 * whole image different.
 */

export interface CompareOptions {
  /** Per-channel delta (0–255) that still counts as "the same pixel". Default 12. */
  threshold?: number;
  /**
   * Ceiling on the compared area. Above it both images are downscaled by the same
   * factor first — a dpr-3 full-page shot can be 100M+ pixels, and a diff that
   * exhausts memory is worse than one that's a bit coarse.
   */
  maxPixels?: number;
  /**
   * Also build the highlighted diff bitmap. It comes back in memory rather than
   * going straight to a file: the caller only knows whether it's worth keeping
   * once it has seen the verdict.
   */
  renderDiff?: boolean;
}

/** An in-memory RGB bitmap, ready for `writeDiffImage`. */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

export interface ImageComparison {
  /** Pixels that differed, out of `comparedPixels`. */
  changedPixels: number;
  comparedPixels: number;
  /** changedPixels / comparedPixels, 0–1. */
  ratio: number;
  from: { width: number; height: number };
  to: { width: number; height: number };
  /** True when the two shots aren't the same size (only the overlap was compared). */
  sizeChanged: boolean;
  /** Set when the comparison ran at reduced resolution. */
  scale?: number;
  /** Present when `renderDiff` was asked for. */
  diff?: RawImage;
}

/** Read the top-left `w×h` of an image as raw RGB, optionally downscaled to `tw×th`. */
async function readRegion(
  file: string,
  w: number,
  h: number,
  tw: number,
  th: number,
): Promise<RawImage> {
  let img = sharp(file, { limitInputPixels: false }).extract({
    left: 0,
    top: 0,
    width: w,
    height: h,
  });
  if (tw !== w || th !== h) img = img.resize(tw, th, { fit: "fill", kernel: "nearest" });
  // Flatten onto white: PNG screenshots can carry alpha, and comparing premultiplied
  // channels would report transparent regions as different on every run.
  const { data, info } = await img
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function dimensions(file: string): Promise<{ width: number; height: number }> {
  const m = await sharp(file, { limitInputPixels: false }).metadata();
  if (!m.width || !m.height) throw new Error(`cannot read image dimensions: ${file}`);
  return { width: m.width, height: m.height };
}

/**
 * Compare two images and (optionally) render a diff PNG: the new shot, faded, with
 * every differing pixel painted magenta.
 */
export async function compareImages(
  fromFile: string,
  toFile: string,
  opts: CompareOptions = {},
): Promise<ImageComparison> {
  const threshold = opts.threshold ?? 12;
  const maxPixels = opts.maxPixels ?? 24_000_000;

  const from = await dimensions(fromFile);
  const to = await dimensions(toFile);
  const ow = Math.min(from.width, to.width);
  const oh = Math.min(from.height, to.height);
  if (ow < 1 || oh < 1) throw new Error("images have no overlapping region");

  const scale = Math.min(1, Math.sqrt(maxPixels / (ow * oh)));
  const cw = Math.max(1, Math.round(ow * scale));
  const ch = Math.max(1, Math.round(oh * scale));

  const [a, b] = await Promise.all([
    readRegion(fromFile, ow, oh, cw, ch),
    readRegion(toFile, ow, oh, cw, ch),
  ]);

  const total = cw * ch;
  const diff = opts.renderDiff ? Buffer.alloc(total * 3) : undefined;
  let changed = 0;

  for (let i = 0, p = 0; p < total; p++, i += 3) {
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    const differs = dr > threshold || dg > threshold || db > threshold;
    if (differs) changed++;
    if (diff) {
      if (differs) {
        diff[i] = 255;
        diff[i + 1] = 0;
        diff[i + 2] = 255;
      } else {
        // Wash the unchanged pixels out so the magenta reads at a glance.
        const grey = (b.data[i] * 0.299 + b.data[i + 1] * 0.587 + b.data[i + 2] * 0.114) * 0.35;
        const v = Math.round(grey + 166);
        diff[i] = v;
        diff[i + 1] = v;
        diff[i + 2] = v;
      }
    }
  }

  return {
    changedPixels: changed,
    comparedPixels: total,
    ratio: total ? changed / total : 0,
    from,
    to,
    sizeChanged: from.width !== to.width || from.height !== to.height,
    scale: scale < 1 ? scale : undefined,
    diff: diff ? { data: diff, width: cw, height: ch } : undefined,
  };
}

/** Encode a rendered diff bitmap to a PNG, creating its directory. */
export async function writeDiffImage(image: RawImage, file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toFile(file);
}
