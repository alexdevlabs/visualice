import path from "node:path";
import { promises as fs } from "node:fs";
import type { Device, Manifest, RouteNode, ShotRef, StateNode } from "../shared/types";
import { matchesAny } from "../shared/glob";
import { pathExists } from "../shared/fsx";
import { stateSlug } from "../shared/slug";
import { isRunComplete, listRuns, runDir as runDirFor } from "./runs";
import { loadManifest } from "./manifest";

// Partial runs (`crawl --only`): shoot the pages a change touched, and carry every
// other page's shots over from the last finished run, so the new run is still the
// whole site. A carried shot is a hard link to the earlier file where the disk
// allows it (no extra space, and it outlives the earlier run being pruned), a copy
// where it doesn't, and records the run and commit it was really shot in.

/** The finished run a partial run carries from. */
export interface CarrySource {
  runId: string;
  runDir: string;
  manifest: Manifest;
}

/**
 * The newest finished run of a site with a manifest to carry from, other than
 * `exclude` (the run being written, which a `--resume` may have reopened).
 */
export async function findCarrySource(
  site: string,
  exclude?: string,
): Promise<CarrySource | undefined> {
  for (const id of [...(await listRuns(site))].reverse()) {
    if (id === exclude) continue;
    const dir = runDirFor(site, id);
    if (!(await isRunComplete(dir))) continue;
    const file = path.join(dir, "crawl-map.json");
    if (!(await pathExists(file))) continue;
    try {
      return { runId: id, runDir: dir, manifest: await loadManifest(file) };
    } catch {
      // A map that doesn't parse can't be carried from; try the run before it.
    }
  }
  return undefined;
}

/** A route's path, for matching `--only` globs against: `/pricing`, never a full URL. */
function routePath(url: string): string {
  try {
    return new URL(url, "http://_local_").pathname;
  } catch {
    return url;
  }
}

/** Does a route match one of the `--only` paths or globs? */
export function matchesOnly(route: Pick<RouteNode, "url">, only: string[]): boolean {
  return matchesAny(route.url, only) || matchesAny(routePath(route.url), only);
}

/** The devices a state is captured on. */
function devicesFor(state: StateNode, devices: Device[]): string[] {
  const names = devices.map((d) => d.name);
  return state.devices ? names.filter((n) => state.devices!.includes(n)) : names;
}

/**
 * The component states the earlier run looked for on a route, by state id → selector,
 * from its config snapshot: a component it sought there and didn't find isn't on the
 * route, but one added to the config (or pointed at the route) since was never sought.
 */
export function componentsSought(prev: Manifest, url: string): Map<string, string> {
  const sought = new Map<string, string>();
  const snapshot = prev.configSnapshot as
    | { components?: { name?: unknown; selector?: unknown; routes?: unknown }[] }
    | undefined;
  for (const c of snapshot?.components ?? []) {
    if (typeof c.name !== "string" || typeof c.selector !== "string") continue;
    const globs = Array.isArray(c.routes) ? c.routes.filter((g) => typeof g === "string") : [];
    if (matchesAny(routePath(url), globs)) sought.set(`component-${stateSlug(c.name)}`, c.selector);
  }
  return sought;
}

/**
 * Can every shot this route's capture would take be carried from `prev`? Only if
 * the earlier run shot the same state on each device it applies to, and the shot
 * succeeded: a state new since then, a device added since, or a shot that failed
 * then all mean the route is shot again instead. A component the earlier run sought
 * on the route (`sought`) and didn't find was dropped from it, so that is no gap; a
 * component it never looked for is.
 */
export function canCarry(
  route: RouteNode,
  prev: RouteNode | undefined,
  devices: Device[],
  sought: Map<string, string> = new Map(),
): boolean {
  if (!prev) return false;
  const byId = new Map(prev.states.map((s) => [s.id, s]));
  for (const state of route.states) {
    const before = byId.get(state.id);
    if (!before) {
      if (state.element !== undefined && sought.get(state.id) === state.element) continue;
      return false;
    }
    for (const device of devicesFor(state, devices)) {
      const ref = before.shots[device];
      if (!ref) {
        if (state.element !== undefined) continue; // not on this route at that size
        return false;
      }
      if (ref.error || !ref.full) return false;
    }
  }
  return true;
}

export interface CarryPlan {
  /** Routes to shoot: the ones `--only` names, and any the earlier run can't cover. */
  capture: RouteNode[];
  /** Routes whose shots come from the earlier run. */
  carry: RouteNode[];
  /** Routes outside `--only` that are shot anyway, and why. */
  forced: { url: string; reason: "new" | "incomplete" }[];
}

/** Split a run's routes into the ones to shoot and the ones to carry from `prev`. */
export function planCarry(
  routes: RouteNode[],
  only: string[],
  prev: Manifest,
  devices: Device[],
): CarryPlan {
  const prevByUrl = new Map(prev.routes.map((r) => [r.url, r]));
  const plan: CarryPlan = { capture: [], carry: [], forced: [] };
  for (const route of routes) {
    if (matchesOnly(route, only)) {
      plan.capture.push(route);
      continue;
    }
    const before = prevByUrl.get(route.url);
    if (canCarry(route, before, devices, componentsSought(prev, route.url))) {
      plan.carry.push(route);
    } else {
      plan.capture.push(route);
      plan.forced.push({ url: route.url, reason: before ? "incomplete" : "new" });
    }
  }
  return plan;
}

/**
 * Move to `capture` any route whose shots in `source` are missing a file on disk
 * (an earlier run cleaned up by hand, or cut short while exporting): carrying it
 * would fail after every other page had been shot.
 */
export async function verifyCarry(
  plan: CarryPlan,
  source: CarrySource,
  devices: Device[],
): Promise<CarryPlan> {
  const out: CarryPlan = { capture: [...plan.capture], carry: [], forced: [...plan.forced] };
  for (const route of plan.carry) {
    const prev = source.manifest.routes.find((r) => r.url === route.url);
    const files = prev ? carriedFiles(route, prev, devices) : [];
    const present = await Promise.all(files.map((f) => pathExists(path.join(source.runDir, f))));
    if (present.every(Boolean)) {
      out.carry.push(route);
    } else {
      out.capture.push(route);
      out.forced.push({ url: route.url, reason: "incomplete" });
    }
  }
  return out;
}

/** The files carrying `route` from `prev` would copy. */
function carriedFiles(route: RouteNode, prev: RouteNode, devices: Device[]): string[] {
  const byId = new Map(prev.states.map((s) => [s.id, s]));
  const files: string[] = [];
  for (const state of route.states) {
    const before = byId.get(state.id);
    if (!before) continue;
    for (const device of devicesFor(state, devices)) {
      const ref = before.shots[device];
      if (ref?.full && !ref.error) files.push(...shotFiles(ref));
    }
  }
  return files;
}

/** The files a shot points at, relative to its run directory. */
function shotFiles(ref: ShotRef): string[] {
  return [ref.full, ref.viewport, ref.thumb, ref.mid, ref.meta].filter(
    (f): f is string => typeof f === "string",
  );
}

/** Hard-link `from` to `to`, copying instead where links aren't possible. */
async function linkOrCopy(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rm(to, { force: true });
  try {
    await fs.link(from, to);
  } catch {
    await fs.copyFile(from, to);
  }
}

/**
 * Fill `route`'s shots from the same route in `source`, copying the files into
 * `runDir`. Returns how many shots were carried. A shot already carried keeps its
 * original provenance: carried twice, it still says where it was really taken.
 */
export async function carryRoute(
  route: RouteNode,
  source: CarrySource,
  runDir: string,
  devices: Device[],
): Promise<number> {
  const prev = source.manifest.routes.find((r) => r.url === route.url);
  if (!prev) return 0;
  const byId = new Map(prev.states.map((s) => [s.id, s]));
  let carried = 0;
  for (const state of route.states) {
    const before = byId.get(state.id);
    if (!before) continue;
    for (const device of devicesFor(state, devices)) {
      const ref = before.shots[device];
      if (!ref?.full || ref.error) continue;
      try {
        for (const rel of shotFiles(ref)) {
          await linkOrCopy(path.join(source.runDir, rel), path.join(runDir, rel));
        }
      } catch (err) {
        // verifyCarry checked the files; one gone since fails this shot, not the run.
        state.shots[device] = {
          error: `couldn't carry the shot from run ${source.runId}: ${(err as Error).message}`,
        };
        continue;
      }
      state.shots[device] = {
        ...ref,
        carried: ref.carried ?? {
          runId: source.runId,
          commit: source.manifest.source?.commit,
          capturedAt: source.manifest.source?.capturedAt ?? source.manifest.site.generatedAt,
        },
      };
      carried++;
    }
  }
  // As a capture does: a component found on no device was never on this route.
  route.states = route.states.filter(
    (s) => s.element === undefined || Object.keys(s.shots).length > 0,
  );
  return carried;
}
