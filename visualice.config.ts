import type { VisualiceConfig } from "./src/shared/config";

/**
 * Example config. Everything not set falls back to sensible defaults
 * (see src/shared/config.ts). Run: `npm run capture -- --manifest=<path>`.
 */
const config: VisualiceConfig = {
  target: "https://example.com",

  scope: {
    include: ["/**"],
    exclude: ["/admin/**", "/logout"],
    maxDepth: 4,
    maxPages: 200,
  },

  devices: [
    { name: "desktop", width: 1440, height: 900, dpr: 2 },
    { name: "laptop", width: 1280, height: 800, dpr: 2 },
    { name: "tablet", width: 820, height: 1180, dpr: 2, mobile: true, touch: true },
    { name: "mobile", width: 390, height: 844, dpr: 3, mobile: true, touch: true },
  ],

  screenshot: {
    fullPage: "screens",
    alsoViewport: true,
    format: "png",
    thumbnail: { width: 480, format: "webp", quality: 70 },
  },

  stabilize: {
    animations: "disabled",
    freezeTime: "2025-01-01T00:00:00Z",
    seedRandom: 42,
    maskSelectors: [".ad", "[data-volatile]"],
    waitStrategy: "networkidle",
  },

  // Authenticated crawls: run the login recipe once, reuse the saved session.
  // Secrets come from env (${VC_USER} / ${VC_PASS}) — never hardcode them.
  // auth: {
  //   storageStatePath: ".visualice/auth.json",
  //   login: {
  //     url: "/login",
  //     steps: [
  //       { action: "fill", target: { label: "Email" }, value: "${VC_USER}" },
  //       { action: "fill", target: { label: "Password" }, value: "${VC_PASS}" },
  //       { action: "click", target: { role: "button", name: "Sign in" } },
  //       { action: "waitFor", url: "**/dashboard" },
  //     ],
  //   },
  // },
};

export default config;
