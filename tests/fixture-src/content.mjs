// All site copy + article data for the Third Pour fixture. Pages are generated from
// this — change content here, then `npm run fixture:build`.

export const site = {
  name: "Third Pour",
  tagline: "Field notes for people who take coffee a little too seriously.",
  description:
    "Third Pour is a small, opinionated coffee journal about brewing, beans, and the gear that earns its counter space.",
};

export const nav = [
  { label: "Home", href: "/" },
  { label: "Articles", href: "/articles" },
  { label: "About", href: "/about" },
  { label: "Contact", href: "/contact" },
];

export const categories = ["All", "Brewing", "Beans", "Gear"];

export const author = {
  name: "Mara Okafor",
  role: "Founder & head taster",
  bio: "Former line cook turned full-time coffee nerd. Mara has pulled more shots than she'd care to admit and still gets excited about a clean, sweet pour-over.",
};

// `body` is prose HTML (rendered inside a Tailwind `prose` container).
export const articles = [
  {
    slug: "the-pour-over-ratio",
    title: "The Pour-Over Ratio, Settled",
    dek: "One number does most of the work. Here's how to pick it and stop second-guessing every cup.",
    category: "Brewing",
    date: "Dec 18, 2024",
    readingTime: "6 min",
    art: "figureV60",
    featured: true,
    body: `
      <p>If you only remember one thing about pour-over, make it the ratio. Everything
      else — grind, pour pattern, water temperature — is a refinement on top of getting
      the coffee-to-water proportion right.</p>
      <p>The ratio is just grams of coffee to grams of water. A <strong>1:16</strong>
      ratio means 1 gram of coffee for every 16 grams of water. For a single mug, that's
      roughly 22 g of coffee to 350 g of water.</p>
      <figure>
        <div class="not-prose my-2 text-amber-700 dark:text-amber-500">__FIGURE_V60__</div>
        <figcaption>The bed should stay flat. A crater or a deep cone usually means your pour is too aggressive.</figcaption>
      </figure>
      <h2>Where to start</h2>
      <p>1:16 is the sweet spot for most light-to-medium roasts. Go tighter (1:15) if a
      coffee tastes thin or sour; open it up (1:17) if it's heavy or bitter.</p>
      <ol>
        <li>Weigh your coffee. Grind it medium, like coarse sea salt.</li>
        <li>Multiply by your ratio to get your water target.</li>
        <li>Bloom with twice the coffee's weight in water for 30–45 seconds.</li>
        <li>Pour the rest in slow, steady spirals. Aim to finish around 3 minutes.</li>
      </ol>
      <blockquote>Dial the ratio first, the grind second. Changing both at once just hides which one mattered.</blockquote>
      <h2>A quick grind reference</h2>
      <table>
        <thead><tr><th>Method</th><th>Grind</th><th>Ratio</th></tr></thead>
        <tbody>
          <tr><td>Pour-over</td><td>Medium</td><td>1:16</td></tr>
          <tr><td>French press</td><td>Coarse</td><td>1:14</td></tr>
          <tr><td>Espresso</td><td>Fine</td><td>1:2</td></tr>
        </tbody>
      </table>
      <p>Write down what you do. Two weeks of notes will teach you more than any chart,
      this one included.</p>`,
  },
  {
    slug: "single-origin-vs-blend",
    title: "Single Origin vs. Blend",
    dek: "Two honest philosophies of coffee — and why your morning cup probably wants the boring one.",
    category: "Beans",
    date: "Dec 9, 2024",
    readingTime: "5 min",
    art: "beansArt",
    body: `
      <p>A single origin is coffee from one place — one farm, one region, one harvest. A
      blend is a deliberate mix built to taste a certain way every time. Neither is better;
      they're answering different questions.</p>
      <h2>Single origin: the snapshot</h2>
      <p>Single origins are about <em>specificity</em>. A washed Ethiopian tastes of citrus
      and tea; a Colombian might lean toward caramel and red fruit. You're tasting a place
      and a season, which also means it will change — and eventually disappear.</p>
      <h2>Blends: the recipe</h2>
      <p>Blends trade surprise for reliability. A good roaster blends to fill in gaps —
      body from one coffee, sweetness from another, acidity from a third — and to keep the
      profile steady all year.</p>
      <ul>
        <li><strong>Want consistency?</strong> Reach for a blend, especially for espresso.</li>
        <li><strong>Want to explore?</strong> Buy single origins and take notes.</li>
        <li><strong>Want both?</strong> Most people end up with a house blend for daily and an origin for the weekend.</li>
      </ul>
      <blockquote>The best bag of coffee is the one you'll actually finish while it's fresh.</blockquote>
      <p>Freshness beats pedigree. A two-week-old single origin will lose to a blend you opened yesterday.</p>`,
  },
  {
    slug: "dialing-in-espresso",
    title: "Dialing In Espresso Without Losing Your Mind",
    dek: "A repeatable routine for finding a shot you like — and getting back to it tomorrow.",
    category: "Brewing",
    date: "Nov 27, 2024",
    readingTime: "7 min",
    art: "brewRatio",
    body: `
      <p>Espresso feels finicky because three variables move at once: dose, grind, and time.
      The trick is to change exactly one thing at a time and write down what happened.</p>
      <h2>Lock the dose</h2>
      <p>Pick a dose and leave it. For a double, 18 g in is a fine starting point. Now your
      only job is to control how fast water moves through it.</p>
      <h2>Chase the time, move the grind</h2>
      <ol>
        <li>Target roughly 36 g out in 25–30 seconds (a 1:2 ratio).</li>
        <li>Too fast and sour? Grind finer.</li>
        <li>Too slow and bitter? Grind coarser.</li>
        <li>Re-pull. One change, one shot, every time.</li>
      </ol>
      <blockquote>If you change the dose, the grind, and the basket all at once, you don't have a recipe — you have a coincidence.</blockquote>
      <p>Once you find a shot you love, write the numbers on a sticky note and tape it to the
      machine. Tomorrow-you will be grateful.</p>`,
  },
  {
    slug: "storing-beans-for-freshness",
    title: "Storing Beans for Freshness",
    dek: "The fridge is a trap. Here's what actually keeps roasted coffee tasting alive.",
    category: "Beans",
    date: "Nov 14, 2024",
    readingTime: "4 min",
    art: "beansArt",
    body: `
      <p>Roasted coffee has four enemies: air, moisture, heat, and light. Beat those and a
      bag stays good for weeks.</p>
      <ul>
        <li><strong>Air:</strong> use an airtight container, ideally one with a one-way valve.</li>
        <li><strong>Light & heat:</strong> a cupboard, not the counter next to the kettle.</li>
        <li><strong>Moisture:</strong> keep beans out of the fridge — condensation ruins them.</li>
      </ul>
      <h2>What about the freezer?</h2>
      <p>The freezer actually works, with one rule: portion beans into sealed bags and only
      take out what you'll brew that week. Never refreeze a thawed bag.</p>
      <blockquote>Buy what you'll drink in three weeks. Storage buys you time; it doesn't buy you freshness.</blockquote>`,
  },
  {
    slug: "choosing-your-first-grinder",
    title: "Choosing Your First Grinder",
    dek: "If you upgrade one thing this year, make it the grinder. Here's how to spend wisely.",
    category: "Gear",
    date: "Oct 30, 2024",
    readingTime: "5 min",
    art: "brewRatio",
    body: `
      <p>A better grinder will do more for your coffee than a better brewer or a fancier bag
      of beans. Even grounds extract evenly; uneven grounds give you sour and bitter in the
      same cup.</p>
      <h2>Burrs, not blades</h2>
      <p>Blade grinders chop randomly. Burr grinders crush beans between two surfaces set a
      fixed distance apart, so the grounds come out a consistent size. Always buy burrs.</p>
      <h2>Hand or electric?</h2>
      <ul>
        <li><strong>Hand grinders</strong> give you excellent burrs for the money if you only
        brew a cup or two a day.</li>
        <li><strong>Electric</strong> is worth it once grinding by hand becomes the reason you
        skip coffee on a busy morning.</li>
      </ul>
      <blockquote>Spend on the grinder, save on the brewer. A $40 dripper with a great grinder beats the reverse every time.</blockquote>`,
  },
];

export const faqs = [
  {
    q: "What gear do you actually use?",
    a: "A hand grinder with conical burrs, a plastic cone dripper, a cheap gooseneck kettle, and a $15 scale. That's it — and it makes excellent coffee.",
  },
  {
    q: "Do I need a fancy machine for good coffee?",
    a: "No. Grind quality and freshness matter far more than the brewer. Most of our favorite cups come from a dripper that costs less than lunch.",
  },
  {
    q: "How often should you clean your gear?",
    a: "Rinse after every brew, deep clean weekly. Old coffee oils go rancid and that taste ends up in your cup.",
  },
];

export const findArticle = (slug) => articles.find((a) => a.slug === slug);
export const featured = articles.find((a) => a.featured) ?? articles[0];
export const articleUrl = (a) => `/articles/${a.slug}`;
