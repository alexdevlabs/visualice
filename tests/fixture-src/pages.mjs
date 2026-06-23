// Page builders. Each returns { path, file, title, description, main }; build.mjs wraps
// `main` in the shared layout and writes `file`.

import {
  site,
  articles,
  categories,
  author,
  faqs,
  featured,
  articleUrl,
  findArticle,
} from "./content.mjs";
import { articleCard, badge } from "./partials.mjs";
import { icons, heroPourOver, brewRatio, beansArt, portrait, figureV60 } from "./svg.mjs";

const sectionHeading = (kicker, title, lead) => `
<div class="max-w-2xl">
  <p class="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-500">${kicker}</p>
  <h2 class="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">${title}</h2>
  ${lead ? `<p class="mt-3 text-lg leading-relaxed text-stone-600 dark:text-stone-300">${lead}</p>` : ""}
</div>`;

export function home() {
  const main = `
<section class="container-tp grid items-center gap-10 py-14 sm:py-20 lg:grid-cols-2">
  <div>
    <p class="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-paper px-3 py-1 text-xs font-medium text-stone-500 dark:border-stone-700 dark:bg-espresso dark:text-stone-400">
      <span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span> New this week · ${featured.category}
    </p>
    <h1 class="mt-5 text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">Better coffee, one honest cup at a time.</h1>
    <p class="mt-5 max-w-md text-lg leading-relaxed text-stone-600 dark:text-stone-300">${site.tagline}</p>
    <div class="mt-7 flex flex-wrap items-center gap-3">
      <a href="/articles" class="btn-primary" data-testid="hero-cta">Start reading ${icons.arrow}</a>
      <button type="button" class="btn-ghost" data-subscribe>Subscribe</button>
    </div>
  </div>
  <div class="mx-auto aspect-square w-full max-w-sm text-amber-700 dark:text-amber-500">${heroPourOver}</div>
</section>

<section class="container-tp pb-6">
  <a href="${articleUrl(featured)}" class="card group grid gap-6 sm:grid-cols-[1.4fr_1fr] sm:items-center">
    <div>
      <div class="flex items-center gap-2 text-xs">${badge("Featured")} ${badge(featured.category)}
        <span class="inline-flex items-center gap-1 text-stone-500 dark:text-stone-400">${icons.clock} ${featured.readingTime}</span></div>
      <h2 class="mt-3 text-2xl font-bold leading-snug group-hover:text-amber-700 dark:group-hover:text-amber-400 sm:text-3xl">${featured.title}</h2>
      <p class="mt-2 text-stone-600 dark:text-stone-300">${featured.dek}</p>
      <span class="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-amber-700 dark:text-amber-500">Read the guide ${icons.arrow}</span>
    </div>
    <div class="mx-auto h-36 w-36 text-amber-700 dark:text-amber-500 sm:h-44 sm:w-44">${figureV60}</div>
  </a>
</section>

<section class="container-tp py-12">
  ${sectionHeading("The latest", "Fresh from the kitchen counter", "Brewing notes, bean reviews, and gear we actually keep.")}
  <div class="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
    ${articles.map(articleCard).join("\n")}
  </div>
</section>

<section class="container-tp py-12">
  <div class="card grid items-center gap-6 sm:grid-cols-[1fr_auto]">
    <div>
      ${sectionHeading("Brew math", "The only number you need", "Pick a ratio, weigh your coffee, and let the rest follow. Most cups start at 1:16.")}
      <a href="/articles/the-pour-over-ratio" class="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-amber-700 dark:text-amber-500">How the ratio works ${icons.arrow}</a>
    </div>
    <div class="mx-auto h-32 w-32 text-amber-700 dark:text-amber-500">${brewRatio}</div>
  </div>
</section>

<section class="container-tp py-12">
  <div class="overflow-hidden rounded-3xl border border-amber-200 bg-gradient-to-br from-amber-50 to-paper p-8 dark:border-amber-500/20 dark:from-espresso dark:to-grounds sm:p-12">
    <div class="grid items-center gap-6 sm:grid-cols-[1fr_auto]">
      <div>
        <h2 class="text-2xl font-bold sm:text-3xl">The Weekly Pour</h2>
        <p class="mt-2 max-w-md text-stone-600 dark:text-stone-300">One short email each Friday: a brew tip and a bean worth trying. No spam, ever.</p>
      </div>
      <button type="button" class="btn-primary shrink-0" data-subscribe data-testid="subscribe-button">Join the list</button>
    </div>
  </div>
</section>`;
  return { path: "/", file: "index.html", title: "Home", description: site.description, main };
}

export function articlesIndex() {
  const pills = categories
    .map((c, i) => {
      const active = i === 0;
      return `<button type="button" class="pill ${active ? "filter-active" : ""}" data-filter="${c}"
        data-testid="filter-${c.toLowerCase()}" aria-pressed="${active}">${c}</button>`;
    })
    .join("");
  const main = `
<section class="container-tp py-14">
  ${sectionHeading("Archive", "Every article", "Filter by what you're into. We keep it short and useful.")}
  <div class="mt-8 flex flex-wrap gap-2" role="group" aria-label="Filter by category">${pills}</div>
  <div class="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
    ${articles.map(articleCard).join("\n")}
  </div>
</section>`;
  return {
    path: "/articles",
    file: "articles.html",
    title: "Articles",
    description: "Every Third Pour article — brewing, beans, and gear.",
    main,
  };
}

export function article(slug) {
  const a = findArticle(slug);
  const related = articles.filter((x) => x.slug !== slug).slice(0, 3);
  const body = a.body.replace("__FIGURE_V60__", figureV60);
  const main = `
<article class="container-tp py-12 lg:py-16">
  <a href="/articles" class="inline-flex items-center gap-1 text-sm font-medium text-stone-500 hover:text-amber-700 dark:text-stone-400 dark:hover:text-amber-400"><span class="inline-flex rotate-180">${icons.arrow}</span> All articles</a>
  <header class="mt-6 max-w-prose">
    <div class="flex flex-wrap items-center gap-2 text-xs">${badge(a.category)}
      <span class="inline-flex items-center gap-1 text-stone-500 dark:text-stone-400">${icons.calendar} ${a.date}</span>
      <span class="inline-flex items-center gap-1 text-stone-500 dark:text-stone-400">${icons.clock} ${a.readingTime}</span></div>
    <h1 class="mt-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">${a.title}</h1>
    <p class="mt-4 text-xl leading-relaxed text-stone-600 dark:text-stone-300">${a.dek}</p>
    <div class="mt-6 flex items-center justify-between border-y border-stone-200 py-4 dark:border-stone-700">
      <div class="flex items-center gap-3">
        <span class="h-10 w-10 shrink-0 text-amber-700 dark:text-amber-500">${portrait}</span>
        <div class="text-sm"><p class="font-semibold text-stone-900 dark:text-stone-100">${author.name}</p>
          <p class="text-stone-500 dark:text-stone-400">${author.role}</p></div>
      </div>
      <div class="relative">
        <button type="button" class="btn-ghost px-4 py-2" data-testid="share-button" aria-haspopup="true" aria-expanded="false">${icons.share} Share</button>
        <div id="share-popover" hidden class="absolute right-0 z-10 mt-2 w-44 rounded-xl border border-stone-200 bg-paper p-2 shadow-xl dark:border-stone-700 dark:bg-espresso">
          <button type="button" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800" data-testid="copy-link">${icons.link} Copy link</button>
          <a href="/contact" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800">${icons.bluesky} Bluesky</a>
          <a href="/contact" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800">${icons.mail} Email</a>
        </div>
      </div>
    </div>
  </header>

  <div class="prose prose-stone mt-8 max-w-prose dark:prose-invert prose-headings:font-serif prose-a:text-amber-700 prose-blockquote:border-amber-500 prose-blockquote:not-italic dark:prose-a:text-amber-400">
    ${body}
  </div>
</article>

<section class="container-tp border-t border-stone-200 py-12 dark:border-stone-700">
  <h2 class="text-2xl font-bold">Keep reading</h2>
  <div class="mt-6 grid gap-6 sm:grid-cols-3">${related.map(articleCard).join("\n")}</div>
</section>`;
  return {
    path: articleUrl(a),
    file: `articles/${a.slug}.html`,
    title: a.title,
    description: a.dek,
    main,
  };
}

export function about() {
  const faqItems = faqs
    .map(
      (f, i) => `
    <div class="border-b border-stone-200 last:border-0 dark:border-stone-700">
      <button type="button" class="flex w-full items-center justify-between gap-4 py-4 text-left font-medium text-stone-900 dark:text-stone-100"
        data-accordion-trigger aria-expanded="false" aria-controls="faq-${i}" data-testid="accordion-trigger-${i}">
        <span>${f.q}</span><span class="text-stone-400">${icons.chevron}</span></button>
      <div id="faq-${i}" hidden class="pb-4 text-stone-600 dark:text-stone-300">${f.a}</div>
    </div>`,
    )
    .join("");
  const main = `
<section class="container-tp grid items-center gap-10 py-14 lg:grid-cols-[1.3fr_1fr]">
  <div>
    ${sectionHeading("About", "We're just really into coffee", "")}
    <div class="mt-5 space-y-4 text-lg leading-relaxed text-stone-600 dark:text-stone-300">
      <p>${site.name} started as a shared spreadsheet of brew notes between two friends who couldn't agree on a grind setting. It's now a small journal about making better coffee without the gatekeeping.</p>
      <p>We test gear on a normal kitchen counter, buy our own beans, and write down what actually worked. No sponsored verdicts, no $900 espresso machines you'll never own.</p>
    </div>
    <a href="/articles" class="btn-primary mt-7">Read the articles ${icons.arrow}</a>
  </div>
  <div class="mx-auto aspect-square w-full max-w-xs text-amber-700 dark:text-amber-500">${beansArt}</div>
</section>

<section class="container-tp py-8">
  <div class="grid gap-6 sm:grid-cols-3">
    <div class="card"><h3 class="font-serif text-lg font-bold">Honest tests</h3><p class="mt-2 text-sm text-stone-600 dark:text-stone-300">Everything is bought with our own money and used for weeks before we write a word.</p></div>
    <div class="card"><h3 class="font-serif text-lg font-bold">Plain language</h3><p class="mt-2 text-sm text-stone-600 dark:text-stone-300">No jargon for its own sake. If a tip needs a glossary, we rewrite the tip.</p></div>
    <div class="card"><h3 class="font-serif text-lg font-bold">Repeatable</h3><p class="mt-2 text-sm text-stone-600 dark:text-stone-300">Every recipe is something you can do again tomorrow and get the same cup.</p></div>
  </div>
</section>

<section class="container-tp grid gap-10 py-12 lg:grid-cols-[1fr_1.2fr]">
  <div class="card flex flex-col items-start">
    <span class="h-20 w-20 text-amber-700 dark:text-amber-500">${portrait}</span>
    <h3 class="mt-4 font-serif text-xl font-bold">${author.name}</h3>
    <p class="text-sm text-amber-700 dark:text-amber-500">${author.role}</p>
    <p class="mt-3 text-sm leading-relaxed text-stone-600 dark:text-stone-300">${author.bio}</p>
  </div>
  <div data-accordion>
    <h2 class="text-2xl font-bold">Frequently asked</h2>
    <div class="mt-4 rounded-2xl border border-stone-200 bg-paper px-6 dark:border-stone-700 dark:bg-espresso">${faqItems}</div>
  </div>
</section>`;
  return { path: "/about", file: "about.html", title: "About", description: `About ${site.name}.`, main };
}

export function contact() {
  // `required` defaults on; the subject <select> is optional so the success state is
  // reachable from a recipe (fill can't set a <select>).
  const field = (id, label, type = "text", required = true) => {
    const req = required ? "required" : "";
    const control =
      type === "textarea"
        ? `<textarea id="${id}" data-testid="${id}" rows="5" ${req} class="field"></textarea>`
        : type === "select"
          ? `<select id="${id}" data-testid="${id}" ${req} class="field"><option value="">Choose one…</option><option>Brewing help</option><option>Gear question</option><option>Just saying hi</option></select>`
          : `<input id="${id}" type="${type}" data-testid="${id}" ${req} class="field" />`;
    return `
    <label class="block">
      <span class="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-200">${label}</span>
      ${control}
      ${required ? '<span class="field-error mt-1 block text-sm text-red-600 dark:text-red-400" hidden>This field is required.</span>' : ""}
    </label>`;
  };
  const main = `
<section class="container-tp grid gap-10 py-14 lg:grid-cols-[1.2fr_1fr]">
  <div>
    ${sectionHeading("Contact", "Say hello", "Got a brewing question or a bean we should try? We read everything.")}
    <form id="contact-form" class="mt-8 space-y-5" novalidate>
      ${field("contact-name", "Name")}
      ${field("contact-email", "Email", "email")}
      ${field("contact-subject", "Subject", "select", false)}
      ${field("contact-message", "Message", "textarea")}
      <button type="submit" class="btn-primary w-full sm:w-auto" data-testid="contact-submit">Send message ${icons.arrow}</button>
    </form>
    <div id="contact-success" hidden class="mt-8 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-500/30 dark:bg-amber-500/10">
      <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-600 text-white">${icons.check}</span>
      <div><p class="font-semibold text-stone-900 dark:text-stone-100">Thanks — message sent!</p>
        <p class="text-sm text-stone-600 dark:text-stone-300">We'll get back to you within a cup or two. (This is a demo, so nothing was actually emailed.)</p></div>
    </div>
  </div>
  <aside class="space-y-4">
    <div class="card"><h3 class="font-serif text-lg font-bold">Email</h3><p class="mt-1 text-sm text-stone-600 dark:text-stone-300">hello@thirdpour.example</p></div>
    <div class="card"><h3 class="font-serif text-lg font-bold">Response time</h3><p class="mt-1 text-sm text-stone-600 dark:text-stone-300">Usually within two business days.</p></div>
    <div class="card"><h3 class="font-serif text-lg font-bold">Pitch a topic</h3><p class="mt-1 text-sm text-stone-600 dark:text-stone-300">Tell us what you wish someone would explain clearly.</p></div>
  </aside>
</section>`;
  return {
    path: "/contact",
    file: "contact.html",
    title: "Contact",
    description: `Get in touch with ${site.name}.`,
    main,
  };
}

export function login() {
  const main = `
<section class="container-tp flex items-center justify-center py-16 sm:py-24">
  <div class="card w-full max-w-sm">
    <h1 class="text-2xl font-bold">Sign in</h1>
    <p class="mt-1 text-sm text-stone-500 dark:text-stone-400">Welcome back to ${site.name}.</p>
    <div id="login-error" hidden class="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
      Enter both an email and a password to continue.
    </div>
    <form id="login-form" class="mt-5 space-y-4" novalidate>
      <label class="block"><span class="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-200">Email</span>
        <input type="email" data-testid="email" autocomplete="username" class="field" placeholder="you@example.com" /></label>
      <label class="block"><span class="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-200">Password</span>
        <input type="password" data-testid="password" autocomplete="current-password" class="field" placeholder="••••••••" /></label>
      <button type="submit" class="btn-primary w-full" data-testid="login-submit">Sign in</button>
    </form>
    <p class="mt-4 text-center text-xs text-stone-400 dark:text-stone-500">Demo only — any non-empty credentials work. No real account, no protection.</p>
  </div>
</section>`;
  return {
    path: "/login",
    file: "login.html",
    title: "Sign in",
    description: `Sign in to ${site.name}.`,
    main,
  };
}

export function dashboard() {
  const saved = articles.slice(0, 3);
  const main = `
<section class="container-tp py-14">
  <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-500">Your account</p>
      <h1 id="dash-greeting" class="mt-2 text-3xl font-bold sm:text-4xl">Welcome back</h1>
    </div>
    <button type="button" class="btn-ghost" data-testid="signout">Sign out</button>
  </div>

  <div class="mt-8 grid gap-6 sm:grid-cols-3">
    <div class="card text-center"><p class="text-3xl font-bold text-amber-700 dark:text-amber-500">14</p><p class="mt-1 text-sm text-stone-500 dark:text-stone-400">Articles read</p></div>
    <div class="card text-center"><p class="text-3xl font-bold text-amber-700 dark:text-amber-500">1:16</p><p class="mt-1 text-sm text-stone-500 dark:text-stone-400">Your go-to ratio</p></div>
    <div class="card text-center"><p class="text-3xl font-bold text-amber-700 dark:text-amber-500"><span data-volatile>3</span></p><p class="mt-1 text-sm text-stone-500 dark:text-stone-400">Day streak</p></div>
  </div>

  <div class="mt-10 grid gap-8 lg:grid-cols-[1.4fr_1fr]">
    <div>
      <h2 class="text-xl font-bold">Saved for later</h2>
      <div class="mt-4 space-y-3">
        ${saved
          .map(
            (a) => `<a href="${articleUrl(a)}" class="flex items-center justify-between gap-4 rounded-xl border border-stone-200 bg-paper p-4 transition hover:border-amber-400 dark:border-stone-700 dark:bg-espresso">
          <div><div class="flex items-center gap-2 text-xs">${badge(a.category)}<span class="text-stone-400">${a.readingTime}</span></div>
            <p class="mt-1 font-medium text-stone-900 dark:text-stone-100">${a.title}</p></div>
          <span class="text-amber-700 dark:text-amber-500">${icons.arrow}</span></a>`,
          )
          .join("\n")}
      </div>
    </div>
    <div>
      <h2 class="text-xl font-bold">Preferences</h2>
      <form class="card mt-4 space-y-4" data-testid="prefs-form">
        <label class="block"><span class="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-200">Display name</span>
          <input type="text" class="field" value="Coffee Friend" /></label>
        <label class="block"><span class="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-200">Default ratio</span>
          <select class="field"><option>1:15</option><option selected>1:16</option><option>1:17</option></select></label>
        <label class="flex items-center gap-2 text-sm text-stone-700 dark:text-stone-200">
          <input type="checkbox" class="rounded border-stone-300 text-amber-600 focus:ring-amber-500" checked /> Email me the Weekly Pour</label>
        <button type="submit" class="btn-primary w-full">Save preferences</button>
      </form>
    </div>
  </div>
</section>`;
  return {
    path: "/dashboard",
    file: "dashboard.html",
    title: "Dashboard",
    description: "Your Third Pour account.",
    main,
  };
}

export function allPages() {
  return [
    home(),
    articlesIndex(),
    ...articles.map((a) => article(a.slug)),
    about(),
    contact(),
    login(),
    dashboard(),
  ];
}
