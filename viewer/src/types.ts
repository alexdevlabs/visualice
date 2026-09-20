/**
 * The viewer reads the producer's types directly instead of mirroring them.
 *
 * These are `export type` re-exports, so nothing from `src/` is pulled into the
 * browser bundle — the imports erase at compile time. Keeping a hand-written copy
 * here used to mean the two could drift silently, with the viewer quietly ignoring
 * fields the engine had started emitting.
 */
export type { Device, StateKind, ViewerData, ViewerTile } from "../../src/shared/types";
