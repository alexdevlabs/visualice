<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { withBase } from "vitepress";
import ClaimArt from "./ClaimArt.vue";

/**
 * The home page: a split hero with the viewer's grid (a row per state, a column per
 * device) drawn in markup, and the logo's crawler walking over it.
 */

const demo = withBase("/demo/");

// The crawler scans the grid like a reviewer: along the first row of pages, a U-turn
// down, back along the next, and so on, then up the left edge to start again. The
// route is measured from where the rows really are, so it fits any width, and it is
// always walked forwards, so the crawler always goes head first.
const SPEED = 70; // px per second

const grid = ref<HTMLElement>();
const crawler = ref<HTMLElement>();
const path = ref("");
const duration = ref("30s");
let observer: ResizeObserver | undefined;

// The card the crawler is standing on gets the selection frame, like a shot clicked in
// the viewer; none while it's between cards. Checked every frame, but only while the
// grid is on screen and the crawler is moving: with reduced motion it stands still, so
// once is enough.
const active = ref("menu-0");
let frame = 0;
let onScreen = false;
let motion: MediaQueryList | undefined;
let visibility: IntersectionObserver | undefined;
function check() {
  const bug = crawler.value?.getBoundingClientRect();
  if (bug && grid.value) {
    const x = bug.left + bug.width / 2;
    const y = bug.top + bug.height / 2;
    let under = "";
    for (const tile of grid.value.querySelectorAll<HTMLElement>(".vh-tile")) {
      const t = tile.getBoundingClientRect();
      if (x >= t.left && x <= t.right && y >= t.top && y <= t.bottom) {
        under = tile.dataset.key ?? "";
        break;
      }
    }
    if (under !== active.value) active.value = under;
  }
}
function loop() {
  check();
  frame = requestAnimationFrame(loop);
}
function stop() {
  cancelAnimationFrame(frame);
  frame = 0;
}
function update() {
  if (onScreen && !motion?.matches) {
    if (!frame) frame = requestAnimationFrame(loop);
  } else {
    stop();
    requestAnimationFrame(check);
  }
}

function scanRoute(el: HTMLElement): { d: string; length: number } | undefined {
  const rows = [...el.querySelectorAll<HTMLElement>(".vh-row")];
  if (rows.length < 2) return undefined;
  const ys = rows.map((r) => r.offsetTop + r.offsetHeight / 2);
  const r = (ys[1] - ys[0]) / 2;
  const left = rows[0].offsetLeft + r;
  const right = rows[0].offsetLeft + rows[0].offsetWidth - r;
  const edge = Math.max(20, rows[0].offsetLeft);
  const parts = [`M ${left} ${ys[0]}`];
  let length = 0;
  ys.forEach((y, i) => {
    const rightward = i % 2 === 0;
    parts.push(`L ${rightward ? right : left} ${y}`);
    length += right - left;
    if (i < ys.length - 1) {
      // U-turn down to the next row, on whichever side the crawler is.
      parts.push(`A ${r} ${r} 0 0 ${rightward ? 1 : 0} ${rightward ? right : left} ${ys[i + 1]}`);
      length += Math.PI * r;
    }
  });
  // Back to the start: out to the left edge, up it, and into the first row.
  const last = ys[ys.length - 1];
  const end = ys.length % 2 === 0 ? left : right;
  if (end === right) {
    parts.push(`L ${left} ${last}`);
    length += right - left;
  }
  parts.push(
    `Q ${edge} ${last} ${edge} ${last - r}`,
    `L ${edge} ${ys[0] + r}`,
    `Q ${edge} ${ys[0]} ${left} ${ys[0]}`,
  );
  length += last - ys[0] + 2 * r;
  return { d: parts.join(" "), length };
}

onMounted(() => {
  const el = grid.value;
  if (!el) return;
  observer = new ResizeObserver(() => {
    const route = scanRoute(el);
    if (!route) return;
    path.value = `path("${route.d}")`;
    duration.value = `${Math.round(route.length / SPEED)}s`;
    update();
  });
  observer.observe(el);
  visibility = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    update();
  });
  visibility.observe(el);
  motion = matchMedia("(prefers-reduced-motion: reduce)");
  motion.addEventListener("change", update);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  visibility?.disconnect();
  motion?.removeEventListener("change", update);
  stop();
});

// The three steps of the install section, for the Claude Code plugin.
const steps = [
  { title: "Add the marketplace", command: "/plugin marketplace add alexdevlabs/visualice" },
  { title: "Install the plugin", command: "/plugin install visualice@visualice" },
  { title: "Ask for your site", command: "run visualice on https://your.site" },
];

// The install step whose command was just copied, for a moment.
const copied = ref<number | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copy(text: string, i: number) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return; // no clipboard access (an insecure origin, a denied permission): leave it be
  }
  copied.value = i;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = null), 1600);
}

// A row per state (default, menu open, form error, cart with items), a column per device.
const rows = [
  { id: "default", tiles: ["page", "page", "page"] },
  { id: "menu", tiles: ["menu", "page", "page"] },
  { id: "error", tiles: ["error", "error", "error"] },
  { id: "cart", tiles: ["list", "page", "page"] },
];
</script>

<template>
  <div class="vh">
    <section class="vh-hero">
      <div class="vh-copy">
        <h1>See every screen of your site at once.</h1>
        <p class="vh-lede">
          Every page and every state, on every device, laid out on one canvas you can zoom through.
          Spot the broken one before your users do.
        </p>
        <div class="vh-actions">
          <a class="vh-btn vh-btn-primary" :href="withBase('/guide/getting-started')"
            >Get started</a
          >
          <a class="vh-btn vh-btn-ghost" :href="demo" target="_blank" rel="noopener"
            >See the live demo</a
          >
        </div>
      </div>

      <div ref="grid" class="vh-grid" aria-hidden="true">
        <div
          v-show="path"
          ref="crawler"
          class="vh-crawler"
          :style="{ offsetPath: path, animationDuration: duration }"
        >
          <svg viewBox="0 0 64 64">
            <g transform="rotate(90 32 32)">
              <g class="vh-legs-a">
                <path d="M21 32 L13 27 M47 42 L55 42 M21 52 L13 57" />
              </g>
              <g class="vh-legs-b">
                <path d="M17 42 L9 42 M43 32 L51 27 M43 52 L51 57" />
              </g>
              <path class="vh-antennae" d="M27.5 14 L23.5 8 M36.5 14 L40.5 8" />
              <circle cx="32" cy="42" r="17" class="vh-body" />
              <circle cx="32" cy="20" r="8.5" class="vh-head" />
            </g>
          </svg>
        </div>
        <div v-for="row in rows" :key="row.id" class="vh-row">
          <div
            v-for="(kind, i) in row.tiles"
            :key="i"
            class="vh-tile"
            :data-key="`${row.id}-${i}`"
            :class="[`vh-${kind}`, { 'vh-selected': active === `${row.id}-${i}` }]"
          >
            <div class="vh-bar vh-title"></div>
            <div class="vh-bar"></div>
            <div class="vh-bar vh-short"></div>
          </div>
        </div>
      </div>
    </section>

    <section class="vh-wrap vh-install" aria-labelledby="vh-install-h">
      <div class="vh-install-head">
        <span class="vh-eyebrow">Install</span>
        <h2 id="vh-install-h">Running in Claude Code in three steps.</h2>
      </div>
      <ol class="vh-steps">
        <li v-for="(step, i) in steps" :key="i" :class="{ 'vh-step-last': i === steps.length - 1 }">
          <span class="vh-step-n" aria-hidden="true">{{ i + 1 }}</span>
          <h3>{{ step.title }}</h3>
          <div class="vh-cmd">
            <code>{{ step.command }}</code>
            <button
              type="button"
              class="vh-copy-btn"
              :aria-label="copied === i ? 'Copied' : `Copy: ${step.command}`"
              @click="copy(step.command, i)"
            >
              <svg v-if="copied === i" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
              <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                <rect x="8" y="8" width="12" height="12" rx="2.5" />
                <path
                  d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"
                />
              </svg>
            </button>
          </div>
        </li>
      </ol>
      <p class="vh-install-cli">
        Not using Claude Code? <code>npm i -g visualice</code> (Node 22.18+), then
        <code>visualice crawl https://your.site</code> ·
        <a :href="withBase('/guide/getting-started')">Getting started →</a>
      </p>
    </section>

    <section class="vh-claims">
      <div class="vh-wrap vh-claims-grid">
        <div>
          <ClaimArt kind="explore" />
          <h2>Explores like a QA reviewer</h2>
          <p>
            The crawler maps pages and the obvious states. An agent then works through each kind of
            page and finds what a crawler can't: form errors, a cart with items, signed-in views.
          </p>
        </div>
        <div>
          <ClaimArt kind="replay" />
          <h2>Repeatable without the agent</h2>
          <p>
            Each state is a recipe the engine replays, so reruns are identical and CI can recapture
            the catalogue on every deploy.
          </p>
        </div>
        <div>
          <ClaimArt kind="screens" />
          <h2>Shows what users see</h2>
          <p>
            Pages are captured one screen at a time, as a user scrolls, so sticky headers and
            backdrops look the way they really do.
          </p>
        </div>
      </div>
    </section>

    <section class="vh-wrap vh-shot">
      <div class="vh-shot-head">
        <h2>Zoom out for the whole site. Zoom in to the pixel.</h2>
        <a class="vh-btn vh-btn-ghost" :href="demo" target="_blank" rel="noopener"
          >Open the live demo</a
        >
      </div>
      <a :href="demo" target="_blank" rel="noopener" class="vh-shot-link">
        <picture>
          <!-- With reduced motion, a still of the viewer instead of the zoom loop. -->
          <source media="(prefers-reduced-motion: reduce)" :srcset="withBase('/viewer.webp')" />
          <img
            :src="withBase('/viewer-zoom.webp')"
            alt="The visualice viewer zooming from a demo blog's whole catalogue into one page and back out"
            width="1200"
            height="750"
            loading="lazy"
            decoding="async"
          />
        </picture>
      </a>
    </section>

    <footer class="vh-footer">
      <div class="vh-wrap vh-footer-row">
        <a class="vh-footer-brand" :href="withBase('/')">
          <img :src="withBase('/mark.svg')" alt="" width="22" height="22" />
          <span>visua<span class="vh-lice">lice</span></span>
        </a>
        <nav class="vh-footer-links" aria-label="Footer">
          <a :href="withBase('/guide/getting-started')">Docs</a>
          <a :href="demo" target="_blank" rel="noopener">Live demo</a>
          <a :href="withBase('/changelog')">Changelog</a>
          <a :href="withBase('/contributing')">Contributing</a>
        </nav>
        <div class="vh-footer-icons">
          <a href="https://github.com/alexdevlabs/visualice" aria-label="GitHub">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.6.2 2.9.1 3.2.8.8 1.3 1.9 1.3 3.1 0 4.8-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"
              />
            </svg>
          </a>
          <a href="https://www.npmjs.com/package/visualice" aria-label="npm">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2 2h20v20H2zM5.5 5.5v13h6.5V8.5h3.5v10h3V5.5z" />
            </svg>
          </a>
        </div>
      </div>
      <p class="vh-wrap vh-footer-note">MIT licensed · Only crawl sites you own or may test.</p>
    </footer>
  </div>
</template>

<style scoped>
.vh {
  --vh-paper: var(--vc-paper);
  color: var(--vp-c-text-1);
  background: var(--vh-paper);
}
.vh-wrap,
.vh-hero {
  max-width: 1240px;
  margin: 0 auto;
  padding-left: 24px;
  padding-right: 24px;
  box-sizing: border-box;
}
.vh h1,
.vh h2 {
  font-family: var(--vp-font-family-base);
  color: var(--vp-c-text-1);
  border: 0;
  margin: 0;
  padding: 0;
}

/* Hero */
.vh-hero {
  display: flex;
  flex-wrap: wrap;
  gap: 56px;
  align-items: center;
  padding-top: 72px;
  padding-bottom: 96px;
}
.vh-copy {
  flex: 1 1 440px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.vh h1 {
  font-size: clamp(38px, 4.6vw, 58px);
  line-height: 1.04;
  letter-spacing: -0.03em;
  font-weight: 800;
}
.vh-lede {
  margin: 0;
  max-width: 520px;
  font-size: 19px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.vh-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.vh-btn {
  display: inline-flex;
  align-items: center;
  min-height: 46px;
  padding: 0 22px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 15px;
  text-decoration: none;
  box-sizing: border-box;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.vh-btn-primary {
  background: var(--vc-ink);
  color: var(--vc-on-ink);
}
.vh-btn-primary:hover {
  background: var(--vc-ink-hover);
  color: var(--vc-on-ink);
}
.vh-btn-ghost {
  color: var(--vp-c-text-1);
  border: 1px solid var(--vc-line-strong);
}
.vh-btn-ghost:hover {
  border-color: var(--vp-c-text-1);
  color: var(--vp-c-text-1);
}
/* The grid, with the crawler on top */
.vh-grid {
  position: relative;
  overflow: hidden;
  flex: 1 1 520px;
  min-width: 0;
  border-radius: 22px;
  background-color: var(--vc-canvas);
  background-image: radial-gradient(var(--vc-dot) 1.2px, transparent 1.2px);
  background-size: 20px 20px;
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.vh-row {
  display: grid;
  grid-template-columns: 3fr 1.4fr 1fr;
  gap: 14px;
  align-items: center;
}
.vh-tile {
  height: 96px;
  background: var(--vc-tile);
  border: 1px solid var(--vc-tile-line);
  border-radius: 8px;
  padding: 9px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.vh-bar {
  height: 7px;
  border-radius: 3px;
  background: var(--vc-bar);
  width: 85%;
}
.vh-bar.vh-title {
  width: 60%;
  background: var(--vc-bar-strong);
}
.vh-bar.vh-short {
  width: 45%;
}
.vh-menu .vh-bar:nth-child(2) {
  height: 38px;
  background: var(--vc-hot-soft);
}
.vh-menu .vh-bar.vh-title {
  background: var(--vc-hot);
}
.vh-error .vh-bar.vh-short {
  background: var(--vc-hot);
}
.vh-list .vh-bar.vh-short {
  width: 85%;
}
.vh-tile {
  outline: 2.5px solid transparent;
  outline-offset: 4px;
  transition: outline-color 0.45s ease;
}
.vh-tile.vh-selected {
  outline-color: var(--vc-accent);
}

.vh-crawler {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  width: 40px;
  height: 40px;
  offset-rotate: auto;
  pointer-events: none;
  animation: vh-wander linear infinite;
}
.vh-crawler svg {
  display: block;
  width: 100%;
  height: 100%;
}
.vh-crawler path {
  fill: none;
  stroke: var(--vc-bug);
  stroke-width: 5.5;
  stroke-linecap: round;
}
.vh-crawler .vh-antennae {
  stroke-width: 3.5;
}
.vh-body {
  fill: var(--vc-bug);
}
.vh-head {
  fill: var(--vc-accent);
}
.vh-legs-a,
.vh-legs-b {
  transform-box: view-box;
  transform-origin: 32px 42px;
  animation: vh-step-a 0.32s ease-in-out infinite alternate;
}
.vh-legs-b {
  animation-name: vh-step-b;
}
@keyframes vh-step-a {
  from {
    transform: rotate(-9deg);
  }
  to {
    transform: rotate(9deg);
  }
}
@keyframes vh-step-b {
  from {
    transform: rotate(9deg);
  }
  to {
    transform: rotate(-9deg);
  }
}
@keyframes vh-wander {
  from {
    offset-distance: 0%;
  }
  to {
    offset-distance: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .vh-crawler,
  .vh-legs-a,
  .vh-legs-b {
    animation: none;
  }
  .vh-crawler {
    offset-distance: 8%;
  }
}

/* Install: three steps for the plugin, one line for the CLI */
.vh-install {
  padding-top: 8px;
  padding-bottom: 96px;
  display: flex;
  flex-direction: column;
  gap: 40px;
}
.vh-install-head {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.vh-eyebrow {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}
.vh-install h2 {
  font-size: clamp(26px, 2.6vw, 32px);
  line-height: 1.15;
  letter-spacing: -0.02em;
  font-weight: 700;
}
.vh-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}
.vh-steps li {
  margin: 0;
  min-width: 0;
  background: var(--vc-paper-2);
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.vh-steps li.vh-step-last {
  border-color: var(--vc-accent);
}
.vh-step-n {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--vc-ink);
  color: var(--vc-on-ink);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 15px;
}
.vh-step-last .vh-step-n {
  background: var(--vc-accent);
  color: #16161a;
}
.vh-steps h3 {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
}
.vh-cmd {
  position: relative;
}
.vh-steps code {
  display: block;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.5;
  background: #16161a;
  color: #f4f2ec;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 12px 48px 12px 14px;
  overflow-wrap: anywhere;
}
.vh-copy-btn {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #8b877e;
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
}
.vh-copy-btn:hover {
  color: #f4f2ec;
  background: rgba(244, 242, 236, 0.08);
}
.vh-copy-btn:focus-visible {
  outline: 2px solid var(--vc-accent);
  outline-offset: -2px;
}
.vh-copy-btn svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.vh-install-cli {
  margin: 0;
  font-size: 15px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
}
.vh-install-cli code {
  font-family: var(--vp-font-family-mono);
  font-size: 13.5px;
  background: var(--vp-code-bg);
  color: var(--vp-code-color);
  border-radius: 6px;
  padding: 3px 7px;
}
.vh-install-cli a {
  font-weight: 600;
  text-decoration: none;
  color: var(--vp-c-brand-1);
}

/* Claims */
.vh-claims {
  background: var(--vp-c-bg);
  border-top: 1px solid var(--vp-c-divider);
  border-bottom: 1px solid var(--vp-c-divider);
}
.vh-claims-grid {
  padding-top: 88px;
  padding-bottom: 88px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 48px;
}
.vh-claims h2 {
  margin-bottom: 12px;
  font-size: 22px;
  line-height: 1.25;
  letter-spacing: -0.015em;
  font-weight: 700;
}
.vh-claims p {
  margin: 0;
  font-size: 17px;
  line-height: 1.65;
  color: var(--vp-c-text-2);
}

/* Screenshot and install */
.vh-shot {
  padding-top: 96px;
  padding-bottom: 96px;
  display: flex;
  flex-direction: column;
  gap: 40px;
}
.vh-shot-head {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  justify-content: space-between;
  align-items: flex-end;
}
.vh-shot-head h2 {
  max-width: 640px;
  font-size: clamp(26px, 2.6vw, 32px);
  line-height: 1.15;
  letter-spacing: -0.02em;
  font-weight: 700;
}
.vh-shot-link,
.vh-shot-link picture {
  display: block;
}
.vh-shot-link img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 16px;
  border: 1px solid var(--vc-tile-line);
  box-shadow: 0 30px 60px -24px rgba(22, 22, 26, 0.25);
}
/* Footer: one row, on the nav's lighter paper */
.vh-footer {
  background: var(--vc-paper-2);
  border-top: 1px solid var(--vp-c-divider);
}
.vh-footer-row {
  padding-top: 20px;
  padding-bottom: 8px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 32px;
}
.vh-footer-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 8px;
  font-weight: 700;
  font-size: 16px;
  color: var(--vp-c-text-1);
  text-decoration: none;
}
.vh-footer-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0 24px;
}
.vh-footer-links a {
  padding: 12px 0;
  font-size: 14px;
  color: var(--vp-c-text-1);
  text-decoration: none;
}
.vh-footer-links a:hover,
.vh-footer-brand:hover {
  color: var(--vp-c-brand-1);
}
.vh-footer-icons {
  display: flex;
  margin-left: auto;
}
.vh-footer-icons a {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  color: var(--vp-c-text-2);
}
.vh-footer-icons a:hover {
  color: var(--vp-c-text-1);
}
.vh-footer-icons svg {
  width: 20px;
  height: 20px;
  fill: currentColor;
}
.vh-footer-note {
  margin: 0 auto;
  padding-bottom: 24px;
  font-size: 13px;
  color: var(--vp-c-text-3);
}

@media (max-width: 640px) {
  .vh-hero {
    padding-top: 48px;
    padding-bottom: 64px;
    gap: 40px;
  }
  .vh-grid {
    padding: 18px;
    gap: 12px;
  }
  .vh-row {
    gap: 8px;
  }
  .vh-tile {
    height: 72px;
    padding: 7px;
  }
}
</style>
