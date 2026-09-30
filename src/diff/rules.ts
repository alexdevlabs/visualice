import type { DiffRule } from "../shared/config";
import { globToRegExp } from "../shared/glob";
import type { Rect } from "./pixels";

/**
 * Which comparison settings apply to one shot.
 *
 * `diff.rules` is a list rather than a map so one shot can pick up several: a
 * site-wide ignore region for the cookie banner, plus a looser threshold for the
 * one route with a video poster. Every matching rule applies in order — scalars
 * from a later rule replace earlier ones, ignore regions accumulate.
 */

export interface ShotSettings {
  threshold: number;
  minRatio: number;
  /** In CSS px, as authored; the caller scales them by the device's pixel ratio. */
  ignore: Rect[];
}

export interface RuleSubject {
  /** The route as the manifest records it: a path, possibly with a query or hash. */
  routeUrl: string;
  state: string;
  device: string;
}

function pathOf(routeUrl: string): string {
  try {
    return new URL(routeUrl, "http://_local_").pathname;
  } catch {
    return routeUrl;
  }
}

/** `*` wildcards only — a state id has no path structure for `**` to mean anything. */
function matchesName(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const re = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.|?+()[\]{}]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`).test(name);
}

export function ruleMatches(rule: DiffRule, shot: RuleSubject): boolean {
  if (!globToRegExp(rule.route).test(pathOf(shot.routeUrl))) return false;
  if (rule.state !== undefined && !matchesName(rule.state, shot.state)) return false;
  if (rule.device !== undefined && rule.device !== shot.device) return false;
  return true;
}

export function settingsFor(
  rules: DiffRule[],
  defaults: { threshold: number; minRatio: number },
  shot: RuleSubject,
): ShotSettings {
  const out: ShotSettings = { ...defaults, ignore: [] };
  for (const rule of rules) {
    if (!ruleMatches(rule, shot)) continue;
    if (rule.threshold !== undefined) out.threshold = rule.threshold;
    if (rule.minRatio !== undefined) out.minRatio = rule.minRatio;
    out.ignore.push(...rule.ignore);
  }
  return out;
}
