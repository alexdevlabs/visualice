import { _electron, chromium } from "playwright";
import type { Browser, ElectronApplication, Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs, createReadStream } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../../shared/config";
import type { Device } from "../../shared/types";
import { resolveEnvRecord } from "../../shared/env";
import { pathExists } from "../../shared/fsx";
import type { AppDriver, AppInstance } from "./host";

type ElectronConfig = NonNullable<AppConfig["electron"]>;

/** What to run for an Electron app: the program, and the arguments it needs first. */
export interface ElectronProgram {
  executablePath: string;
  /** An Electron project's folder, which the `electron` binary takes as its app. */
  appArgs: string[];
}

/**
 * The program behind `app.electron.executable`. A macOS `.app` bundle runs the
 * program its Info.plist names; a folder with a package.json is an Electron project,
 * run by the `electron` installed in it; anything else is the program itself.
 */
export async function resolveElectron(executable: string): Promise<ElectronProgram> {
  const abs = path.resolve(executable);
  const stat = await fs.stat(abs).catch(() => undefined);
  if (!stat) throw new Error(`app.electron.executable: nothing at ${abs}`);
  if (stat.isDirectory() && /\.app$/i.test(abs)) {
    return { executablePath: await bundleProgram(abs), appArgs: [] };
  }
  if (stat.isDirectory()) {
    const pkg = path.join(abs, "package.json");
    if (!(await pathExists(pkg))) {
      throw new Error(
        `app.electron.executable: ${abs} is a folder, but neither an .app bundle nor an Electron project (no package.json)`,
      );
    }
    let bin: unknown;
    try {
      // The `electron` package's main export is the path to its binary.
      bin = createRequire(pkg)("electron");
    } catch {
      throw new Error(
        `app.electron.executable: ${abs} is an Electron project, but electron isn't installed in it — run 'npm i -D electron' there`,
      );
    }
    if (typeof bin !== "string") {
      throw new Error(
        `app.electron.executable: the electron package in ${abs} gave no binary path`,
      );
    }
    return { executablePath: bin, appArgs: [abs] };
  }
  return { executablePath: abs, appArgs: [] };
}

async function bundleProgram(bundle: string): Promise<string> {
  const dir = path.join(bundle, "Contents", "MacOS");
  const plist = await fs
    .readFile(path.join(bundle, "Contents", "Info.plist"), "utf8")
    .catch(() => "");
  const named = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (named && (await pathExists(path.join(dir, named)))) return path.join(dir, named);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  if (files.length === 1) return path.join(dir, files[0]);
  throw new Error(
    `app.electron.executable: can't tell which program in ${dir} is the app — set executable to it`,
  );
}

/** Electron's fuse wire starts after this marker in the binary that holds it. */
const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
/** Position of `EnableNodeCliInspectArguments` in the wire. */
const INSPECT_FUSE = 3;

/**
 * Can Playwright launch this app? Its Electron support starts the app with
 * `--inspect`, which an app can switch off at build time with a fuse (Slack and
 * Discord do). Read from the binary rather than found out by trying: a refused
 * launch only fails after its timeout, and Playwright reports it a second time as an
 * unhandled rejection, which ends the process.
 *
 * On macOS the wire is in the Electron Framework, elsewhere in the program itself.
 * No wire at all is an Electron from before fuses, which always allowed it.
 */
export async function inspectorAllowed(executablePath: string): Promise<boolean> {
  const framework = path.join(
    path.dirname(executablePath),
    "..",
    "Frameworks",
    "Electron Framework.framework",
    "Electron Framework",
  );
  const file = (await pathExists(framework)) ? framework : executablePath;
  const wire = await readFuseWire(file);
  // `1` is on, `0` off, `r` removed (on).
  return wire === undefined || wire[INSPECT_FUSE] !== "0".charCodeAt(0);
}

/** The fuse bytes after the sentinel (`[version, length, ...fuses]`), if there are any. */
export async function readFuseWire(file: string): Promise<Buffer | undefined> {
  const stream = createReadStream(file, { highWaterMark: 1 << 20 });
  let carry: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const buf: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const at = buf.indexOf(FUSE_SENTINEL);
      if (at >= 0 && buf.length >= at + FUSE_SENTINEL.length + 2) {
        const start = at + FUSE_SENTINEL.length;
        const length = buf[start + 1];
        if (buf.length >= start + 2 + length) return buf.subarray(start + 2, start + 2 + length);
        carry = buf.subarray(at);
        continue;
      }
      // Keep enough of the tail that a sentinel split across two chunks is still found.
      carry = buf.subarray(Math.max(0, buf.length - FUSE_SENTINEL.length - 64));
    }
  } finally {
    stream.destroy();
  }
  return undefined;
}

/**
 * Launch Electron apps for a crawl. Every launch gets its own empty profile (or a
 * copy of `profile`) in a short temporary folder: some apps put an IPC socket in
 * there, and a socket path has a length limit (103 bytes on macOS).
 */
export function electronDriver(cfg: ElectronConfig, log: (msg: string) => void): AppDriver {
  let program: ElectronProgram | undefined;
  let mode: "launch" | "cdp" | undefined = cfg.connect === "auto" ? undefined : cfg.connect;

  return {
    kind: "electron",
    async launch(device: Device): Promise<AppInstance> {
      program ??= await resolveElectron(cfg.executable);
      if (!mode) {
        mode = (await inspectorAllowed(program.executablePath)) ? "launch" : "cdp";
        if (mode === "cdp") {
          log("  this app has its Node inspector switched off — connecting over CDP instead");
        }
      }
      const profile = await fs.mkdtemp(path.join(os.tmpdir(), "vz-"));
      const cleanup = () => fs.rm(profile, { recursive: true, force: true }).catch(() => {});
      try {
        if (cfg.profile) await fs.cp(path.resolve(cfg.profile), profile, { recursive: true });
        const args = [
          ...program.appArgs,
          `--user-data-dir=${profile}`,
          // The device's pixel ratio, whatever screen the crawl runs on.
          `--force-device-scale-factor=${device.dpr}`,
          ...cfg.args,
        ];
        const env = {
          ...(process.env as Record<string, string>),
          ...resolveEnvRecord(cfg.env, "app.electron.env"),
        };
        const opened =
          mode === "launch"
            ? await viaLaunch(program.executablePath, args, env, cfg.startTimeoutMs)
            : await viaCdp(program.executablePath, args, env, cfg.startTimeoutMs);
        await sizeWindow(opened, device, log);
        return {
          page: opened.page,
          context: opened.page.context(),
          close: async () => {
            await opened.close();
            await cleanup();
          },
        };
      } catch (e) {
        await cleanup();
        throw e;
      }
    },
    async dispose() {},
  };
}

interface Opened {
  page: Page;
  /** Launched: the app's main process, which can resize its windows. */
  app?: ElectronApplication;
  close(): Promise<void>;
}

/** The app's first window that is the app, not a devtools window. */
async function firstAppWindow(
  pages: () => Page[],
  next: (timeout: number) => Promise<Page>,
  timeoutMs: number,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = pages().find((p) => !p.url().startsWith("devtools://"));
    if (page) {
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
      return page;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`the app opened no window within ${timeoutMs}ms`);
    await next(left).catch(() => {});
  }
}

async function viaLaunch(
  executablePath: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<Opened> {
  const app = await _electron.launch({ executablePath, args, env, timeout: timeoutMs });
  try {
    const page = await firstAppWindow(
      () => app.windows(),
      (timeout) => app.waitForEvent("window", { timeout }),
      timeoutMs,
    );
    return { page, app, close: () => app.close().catch(() => {}) };
  } catch (e) {
    await app.close().catch(() => {});
    throw e;
  }
}

/** A port nothing is listening on, for the app's remote debugging. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Children started for CDP, stopped if visualice exits without closing them. */
const children = new Set<ChildProcess>();
let exitHook = false;

async function viaCdp(
  executablePath: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<Opened> {
  const port = await freePort();
  const child = spawn(executablePath, [...args, `--remote-debugging-port=${port}`], {
    env,
    stdio: "ignore",
  });
  children.add(child);
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => {
      for (const c of children) c.kill();
    });
  }
  const stop = async () => {
    children.delete(child);
    if (child.exitCode === null) child.kill();
  };
  let browser: Browser | undefined;
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`the app exited (code ${child.exitCode}) before it could be connected to`);
      }
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2_000 });
        break;
      } catch (e) {
        if (Date.now() > deadline) {
          throw new Error(
            `couldn't connect to the app over CDP within ${timeoutMs}ms — it may strip --remote-debugging-port too: ${(e as Error).message.split("\n")[0]}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error("the app has no browser context to connect to");
    const page = await firstAppWindow(
      () => context.pages(),
      (timeout) => context.waitForEvent("page", { timeout }),
      Math.max(1_000, deadline - Date.now()),
    );
    const connected = browser;
    return {
      page,
      close: async () => {
        await connected.close().catch(() => {});
        await stop();
      },
    };
  } catch (e) {
    await browser?.close().catch(() => {});
    await stop();
    throw e;
  }
}

/**
 * Make the window's page the device's size. Launched apps are resized from the main
 * process, connected ones through the window's CDP bounds (which are its outside
 * size, so the frame is measured and added). An app with a minimum window size
 * may not go as small as asked; the shot is then the size it went to.
 */
async function sizeWindow(opened: Opened, device: Device, log: (msg: string) => void) {
  const { page } = opened;
  const want = { width: device.width, height: device.height };
  try {
    if (opened.app) {
      const win = await opened.app.browserWindow(page);
      await win.evaluate((w, size) => {
        if (w.isMaximized()) w.unmaximize();
        if (w.isFullScreen()) w.setFullScreen(false);
        w.setContentSize(size.width, size.height);
      }, want);
    } else {
      // Over CDP there is no main process to ask, and Electron has no CDP window
      // bounds either: the page's viewport is emulated at the device's size instead,
      // which is what its screenshots are taken at whatever the window's own size.
      // The session stays open: closing it would drop the override.
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.setDeviceMetricsOverride", {
        ...want,
        deviceScaleFactor: device.dpr,
        mobile: false,
      });
    }
    await page
      .waitForFunction((s) => innerWidth === s.width && innerHeight === s.height, want, {
        timeout: 2_000,
      })
      .catch(() => {});
    const got = await page.evaluate(() => [innerWidth, innerHeight]);
    if (got[0] !== want.width || got[1] !== want.height) {
      log(
        `  ⚠ the window went to ${got[0]}×${got[1]}, not ${want.width}×${want.height} (${device.name}): the app may have a minimum size`,
      );
    }
  } catch (e) {
    log(
      `  ⚠ couldn't resize the window for ${device.name}: ${(e as Error).message.split("\n")[0]}`,
    );
  }
}
