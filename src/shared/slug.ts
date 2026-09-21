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
 * The `__h-` part of a slug for a route fragment, or "" when there is none.
 *
 * Segments are joined with `--`, which `safeSegment` never produces at a segment's
 * edge, so `#/a/b` (`a--b`) and `#/a-b` (`a-b`) stay apart. Every other lossy step —
 * case, a character that isn't filename-safe, a `#!` prefix, an empty segment, a
 * `--` inside a segment — is caught by reading the slug back: if the readable form
 * doesn't spell out the fragment it came from, a hash of the original is appended,
 * the same way a query string is. Plain routes (`#/about`, `#/users/42`) come back
 * unhashed; `#/About` and `#/about` can no longer share a folder.
 */
function hashSuffix(hash: string): string {
  const segs = hash.replace(/^#!?/, "").split("/").filter(Boolean).map(safeSegment);
  if (!segs.length) return "";
  const readable = segs.join("--");
  const faithful = `#/${segs.join("/")}` === hash && !segs.some((s) => s.includes("--"));
  return `__h-${readable}${faithful ? "" : `-${shortHash(hash)}`}`;
}

/**
 * Turn a URL (or path) into a stable, nested, filesystem-safe folder slug.
 *
 * A route fragment becomes a readable `__h-` suffix rather than nested directories:
 * on a hash-routed SPA every route shares the same pathname, so without it
 * `/#/about` and `/#/pricing` would both land in `home/` and overwrite each other.
 * The suffix is flat so the folder tree still mirrors the server's paths, with the
 * client-side route beside it; see `hashSuffix` for how it stays unambiguous.
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
  const suffix = (search ? `__q-${shortHash(search)}` : "") + hashSuffix(hash);
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
