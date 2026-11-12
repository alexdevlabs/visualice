/**
 * Minimal glob → RegExp for path scoping.
 * - `**` matches any chars including `/`
 * - `*` matches any chars except `/`
 * - a `/**` segment also matches the parent dir itself (so `/docs/**` ⊇ `/docs`)
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "/" && glob[i + 1] === "*" && glob[i + 2] === "*") {
      // "/**" → optionally "/<anything>", so the directory itself matches too
      // "/**/x": whole segments in between, or none ("/a/**/b" ⊇ "/a/b", not "/ab")
      re += "(?:/.*)?";
      i += 2;
    } else if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * Is a page inside the scope globs? A glob is about the path, so `/search` covers
 * `/search?q=1` too. One written with a `?` is about the path and its query
 * (`withQuery`, when the caller has it): `/search?*` leaves `/search` itself in.
 */
export function inScope(
  path: string,
  include: string[],
  exclude: string[],
  withQuery: string = path,
): boolean {
  const matches = (globs: string[]) =>
    globs.some((g) => globToRegExp(g).test(g.includes("?") ? withQuery : path));
  if (include.length && !matches(include)) return false;
  if (exclude.length && matches(exclude)) return false;
  return true;
}

/**
 * Does any of these globs name this route (`/path?query#/hash`)? The same rule as
 * `inScope`: a glob is about the path, one with a `?` about the path and its query.
 */
export function routeMatches(url: string, globs: string[]): boolean {
  if (!globs.length) return false;
  const path = url.replace(/\?[^#]*/, "");
  return !inScope(path, [], globs, url);
}
