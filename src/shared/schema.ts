import { z } from "zod";
import { ConfigSchema } from "./config";
import { InputManifestSchema } from "./manifest-schema";

/**
 * JSON Schema for `visualice.config.json` — derived from the zod schema so the
 * two can never drift (a unit test asserts the checked-in file matches).
 *
 * Generated in "input" mode: it describes what a human may *write*, so every
 * field with a default is optional rather than required.
 */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ConfigSchema, { io: "input", target: "draft-7" }) as Record<
    string,
    unknown
  >;
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://visualice.dev/config.schema.json",
    title: "Visualice config",
    description:
      "Configuration for a visualice crawl. Every field is optional; omitted fields fall back to the defaults in src/shared/config.ts.",
    ...schema,
  };
}

/** The exact bytes written to config.schema.json. */
export function renderConfigJsonSchema(): string {
  return `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
}

/**
 * JSON Schema for the crawl manifest / cached site model — what `visualice validate`
 * checks and what Explore mode hand-edits. Derived from the same zod schema the
 * engine validates with, so the two can never drift.
 */
export function manifestJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(InputManifestSchema, { io: "input", target: "draft-7" }) as Record<
    string,
    unknown
  >;
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://visualice.dev/manifest.schema.json",
    title: "Visualice crawl manifest",
    description:
      "A site model: routes, their UI states, and the replayable recipes that reach them. Written by discovery, hand-edited in Explore mode, replayed by capture.",
    ...schema,
  };
}

/** The exact bytes written to manifest.schema.json. */
export function renderManifestJsonSchema(): string {
  return `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;
}
