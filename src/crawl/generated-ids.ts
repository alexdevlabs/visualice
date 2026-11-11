/**
 * Ids a UI library generates at render time, which a recipe can't rely on.
 *
 * React's `useId()` numbers each call in render order (`:r1:` in React 18, `«r1»`
 * in 19.0, `_r_1_` from 19.1), and component libraries build their ids from it or
 * from a counter of their own (`base-ui-_r_2_`, `radix-:r3:`, `headlessui-menu-1`,
 * `mui-12`, `react-select-2-input`). The number depends on everything that
 * rendered before: another device's layout, a longer table, an earlier click or
 * a fresh load all shift it. A recipe that waits for `[id="_r_1i5_"]` then waits
 * for an element that no longer exists, and every capture of that state times out;
 * a signature built from it no longer matches the state it named.
 *
 * The pattern is kept as a source string so it can also run inside the page.
 */
export const GENERATED_ID_SOURCE = [
  // React useId, alone or inside a library prefix/suffix.
  String.raw`(?:^|[-:_])(?::[rR][0-9a-zA-Z]*:|«[rR][0-9a-zA-Z]*»|_[rR]_[0-9a-zA-Z]*_)(?:$|[-:_])`,
  // Libraries that number their own ids.
  String.raw`^(?:headlessui|radix|base-ui|mui|reach|chakra|mantine|react-aria)[-:_]?`,
  String.raw`^react-select-\d+-`,
].join("|");

const GENERATED_ID = new RegExp(GENERATED_ID_SOURCE);

export function isGeneratedId(id: string): boolean {
  return GENERATED_ID.test(id);
}

/**
 * Does a selector depend on a generated id: `#base-ui-_r_2_`, `[id="_r_6_"]`?
 * Recipes recorded before generated ids were recognised still carry them.
 */
export function namesGeneratedId(selector: string): boolean {
  const ids = [
    ...Array.from(selector.matchAll(/\[id="((?:[^"\\]|\\.)*)"\]/g), (m) =>
      m[1].replace(/\\(.)/g, "$1"),
    ),
    ...Array.from(selector.matchAll(/#((?:[\w\u00a0-\uffff-]|\\.)+)/g), (m) =>
      m[1].replace(/\\(.)/g, "$1"),
    ),
  ];
  return ids.some(isGeneratedId);
}
