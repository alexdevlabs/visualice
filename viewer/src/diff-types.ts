/**
 * The comparison types, re-exported from the engine rather than copied — the same
 * arrangement `types.ts` uses for the manifest. `src/diff/types.ts` holds no
 * runtime imports, so nothing from the engine reaches the browser bundle.
 */
export type { RunDiff, ShotDiff, ShotStatus } from "../../src/diff/types";
