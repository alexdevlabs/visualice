import type { Config } from "./shared/config";

// Flag parsing and config overrides for the CLI, separated from cli.ts (which runs
// its command on import) so they stay unit-testable.

/** Usage mistakes (bad flag, bad value) → exit 2, no stack trace. */
export class UsageError extends Error {}

export type Flags = Record<string, string | boolean>;

type FlagType = "string" | "boolean";

/** Every flag the CLI knows, with its arity. */
const FLAG_TYPES: Record<string, FlagType> = {
  config: "string",
  base: "string",
  manifest: "string",
  replay: "boolean",
  resume: "boolean",
  run: "string",
  port: "string",
  open: "boolean",
  shoot: "string",
  force: "boolean",
  json: "boolean",
  quiet: "boolean",
  "fail-on-error": "boolean",
  "max-pages": "string",
  include: "string",
  exclude: "string",
  devices: "string",
  concurrency: "string",
  timeout: "string",
  out: "string",
  "no-save": "boolean",
  "no-fix": "boolean",
  dest: "string",
  page: "string",
  recipe: "string",
  state: "string",
  device: "string",
  shot: "string",
  inventory: "boolean",
  from: "string",
  "all-devices": "boolean",
};

/** Commands that accept one bare positional, mapped onto a flag (crawl <url>). */
const POSITIONAL: Record<string, string> = {
  crawl: "base",
  discover: "base",
  init: "base",
  export: "dest",
  probe: "page",
  author: "from",
};

const OVERRIDE_FLAGS = [
  "max-pages",
  "include",
  "exclude",
  "devices",
  "concurrency",
  "timeout",
  "out",
] as const;

/** Which flags each command accepts; anything else is an error, not a silent no-op. */
export const COMMAND_FLAGS: Record<string, string[]> = {
  crawl: [
    "config",
    "base",
    "replay",
    "resume",
    "json",
    "quiet",
    "fail-on-error",
    "no-save",
    ...OVERRIDE_FLAGS,
  ],
  discover: ["config", "base", "json", "quiet", ...OVERRIDE_FLAGS],
  capture: ["config", "base", "manifest", "json", "quiet", "fail-on-error", ...OVERRIDE_FLAGS],
  init: ["base", "force", "quiet"],
  routes: ["config", "json", "quiet", "out"],
  auth: ["config", "force", "quiet"],
  validate: ["config", "manifest", "json", "quiet", "out"],
  serve: ["config", "run", "port", "open", "shoot", "quiet", "out"],
  fixture: ["port", "open", "quiet"],
  demo: ["config", "json", "quiet", "fail-on-error"],
  "demo-crawl": ["config", "replay", "json", "quiet", "fail-on-error"],
  doctor: ["json", "quiet", "no-fix"],
  export: ["config", "run", "dest", "json", "quiet", "out"],
  author: ["config", "base", "from", "json", "quiet", "out"],
  probe: [
    "config",
    "base",
    "page",
    "recipe",
    "state",
    "device",
    "shot",
    "inventory",
    "all-devices",
    "quiet",
    "out",
  ],
};

/**
 * Is `cmd` a command this CLI has? An own-property check, not `in`: the tables are
 * plain object literals, so `in` also answers yes for every name on
 * `Object.prototype` — `visualice toString` would pass and do nothing, and
 * `visualice valueOf --json` would crash looking its flags up.
 */
export function isCommand(cmd: string): boolean {
  return Object.hasOwn(COMMAND_FLAGS, cmd);
}

/** A table lookup that can't reach `Object.prototype`. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Parse `--flag=value`, `--flag value` and bare `--flag` forms, strictly: unknown
 * flags, missing values and values on boolean flags all throw instead of being
 * silently dropped (an agent's typo'd flag must fail loudly).
 */
export function parseFlags(cmd: string, argv: string[]): Flags {
  const allowed = own(COMMAND_FLAGS, cmd) ?? [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      const positional = own(POSITIONAL, cmd);
      if (positional && flags[positional] === undefined) {
        flags[positional] = token;
        continue;
      }
      throw new UsageError(`unexpected argument "${token}" — flags look like --name=value`);
    }
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    const type = own(FLAG_TYPES, name);
    if (!type || !allowed.includes(name)) {
      throw new UsageError(`unknown flag --${name} for '${cmd}' (see 'visualice help')`);
    }
    if (type === "boolean") {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
    } else if (eq >= 0) {
      flags[name] = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`--${name} requires a value (--${name}=<value>)`);
      }
      flags[name] = next;
      i++;
    }
  }
  return flags;
}

export const str = (flags: Flags, name: string): string | undefined =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined;

export function intFlag(flags: Flags, name: string): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--${name} must be a positive integer (got "${v}")`);
  }
  return n;
}

export const csv = (v: string): string[] =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Apply the one-off override flags on top of the loaded config. */
export function applyOverrides(config: Config, flags: Flags): Config {
  const out = {
    ...config,
    scope: { ...config.scope },
    politeness: { ...config.politeness },
    output: { ...config.output },
  };
  const maxPages = intFlag(flags, "max-pages");
  if (maxPages !== undefined) out.scope.maxPages = maxPages;
  const include = str(flags, "include");
  if (include !== undefined) out.scope.include = csv(include);
  const exclude = str(flags, "exclude");
  if (exclude !== undefined) out.scope.exclude = csv(exclude);
  const concurrency = intFlag(flags, "concurrency");
  if (concurrency !== undefined) out.politeness.concurrency = concurrency;
  const timeout = intFlag(flags, "timeout");
  if (timeout !== undefined) out.politeness.timeoutMs = timeout;
  const dir = str(flags, "out");
  if (dir !== undefined) out.output.dir = dir;
  const devices = str(flags, "devices");
  if (devices !== undefined) {
    const names = csv(devices);
    if (!names.length) throw new UsageError("--devices needs at least one device name");
    const known = new Map(config.devices.map((d) => [d.name, d]));
    const missing = names.filter((n) => !known.has(n));
    if (missing.length) {
      throw new UsageError(
        `--devices: unknown device(s) ${missing.join(", ")} — configured: ${[...known.keys()].join(", ")}`,
      );
    }
    out.devices = names.map((n) => known.get(n)!);
  }
  return out;
}
