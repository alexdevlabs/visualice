export type Theme = "light" | "dark";

const KEY = "visualice:theme";

/** The viewer opens light unless this browser picked dark before. */
export function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Switch the page's tokens (styles.css keys them off `data-theme`) and remember the choice. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private windows and blocked storage just don't remember it.
  }
}
