import type { Manifest, ShotRef } from "../shared/types";
import { pathSlug } from "../shared/slug";

/**
 * Pairing two runs' shots, as pure data. The pixel work happens elsewhere — this
 * decides *what* to compare, which is where the interesting edge cases live (a
 * route that disappeared, a state that only exists on mobile, a shot that failed
 * to capture in one of the two runs).
 */

export interface ShotIdentity {
  /** Stable across runs: the route's path slug, the state id and the device name. */
  key: string;
  route: string;
  routeUrl: string;
  state: string;
  stateLabel: string;
  device: string;
}

export interface ShotEntry extends ShotIdentity {
  ref: ShotRef;
}

export type PairStatus = "added" | "removed" | "both" | "uncomparable";

export interface ShotPair extends ShotIdentity {
  status: PairStatus;
  from?: ShotRef;
  to?: ShotRef;
  /** Why an otherwise-matched pair can't be pixel-compared. */
  note?: string;
}

/** Every captured shot in a manifest, keyed route|state|device. */
export function indexShots(m: Manifest): Map<string, ShotEntry> {
  const out = new Map<string, ShotEntry>();
  for (const route of m.routes) {
    const routeSlug = pathSlug(route.url);
    for (const state of route.states) {
      for (const [device, ref] of Object.entries(state.shots)) {
        const key = `${routeSlug}|${state.id}|${device}`;
        out.set(key, {
          key,
          route: routeSlug,
          routeUrl: route.url,
          state: state.id,
          stateLabel: state.label,
          device,
          ref,
        });
      }
    }
  }
  return out;
}

/**
 * Left-join both directions: every shot in either run appears exactly once, sorted
 * by key so a report (and its tests) are deterministic.
 */
export function pairShots(from: Manifest, to: Manifest): ShotPair[] {
  const a = indexShots(from);
  const b = indexShots(to);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();

  return keys.map((key) => {
    const left = a.get(key);
    const right = b.get(key);
    const identity: ShotIdentity = {
      key,
      route: (right ?? left)!.route,
      routeUrl: (right ?? left)!.routeUrl,
      state: (right ?? left)!.state,
      stateLabel: (right ?? left)!.stateLabel,
      device: (right ?? left)!.device,
    };

    if (!left) return { ...identity, status: "added", to: right!.ref };
    if (!right) return { ...identity, status: "removed", from: left.ref };

    // Present in both, but one side never produced an image: a failed capture is a
    // real signal, just not a pixel one.
    const failed = [
      left.ref.error ? `failed in the baseline run (${left.ref.error})` : undefined,
      right.ref.error ? `failed in the new run (${right.ref.error})` : undefined,
    ].filter(Boolean);
    if (failed.length || !left.ref.full || !right.ref.full) {
      return {
        ...identity,
        status: "uncomparable",
        from: left.ref,
        to: right.ref,
        note: failed.join("; ") || "one of the runs has no full-size image",
      };
    }
    return { ...identity, status: "both", from: left.ref, to: right.ref };
  });
}

/** Routes that exist in only one of the two runs — the coarse "site changed" signal. */
export function routeDelta(from: Manifest, to: Manifest): { added: string[]; removed: string[] } {
  const a = new Set(from.routes.map((r) => pathSlug(r.url)));
  const b = new Set(to.routes.map((r) => pathSlug(r.url)));
  return {
    added: [...b].filter((r) => !a.has(r)).sort(),
    removed: [...a].filter((r) => !b.has(r)).sort(),
  };
}
