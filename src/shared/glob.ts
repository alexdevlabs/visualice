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

export function inScope(path: string, include: string[], exclude: string[]): boolean {
  if (include.length && !matchesAny(path, include)) return false;
  if (exclude.length && matchesAny(path, exclude)) return false;
  return true;
}
