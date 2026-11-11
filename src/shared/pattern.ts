/** Is `p` a usable regular expression: non-empty, and one `new RegExp` accepts? */
export function validPattern(p: string): boolean {
  try {
    new RegExp(p);
    return p.length > 0;
  } catch {
    return false;
  }
}
