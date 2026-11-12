// Trimming one character off the ends of a string, without a regular expression.
// `/x+$/` rescans from every `x` it meets, so on a long run of them that isn't at the
// end it takes time that grows with the square of the run: these are a single pass.

/** `s` without the run of `ch` at its end. */
export function trimEndOf(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}

/** `s` without the runs of `ch` at its start and end. */
export function trimOf(s: string, ch: string): string {
  let start = 0;
  while (start < s.length && s[start] === ch) start++;
  return trimEndOf(s.slice(start), ch);
}
