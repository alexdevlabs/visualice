/**
 * ${ENV_VAR} substitution for secret-bearing config values (login fills, HTTP
 * credentials, headers). Secrets stay out of config files and run artifacts —
 * the manifest's configSnapshot keeps the placeholder, never the value.
 */
export function resolveEnvString(s: string, missing: Set<string>): string {
  return s.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, key: string) => {
    const v = process.env[key];
    if (v === undefined) {
      missing.add(key);
      return "";
    }
    return v;
  });
}

/** Resolve every value of a record, throwing if any referenced env var is unset. */
export function resolveEnvRecord(
  record: Record<string, string>,
  what: string,
): Record<string, string> {
  const missing = new Set<string>();
  const out = Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, resolveEnvString(v, missing)]),
  );
  if (missing.size) {
    throw new Error(`${what}: missing env var(s): ${[...missing].join(", ")}`);
  }
  return out;
}
