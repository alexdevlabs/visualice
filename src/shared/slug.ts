import { createHash } from "node:crypto";

export function shortHash(s: string, len = 6): string {
  return createHash("sha1").update(s).digest("hex").slice(0, len);
}

function safeSegment(s: string): string {
  let decoded = s;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  const cleaned = decoded
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "x";
}

/**
 * Turn a URL (or path) into a stable, nested, filesystem-safe folder slug.
 *
 * A route fragment becomes a readable `__h-` suffix rather than nested directories:
 * on a hash-routed SPA every route shares the same pathname, so without it
 * `/#/about` and `/#/pricing` would both land in `home/` and overwrite each other.
 * The suffix is flat (and the fragment's own slashes become dashes) so the folder
 * tree still mirrors the server's paths, with the client-side route beside it.
 */
export function pathSlug(rawUrl: string): string {
  let pathname: string;
  let search = "";
  let hash = "";
  try {
    const u = new URL(rawUrl, "http://_local_");
    pathname = u.pathname;
    search = u.search;
    hash = u.hash;
  } catch {
    pathname = rawUrl;
  }
  const hashSegs = hash.replace(/^#!?/, "").split("/").filter(Boolean).map(safeSegment);
  const suffix =
    (search ? `__q-${shortHash(search)}` : "") +
    (hashSegs.length ? `__h-${hashSegs.join("-")}` : "");
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/") return suffix ? `home${suffix}` : "home";
  const segs = trimmed.split("/").filter(Boolean).map(safeSegment);
  return segs.join("/") + suffix;
}

export function stateSlug(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "state"
  );
}
