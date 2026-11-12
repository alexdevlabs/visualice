import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { InputManifest, StateNode } from "../shared/types";
import { StateNodeSchema, formatManifestIssues } from "../shared/manifest-schema";

/**
 * Explore-mode states arrive as files, not edits.
 *
 * Several explorer agents work a site at once, one per kind of page. Each editing
 * the cached model directly would be a race — the last to save wins and everyone
 * else's states are gone. So each writes what it verified to a file of its own,
 * and `visualice author` merges them all in one step, under the output lock,
 * validating every state on the way in.
 */

/** One explorer's output: states keyed by the page they belong on. */
export const AuthoredFileSchema = z.object({
  states: z
    .array(
      StateNodeSchema.extend({
        // The routes file lists a state by its id, as one word.
        id: z
          .string()
          .regex(
            /^[A-Za-z0-9][\w.-]*$/,
            'a state id is one word: letters, digits, `.`, `_` or `-` (open-modal, not "Open Modal")',
          ),
        page: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe(
            "The page (route path) the state belongs on — or several, for a state every page of a kind shares.",
          ),
      }),
    )
    .default([]),
  /** Pages the explorer found that the model doesn't have, for the routes file. */
  pages: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export type AuthoredFile = z.output<typeof AuthoredFileSchema>;

export interface AuthorResult {
  model: InputManifest;
  added: { page: string; state: string }[];
  replaced: { page: string; state: string }[];
  /** States for pages the model doesn't have: seed the page first, then re-author. */
  unknownPages: string[];
  /** Pages the explorers proposed that the model doesn't have yet. */
  proposedPages: string[];
}

/** Read one explorer file, or throw with every problem in it listed. */
export async function readAuthoredFile(file: string): Promise<AuthoredFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: not valid JSON — ${(e as Error).message}`);
  }
  const parsed = AuthoredFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file}:\n  - ${formatManifestIssues(parsed.error).join("\n  - ")}`);
  }
  return parsed.data;
}

/** The explorer files to merge: the given files, or every `.json` in a directory. */
export async function listAuthoredFiles(from: string): Promise<string[]> {
  const stat = await fs.stat(from).catch(() => null);
  if (!stat) throw new Error(`nothing to author: ${from} does not exist`);
  if (!stat.isDirectory()) return [from];
  return (await fs.readdir(from))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(from, f));
}

/**
 * Merge explorer states into the model. A state replaces the one with its id on
 * that page — an explorer's verified recipe beats whatever was there, auto or
 * authored — and is always marked authored, so rediscovery never clobbers it.
 * Pure: the caller saves.
 */
export function mergeAuthored(
  model: InputManifest,
  files: AuthoredFile[],
  canonical: (page: string) => string = (p) => p,
): AuthorResult {
  const routes = model.routes.map((r) => ({ ...r, states: [...r.states] }));
  const byUrl = new Map(routes.map((r) => [r.url, r]));
  const result: Omit<AuthorResult, "model"> = {
    added: [],
    replaced: [],
    unknownPages: [],
    proposedPages: [],
  };
  for (const file of files) {
    for (const { page: pages, ...rest } of file.states) {
      for (const page of [pages].flat()) {
        const route = byUrl.get(page) ?? byUrl.get(canonical(page));
        if (!route) {
          if (!result.unknownPages.includes(page)) result.unknownPages.push(page);
          continue;
        }
        const state: StateNode = { ...(rest as StateNode), source: "authored", shots: {} };
        const at = route.states.findIndex((s) => s.id === state.id);
        if (at >= 0) {
          route.states[at] = state;
          result.replaced.push({ page: route.url, state: state.id });
        } else {
          route.states.push(state);
          result.added.push({ page: route.url, state: state.id });
        }
      }
    }
    for (const page of file.pages) {
      const known = byUrl.has(page) || byUrl.has(canonical(page));
      if (!known && !result.proposedPages.includes(page)) result.proposedPages.push(page);
    }
  }
  return { model: { ...model, routes }, ...result };
}
