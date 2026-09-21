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
  name: z.string().describe("Device label; also the screenshot filename (desktop.png)."),
  width: z.number().int().positive().describe("Viewport width in CSS px."),
  height: z.number().int().positive().describe("Viewport height in CSS px."),
  dpr: z.number().positive().default(1).describe("Device pixel ratio (deviceScaleFactor)."),
  mobile: z.boolean().default(false).describe("Emulate a mobile browser (meta viewport, UA)."),
  touch: z.boolean().default(false).describe("Emulate touch input."),
  userAgent: z.string().optional().describe("Override the user-agent string."),
  colorScheme: z
    .enum(["light", "dark", "no-preference"])
    .default("light")
    .describe("prefers-color-scheme — add a second device with `dark` for a dark-mode catalog."),
  reducedMotion: z
    .enum(["reduce", "no-preference"])
    .default("reduce")
    .describe("prefers-reduced-motion; `reduce` complements the animation-kill stabilizer."),
  locale: z
    .string()
    .default("en-US")
    .describe("Browser locale — pinned so Intl/toLocaleString output is machine-independent."),
  timezoneId: z
    .string()
    .default("UTC")
    .describe("IANA timezone — pinned so rendered dates are machine-independent."),
});

const ScopeSchema = z.object({
  include: z
    .array(z.string())
    .default(["/**"])
    .describe("Path globs to crawl. `**` crosses `/`, `*` does not."),
  exclude: z.array(z.string()).default([]).describe("Path globs to skip; wins over `include`."),
  maxDepth: z.number().int().nonnegative().default(4).describe("Max link hops from a seed."),
  maxPages: z.number().int().positive().default(200).describe("Hard cap on routes captured."),
  sameOriginOnly: z.boolean().default(true).describe("Never leave the target origin."),
  hashRoutes: z
    .enum(["auto", "never", "always"])
    .default("auto")
    .describe(
      "Whether a URL fragment identifies a route. `auto` counts router-shaped fragments (`#/about`, `#!/about`) and leaves plain anchors alone; `never` treats every fragment as an in-page anchor; `always` makes any fragment a route (which turns a page's anchor list into routes — opt in deliberately).",
    ),
});

const InteractionsSchema = z.object({
  auto: z.boolean().default(true).describe("Heuristically probe triggers to discover UI states."),
  hover: z
    .boolean()
    .default(true)
    .describe("Also probe hover-revealed states (dropdown navs, hover menus)."),
  maxPerPage: z
    .number()
    .int()
    .positive()
    .default(12)
    .describe("Cap on discovered states per route (combinatorial guard)."),
  maxCandidates: z
    .number()
    .int()
    .positive()
    .default(40)
    .describe("Cap on trigger candidates examined per page."),
  clickTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(4000)
    .describe("Timeout for one probe click/hover."),
  settleMs: z
    .number()
    .int()
    .nonnegative()
    .default(250)
    .describe("Settle delay after a probe before diffing the DOM."),
  nestDepth: z
    .number()
    .int()
    .nonnegative()
    .default(1)
    .describe(
      "0 = default render only, 1 = single mutations, >1 = also probe inside opened states (expensive).",
    ),
  denyLabels: z
    .array(z.string())
    .default(["logout", "sign out", "delete", "remove", "unsubscribe", "pay"])
    .describe("Skip triggers whose accessible label contains any of these (case-insensitive)."),
  denySelectors: z
    .array(z.string())
    .default([])
    .describe("Skip triggers matching these selectors."),
  extraTriggers: z
    .array(z.string())
    .default([])
    .describe("Extra selectors to treat as candidate triggers."),
  formStates: z
    .boolean()
    .default(true)
    .describe(
      "Also probe forms for a focused state (when the page styles a focus ring) and a validation-error state (by touching required fields, never by submitting).",
    ),
});

const DiscoveryViewportSchema = z.object({
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(900),
});

const DiscoverySchema = z.object({
  useSitemap: z
    .boolean()
    .default(true)
    .describe("Seed the crawl from /sitemap.xml and robots-declared sitemaps."),
  viewport: DiscoveryViewportSchema.default(DiscoveryViewportSchema.parse({})).describe(
    "Viewport used while probing for states (capture replays them on every device).",
  ),
  mobileStates: z
    .boolean()
    .default(true)
    .describe(
      "Also probe at the first mobile device's viewport, so mobile-only states (hamburger nav) are discovered; those states capture only on mobile devices.",
    ),
  interactions: InteractionsSchema.default(InteractionsSchema.parse({})),
});

const ThumbnailSchema = z.object({
  width: z.number().int().positive().default(480).describe("Thumbnail width in px."),
  midWidth: z
    .number()
    .int()
    .nonnegative()
    .default(1024)
    .describe(
      "Width of a mid-resolution step between the thumbnail and the full image, so zooming doesn't jump straight to a multi-MB PNG. 0 disables it.",
    ),
  format: z.enum(["webp", "jpeg", "png"]).default("webp").describe("Thumbnail image format."),
  quality: z.number().int().min(1).max(100).default(70).describe("Thumbnail encoder quality."),
});

const ScreenshotSchema = z.object({
  fullPage: z.boolean().default(true).describe("Capture the whole scrollable page."),
  alsoViewport: z
    .boolean()
    .default(false)
    .describe("Additionally write an above-the-fold crop per shot."),
  format: z.enum(["png", "jpeg", "webp"]).default("png").describe("Full-resolution image format."),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(90)
    .describe("Encoder quality for lossy formats."),
  maxHeight: z
    .number()
    .int()
    .nonnegative()
    .default(20000)
    .describe(
      "Clamp for full-page shots, in CSS px; taller pages are cropped to this and flagged. 0 disables the clamp (infinite-scroll pages can then exhaust memory).",
    ),
  thumbnail: ThumbnailSchema.default(ThumbnailSchema.parse({})),
});

const StabilizeSchema = z.object({
  animations: z
    .enum(["disabled", "allow"])
    .default("disabled")
    .describe("Inject CSS that kills transitions/animations before shooting."),
  freezeTime: z
    .string()
    .optional()
    .describe("ISO timestamp pinned into the page as `Date.now()` for reproducible shots."),
  seedRandom: z.number().optional().describe("Seed for a deterministic `Math.random()`."),
  maskSelectors: z
    .array(z.string())
    .default([])
    .describe("Selectors painted over with an opaque box (ads, clocks, carousels)."),
  waitForSelectors: z
    .array(z.string())
    .default([])
    .describe(
      "Selectors that must be visible before a screenshot is taken — the shot waits for the page's own 'ready' markers instead of a fixed delay.",
    ),
  waitForSelectorsTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(5000)
    .describe(
      "Total time all `waitForSelectors` entries share per shot — they are waited on together, so this is the whole cost, not the cost per selector. Deliberately short: a stale selector should cost a moment and a warning, not the full navigation timeout on every shot.",
    ),
  waitStrategy: z
    .enum(["load", "domcontentloaded", "networkidle"])
    .default("networkidle")
    .describe("Navigation wait condition."),
  extraDelayMs: z
    .number()
    .int()
    .nonnegative()
    .default(250)
    .describe("Settle delay applied right before each screenshot."),
  waitForFonts: z.boolean().default(true).describe("Await `document.fonts.ready`."),
  lazyScroll: z
    .boolean()
    .default(true)
    .describe("Scroll to the bottom and back to trigger lazy-loaded content."),
});

const LoginSchema = z.object({
  url: z.string().optional().describe("Login page, absolute or relative to `target`."),
  // steps are RecipeStep[]; validated loosely here and cast at runtime to keep the
  // discriminated union out of the schema. Use ${ENV_VAR} in fill values for secrets.
  steps: z
    .array(z.unknown())
    .default([])
    .describe("Recipe steps to sign in. Use ${ENV_VAR} in `fill` values for secrets."),
  maxAgeHours: z
    .number()
    .positive()
    .default(12)
    .describe(
      "Re-run the login recipe once the saved session is older than this. Ignored when `sessionCookies` names a cookie with an expiry.",
    ),
  sessionCookies: z
    .array(z.string())
    .optional()
    .describe(
      "Names of the cookie(s) that carry the session (a trailing * matches a prefix, e.g. wordpress_logged_in_*). When set, the session is refreshed when the soonest of these expires, instead of after maxAgeHours. Other cookies (CSRF, consent, analytics) never decide it.",
    ),
  verify: z
    .object({
      url: z
        .string()
        .optional()
        .describe("URL glob the page must reach after the login recipe (e.g. **/dashboard)."),
      selector: z
        .string()
        .optional()
        .describe("Selector that must be visible after the login recipe."),
      timeoutMs: z.number().int().positive().default(10000).describe("Verification timeout."),
    })
    .optional()
    .describe(
      "Post-login success check. Without it, a silently-changed login form would save a logged-out session and produce a run of login-wall screenshots.",
    ),
});

const AuthSchema = z.object({
  storageStatePath: z
    .string()
    .optional()
    .describe("Where the Playwright storage state (cookies + localStorage) is kept."),
  login: LoginSchema.optional(),
});

const HttpSchema = z.object({
  ignoreHTTPSErrors: z
    .boolean()
    .default(false)
    .describe("Accept invalid/self-signed TLS certificates (staging environments)."),
  extraHTTPHeaders: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Headers sent with every browser request (preview tokens, bypass cookies). Values may use ${ENV_VAR}.",
    ),
  httpCredentials: z
    .object({
      username: z.string().describe("Basic-auth username; may use ${ENV_VAR}."),
      password: z.string().describe("Basic-auth password; may use ${ENV_VAR}."),
    })
    .optional()
    .describe("HTTP basic-auth credentials for password-protected environments."),
  proxy: z
    .object({
      server: z
        .string()
        .describe("Proxy URL, e.g. http://proxy:3128 or socks5://proxy:1080; may use ${ENV_VAR}."),
      bypass: z
        .string()
        .optional()
        .describe('Comma-separated hosts to reach directly, e.g. "localhost,*.internal".'),
      username: z.string().optional().describe("Proxy username; may use ${ENV_VAR}."),
      password: z.string().optional().describe("Proxy password; may use ${ENV_VAR}."),
    })
    .optional()
    .describe(
      "Route browser traffic through a proxy — needed on corporate networks and to reach an environment only visible behind one.",
    ),
});

const OutputSchema = z.object({
  dir: z.string().default(".visualice").describe("Root output directory."),
  keepRuns: z.number().int().positive().default(5).describe("Prune all but the newest N runs."),
});

const PolitenessSchema = z.object({
  concurrency: z.number().int().positive().default(4).describe("Pages captured in parallel."),
  minDelayMs: z
    .number()
    .int()
    .nonnegative()
    .default(150)
    .describe("Floor for the delay between requests to the target."),
  respectRobots: z
    .boolean()
    .default(true)
    .describe("Obey robots.txt Disallow/Allow rules and Crawl-delay during discovery."),
  timeoutMs: z.number().int().positive().default(30000).describe("Per-navigation timeout."),
  retries: z
    .number()
    .int()
    .nonnegative()
    .default(1)
    .describe("Extra attempts for a failed navigation or capture before recording a failure."),
  reuseNavigation: z
    .boolean()
    .default(true)
    .describe(
      "Skip the page reload when the next state's recipe simply extends what the page already shows (a state captured right after the route's default render, or a nested state after its parent). Fewer requests to the target and a faster run; turn off if a page can only be trusted straight from a reload.",
    ),
});

export const ConfigSchema = z.object({
  target: z.string().optional().describe("Base URL of the site to crawl."),
  scope: ScopeSchema.default(ScopeSchema.parse({})),
  seeds: z
    .array(z.string())
    .default([])
    .describe("Extra entry points to crawl beyond the homepage."),
  discovery: DiscoverySchema.default(DiscoverySchema.parse({})),
  devices: z
    .array(DeviceSchema)
    .default([
      DeviceSchema.parse({ name: "desktop", width: 1440, height: 900, dpr: 2 }),
      DeviceSchema.parse({
        name: "mobile",
        width: 390,
        height: 844,
        dpr: 3,
        mobile: true,
        touch: true,
      }),
    ])
    .describe("Device profiles; every route × state is captured once per device."),
  screenshot: ScreenshotSchema.default(ScreenshotSchema.parse({})),
  stabilize: StabilizeSchema.default(StabilizeSchema.parse({})),
  auth: AuthSchema.default(AuthSchema.parse({})),
  http: HttpSchema.default(HttpSchema.parse({})),
  routesFile: z
    .union([z.string(), z.literal(false)])
    .default("visualice.routes.md")
    .describe(
      "Human/LLM-editable site index (routes + states), regenerated after every crawl; `false` disables it.",
    ),
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
