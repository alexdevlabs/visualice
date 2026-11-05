<script setup lang="ts">
import CrawlerGlyph from "./CrawlerGlyph.vue";

/**
 * The small picture above each claim on the home page, the first two with the crawler in them:
 * - `explore`: puzzling over a form field in its error state,
 * - `replay`: walking the same route through two identical runs,
 * - `screens`: the screens captured as the viewport scrolls down a page.
 * Every colour is a site token, so they follow the theme, and every animation is CSS,
 * so reduced motion stops them.
 */
defineProps<{ kind: "explore" | "replay" | "screens" }>();

const FIGURE_EIGHT =
  "M 85 86 C 85 46 140 46 160 86 C 180 126 235 126 235 86 C 235 46 180 46 160 86 C 140 126 85 126 85 86 Z";
const pages = [30, 180];
const thumbs = [
  { y: 18, newest: false },
  { y: 70, newest: false },
  { y: 122, newest: true },
];
</script>

<template>
  <div class="ca" aria-hidden="true">
    <svg viewBox="0 0 320 180">
      <template v-if="kind === 'explore'">
        <rect x="96" y="14" width="200" height="152" rx="10" class="ca-page" />
        <rect x="114" y="30" width="96" height="9" rx="4" class="ca-bar-strong" />
        <rect x="114" y="50" width="50" height="6" rx="3" class="ca-bar" />
        <rect x="114" y="60" width="164" height="18" rx="5" class="ca-input" />
        <rect x="114" y="86" width="50" height="6" rx="3" class="ca-bar" />
        <rect x="114" y="96" width="164" height="18" rx="5" class="ca-input ca-error" />
        <circle cx="264" cy="105" r="6" class="ca-accent" />
        <rect x="263" y="101" width="2" height="5" rx="1" class="ca-mark" />
        <rect x="263" y="107.5" width="2" height="2" rx="1" class="ca-mark" />
        <rect x="114" y="120" width="80" height="5" rx="2.5" class="ca-hot" />
        <rect x="114" y="136" width="64" height="20" rx="10" class="ca-ink" />
        <g transform="translate(52 112)">
          <g class="ca-tilt"><CrawlerGlyph :size="34" /></g>
          <g class="ca-bubble">
            <circle cx="10" cy="-44" r="15" class="ca-cloud" />
            <circle cx="4" cy="-25" r="3.5" class="ca-cloud" />
            <circle cx="8" cy="-46" r="5.5" class="ca-lens" />
            <path d="M 12 -42 L 17 -37" class="ca-handle" />
          </g>
        </g>
      </template>

      <template v-else-if="kind === 'replay'">
        <g v-for="x in pages" :key="x">
          <rect :x="x" y="34" width="110" height="104" rx="8" class="ca-page" />
          <rect :x="x + 12" y="46" width="56" height="7" rx="3.5" class="ca-bar-strong" />
          <rect :x="x + 12" y="60" width="32" height="44" rx="4" class="ca-hot-soft" />
          <rect :x="x + 12" y="60" width="32" height="7" rx="3.5" class="ca-hot" />
          <rect :x="x + 50" y="60" width="48" height="7" rx="3.5" class="ca-bar" />
          <rect :x="x + 50" y="73" width="40" height="7" rx="3.5" class="ca-bar" />
          <rect :x="x + 12" y="114" width="86" height="7" rx="3.5" class="ca-bar" />
        </g>
        <path :d="FIGURE_EIGHT" class="ca-route" />
        <text x="85" y="160" text-anchor="middle" class="ca-label">run 1</text>
        <text x="235" y="160" text-anchor="middle" class="ca-label">run 2</text>
        <rect x="152" y="150" width="16" height="2.5" rx="1.25" class="ca-accent" />
        <rect x="152" y="156" width="16" height="2.5" rx="1.25" class="ca-accent" />
        <g class="ca-walk" :style="{ offsetPath: `path('${FIGURE_EIGHT}')` }">
          <CrawlerGlyph />
        </g>
      </template>

      <template v-else>
        <g v-for="t in thumbs" :key="t.y">
          <rect
            x="30"
            :y="t.y"
            width="56"
            height="40"
            rx="5"
            class="ca-page"
            :class="{ 'ca-newest': t.newest }"
          />
          <rect x="30.5" :y="t.y + 0.5" width="55" height="9" rx="4.5" class="ca-header" />
          <rect x="38" :y="t.y + 16" width="34" height="5" rx="2.5" class="ca-bar" />
          <rect x="38" :y="t.y + 26" width="26" height="5" rx="2.5" class="ca-bar" />
        </g>
        <rect x="120" y="12" width="104" height="160" rx="12" class="ca-page" />
        <rect x="134" y="44" width="60" height="7" rx="3.5" class="ca-bar-strong" />
        <rect x="134" y="58" width="76" height="30" rx="4" class="ca-bar" />
        <rect x="134" y="96" width="70" height="6" rx="3" class="ca-bar" />
        <rect x="134" y="108" width="54" height="6" rx="3" class="ca-bar" />
        <rect x="134" y="122" width="76" height="22" rx="4" class="ca-hot-soft" />
        <rect x="134" y="152" width="62" height="6" rx="3" class="ca-bar" />
        <g class="ca-scroll">
          <rect x="114" y="16" width="116" height="58" rx="9" class="ca-viewport" />
          <rect x="121" y="21" width="102" height="11" rx="4" class="ca-header" />
          <circle cx="129" cy="26.5" r="2.5" class="ca-accent" />
        </g>
      </template>
    </svg>
  </div>
</template>

<style scoped>
.ca {
  margin-bottom: 24px;
  border-radius: 18px;
  overflow: hidden;
  background-color: var(--vc-canvas);
  background-image: radial-gradient(var(--vc-dot) 1.2px, transparent 1.2px);
  background-size: 20px 20px;
}
.ca svg {
  display: block;
  width: 100%;
  height: auto;
}
.ca-page {
  fill: var(--vc-tile);
  stroke: var(--vc-tile-line);
}
.ca-newest {
  stroke: var(--vc-accent);
}
.ca-bar {
  fill: var(--vc-bar);
}
.ca-bar-strong {
  fill: var(--vc-bar-strong);
}
.ca-input {
  fill: var(--vc-paper-2);
  stroke: var(--vc-tile-line);
}
.ca-input.ca-error {
  fill: var(--vc-hot-soft);
  stroke: var(--vc-accent);
  stroke-width: 1.5;
}
.ca-hot {
  fill: var(--vc-hot);
}
.ca-hot-soft {
  fill: var(--vc-hot-soft);
}
.ca-accent {
  fill: var(--vc-accent);
}
.ca-mark {
  fill: #ffffff;
}
.ca-ink,
.ca-header {
  fill: var(--vc-ink);
}
.ca-cloud {
  fill: var(--vc-tile);
  stroke: var(--vc-tile-line);
}
.ca-lens {
  fill: none;
  stroke: var(--vc-accent);
  stroke-width: 2.5;
}
.ca-handle {
  stroke: var(--vc-accent);
  stroke-width: 3;
  stroke-linecap: round;
}
.ca-route {
  fill: none;
  stroke: var(--vc-line-strong);
  stroke-width: 1.5;
  stroke-dasharray: 3 6;
}
.ca-label {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  fill: var(--vp-c-text-2);
}
.ca-viewport {
  fill: none;
  stroke: var(--vc-accent);
  stroke-width: 2;
}

/* Puzzling over the error: a tilt, and a thought with a magnifying glass in it */
.ca-tilt {
  transform-box: fill-box;
  transform-origin: center;
  animation: ca-tilt 4s ease-in-out infinite;
}
@keyframes ca-tilt {
  0%,
  35% {
    transform: rotate(0);
  }
  45%,
  75% {
    transform: rotate(-14deg);
  }
  85%,
  100% {
    transform: rotate(0);
  }
}
.ca-bubble {
  animation: ca-bubble 4s ease-in-out infinite;
}
@keyframes ca-bubble {
  0%,
  38% {
    opacity: 0;
    transform: translateY(6px);
  }
  50%,
  80% {
    opacity: 1;
    transform: translateY(0);
  }
  100% {
    opacity: 0;
    transform: translateY(6px);
  }
}

/* The same route, through both runs */
.ca-walk {
  offset-rotate: auto;
  animation: ca-walk 8s linear infinite;
}
@keyframes ca-walk {
  from {
    offset-distance: 0%;
  }
  to {
    offset-distance: 100%;
  }
}

/* One screen at a time, down the page */
.ca-scroll {
  animation: ca-scroll 7s ease-in-out infinite;
}
@keyframes ca-scroll {
  0%,
  20% {
    transform: translateY(0);
  }
  32%,
  52% {
    transform: translateY(46px);
  }
  64%,
  86% {
    transform: translateY(94px);
  }
  100% {
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ca-tilt,
  .ca-walk,
  .ca-scroll {
    animation: none;
  }
  .ca-bubble {
    animation: none;
    opacity: 1;
  }
  .ca-walk {
    offset-distance: 12%;
  }
}
</style>
