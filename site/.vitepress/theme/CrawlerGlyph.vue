<script setup lang="ts">
/**
 * The logo's crawler, for drawing inside another SVG: centred on the parent's origin,
 * `size` across, facing right unless `turn` says otherwise (degrees, clockwise).
 */
withDefaults(defineProps<{ size?: number; turn?: number }>(), { size: 30, turn: 0 });
</script>

<template>
  <svg
    :x="-size / 2"
    :y="-size / 2"
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    overflow="visible"
  >
    <g :transform="`rotate(${90 + turn} 32 32)`">
      <g class="cg-legs-a"><path d="M21 32 L13 27 M47 42 L55 42 M21 52 L13 57" /></g>
      <g class="cg-legs-b"><path d="M17 42 L9 42 M43 32 L51 27 M43 52 L51 57" /></g>
      <path class="cg-antennae" d="M27.5 14 L23.5 8 M36.5 14 L40.5 8" />
      <circle cx="32" cy="42" r="17" class="cg-body" />
      <circle cx="32" cy="20" r="8.5" class="cg-head" />
    </g>
  </svg>
</template>

<style scoped>
path {
  fill: none;
  stroke: var(--vc-bug);
  stroke-width: 5.5;
  stroke-linecap: round;
}
.cg-antennae {
  stroke-width: 3.5;
}
.cg-body {
  fill: var(--vc-bug);
}
.cg-head {
  fill: var(--vc-accent);
}
.cg-legs-a,
.cg-legs-b {
  transform-box: view-box;
  transform-origin: 32px 42px;
  animation: cg-step-a 0.32s ease-in-out infinite alternate;
}
.cg-legs-b {
  animation-name: cg-step-b;
}
@keyframes cg-step-a {
  from {
    transform: rotate(-9deg);
  }
  to {
    transform: rotate(9deg);
  }
}
@keyframes cg-step-b {
  from {
    transform: rotate(9deg);
  }
  to {
    transform: rotate(-9deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .cg-legs-a,
  .cg-legs-b {
    animation: none;
  }
}
</style>
