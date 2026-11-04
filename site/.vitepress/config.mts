import path from "node:path";
import { defineConfig, type MarkdownRenderer } from "vitepress";

/**
 * The docs site. Pages are the repo's own Markdown, read where it lives: GitHub, the
 * plugin and this site all show the same files. `npm run site` builds it with the
 * demo and serves it locally; `.github/workflows/pages.yml` deploys it.
 */

const REPO = "https://github.com/alexdevlabs/visualice";
const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Source file (repo-relative) → page. Everything else in the repo isn't a page. */
const PAGES: Record<string, string> = {
  "site/index.md": "index.md",
  "site/guide/getting-started.md": "guide/getting-started.md",
  "skills/visualice/references/explore-mode.md": "guide/explore.md",
  "docs/crawling.md": "guide/crawling.md",
  "docs/configuration.md": "guide/configuration.md",
  "skills/visualice/references/auth.md": "guide/auth.md",
  "docs/viewer.md": "guide/viewer.md",
  "skills/visualice/references/cli.md": "guide/cli.md",
  "docs/library.md": "guide/library.md",
  "CHANGELOG.md": "changelog.md",
  "CONTRIBUTING.md": "contributing.md",
};

/**
 * The files link to each other by repo path (`../skills/visualice/references/cli.md`),
 * which is right on GitHub. Here a link to another page goes to that page, and a link
 * to any other repo file goes to it on GitHub.
 */
function repoLinks(md: MarkdownRenderer) {
  md.core.ruler.push("repo-links", (state) => {
    const env = state.env as { realPath?: string; path?: string };
    const from = path.relative(ROOT, env.realPath ?? env.path ?? "");
    for (const block of state.tokens) {
      for (const t of block.children ?? []) {
        if (t.type !== "link_open") continue;
        const href: string = t.attrGet("href") ?? "";
        if (!href || /^([a-z]+:|#|\/)/i.test(href)) continue;
        const [file, hash] = href.split("#");
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), file));
        const page = PAGES[target];
        t.attrSet(
          "href",
          page
            ? `/${page.replace(/(index)?\.md$/, "")}${hash ? `#${hash}` : ""}`
            : `${REPO}/blob/main/${target}${hash ? `#${hash}` : ""}`,
        );
      }
    }
  });
}

export default defineConfig({
  title: "visualice",
  description: "Every page and UI state of your site, on every device.",
  base: "/visualice/",
  srcDir: "..",
  // The repo's other Markdown (dot-folders like .visualice/ are skipped already).
  srcExclude: [
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
    "SECURITY.md",
    "agents/**",
    "commands/**",
    "skills/visualice/SKILL.md",
    "src/**",
    "tests/**",
    "viewer/**",
    "scripts/**",
    "assets/**",
    "coverage/**",
    "site/public/**",
  ],
  rewrites: PAGES,
  cleanUrls: true,
  // The demo is added to the build output after VitePress runs (scripts/site.ts).
  ignoreDeadLinks: [/^\/demo\//, /^\/demo-site\//],
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/visualice/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#e8492a" }],
  ],
  // srcDir is the repo root, so say where the site's own public files are.
  vite: { publicDir: path.join(ROOT, "site", "public") },
  markdown: {
    config: repoLinks,
    // Code blocks are dark in both themes, like the viewer's.
    theme: { light: "github-dark", dark: "github-dark" },
  },
  themeConfig: {
    logo: { src: "/mark.svg", alt: "" },
    nav: [
      { text: "Guide", link: "/guide/getting-started", activeMatch: "/guide/" },
      { text: "Live demo", link: "/demo/", target: "_blank", rel: "noopener" },
      { text: "Changelog", link: "/changelog" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "The explore flow", link: "/guide/explore" },
        ],
      },
      {
        text: "Guide",
        items: [
          { text: "Crawling", link: "/guide/crawling" },
          { text: "Configuration", link: "/guide/configuration" },
          { text: "Logging in", link: "/guide/auth" },
          { text: "The viewer", link: "/guide/viewer" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI", link: "/guide/cli" },
          { text: "Using it as a library", link: "/guide/library" },
          { text: "Changelog", link: "/changelog" },
          { text: "Contributing", link: "/contributing" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: REPO },
      { icon: "npm", link: "https://www.npmjs.com/package/visualice" },
    ],
    search: { provider: "local" },
    editLink: { pattern: `${REPO}/edit/main/:path`, text: "Edit this page on GitHub" },
    footer: { message: "MIT licensed.", copyright: "Only crawl sites you own or may test." },
  },
});
