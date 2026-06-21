/** Minimal glob → RegExp for path scoping. Supports `**` (any incl. `/`) and `*` (any except `/`). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // collapse `**/` so it can also match zero segments
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
