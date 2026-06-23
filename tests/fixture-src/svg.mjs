// Inline SVG set for the Third Pour fixture. Everything is currentColor-driven so
// it inherits the surrounding Tailwind text color (and flips cleanly in dark mode).
// No external image assets — keeps the fixture hermetic for offline/deterministic crawls.

const icon = (paths, { size = 20, fill = false } = {}) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" ${
    fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.6"'
  } stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const icons = {
  menu: icon('<path d="M3 6h18M3 12h18M3 18h18"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  search: icon('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  sun: icon(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  ),
  moon: icon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  share: icon(
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  ),
  arrow: icon('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  mail: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
  check: icon('<path d="M20 6 9 17l-5-5"/>'),
  chevron: icon('<path d="m6 9 6 6 6-6"/>', { size: 18 }),
  clock: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', { size: 16 }),
  calendar: icon(
    '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    { size: 16 },
  ),
  link: icon('<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>'),
  rss: icon('<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"/>'),
  instagram: icon('<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/>'),
  bluesky: icon('<path d="M12 10.5C10.6 7.9 7 4.6 5 5c-1.6.3-.8 4.2-.4 5.6.4 1.4 2 1.9 3.6 1.7-2.4.4-2.8 1.8-1.6 3.2 2.3 2.6 3.4-.9 5.4-3.5 2 2.6 3.1 6.1 5.4 3.5 1.2-1.4.8-2.8-1.6-3.2 1.6.2 3.2-.3 3.6-1.7.4-1.4 1.2-5.3-.4-5.6-2-.4-5.6 2.9-7 5.5z" fill="currentColor" stroke="none"/>'),
  github: icon('<path d="M9 19c-4 1.2-4-2-6-2.5m12 4.5v-3.5a3 3 0 0 0-.8-2.3c2.7-.3 5.5-1.3 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6.2 0C6.6 2.8 5.6 3.1 5.6 3.1a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.2 9.5c0 4.6 2.8 5.7 5.5 6a3 3 0 0 0-.8 2.3V21"/>'),
};

// Brand mark: a little cup with a steam curl.
export const logoMark = `
<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6 14h17v5a6 6 0 0 1-6 6h-5a6 6 0 0 1-6-6z"/>
  <path d="M23 15h2.5a3 3 0 0 1 0 6H23"/>
  <path d="M11 8c-1 1.2-1 2.4 0 3.6M16 7c-1 1.2-1 2.4 0 3.6" opacity="0.8"/>
</svg>`;

// Hero illustration: a pour-over dripper over a cup, with a falling stream + steam.
export const heroPourOver = `
<svg viewBox="0 0 240 240" class="h-full w-full" role="img" aria-label="A pour-over coffee dripper over a cup">
  <defs>
    <linearGradient id="tp-brew" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="currentColor" stop-opacity="0.18"/>
      <stop offset="1" stop-color="currentColor" stop-opacity="0.04"/>
    </linearGradient>
  </defs>
  <circle cx="120" cy="120" r="110" fill="url(#tp-brew)"/>
  <g fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M70 70h100l-26 40H96z"/>
    <path d="M110 110l10 26 10-26"/>
    <path d="M120 40c-7 7-7 14 0 21M138 46c-6 6-6 12 0 18M102 46c-6 6-6 12 0 18" opacity="0.7"/>
    <path d="M120 150v18"/>
    <path d="M86 176h68l-8 34a8 8 0 0 1-8 7h-36a8 8 0 0 1-8-7z"/>
    <path d="M154 182h14a10 10 0 0 1 0 20h-12"/>
  </g>
</svg>`;

// Coffee beans cluster (decorative).
export const beansArt = `
<svg viewBox="0 0 120 120" class="h-full w-full" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
  <g transform="rotate(-20 45 50)"><ellipse cx="45" cy="50" rx="16" ry="24"/><path d="M45 28c-7 12-7 32 0 44"/></g>
  <g transform="rotate(25 80 70)"><ellipse cx="80" cy="70" rx="16" ry="24"/><path d="M80 48c-7 12-7 32 0 44"/></g>
</svg>`;

// Brew-ratio dial used on the home page.
export const brewRatio = `
<svg viewBox="0 0 120 120" class="h-full w-full" aria-label="Brew ratio dial" role="img">
  <circle cx="60" cy="60" r="48" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="10"/>
  <circle cx="60" cy="60" r="48" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"
    stroke-dasharray="226 302" transform="rotate(-90 60 60)"/>
  <text x="60" y="56" text-anchor="middle" font-size="20" font-weight="700" fill="currentColor">1:16</text>
  <text x="60" y="76" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.7">RATIO</text>
</svg>`;

// Abstract author portrait.
export const portrait = `
<svg viewBox="0 0 120 120" class="h-full w-full" role="img" aria-label="Author portrait">
  <circle cx="60" cy="60" r="58" fill="currentColor" fill-opacity="0.10"/>
  <circle cx="60" cy="48" r="20" fill="none" stroke="currentColor" stroke-width="4"/>
  <path d="M26 100a34 34 0 0 1 68 0" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
</svg>`;

// Article figure: V60 cone cross-section with grounds + ratio guides.
export const figureV60 = `
<svg viewBox="0 0 320 200" class="h-full w-full" role="img" aria-label="Cross-section of a V60 cone showing the coffee bed">
  <g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M90 30h140l-58 120h-24z"/>
    <path d="M118 90h84" stroke-opacity="0.5"/>
    <path d="M132 120l56 0" stroke-opacity="0.5"/>
    <path d="M120 86c20 8 60 8 80 0" />
    <path d="M160 150v22M150 172h20" />
  </g>
  <g fill="currentColor" fill-opacity="0.18"><path d="M122 86c18 7 56 7 76 0l-22 46h-32z"/></g>
  <g font-size="12" fill="currentColor" opacity="0.75">
    <text x="244" y="60">water</text>
    <text x="244" y="100">slurry</text>
    <text x="244" y="150">bed</text>
  </g>
</svg>`;
