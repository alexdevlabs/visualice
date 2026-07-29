/**
 * Programmatic entrypoint.
 *
 * The CLI (`src/cli.ts`) is a thin wrapper over these functions; import them
 * directly to drive a crawl from your own script:
 *
 * ```ts
 * import { loadConfig, crawlPipeline } from "visualice";
 *
 * const config = await loadConfig("visualice.config.ts");
 * const { runDir } = await crawlPipeline({ config, baseUrl: "https://example.com" });
 * ```
 *
 * The package ships TypeScript sources (no build step) — run consumers with
 * `tsx`, or through any bundler that compiles TS.
 */

export { loadConfig, ConfigSchema, DeviceSchema } from "./shared/config";
export type { Config, VisualiceConfig } from "./shared/config";
export {
  configJsonSchema,
  renderConfigJsonSchema,
  manifestJsonSchema,
  renderManifestJsonSchema,
} from "./shared/schema";
export {
  InputManifestSchema,
  RouteNodeSchema,
  StateNodeSchema,
  RecipeStepSchema,
  TargetSchema,
  parseInputManifest,
  formatManifestIssues,
} from "./shared/manifest-schema";

export { crawlPipeline, capturePipeline, makeRunId } from "./crawl/orchestrator";
export type {
  CrawlPipelineOptions,
  CapturePipelineOptions,
  CapturePipelineResult,
} from "./crawl/orchestrator";

export { discoverPipeline } from "./crawl/discover";
export type { DiscoverOptions } from "./crawl/discover";
export { discoverRoutes } from "./crawl/discover-routes";
export { discoverStates } from "./crawl/discover-states";
export { runCapture } from "./crawl/capture";
export type { CaptureOptions, CaptureResult } from "./crawl/capture";
export { ensureStorageState } from "./crawl/auth";
export { loadInputManifest, mergeManifests, saveJson } from "./crawl/manifest";
export { renderReport } from "./crawl/report";
export { applyRecipe, resolveUrl } from "./crawl/recipe";
export { applyContextInit, stabilizePage } from "./crawl/stabilize";

export { serveViewer } from "./serve";
export { serveDirectory } from "./shared/static-server";
export type { StaticServer } from "./shared/file-serve";

export { inScope, matchesAny, globToRegExp } from "./shared/glob";
export {
  canonicalPath,
  scopePath,
  routeId,
  dedupeLinks,
  relativeToOrigin,
  uniqueId,
} from "./shared/url";
export { pathSlug, stateSlug, shortHash } from "./shared/slug";
export { parseRobots, isAllowed, fetchRobots, ROBOTS_UA, ALLOW_ALL } from "./shared/robots";
export type { RobotsRules, RobotsRule } from "./shared/robots";

export type * from "./shared/types";
