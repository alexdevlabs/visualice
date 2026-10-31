# Security

## Reporting a vulnerability

Please report security issues privately, through GitHub's
[private vulnerability reporting](https://github.com/alexdevlabs/visualice/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it, and the version
(`visualice --version`). You'll get a reply within a week.

Fixes land in the latest release only; there are no backports while visualice is 0.x.

## What visualice touches

Worth knowing when you assess a report, or decide where to run it:

- **Login sessions.** `visualice auth` and `crawl` save the browser's storage state
  (cookies, localStorage) to `auth.storageStatePath`, in plain text. Keep that file
  under the gitignored `.visualice/`, and treat it like a password.
- **Secrets in recipes.** `${VAR}` placeholders in the login recipe and `http` settings
  are read from the environment (or a `.env` in the working directory) when they're
  used. The config snapshot written into each run's `crawl-map.json` keeps the
  placeholders and replaces anything else in a credential field with `[redacted]`.
  Never write a real credential into a config or a state recipe: state recipes are
  stored as written.
- **The viewer server.** `visualice serve` listens on every interface, so a phone on the
  same network can browse the runs; anyone who can reach the port can read them. Its one
  write action, deleting a site's runs, is accepted only from this machine (a loopback
  address and host, and a same-origin page), and is confined to direct children of
  `<dir>/sites/`. Don't serve runs of a private site on an untrusted network.
- **Crawling.** A crawl clicks through the target site in a real browser. Discovery
  avoids triggers that look destructive (`discovery.interactions.denyLabels`) and never
  submits non-idempotent forms, but only crawl sites you own or are allowed to test.
