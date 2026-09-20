/**
 * Minimal `>=x.y.z` range check — just enough for the `engines.node` preflight in
 * `doctor`, without pulling in a semver dependency for one comparison.
 */

/** Parse "v24.21.0" / "20.12.0-nightly" → [24, 21, 0]. Missing parts read as 0. */
export function parseVersion(v: string): [number, number, number] {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** -1 | 0 | 1, comparing major, then minor, then patch. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * True when `version` satisfies `range`. Only the forms this project's
 * `engines.node` uses are understood (">=20.12.0", "20.12.0", "*"); anything else
 * is treated as satisfied rather than failing a preflight on a parse we can't do.
 */
export function satisfies(version: string, range: string): boolean {
  const r = range.trim();
  if (r === "" || r === "*") return true;
  const m = /^(>=|>|<=|<|=)?\s*v?(\d.*)$/.exec(r);
  if (!m) return true;
  const cmp = compareVersions(version, m[2]);
  switch (m[1] ?? "=") {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    default:
      return cmp === 0;
  }
}
