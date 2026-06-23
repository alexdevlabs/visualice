import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

// NOTE on defaults: zod's `.default(value)` does NOT re-parse the provided value,
// so attaching `.default({})` to a nested object schema would yield a bare `{}`
// without inner defaults. We therefore build schemas bottom-up and seed each
// nested default with `Schema.parse({})`, which DOES apply that schema's
// field-level defaults. Result: `ConfigSchema.parse({})` is fully populated.

export const DeviceSchema = z.object({
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  dpr: z.number().positive().default(1),
  mobile: z.boolean().default(false),
  touch: z.boolean().default(false),
  userAgent: z.string().optional(),
});

const ScopeSchema = z.object({
  include: z.array(z.string()).default(["/**"]),
  exclude: z.array(z.string()).default([]),
  maxDepth: z.number().int().nonnegative().default(4),
  maxPages: z.number().int().positive().default(200),
  sameOriginOnly: z.boolean().default(true),
});

const InteractionsSchema = z.object({
  auto: z.boolean().default(true),
  maxPerPage: z.number().int().positive().default(12),
  nestDepth: z.number().int().nonnegative().default(1),
  denyLabels: z
    .array(z.string())
    .default(["logout", "sign out", "delete", "remove", "unsubscribe", "pay"]),
  denySelectors: z.array(z.string()).default([]),
  extraTriggers: z.array(z.string()).default([]),
});

const DiscoverySchema = z.object({
  useSitemap: z.boolean().default(true),
  followSpaNav: z.boolean().default(true),
  interactions: InteractionsSchema.default(InteractionsSchema.parse({})),
});

const ThumbnailSchema = z.object({
  width: z.number().int().positive().default(480),
  format: z.enum(["webp", "jpeg", "png"]).default("webp"),
  quality: z.number().int().min(1).max(100).default(70),
});

const ScreenshotSchema = z.object({
  fullPage: z.boolean().default(true),
  alsoViewport: z.boolean().default(false),
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
  quality: z.number().int().min(1).max(100).default(90),
  thumbnail: ThumbnailSchema.default(ThumbnailSchema.parse({})),
});

const StabilizeSchema = z.object({
  animations: z.enum(["disabled", "allow"]).default("disabled"),
  freezeTime: z.string().optional(),
  seedRandom: z.number().optional(),
  maskSelectors: z.array(z.string()).default([]),
  waitStrategy: z.enum(["load", "domcontentloaded", "networkidle"]).default("networkidle"),
  extraDelayMs: z.number().int().nonnegative().default(250),
  waitForFonts: z.boolean().default(true),
  lazyScroll: z.boolean().default(true),
});

const LoginSchema = z.object({
  url: z.string().optional(),
  // steps are RecipeStep[]; validated loosely here and cast at runtime to keep the
  // discriminated union out of the schema. Use ${ENV_VAR} in fill values for secrets.
  steps: z.array(z.unknown()).default([]),
  maxAgeHours: z.number().positive().default(12),
});

const AuthSchema = z.object({
  storageStatePath: z.string().optional(),
  login: LoginSchema.optional(),
});

const OutputSchema = z.object({
  dir: z.string().default(".visualice"),
  keepRuns: z.number().int().positive().default(5),
});

const PolitenessSchema = z.object({
  concurrency: z.number().int().positive().default(4),
  minDelayMs: z.number().int().nonnegative().default(150),
  respectRobots: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(30000),
});

export const ConfigSchema = z.object({
  target: z.string().optional(),
  scope: ScopeSchema.default(ScopeSchema.parse({})),
  seeds: z.array(z.string()).default([]),
  discovery: DiscoverySchema.default(DiscoverySchema.parse({})),
  devices: z.array(DeviceSchema).default([
    { name: "desktop", width: 1440, height: 900, dpr: 2, mobile: false, touch: false },
    { name: "mobile", width: 390, height: 844, dpr: 3, mobile: true, touch: true },
  ]),
  screenshot: ScreenshotSchema.default(ScreenshotSchema.parse({})),
  stabilize: StabilizeSchema.default(StabilizeSchema.parse({})),
  auth: AuthSchema.default(AuthSchema.parse({})),
  output: OutputSchema.default(OutputSchema.parse({})),
  politeness: PolitenessSchema.default(PolitenessSchema.parse({})),
});

export type Config = z.infer<typeof ConfigSchema>;
/** Authoring type for `visualice.config.ts` — everything optional thanks to defaults. */
export type VisualiceConfig = z.input<typeof ConfigSchema>;

export async function loadConfig(file?: string): Promise<Config> {
  if (!file) return ConfigSchema.parse({});
  const abs = path.resolve(file);
  let raw: unknown;
  if (abs.endsWith(".json")) {
    raw = JSON.parse(await fs.readFile(abs, "utf8"));
  } else {
    const mod = await import(pathToFileURL(abs).href);
    raw = (mod as { default?: unknown }).default ?? mod;
  }
  return ConfigSchema.parse(raw);
}
