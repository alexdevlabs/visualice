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
  /**
   * Regions left out of the comparison, in the images' own pixels. They neither
   * count as changed nor as compared, and the diff image tints them so a reader
   * can see what was not looked at.
   */
  ignore?: Rect[];
  /**
   * Don't count anti-aliased pixels. Text and shape edges are blends of their
   * neighbours, and the blend shifts by a level or two between machines, GPU
   * drivers and font hinting settings — a difference that is real in the bytes and
   * invisible on the page.
   */
  antialiasing?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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
  /** Differing pixels left out of the count as anti-aliasing (with `antialiasing`). */
  antialiasedPixels?: number;
  /** Pixels inside an `ignore` region. */
  ignoredPixels?: number;
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

const brightness = (d: Buffer, i: number): number =>
  d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;

/** Does the pixel at (x, y) have at least three neighbours of exactly its colour? */
function hasManySiblings(img: RawImage, x: number, y: number): boolean {
  const { data, width, height } = img;
  const i = (y * width + x) * 3;
  // A pixel on the image's edge has fewer neighbours to find; count the missing
  // ones as siblings, as a flat area running off the edge would be.
  let same = x === 0 || x === width - 1 || y === 0 || y === height - 1 ? 1 : 0;
  for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
      if (nx === x && ny === y) continue;
      const j = (ny * width + nx) * 3;
      if (data[i] === data[j] && data[i + 1] === data[j + 1] && data[i + 2] === data[j + 2]) {
        if (++same > 2) return true;
      }
    }
  }
  return false;
}

/**
 * Is the pixel at (x, y) of `img` anti-aliasing? The test from Vyšniauskas,
 * "Anti-aliased Pixel and Intensity Slope Detector" (2009), which pixelmatch made
 * the usual way to do this: an anti-aliased pixel sits on a slope — it has a
 * darker and a brighter neighbour, few neighbours of its own colour — and the two
 * ends of that slope are flat areas in both images.
 */
function isAntialiased(img: RawImage, x: number, y: number, other: RawImage): boolean {
  const { data, width, height } = img;
  const i = (y * width + x) * 3;
  const here = brightness(data, i);
  let identical = x === 0 || x === width - 1 || y === 0 || y === height - 1 ? 1 : 0;
  let min = 0;
  let max = 0;
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;

  for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
      if (nx === x && ny === y) continue;
      const delta = brightness(data, (ny * width + nx) * 3) - here;
      if (delta === 0) {
        // More than two neighbours this exact brightness: a flat area, not an edge.
        if (++identical > 2) return false;
      } else if (delta < min) {
        min = delta;
        minX = nx;
        minY = ny;
      } else if (delta > max) {
        max = delta;
        maxX = nx;
        maxY = ny;
      }
    }
  }
  // No darker or no brighter neighbour: a corner or a flat step, not a blend.
  if (min === 0 || max === 0) return false;
  return (
    (hasManySiblings(img, minX, minY) && hasManySiblings(other, minX, minY)) ||
    (hasManySiblings(img, maxX, maxY) && hasManySiblings(other, maxX, maxY))
  );
}

/** Mark the pixels each rect covers, clipped to the compared area. */
function ignoreMask(rects: Rect[], scale: number, w: number, h: number): Uint8Array | undefined {
  if (!rects.length) return undefined;
  const mask = new Uint8Array(w * h);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x * scale));
    const y0 = Math.max(0, Math.floor(r.y * scale));
    const x1 = Math.min(w, Math.ceil((r.x + r.width) * scale));
    const y1 = Math.min(h, Math.ceil((r.y + r.height) * scale));
    for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
  }
  return mask;
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
  const mask = ignoreMask(opts.ignore ?? [], scale, cw, ch);
  let changed = 0;
  let antialiased = 0;
  let ignored = 0;

  for (let i = 0, p = 0; p < total; p++, i += 3) {
    const skip = mask !== undefined && mask[p] === 1;
    if (skip) ignored++;
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    let differs = !skip && (dr > threshold || dg > threshold || db > threshold);
    if (differs && opts.antialiasing) {
      const x = p % cw;
      const y = (p - x) / cw;
      if (isAntialiased(a, x, y, b) || isAntialiased(b, x, y, a)) {
        differs = false;
        antialiased++;
      }
    }
    if (differs) changed++;
    if (diff) {
      if (differs) {
        diff[i] = 255;
        diff[i + 1] = 0;
        diff[i + 2] = 255;
      } else if (skip) {
        // Ignored regions get a cool tint: visibly not compared, but not alarming.
        const grey = brightness(b.data, i) * 0.3;
        diff[i] = Math.round(grey + 120);
        diff[i + 1] = Math.round(grey + 150);
        diff[i + 2] = Math.round(grey + 178);
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

  const compared = total - ignored;
  return {
    changedPixels: changed,
    comparedPixels: compared,
    ratio: compared ? changed / compared : 0,
    antialiasedPixels: opts.antialiasing ? antialiased : undefined,
    ignoredPixels: mask ? ignored : undefined,
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

/** A small lossy copy of a diff bitmap, for lists and first paint. */
export async function writeDiffThumb(image: RawImage, file: string, width = 480): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 70 })
    .toFile(file);
}
