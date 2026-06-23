// The page shell: <head>, the no-flash theme script, shared chrome (header/footer/
// modals/drawer/cookie banner), and one shared behavior script. Page builders supply
// only their `main` HTML plus title/description/path.

import { site } from "./content.mjs";
import {
  header,
  footer,
  drawer,
  searchModal,
  newsletterModal,
  cookieBanner,
} from "./partials.mjs";

// Runs before paint so the page never flashes the wrong theme. Theme is intentionally
// NOT persisted to localStorage: the crawler captures states in a shared browser context,
// and a persisted theme would leak across captures (and make the toggle flip the wrong way).
// Honoring only prefers-color-scheme keeps every fresh navigation deterministic (light by
// default under the crawler), so the "dark" recipe is always a clean light→dark toggle.
const noFlashTheme = `
(function () {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
})();`;

// All interactive behavior for the site. Guards every lookup so each page only wires
// up what it actually contains.
const behavior = `
(function () {
  var root = document.documentElement;
  function setTheme(dark) {
    // In-memory only (see noFlashTheme above) — deliberately not persisted.
    root.classList.toggle('dark', dark);
  }
  document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
    b.addEventListener('click', function () { setTheme(!root.classList.contains('dark')); });
  });

  var drawer = document.getElementById('mobile-drawer');
  var backdrop = document.getElementById('drawer-backdrop');
  var menuBtn = document.querySelector('[data-testid=menu-button]');
  function setDrawer(open) {
    if (!drawer) return;
    drawer.toggleAttribute('hidden', !open);
    if (backdrop) backdrop.toggleAttribute('hidden', !open);
    if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open));
  }
  if (menuBtn) menuBtn.addEventListener('click', function () { setDrawer(drawer && drawer.hasAttribute('hidden')); });
  document.querySelectorAll('[data-drawer-close]').forEach(function (b) { b.addEventListener('click', function () { setDrawer(false); }); });
  if (backdrop) backdrop.addEventListener('click', function () { setDrawer(false); });

  function openDialog(id) { var d = document.getElementById(id); if (d && d.showModal && !d.open) d.showModal(); }
  var searchBtn = document.querySelector('[data-testid=search-button]');
  if (searchBtn) searchBtn.addEventListener('click', function () { openDialog('search-modal'); });
  document.querySelectorAll('[data-subscribe]').forEach(function (b) { b.addEventListener('click', function () { openDialog('newsletter-modal'); }); });
  document.querySelectorAll('[data-modal-close]').forEach(function (b) {
    b.addEventListener('click', function () { var d = b.closest('dialog'); if (d) d.close(); });
  });

  var nf = document.getElementById('newsletter-form');
  if (nf) nf.addEventListener('submit', function (e) {
    e.preventDefault();
    nf.setAttribute('hidden', '');
    var t = document.getElementById('newsletter-thanks');
    if (t) t.removeAttribute('hidden');
  });

  var banner = document.getElementById('cookie-banner');
  try { if (banner && localStorage.getItem('tp_cookies')) banner.remove(); } catch (e) {}
  function dismissCookies(accept) {
    if (!banner) return;
    try { localStorage.setItem('tp_cookies', accept ? 'accepted' : 'declined'); } catch (e) {}
    banner.remove();
  }
  document.querySelectorAll('[data-cookie-accept]').forEach(function (b) { b.addEventListener('click', function () { dismissCookies(true); }); });
  document.querySelectorAll('[data-cookie-dismiss]').forEach(function (b) { b.addEventListener('click', function () { dismissCookies(false); }); });

  document.querySelectorAll('[data-filter]').forEach(function (pill) {
    pill.addEventListener('click', function () {
      var cat = pill.getAttribute('data-filter');
      document.querySelectorAll('[data-filter]').forEach(function (p) {
        var on = p === pill;
        p.setAttribute('aria-pressed', String(on));
        p.classList.toggle('filter-active', on);
      });
      document.querySelectorAll('[data-category]').forEach(function (card) {
        card.toggleAttribute('hidden', !(cat === 'All' || card.getAttribute('data-category') === cat));
      });
    });
  });

  var shareBtn = document.querySelector('[data-testid=share-button]');
  var sharePop = document.getElementById('share-popover');
  if (shareBtn && sharePop) {
    shareBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = sharePop.hasAttribute('hidden');
      sharePop.toggleAttribute('hidden', !open);
      shareBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', function (e) {
      if (sharePop.hasAttribute('hidden')) return;
      if (!sharePop.contains(e.target) && !shareBtn.contains(e.target)) {
        sharePop.setAttribute('hidden', '');
        shareBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  document.querySelectorAll('[data-accordion] [data-accordion-trigger]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = document.getElementById(btn.getAttribute('aria-controls'));
      var open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      if (panel) panel.toggleAttribute('hidden', !open);
    });
  });

  var cf = document.getElementById('contact-form');
  if (cf) cf.addEventListener('submit', function (e) {
    e.preventDefault();
    var ok = true;
    cf.querySelectorAll('[required]').forEach(function (field) {
      var bad = !String(field.value || '').trim();
      var err = field.closest('label') ? field.closest('label').querySelector('.field-error') : null;
      if (err) err.toggleAttribute('hidden', !bad);
      field.setAttribute('aria-invalid', String(bad));
      if (bad) ok = false;
    });
    if (ok) {
      cf.setAttribute('hidden', '');
      var s = document.getElementById('contact-success');
      if (s) s.removeAttribute('hidden');
    }
  });

  var lf = document.getElementById('login-form');
  if (lf) lf.addEventListener('submit', function (e) {
    e.preventDefault();
    var emailEl = document.querySelector('[data-testid=email]');
    var passEl = document.querySelector('[data-testid=password]');
    var email = emailEl ? emailEl.value : '';
    var pass = passEl ? passEl.value : '';
    var err = document.getElementById('login-error');
    if (!email.trim() || !pass.trim()) { if (err) err.removeAttribute('hidden'); return; }
    try { localStorage.setItem('tp_user', email); } catch (e2) {}
    document.cookie = 'tp_session=1; path=/; max-age=86400';
    location.href = '/dashboard';
  });

  var greet = document.getElementById('dash-greeting');
  if (greet) { try { var u = localStorage.getItem('tp_user'); if (u) greet.textContent = 'Welcome back, ' + u; } catch (e) {} }
  var signout = document.querySelector('[data-testid=signout]');
  if (signout) signout.addEventListener('click', function () {
    try { localStorage.removeItem('tp_user'); } catch (e) {}
    document.cookie = 'tp_session=; path=/; max-age=0';
    location.href = '/';
  });
})();`;

export function page({ title, description, path = "/", main }) {
  const desc = description ?? site.description;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · ${site.name}</title>
    <meta name="description" content="${desc}" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%E2%98%95%3C/text%3E%3C/svg%3E" />
    <link rel="stylesheet" href="/assets/tailwind.css" />
    <script>${noFlashTheme}</script>
  </head>
  <body class="flex min-h-screen flex-col">
    ${header(path)}
    <main class="flex-1">${main}</main>
    ${footer()}
    ${drawer(path)}
    ${searchModal()}
    ${newsletterModal()}
    ${cookieBanner()}
    <script>${behavior}</script>
  </body>
</html>`;
}
