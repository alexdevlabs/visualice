import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { ConfigSchema, type Config } from "../src/shared/config";
import { imageSize, makeThumb, writeFull, writeViewportCrop } from "../src/crawl/thumbnails";

type Thumb = Config["screenshot"]["thumbnail"];

const THUMB: Thumb = ConfigSchema.parse({}).screenshot.thumbnail;

let dir: string;

/**
 * Stand-in for a Playwright screenshot: a tall page whose top band (the viewport
 * region) is a different colour from the rest, so a crop is verifiable by pixel.
 */
async function page(width = 800, height = 600, bandHeight = 200): Promise<Buffer> {
  const band = await sharp({
    create: { width, height: bandHeight, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, background: "#0000ff" } })
    .composite([{ input: band, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

async function pixel(file: string, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

const dest = (name: string) => path.join(dir, name);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-thumbs-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("writeFull", () => {
  it("writes a png through byte-for-byte rather than re-encoding it", async () => {
    const buf = await page();
    const file = dest("full.png");
    await writeFull(buf, file, "png", 90);
    expect(await fs.readFile(file)).toEqual(buf);
  });

  it("writes a jpeg through untouched too — Playwright already encoded it", async () => {
    const buf = await sharp(await page())
      .jpeg({ quality: 50 })
      .toBuffer();
    const file = dest("full.jpg");
    await writeFull(buf, file, "jpeg", 90);
    expect(await fs.readFile(file)).toEqual(buf);
  });

  it("transcodes to webp, which Playwright cannot produce, keeping the dimensions", async () => {
    const file = dest("full.webp");
    await writeFull(await page(), file, "webp", 60);
    const meta = await sharp(file).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([800, 600]);
  });
});

describe("makeThumb", () => {
  it("resizes to the configured width, preserving the aspect ratio", async () => {
    const file = dest("thumb.webp");
    await makeThumb(await page(), file, THUMB);
    const meta = await sharp(file).metadata();
    expect(meta.width).toBe(THUMB.width);
    expect(meta.height).toBe(Math.round((THUMB.width / 800) * 600));
  });

  it("honours the configured thumbnail format", async () => {
    for (const format of ["webp", "jpeg", "png"] as const) {
      const file = dest(`fmt.${format}`);
      await makeThumb(await page(), file, { ...THUMB, format });
      expect((await sharp(file).metadata()).format).toBe(format);
    }
  });

  it("never enlarges a shot narrower than the thumbnail width", async () => {
    const file = dest("small.webp");
    await makeThumb(await page(120, 90, 30), file, THUMB);
    expect((await sharp(file).metadata()).width).toBe(120);
  });

  it("uses the width override for the mid tier instead of the thumbnail width", async () => {
    const file = dest("mid.webp");
    await makeThumb(await page(2880, 2160, 400), file, THUMB, THUMB.midWidth);
    const meta = await sharp(file).metadata();
    expect(meta.width).toBe(THUMB.midWidth);
    expect(meta.width).not.toBe(THUMB.width);
  });
});

describe("imageSize", () => {
  it("reports the intrinsic pixel dimensions of the buffer", async () => {
    expect(await imageSize(await page(640, 480, 100))).toEqual({ width: 640, height: 480 });
  });
});

describe("writeViewportCrop", () => {
  it("extracts the top-left region of the full-page buffer", async () => {
    const file = dest("viewport.png");
    await writeViewportCrop(await page(), file, "png", 90, 800, 200);
    expect(await sharp(file).metadata()).toMatchObject({ width: 800, height: 200 });
    // The whole crop is the top band; the blue below it was cut away.
    expect(await pixel(file, 400, 0)).toEqual([255, 0, 0]);
    expect(await pixel(file, 400, 199)).toEqual([255, 0, 0]);
  });

  it("honours the requested output format", async () => {
    const file = dest("viewport.webp");
    await writeViewportCrop(await page(), file, "webp", 80, 800, 200);
    expect((await sharp(file).metadata()).format).toBe("webp");
  });

  it("fails rather than silently truncating when the crop exceeds the image", async () => {
    await expect(
      writeViewportCrop(await page(800, 600), dest("oversized.png"), "png", 90, 800, 900),
    ).rejects.toThrow();
  });
});
