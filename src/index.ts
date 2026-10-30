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
 * The package ships built ESM plus type declarations in `dist/` (`npm run build`,
 * run automatically on publish), so consumers need no TypeScript toolchain of their
 * own. Node 22.18+.
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

export {
  parseRoutesFile,
  renderRoutesFile,
  computeWanted,
  applyRoutesIntent,
  applyStateSkips,
  loadRoutesIntent,
  writeRoutesFile,
  routesFilePath,
} from "./crawl/routes-file";
export type { RoutesIntent, RoutesFileRoute, RoutesFileState } from "./crawl/routes-file";
export { discoverPipeline } from "./crawl/discover";
export type { DiscoverOptions } from "./crawl/discover";
export { discoverRoutes } from "./crawl/discover-routes";
export { discoverStates } from "./crawl/discover-states";
export { runCapture } from "./crawl/capture";
export type { CaptureOptions, CaptureResult } from "./crawl/capture";
export { ensureStorageState } from "./crawl/auth";
export { loadInputManifest, mergeManifests, saveJson } from "./crawl/manifest";
export { renderReport } from "./crawl/report";
export { applyRecipe, gotoRoute, resolveUrl } from "./crawl/recipe";
export { applyContextInit, stabilizePage, waitForStableSelectors } from "./crawl/stabilize";

export { serveViewer } from "./serve";
export { listRuns, listSites, siteDir, siteKey } from "./crawl/runs";
export { exportRun } from "./export";
export type { ExportOptions, ExportResult } from "./export";
export { serveDirectory } from "./shared/static-server";
export type { StaticServer } from "./shared/file-serve";
export { parseRange } from "./shared/file-serve";
export type { RangeResult } from "./shared/file-serve";

export { inScope, matchesAny, globToRegExp } from "./shared/glob";
export {
  canonicalPath,
  hashPart,
  isHashRoute,
  scopePath,
  routeId,
  dedupeLinks,
  relativeToOrigin,
  uniqueId,
} from "./shared/url";
export type { HashRoutes } from "./shared/url";
export { pathSlug, stateSlug, shortHash } from "./shared/slug";
export { parseRobots, isAllowed, fetchRobots, ROBOTS_UA, ALLOW_ALL } from "./shared/robots";
export type { RobotsRules, RobotsRule } from "./shared/robots";

export type * from "./shared/types";
