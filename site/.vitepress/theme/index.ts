import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import "@fontsource/figtree/latin-400.css";
import "@fontsource/figtree/latin-500.css";
import "@fontsource/figtree/latin-600.css";
import "@fontsource/figtree/latin-700.css";
import "@fontsource/figtree/latin-800.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import Home from "./Home.vue";
import "./style.css";

export default {
  extends: DefaultTheme,
  // The wordmark, with "lice" in the accent like the viewer's lockup (siteTitle is off).
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "nav-bar-title-after": () =>
        h("span", { class: "vc-wordmark" }, ["visua", h("span", "lice")]),
    }),
  enhanceApp({ app }) {
    app.component("Home", Home);
  },
} satisfies Theme;
