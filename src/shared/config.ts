import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { validPattern } from "./pattern";

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
  browser: z
    .enum(["chromium", "firefox", "webkit"])
    .default("chromium")
    .describe(
      "Engine this device is captured with. Discovery always runs in Chromium; add a second device with `firefox` or `webkit` for a cross-browser catalog (install the engine with `npx playwright install <name>`).",
    ),
});

const ScopeSchema = z.object({
  include: z
    .array(z.string())
    .default(["/**"])
    .describe("Path globs to crawl. `**` crosses `/`, `*` does not."),
  exclude: z.array(z.string()).default([]).describe("Path globs to skip; wins over `include`."),
  maxDepth: z.number().int().nonnegative().default(4).describe("Max link hops from a seed."),
  maxPages: z.number().int().positive().default(200).describe("Hard cap on routes captured."),
  samples: z
    .record(z.string(), z.number().int().positive())
    .default({})
    .describe(
      'At most this many pages per path glob, e.g. `{ "/product/*": 3 }`: a few pages of a template stand for the rest, whatever their ids. Pages listed in `seeds` or the routes file are kept on top of the sample.',
    ),
  sameOriginOnly: z.boolean().default(true).describe("Never leave the target origin."),
  hashRoutes: z
    .enum(["auto", "never", "always"])
    .default("auto")
    .describe(
      "Whether a URL fragment identifies a route. `auto` counts router-shaped fragments (`#/about`, `#!/about`) and leaves plain anchors alone; `never` treats every fragment as an in-page anchor; `always` makes any fragment a route (which turns a page's anchor list into routes — opt in deliberately).",
    ),
});

const InteractionsSchema = z.object({
  auto: z
    .boolean()
    .default(true)
    .describe(
      "Probe the page for UI states (menus, modals, tabs, forms). Off captures each page's default render only.",
    ),
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
  patienceMs: z
    .number()
    .int()
    .nonnegative()
    .default(1500)
    .describe(
      "How long a probe keeps looking for what a click opened while the page is still busy after `settleMs` (requests the click started still loading, the DOM still changing). A slow server or a dev build can take longer than `settleMs` to show a dialog. 0 looks once, after `settleMs`.",
    ),
  nestDepth: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe(
      "How deep to probe: 1 = states one interaction away, >1 = also probe inside opened states (expensive). Turn states off with `auto: false`.",
    ),
  siteWideOnce: z
    .boolean()
    .default(true)
    .describe(
      "Keep a state found identically on several pages (a header dropdown, a chat widget) only on the first page it was found on, instead of capturing it on every page.",
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
  unstableIds: z
    .array(z.string().refine(validPattern, { message: "not a valid regular expression" }))
    .default([])
    .describe(
      "Element ids this site generates at render time, as regular expressions (`^mat-dialog-\\d+$`, `^ember\\d+$`). Such an id is different on the next load, on another device or after another click, so recipes and state signatures never use one. React's useId and common component libraries are known already, and each crawl lists the ones it noticed changing; add those here to keep them.",
    ),
});

const ThumbnailSchema = z.object({
  width: z.number().int().positive().default(480).describe("Thumbnail width in px."),
  zoomWidth: z
    .number()
    .int()
    .nonnegative()
    .default(1024)
    .describe(
      "Width of the in-between image the viewer shows while zooming in, between the thumbnail and the full image, so zooming doesn't jump straight to a multi-MB PNG. 0 disables it.",
    ),
  format: z.enum(["webp", "jpeg", "png"]).default("webp").describe("Thumbnail image format."),
  quality: z.number().int().min(1).max(100).default(70).describe("Thumbnail encoder quality."),
});

const ScreenshotSchema = z.object({
  fullPage: z
    .union([z.enum(["screens", "single"]), z.literal(false)])
    .default("screens")
    .describe(
      "How a whole page is captured. `screens`: the way a user sees it, one screen at a time, scrolling between them, stacked into one image, so fixed banners and modal backdrops appear on every screen as they do in the browser. `single`: one tall render, which draws fixed elements once, mid-page. `false`: the first screen only.",
    ),
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
    .default(25000)
    .describe(
      "Longest page captured, in CSS px, in both full-page modes; a longer page is cut off there and flagged. Bounds an infinite-scroll page. 0 disables the limit (such a page can then exhaust memory).",
    ),
  maxScreens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Deprecated: use `maxHeight`. Still honoured as an extra limit on screens."),
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
  keepRuns: z
    .number()
    .int()
    .positive()
    .default(5)
    .describe("Prune all but the newest N runs of each site."),
  site: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Folder name for this site's runs under <dir>/sites/. Default: the target's hostname without www. (and without the port on localhost).",
    ),
});

const ComponentSchema = z.object({
  name: z.string().describe("Label for the component; also its state id (`component-<name>`)."),
  selector: z.string().describe("Selector of the element to screenshot on its own."),
  routes: z
    .array(z.string())
    .default(["/**"])
    .describe("Path globs of the routes to look for it on; a route without it is skipped."),
});

const ChecksSchema = z.object({
  accessibility: z
    .boolean()
    .default(false)
    .describe(
      "Run axe-core against every captured state and record the violations beside the shot.",
    ),
  accessibilityTags: z
    .array(z.string())
    .default(["wcag2a", "wcag2aa"])
    .describe("axe rule tags to run."),
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
  testIdAttribute: z
    .string()
    .regex(/^[A-Za-z_][\w.:-]*$/)
    .default("data-testid")
    .describe(
      "Attribute holding the site's test ids (e.g. data-test, data-cy, data-qa). Recipe `testId` targets and discovered triggers use it.",
    ),
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
  components: z
    .array(ComponentSchema)
    .default([])
    .describe("Elements captured on their own, in addition to the page they sit on."),
  checks: ChecksSchema.default(ChecksSchema.parse({})),
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
    const mod = await importConfig(abs);
    raw = (mod as { default?: unknown }).default ?? mod;
  }
  return parseConfig(raw);
}

/** A config file that can't be loaded, for a reason the message fully explains. */
export class ConfigLoadError extends Error {}

/**
 * Import a `.js`/`.ts` config. Node runs `.ts` itself from 22.18 by stripping the
 * types, which also means syntax that needs compiling (an `enum`, a `namespace`)
 * fails; both failures get a message that says what to do instead of a stack trace.
 */
async function importConfig(abs: string): Promise<unknown> {
  try {
    return await import(pathToFileURL(abs).href);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ERR_UNKNOWN_FILE_EXTENSION" && /\.[cm]?ts$/.test(abs)) {
      throw new ConfigLoadError(
        `can't load ${path.basename(abs)}: Node ${process.versions.node} doesn't run TypeScript ` +
          `files (22.18 or newer does). Upgrade Node, or use visualice.config.json.`,
      );
    }
    if (code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
      throw new ConfigLoadError(
        `can't load ${path.basename(abs)}: ${(e as Error).message.split("\n")[0]} — Node only ` +
          `strips types, so use plain objects and unions instead of enums or namespaces.`,
      );
    }
    throw e;
  }
}

type Warn = (msg: string) => void;
const warnStderr: Warn = (m) => console.error(m);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Rewrite config keys renamed before 1.0 to their current names, warning once per
 * key. A pure function of its input: the caller's object is never modified.
 */
export function migrateConfig(raw: unknown, warn: Warn = warnStderr): unknown {
  if (!isObj(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };

  if (isObj(out.screenshot)) {
    const shot: Record<string, unknown> = { ...out.screenshot };
    if (typeof shot.fullPage === "boolean" || "screens" in shot) {
      const full = shot.fullPage ?? true;
      const screens = shot.screens ?? true;
      if ("screens" in shot)
        warn(
          'config: screenshot.screens is deprecated — use screenshot.fullPage: "screens" | "single"',
        );
      else
        warn(
          `config: screenshot.fullPage: ${String(full)} is deprecated — use "screens", "single" or false`,
        );
      shot.fullPage = full === false ? false : screens === false ? "single" : "screens";
      delete shot.screens;
    }
    if (shot.maxScreens !== undefined) {
      warn("config: screenshot.maxScreens is deprecated — use screenshot.maxHeight (CSS px)");
    }
    if (isObj(shot.thumbnail) && "midWidth" in shot.thumbnail) {
      const { midWidth, ...thumb } = shot.thumbnail;
      warn("config: screenshot.thumbnail.midWidth is renamed — use screenshot.thumbnail.zoomWidth");
      shot.thumbnail = { zoomWidth: midWidth, ...thumb };
    }
    out.screenshot = shot;
  }

  if (isObj(out.discovery) && isObj(out.discovery.interactions)) {
    const interactions = out.discovery.interactions;
    if (interactions.nestDepth === 0) {
      warn(
        "config: discovery.interactions.nestDepth: 0 is deprecated — use discovery.interactions.auto: false",
      );
      out.discovery = {
        ...out.discovery,
        interactions: { ...interactions, auto: false, nestDepth: 1 },
      };
    }
  }
  return out;
}

/** Validate a raw config object (after migrating renamed keys) and fill in defaults. */
export function parseConfig(raw: unknown, warn: Warn = warnStderr): Config {
  return ConfigSchema.parse(migrateConfig(raw, warn));
}
