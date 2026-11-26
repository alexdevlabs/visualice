import type { BrowserContext, Cookie, Page } from "playwright";
import { appName, type Config } from "../../shared/config";
import { setAppRoot } from "../../shared/url";
import type { Device } from "../../shared/types";
import { electronDriver } from "./electron";
import { androidDriver } from "./android";

// An app target stands in for a browser. Discovery, capture and probe ask for a
// context per device and a page per state, and reset a page by navigating it; an
// app has one window (or one device) and is reset by starting it again. So here a
// context is a device size and a page is a freshly started copy of the app, and the
// code that crawls websites crawls apps without knowing the difference.

/** One running copy of the app and the page that shows it. */
export interface AppInstance {
  page: Page;
  context: BrowserContext;
  /** The whole screen, for a shot that should show more than the page (Android `frame: "screen"`). */
  screen?: () => Promise<Buffer>;
  close(): Promise<void>;
}

/** Starts copies of one app. */
export interface AppDriver {
  kind: "electron" | "android";
  /** Start a fresh copy sized for `device`. Any copy before it is closed already. */
  launch(device: Device): Promise<AppInstance>;
  /** Put back what the crawl changed on the machine or device. */
  dispose(): Promise<void>;
}

const sameSize = (a: Device, b: Device) =>
  a.width === b.width && a.height === b.height && a.dpr === b.dpr;

/** Shots of the whole screen, by the page they replace. */
const screens = new WeakMap<Page, () => Promise<Buffer>>();

/** How to photograph the whole screen around `page`, when the app is set to. */
export function screenOf(page: Page): (() => Promise<Buffer>) | undefined {
  return screens.get(page);
}

/**
 * The app being crawled. Only one copy runs at a time: starting a page for any
 * context closes the copy before it.
 */
export class AppHost {
  readonly kind: AppDriver["kind"];
  readonly name: string;
  private current?: { instance: AppInstance; device: Device; owner?: AppContext };
  private start?: string;

  constructor(
    private readonly driver: AppDriver,
    private readonly config: Config,
  ) {
    this.kind = driver.kind;
    this.name = appName(config.app!);
  }

  /**
   * The page the app opens on: the base every route is relative to. Found by
   * starting the app, and that copy is the first page handed out after it.
   */
  async startUrl(): Promise<string> {
    if (this.start === undefined) {
      const device = this.config.devices[0];
      await this.stop();
      this.current = { instance: await this.driver.launch(device), device };
      this.start = this.current.instance.page.url();
      setAppRoot(this.start);
    }
    return this.start;
  }

  /** A context for `device` (the first configured one by default). */
  newContext(device?: Device): BrowserContext {
    return new AppContext(this, device ?? this.config.devices[0]) as unknown as BrowserContext;
  }

  /** A fresh copy of the app for `ctx`, with its init scripts and timeout applied. */
  async pageFor(ctx: AppContext): Promise<Page> {
    const idle = this.current && !this.current.owner && sameSize(this.current.device, ctx.device);
    if (!idle) {
      await this.stop();
      this.current = { instance: await this.driver.launch(ctx.device), device: ctx.device };
    }
    const current = this.current!;
    current.owner = ctx;
    const { page, context, screen } = current.instance;
    if (ctx.timeout !== undefined) context.setDefaultTimeout(ctx.timeout);
    for (const script of ctx.inits) await context.addInitScript(script);
    // The first document loaded before the scripts were added: load it again so
    // frozen time and seeded randomness apply to it too.
    if (ctx.inits.length) {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    if (screen) screens.set(page, screen);
    return page;
  }

  cookies(): Promise<Cookie[]> {
    return this.current?.instance.context.cookies() ?? Promise.resolve([]);
  }

  /** Close the running copy if `ctx` is the one using it. */
  async release(ctx: AppContext): Promise<void> {
    if (this.current?.owner === ctx) await this.stop();
  }

  async stop(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    await current?.instance.close().catch(() => {});
  }

  async close(): Promise<void> {
    await this.stop();
    await this.driver.dispose().catch(() => {});
  }
}

/**
 * The part of a BrowserContext the crawler uses, for an app. What is set on it
 * before a page exists (a timeout, init scripts) is kept and applied to each copy
 * of the app it starts.
 */
export class AppContext {
  timeout?: number;
  readonly inits: { content: string }[] = [];

  constructor(
    private readonly host: AppHost,
    readonly device: Device,
  ) {}

  setDefaultTimeout(ms: number): void {
    this.timeout = ms;
  }

  async addInitScript(script: { content?: string; path?: string } | string): Promise<void> {
    if (typeof script === "string") this.inits.push({ content: script });
    else if (script.content !== undefined) this.inits.push({ content: script.content });
    else throw new Error("app targets take init scripts as content, not a path");
  }

  newPage(): Promise<Page> {
    return this.host.pageFor(this);
  }

  cookies(): Promise<Cookie[]> {
    return this.host.cookies();
  }

  async storageState(): Promise<never> {
    throw new Error(
      "an app keeps its session in its own profile — sign in there (app.electron.profile, or app.android.clearData: false)",
    );
  }

  close(): Promise<void> {
    return this.host.release(this);
  }
}

const hosts = new Map<string, AppHost>();

/**
 * The app `config` crawls, started on first use and kept for the rest of the
 * process; undefined for a website. One per app, so discovery and capture in one
 * command share it.
 */
export function appHost(
  config: Config,
  log: (msg: string) => void = () => {},
): AppHost | undefined {
  if (!config.app) return undefined;
  const key = JSON.stringify(config.app);
  let host = hosts.get(key);
  if (!host) {
    const driver = config.app.electron
      ? electronDriver(config.app.electron, log)
      : androidDriver(config.app.android!, log);
    host = new AppHost(driver, config);
    hosts.set(key, host);
  }
  return host;
}

/** Close every app started in this process and put back what was changed. */
export async function closeAppHosts(): Promise<void> {
  const all = [...hosts.values()];
  hosts.clear();
  await Promise.all(all.map((h) => h.close()));
}
