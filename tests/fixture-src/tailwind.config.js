import typography from "@tailwindcss/typography";
import forms from "@tailwindcss/forms";

/** @type {import('tailwindcss').Config} */
export default {
  // Scan the GENERATED html (build.mjs writes it before invoking the CLI).
  content: ["./tests/fixture/**/*.html"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        cream: "#faf6f0", // light page background (warm paper)
        paper: "#fffdf9", // light surface / cards
        espresso: "#241c17", // dark surface / cards
        grounds: "#17120f", // dark page background
      },
      fontFamily: {
        serif: ["Georgia", "Cambria", '"Times New Roman"', "serif"],
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          '"Segoe UI"',
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [typography, forms],
};
