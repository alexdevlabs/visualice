/** Regenerate config.schema.json, manifest.schema.json and explore.schema.json from the zod schemas: `npm run schema`. */
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  renderConfigJsonSchema,
  renderExploreJsonSchema,
  renderManifestJsonSchema,
} from "../src/shared/schema";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const [file, render] of [
  ["config.schema.json", renderConfigJsonSchema],
  ["manifest.schema.json", renderManifestJsonSchema],
  ["explore.schema.json", renderExploreJsonSchema],
] as const) {
  const out = path.join(root, file);
  await fs.writeFile(out, render());
  console.log(`wrote ${path.relative(root, out)}`);
}
