// Shared chrome rendered into every page by layout.mjs: header, mobile drawer,
// search + newsletter modals, cookie banner, footer, plus small card/badge helpers.

import { icons, logoMark } from "./svg.mjs";
import { site, nav, categories, articleUrl } from "./content.mjs";

const navLinks = (active, big = false) =>
  nav
    .map((item) => {
      const isActive = item.href === active;
      const cls = big
        ? `block rounded-lg px-3 py-2 text-base font-medium ${
            isActive
              ? "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
              : "text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800"
          }`
        : `nav-link ${isActive ? "nav-link-active" : ""}`;
      return `<a href="${item.href}" class="${cls}"${isActive ? ' aria-current="page"' : ""}>${item.label}</a>`;
    })
    .join("");

const themeToggle = (testId = "theme-toggle") => `
  <button type="button" class="icon-btn" data-theme-toggle data-testid="${testId}"
    aria-label="Toggle dark mode" title="Toggle dark mode">
    <span class="dark:hidden">${icons.moon}</span>
    <span class="hidden dark:inline">${icons.sun}</span>
  </button>`;

export const header = (active = "/") => `
<header class="sticky top-0 z-30 border-b border-stone-200/80 bg-cream/85 backdrop-blur dark:border-stone-700/70 dark:bg-grounds/85">
  <div class="container-tp flex h-16 items-center gap-3">
    <a href="/" class="flex items-center gap-2 text-amber-700 dark:text-amber-500" aria-label="${site.name} home">
      ${logoMark}
      <span class="font-serif text-lg font-bold tracking-tight text-stone-900 dark:text-stone-50">${site.name}</span>
    </a>
    <nav class="ml-6 hidden items-center gap-1 md:flex" aria-label="Primary">${navLinks(active)}</nav>
    <div class="ml-auto flex items-center gap-1">
      <button type="button" class="icon-btn" data-testid="search-button" aria-label="Search">${icons.search}</button>
      ${themeToggle()}
      <a href="/login" class="btn-primary ml-1 hidden sm:inline-flex" data-testid="signin-link">Sign in</a>
      <button type="button" class="icon-btn md:hidden" data-testid="menu-button" aria-label="Open menu"
        aria-expanded="false" aria-controls="mobile-drawer">${icons.menu}</button>
    </div>
  </div>
</header>`;

export const drawer = (active = "/") => `
<div id="drawer-backdrop" hidden class="fixed inset-0 z-40 bg-stone-900/40 backdrop-blur-sm md:hidden"></div>
<aside id="mobile-drawer" hidden role="dialog" aria-modal="true" aria-label="Menu"
  class="fixed inset-y-0 right-0 z-50 flex w-72 max-w-[80vw] flex-col gap-1 border-l border-stone-200 bg-paper p-5 dark:border-stone-700 dark:bg-espresso md:hidden">
  <div class="mb-3 flex items-center justify-between">
    <span class="font-serif text-lg font-bold text-stone-900 dark:text-stone-50">Menu</span>
    <button type="button" class="icon-btn" data-drawer-close aria-label="Close menu">${icons.close}</button>
  </div>
  ${navLinks(active, true)}
  <div class="mt-auto flex items-center gap-2 border-t border-stone-200 pt-4 dark:border-stone-700">
    ${themeToggle("theme-toggle-drawer")}
    <a href="/login" class="btn-primary flex-1" data-testid="signin-link-drawer">Sign in</a>
  </div>
</aside>`;

export const searchModal = () => `
<dialog id="search-modal" aria-label="Search" class="tp-dialog w-[min(560px,92vw)]">
  <form method="dialog" class="flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h2 class="font-serif text-xl font-bold text-stone-900 dark:text-stone-50">Search</h2>
      <button type="submit" class="icon-btn" aria-label="Close search" data-modal-close>${icons.close}</button>
    </div>
    <label class="relative block">
      <span class="sr-only">Search articles</span>
      <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400">${icons.search}</span>
      <input type="search" data-testid="search-input" placeholder="Try “ratio” or “grinder”…"
        class="field pl-10" autocomplete="off" />
    </label>
    <div>
      <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">Popular</p>
      <ul class="flex flex-wrap gap-2">
        <li><a href="/articles/the-pour-over-ratio" class="badge hover:underline">Pour-over ratio</a></li>
        <li><a href="/articles/dialing-in-espresso" class="badge hover:underline">Espresso</a></li>
        <li><a href="/articles/choosing-your-first-grinder" class="badge hover:underline">Grinders</a></li>
      </ul>
    </div>
  </form>
</dialog>`;

export const newsletterModal = () => `
<dialog id="newsletter-modal" aria-label="Subscribe to the newsletter" class="tp-dialog w-[min(440px,92vw)]">
  <div class="flex items-start justify-between">
    <h2 class="font-serif text-xl font-bold text-stone-900 dark:text-stone-50">The Weekly Pour</h2>
    <button type="button" class="icon-btn" aria-label="Close" data-modal-close>${icons.close}</button>
  </div>
  <form id="newsletter-form" class="mt-3 flex flex-col gap-3">
    <p class="text-sm text-stone-600 dark:text-stone-300">One short email each Friday — a brew tip and a bean worth trying. No spam.</p>
    <label class="block">
      <span class="sr-only">Email address</span>
      <input type="email" required data-testid="newsletter-email" placeholder="you@example.com" class="field" />
    </label>
    <button type="submit" class="btn-primary w-full" data-testid="newsletter-submit">Subscribe</button>
  </form>
  <div id="newsletter-thanks" hidden class="mt-3 flex flex-col items-center gap-2 py-4 text-center">
    <span class="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">${icons.check}</span>
    <p class="font-medium text-stone-800 dark:text-stone-100">You're on the list. See you Friday.</p>
  </div>
</dialog>`;

export const cookieBanner = () => `
<div id="cookie-banner" class="fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-paper/95 backdrop-blur dark:border-stone-700 dark:bg-espresso/95">
  <div class="container-tp flex flex-col items-center gap-3 py-3 sm:flex-row">
    <p class="text-sm text-stone-600 dark:text-stone-300">We use a couple of cookies to remember your theme. That's the whole story.</p>
    <div class="flex shrink-0 items-center gap-2 sm:ml-auto">
      <button type="button" class="btn-ghost px-4 py-1.5 text-xs" data-cookie-dismiss>Decline</button>
      <button type="button" class="btn-primary px-4 py-1.5 text-xs" data-testid="cookie-accept" data-cookie-accept>Accept</button>
    </div>
  </div>
</div>`;

export const footer = () => `
<footer class="mt-20 border-t border-stone-200 bg-paper/60 dark:border-stone-700 dark:bg-espresso/40">
  <div class="container-tp grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-4">
    <div class="sm:col-span-2 lg:col-span-1">
      <div class="flex items-center gap-2 text-amber-700 dark:text-amber-500">${logoMark}
        <span class="font-serif text-lg font-bold text-stone-900 dark:text-stone-50">${site.name}</span></div>
      <p class="mt-3 max-w-xs text-sm leading-relaxed text-stone-500 dark:text-stone-400">${site.tagline}</p>
      <p class="mt-3 text-xs text-stone-400 dark:text-stone-500"><span data-volatile>1,200+</span> cups logged this month.</p>
    </div>
    <div>
      <h3 class="text-xs font-semibold uppercase tracking-wide text-stone-400">Sections</h3>
      <ul class="mt-3 space-y-2 text-sm">${categories
        .filter((c) => c !== "All")
        .map((c) => `<li><a href="/articles" class="text-stone-600 hover:text-amber-700 dark:text-stone-300 dark:hover:text-amber-400">${c}</a></li>`)
        .join("")}</ul>
    </div>
    <div>
      <h3 class="text-xs font-semibold uppercase tracking-wide text-stone-400">Company</h3>
      <ul class="mt-3 space-y-2 text-sm">
        <li><a href="/about" class="text-stone-600 hover:text-amber-700 dark:text-stone-300 dark:hover:text-amber-400">About</a></li>
        <li><a href="/contact" class="text-stone-600 hover:text-amber-700 dark:text-stone-300 dark:hover:text-amber-400">Contact</a></li>
        <li><a href="/login" class="text-stone-600 hover:text-amber-700 dark:text-stone-300 dark:hover:text-amber-400">Sign in</a></li>
      </ul>
    </div>
    <div>
      <h3 class="text-xs font-semibold uppercase tracking-wide text-stone-400">The Weekly Pour</h3>
      <form class="mt-3 flex gap-2" data-testid="footer-newsletter">
        <label class="flex-1"><span class="sr-only">Email</span>
          <input type="email" placeholder="you@example.com" class="field text-sm" /></label>
        <button type="submit" class="btn-primary px-4">${icons.mail}</button>
      </form>
      <div class="mt-4 flex items-center gap-3 text-stone-400">
        <a href="/contact" class="hover:text-amber-700 dark:hover:text-amber-400" aria-label="Bluesky">${icons.bluesky}</a>
        <a href="/contact" class="hover:text-amber-700 dark:hover:text-amber-400" aria-label="Instagram">${icons.instagram}</a>
        <a href="/contact" class="hover:text-amber-700 dark:hover:text-amber-400" aria-label="GitHub">${icons.github}</a>
        <a href="/contact" class="hover:text-amber-700 dark:hover:text-amber-400" aria-label="RSS">${icons.rss}</a>
      </div>
    </div>
  </div>
  <div class="border-t border-stone-200 py-5 dark:border-stone-700">
    <p class="container-tp text-xs text-stone-400 dark:text-stone-500">© 2025 ${site.name}. A demo fixture — every cup is fictional.</p>
  </div>
</footer>`;

// --- small building blocks reused by pages ---

export const badge = (label) => `<span class="badge">${label}</span>`;

export const articleCard = (a) => `
<a href="${articleUrl(a)}" data-category="${a.category}"
  class="card group flex flex-col gap-3 transition hover:-translate-y-0.5 hover:shadow-md">
  <div class="flex items-center gap-2 text-xs">
    ${badge(a.category)}
    <span class="text-stone-300 dark:text-stone-600">·</span>
    <span class="inline-flex items-center gap-1 text-stone-500 dark:text-stone-400">${icons.clock} ${a.readingTime}</span>
  </div>
  <h3 class="font-serif text-xl font-bold leading-snug text-stone-900 group-hover:text-amber-700 dark:text-stone-50 dark:group-hover:text-amber-400">${a.title}</h3>
  <p class="text-sm leading-relaxed text-stone-600 dark:text-stone-300">${a.dek}</p>
  <span class="mt-auto inline-flex items-center gap-1 pt-2 text-sm font-medium text-amber-700 dark:text-amber-500">Read ${icons.arrow}</span>
</a>`;
