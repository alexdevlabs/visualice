import { _android } from "playwright";
import type { AndroidDevice, AndroidWebView } from "playwright";
import path from "node:path";
import type { AppConfig } from "../../shared/config";
import type { Device } from "../../shared/types";
import type { AppDriver, AppInstance } from "./host";

type AndroidConfig = NonNullable<AppConfig["android"]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The screen a device profile asks for, in the device's own pixels and density:
 * `wm size` and `wm density` take those. One emulator then stands in for a phone and
 * a tablet alike.
 */
export function screenFor(device: Pick<Device, "width" | "height" | "dpr">): {
  size: string;
  density: number;
} {
  return {
    size: `${Math.round(device.width * device.dpr)}x${Math.round(device.height * device.dpr)}`,
    density: Math.round(device.dpr * 160),
  };
}

/**
 * Drive an Android app's WebView over adb. Every launch stops the app, clears its
 * data (unless `clearData` is off) and starts it again, so each one begins like a
 * fresh install. The screen is set to the device profile's size and put back when
 * the crawl ends.
 */
export function androidDriver(cfg: AndroidConfig, log: (msg: string) => void): AppDriver {
  let device: AndroidDevice | undefined;
  let installed = false;
  let screen = "";
  let component: string | undefined;

  const connect = async (): Promise<AndroidDevice> => {
    if (device) return device;
    let devices: AndroidDevice[];
    try {
      devices = await _android.devices();
    } catch (e) {
      throw new Error(
        `android: can't reach adb (${(e as Error).message.split("\n")[0]}) — install the Android platform tools and start an emulator`,
      );
    }
    const chosen = cfg.device ? devices.find((d) => d.serial() === cfg.device) : devices[0];
    for (const d of devices) if (d !== chosen) await d.close().catch(() => {});
    if (!chosen) {
      throw new Error(
        cfg.device
          ? `android: no device ${cfg.device} (adb lists: ${devices.map((d) => d.serial()).join(", ") || "none"})`
          : "android: no device or emulator — start one (emulator -avd <name>) or connect a phone with USB debugging on",
      );
    }
    log(`  android: ${chosen.model()} (${chosen.serial()})`);
    device = chosen;
    return chosen;
  };

  const shell = async (d: AndroidDevice, command: string): Promise<string> =>
    (await d.shell(command)).toString().trim();

  return {
    kind: "android",
    async launch(profile: Device): Promise<AppInstance> {
      const d = await connect();
      const pkg = cfg.package;
      if (cfg.apk && !installed) {
        log(`  android: installing ${path.basename(cfg.apk)}`);
        await d.installApk(path.resolve(cfg.apk));
        installed = true;
      }
      const { size, density } = screenFor(profile);
      if (screen !== `${size}@${density}`) {
        await shell(d, `wm size ${size}`);
        await shell(d, `wm density ${density}`);
        screen = `${size}@${density}`;
      }
      await shell(d, `am force-stop ${pkg}`);
      if (cfg.clearData) await shell(d, `pm clear ${pkg}`);
      component ??= cfg.activity ? `${pkg}/${cfg.activity}` : await launcherOf(d, pkg, shell);
      const started = await shell(d, `am start -W -n ${component}`);
      if (/^Error|does not exist/im.test(started)) {
        throw new Error(
          `android: couldn't start ${pkg}: ${started.split("\n").find((l) => /error|abort|not/i.test(l)) ?? started}`,
        );
      }
      const webview = await webViewOf(d, pkg, cfg.startTimeoutMs, (c) => shell(d, c));
      const page = await webview.page();
      // Closing a WebView's page over adb never returns: the WebView belongs to the
      // app, not to Playwright. What the crawler means by it is "done with this
      // copy", so it stops the app instead.
      const stop = () => shell(d, `am force-stop ${pkg}`).then(() => {});
      Object.defineProperty(page, "close", { value: stop, configurable: true });
      await page
        .waitForLoadState("domcontentloaded", { timeout: cfg.startTimeoutMs })
        .catch(() => {});
      return {
        page,
        context: page.context(),
        screen: cfg.frame === "screen" ? () => d.screenshot() : undefined,
        close: () => stop().catch(() => {}),
      };
    },
    async dispose() {
      if (!device) return;
      if (screen) {
        await shell(device, "wm size reset").catch(() => {});
        await shell(device, "wm density reset").catch(() => {});
      }
      await device.close().catch(() => {});
      device = undefined;
    },
  };
}

/**
 * The activity the launcher starts, as `package/.Activity`. Asked of the package
 * manager rather than sent through `monkey`, which on some system images reports
 * success without starting anything.
 */
async function launcherOf(
  d: AndroidDevice,
  pkg: string,
  shell: (d: AndroidDevice, command: string) => Promise<string>,
): Promise<string> {
  const out = await shell(
    d,
    `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`,
  );
  const component = out
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith(`${pkg}/`));
  if (!component) {
    throw new Error(
      `android: ${pkg} has no launcher activity on this device — is it installed? Set app.android.apk to install it, or app.android.activity to name one`,
    );
  }
  return component;
}

/**
 * The WebView of the copy of `pkg` that was just started. The copy before it may
 * still be listed for a moment after it was stopped, so the WebView has to belong
 * to the running process, not just the package.
 */
async function webViewOf(
  d: AndroidDevice,
  pkg: string,
  timeoutMs: number,
  shell: (command: string) => Promise<string>,
): Promise<AndroidWebView> {
  const deadline = Date.now() + timeoutMs;
  let pid = 0;
  for (;;) {
    if (!pid) pid = Number((await shell(`pidof ${pkg}`).catch(() => "")).split(/\s+/)[0]) || 0;
    const match = d.webViews().find((w) => w.pkg() === pkg && (!pid || w.pid() === pid));
    if (match && pid) return match;
    if (Date.now() > deadline) {
      throw new Error(
        pid
          ? `android: ${pkg} is running but shows no debuggable WebView — use a debug build, or call WebView.setWebContentsDebuggingEnabled(true)`
          : `android: ${pkg} didn't start within ${timeoutMs}ms`,
      );
    }
    await sleep(250);
  }
}
