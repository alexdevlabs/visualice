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

/** Turn a URL (or path) into a stable, nested, filesystem-safe folder slug. */
export function pathSlug(rawUrl: string): string {
  let pathname: string;
  let search = "";
  try {
    const u = new URL(rawUrl, "http://_local_");
    pathname = u.pathname;
    search = u.search;
  } catch {
    pathname = rawUrl;
  }
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/") return search ? `home__q-${shortHash(search)}` : "home";
  const segs = trimmed.split("/").filter(Boolean).map(safeSegment);
  let slug = segs.join("/");
  if (search) slug += `__q-${shortHash(search)}`;
  return slug;
}

export function stateSlug(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "state"
  );
}
