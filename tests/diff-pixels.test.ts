import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { compareImages, writeDiffImage } from "../src/diff/pixels";

let dir: string;

/** Solid canvas with an optional filled rectangle, so a known pixel count differs. */
async function png(
  name: string,
  width: number,
  height: number,
  rect?: { x: number; y: number; w: number; h: number; color: string },
): Promise<string> {
  const file = path.join(dir, name);
  let img = sharp({
    create: { width, height, channels: 3, background: "#ffffff" },
  });
  if (rect) {
    const patch = await sharp({
      create: { width: rect.w, height: rect.h, channels: 3, background: rect.color },
    })
      .png()
      .toBuffer();
    img = sharp(await img.png().toBuffer()).composite([
      { input: patch, top: rect.y, left: rect.x },
    ]);
  }
  await img.png().toFile(file);
  return file;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-pixels-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("compareImages", () => {
  it("reports zero difference for identical images", async () => {
    const a = await png("a.png", 40, 30, { x: 5, y: 5, w: 10, h: 10, color: "#ff0000" });
    const b = await png("b.png", 40, 30, { x: 5, y: 5, w: 10, h: 10, color: "#ff0000" });
    const cmp = await compareImages(a, b);
    expect(cmp.changedPixels).toBe(0);
    expect(cmp.ratio).toBe(0);
    expect(cmp.sizeChanged).toBe(false);
    expect(cmp.diff).toBeUndefined(); // no bitmap unless it was asked for
  });

  it("counts exactly the pixels that moved", async () => {
    const a = await png("c.png", 40, 30);
    const b = await png("d.png", 40, 30, { x: 0, y: 0, w: 10, h: 10, color: "#000000" });
    const cmp = await compareImages(a, b);
    expect(cmp.changedPixels).toBe(100);
    expect(cmp.comparedPixels).toBe(1200);
    expect(cmp.ratio).toBeCloseTo(100 / 1200);
  });

  it("ignores differences within the threshold", async () => {
    const a = await png("e.png", 20, 20);
    const b = await png("f.png", 20, 20, { x: 0, y: 0, w: 20, h: 20, color: "#fafafa" });
    expect((await compareImages(a, b, { threshold: 12 })).changedPixels).toBe(0);
    expect((await compareImages(a, b, { threshold: 1 })).changedPixels).toBe(400);
  });

  it("compares the overlap when a page got taller, and says the size changed", async () => {
    const a = await png("g.png", 40, 30);
    const b = await png("h.png", 40, 90, { x: 0, y: 40, w: 40, h: 50, color: "#00ff00" });
    const cmp = await compareImages(a, b);
    expect(cmp.sizeChanged).toBe(true);
    expect(cmp.comparedPixels).toBe(40 * 30); // the shared top region only
    expect(cmp.changedPixels).toBe(0); // …which is untouched
    expect(cmp.from).toEqual({ width: 40, height: 30 });
    expect(cmp.to).toEqual({ width: 40, height: 90 });
  });

  it("writes a diff image that marks the changed region", async () => {
    const a = await png("i.png", 20, 20);
    const b = await png("j.png", 20, 20, { x: 0, y: 0, w: 4, h: 20, color: "#000000" });
    const diffPath = path.join(dir, "nested", "diff.png");
    const cmp = await compareImages(a, b, { renderDiff: true });
    expect(cmp.diff).toBeDefined();
    await writeDiffImage(cmp.diff!, diffPath);

    const { data, info } = await sharp(diffPath).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(20);
    expect(info.height).toBe(20);
    const at = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    expect(at(1, 1)).toEqual([255, 0, 255]); // changed → magenta
    expect(at(10, 10)[0]).toBeGreaterThan(200); // unchanged → washed out
  });

  it("leaves an ignore region out of both the changed and the compared count", async () => {
    const a = await png("m.png", 40, 30);
    const b = await png("n.png", 40, 30, { x: 0, y: 0, w: 10, h: 10, color: "#000000" });
    // Covers the whole changed square, and then some.
    const covered = await compareImages(a, b, {
      ignore: [{ x: 0, y: 0, width: 20, height: 10 }],
      renderDiff: true,
    });
    expect(covered.changedPixels).toBe(0);
    expect(covered.ignoredPixels).toBe(200);
    expect(covered.comparedPixels).toBe(1200 - 200);
    // The diff image tints what was not compared, rather than showing it as unchanged.
    const d = covered.diff!;
    expect([d.data[0], d.data[1], d.data[2]]).not.toEqual([255, 0, 255]);
    expect(d.data[2]).toBeGreaterThan(d.data[0]);

    // Half the changed square still counts.
    const half = await compareImages(a, b, { ignore: [{ x: 0, y: 0, width: 5, height: 10 }] });
    expect(half.changedPixels).toBe(50);
    // A region hanging off the image is clipped, not an error.
    const off = await compareImages(a, b, { ignore: [{ x: 35, y: 25, width: 100, height: 100 }] });
    expect(off.ignoredPixels).toBe(25);
    expect(off.changedPixels).toBe(100);
  });

  it("does not count anti-aliased edge pixels when asked not to", async () => {
    // A black disc on white, rendered by two rasterisations that differ only in how
    // they blend the edge: what sub-pixel text rendering looks like between machines.
    const disc = async (name: string, shift: number) => {
      const file = path.join(dir, name);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#fff"/><circle cx="${40 + shift}" cy="40" r="25" fill="#000"/></svg>`;
      await sharp(Buffer.from(svg)).png().toFile(file);
      return file;
    };
    const a = await disc("aa-1.png", 0);
    const b = await disc("aa-2.png", 0.4);
    const counted = await compareImages(a, b, { threshold: 12 });
    const lenient = await compareImages(a, b, { threshold: 12, antialiasing: true });
    expect(counted.changedPixels).toBeGreaterThan(20);
    expect(lenient.antialiasedPixels).toBeGreaterThan(0);
    expect(lenient.changedPixels).toBeLessThan(counted.changedPixels / 4);

    // A real change is still a change: a solid block is not an edge blend.
    const c = await png("aa-3.png", 40, 30);
    const d2 = await png("aa-4.png", 40, 30, { x: 5, y: 5, w: 20, h: 20, color: "#000000" });
    const block = await compareImages(c, d2, { antialiasing: true });
    expect(block.changedPixels).toBeGreaterThan(300);
  });

  it("downscales both sides rather than exhausting memory on huge shots", async () => {
    const a = await png("k.png", 200, 200);
    const b = await png("l.png", 200, 200, { x: 0, y: 0, w: 100, h: 200, color: "#000000" });
    const cmp = await compareImages(a, b, { maxPixels: 10_000 });
    expect(cmp.comparedPixels).toBeLessThanOrEqual(10_000);
    expect(cmp.scale).toBeCloseTo(0.5, 1);
    // Half the image still reads as changed, just at lower resolution.
    expect(cmp.ratio).toBeCloseTo(0.5, 1);
  });
});
