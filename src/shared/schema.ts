import { z } from "zod";
import { ConfigSchema } from "./config";
import { AuthoredFileSchema, InputManifestSchema } from "./manifest-schema";

/** A zod schema as a draft-7 JSON Schema, in "input" mode, under a header. */
function jsonSchema(
  schema: z.ZodType,
  header: { $id: string; title: string; description: string },
): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    ...header,
    ...(z.toJSONSchema(schema, { io: "input", target: "draft-7" }) as Record<string, unknown>),
  };
}

const render = (schema: Record<string, unknown>): string => `${JSON.stringify(schema, null, 2)}\n`;

/**
 * JSON Schema for `visualice.config.json` — derived from the zod schema so the
 * two can never drift (a unit test asserts the checked-in file matches).
 *
 * Generated in "input" mode: it describes what a human may *write*, so every
 * field with a default is optional rather than required.
 */
export function configJsonSchema(): Record<string, unknown> {
  return jsonSchema(ConfigSchema, {
    $id: "https://unpkg.com/visualice/config.schema.json",
    title: "Visualice config",
    description:
      "Configuration for a visualice crawl. Every field is optional; omitted fields fall back to the defaults in src/shared/config.ts.",
  });
}

/** The exact bytes written to config.schema.json. */
export function renderConfigJsonSchema(): string {
  return render(configJsonSchema());
}

/**
 * JSON Schema for the crawl manifest / cached site model — what `visualice validate`
 * checks and what Explore mode hand-edits. Derived from the same zod schema the
 * engine validates with, so the two can never drift.
 */
export function manifestJsonSchema(): Record<string, unknown> {
  return jsonSchema(InputManifestSchema, {
    $id: "https://unpkg.com/visualice/manifest.schema.json",
    title: "Visualice crawl manifest",
    description:
      "A site model: routes, their UI states, and the replayable recipes that reach them. Written by discovery, hand-edited in Explore mode, replayed by capture.",
  });
}

/** The exact bytes written to manifest.schema.json. */
export function renderManifestJsonSchema(): string {
  return render(manifestJsonSchema());
}

/**
 * JSON Schema for an explorer's state file (`.visualice/explore/<type>.json`), what
 * `visualice author` merges. Pointing the file's `$schema` here lets an editor or an
 * agent check a recipe's steps and targets as they are written.
 */
export function exploreJsonSchema(): Record<string, unknown> {
  return jsonSchema(AuthoredFileSchema, {
    $id: "https://unpkg.com/visualice/explore.schema.json",
    title: "Visualice explorer state file",
    description:
      "States an explorer verified with `visualice probe`, each with the page it belongs on, for `visualice author` to merge into the site model.",
  });
}

/** The exact bytes written to explore.schema.json. */
export function renderExploreJsonSchema(): string {
  return render(exploreJsonSchema());
}
