import { z } from "zod";

// Runtime validation for the crawl manifest / cached site model. Hand-authored and
// Explore-mode states are edited as raw JSON, so this is the safety net that turns
// "silently fails at capture time" into an actionable error message up front.
// Lenient by design: fields with engine-side fallbacks get defaults here too.

export const TargetSchema = z
  .object({
    role: z.string().optional().describe("ARIA role, resolved via getByRole."),
    name: z.string().optional().describe("Accessible name to match alongside `role`."),
    testId: z
      .string()
      .optional()
      .describe(
        "Test id value — `data-testid`, or the config's `testIdAttribute` (highest priority).",
      ),
    label: z.string().optional().describe("Form-control label text."),
    text: z.string().optional().describe("Visible text content."),
    selector: z.string().optional().describe("CSS selector (last resort)."),
    exact: z.boolean().optional().describe("Exact-match text/name instead of substring."),
    nth: z.number().int().nonnegative().optional().describe("Pick the nth match (0-based)."),
  })
  .describe("A robust element locator, resolved in priority order (see selectors.ts).");

const WaitStateSchema = z.enum(["visible", "hidden", "attached", "detached"]);

export const RecipeStepSchema = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("navigate"), url: z.string() }),
    z.object({ action: z.literal("click"), target: TargetSchema }),
    z.object({ action: z.literal("hover"), target: TargetSchema }),
    z.object({ action: z.literal("focus"), target: TargetSchema }),
    z.object({ action: z.literal("blur") }),
    z.object({ action: z.literal("fill"), target: TargetSchema, value: z.string() }),
    z.object({
      action: z.literal("select"),
      target: TargetSchema,
      value: z
        .union([z.string(), z.array(z.string())])
        .describe("Option value or visible label; an array for a multi-select."),
    }),
    z.object({ action: z.literal("press"), key: z.string(), target: TargetSchema.optional() }),
    z.object({
      action: z.literal("waitFor"),
      selector: z.string().optional(),
      url: z.string().optional(),
      state: WaitStateSchema.optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),
    z.object({
      action: z.literal("scroll"),
      to: z.union([z.literal("top"), z.literal("bottom"), z.number()]),
    }),
    z.object({ action: z.literal("wait"), ms: z.number().int().nonnegative() }),
  ])
  .describe("One replayable interaction step.");

export const StateKindSchema = z.enum([
  "default",
  "menu",
  "modal",
  "drawer",
  "accordion",
  "tab",
  "popover",
  "toast",
  "hover",
  "focus",
  "validation",
  "component",
  "other",
]);

export const ShotRefSchema = z.object({
  full: z.string().optional(),
  viewport: z.string().optional(),
  thumb: z.string().optional(),
  meta: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  mid: z.string().optional(),
  clamped: z.boolean().optional(),
  screens: z.number().int().positive().optional(),
  frames: z
    .array(
      z.object({
        y: z.number(),
        top: z.number().nonnegative(),
        bottom: z.number().nonnegative(),
      }),
    )
    .optional(),
  a11y: z.number().optional(),
  error: z.string().optional(),
  carried: z
    .object({
      runId: z.string(),
      commit: z.string().optional(),
      capturedAt: z.string().optional(),
    })
    .optional()
    .describe("Copied from an earlier run by a partial crawl (`--only`), not shot by this one."),
});

export const StateNodeSchema = z.object({
  id: z.string().min(1).describe("Unique within the route; used as the folder slug."),
  kind: StateKindSchema.default("other"),
  label: z.string().default(""),
  trigger: TargetSchema.optional(),
  recipe: z.array(RecipeStepSchema).default([]),
  signature: z.string().optional(),
  siteKey: z
    .string()
    .optional()
    .describe("Page-independent identity of an auto-discovered state, for site-wide dedupe."),
  source: z.enum(["auto", "authored"]).optional(),
  devices: z
    .array(z.string())
    .optional()
    .describe("Capture this state only on these device names (default: all devices)."),
  element: z
    .string()
    .optional()
    .describe("Screenshot only this element (a component) instead of the whole page."),
  isolate: z
    .boolean()
    .optional()
    .describe(
      "Capture in a fresh browser context (signed-in storage state only), so what the recipe stores — a cart, a preference — doesn't leak into other states or theirs into it.",
    ),
  shots: z.record(z.string(), ShotRefSchema).default({}),
});

export const RouteNodeSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1).describe("Route path (or absolute URL) as authored."),
  finalUrl: z.string().optional(),
  title: z.string().optional(),
  status: z.number().int().optional(),
  depth: z.number().int().nonnegative().default(0),
  discoveredFrom: z.string().nullable().optional(),
  links: z.array(z.string()).optional(),
  states: z.array(StateNodeSchema).default([]),
});

const HintsSchema = z.object({
  stableSelectors: z.array(z.string()).optional(),
  flakyRegions: z.array(z.string()).optional(),
  skipTriggers: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

/** The capture input / cached site model (`crawl-map.cache.json`). */
export const InputManifestSchema = z
  .object({
    site: z
      .object({
        baseUrl: z.string().optional(),
        origin: z.string().optional(),
        title: z.string().optional(),
        framework: z.string().optional(),
        runId: z.string().optional(),
        generatedAt: z.string().optional(),
      })
      .optional(),
    auth: z.object({ method: z.string(), notes: z.string().optional() }).optional(),
    hints: HintsSchema.optional(),
    routes: z.array(RouteNodeSchema),
  })
  .superRefine((m, ctx) => {
    const routeIds = new Set<string>();
    m.routes.forEach((r, i) => {
      if (routeIds.has(r.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["routes", i, "id"],
          message: `duplicate route id "${r.id}"`,
        });
      }
      routeIds.add(r.id);
      const stateIds = new Set<string>();
      r.states.forEach((s, j) => {
        if (stateIds.has(s.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["routes", i, "states", j, "id"],
            message: `duplicate state id "${s.id}" on route "${r.url}"`,
          });
        }
        stateIds.add(s.id);
      });
    });
  });

export type ValidInputManifest = z.output<typeof InputManifestSchema>;

/** Format zod issues as human/agent-friendly one-liners (`routes[3].states[1].recipe[0]: …`). */
export function formatManifestIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const at = issue.path.length
      ? issue.path
          .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
          .join("")
          .replace(/^\./, "")
      : "(root)";
    return `${at}: ${issue.message}`;
  });
}

/**
 * Parse a raw JSON value as an input manifest. Returns the parsed (default-filled)
 * manifest, or throws with every problem listed — not just the first.
 */
export function parseInputManifest(raw: unknown, sourceLabel: string): ValidInputManifest {
  const result = InputManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = formatManifestIssues(result.error);
    throw new Error(`invalid manifest ${sourceLabel}:\n  - ${issues.join("\n  - ")}`);
  }
  return result.data;
}
