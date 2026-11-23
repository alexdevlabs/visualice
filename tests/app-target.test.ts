import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appName, parseConfig } from "../src/shared/config";
import {
  appRootHref,
  canonicalPath,
  dedupeLinks,
  originOf,
  scopePath,
  setAppRoot,
} from "../src/shared/url";
import { resolveUrl } from "../src/crawl/recipe";
import { writeOf, writeRules } from "../src/crawl/writes";
import {
  devToolsEndpoint,
  inspectorAllowed,
  readFuseWire,
  resolveElectron,
} from "../src/crawl/app/electron";
import { screenFor } from "../src/crawl/app/android";
import { AppHost, type AppDriver, type AppInstance } from "../src/crawl/app/host";
import type { Device } from "../src/shared/types";

const quiet = () => {};

describe("an app in the config", () => {
  it("gets desktop devices for Electron and a phone for Android", () => {
    const electron = parseConfig({ app: { electron: { executable: "./my-app" } } }, quiet);
    expect(electron.devices.map((d) => [d.name, d.width, d.height, d.dpr])).toEqual([
      ["desktop", 1280, 800, 2],
    ]);
    const android = parseConfig({ app: { android: { package: "com.example.app" } } }, quiet);
    expect(android.devices).toMatchObject([{ name: "phone", width: 412, mobile: true }]);
  });

  it("keeps devices the config names", () => {
    const config = parseConfig(
      {
        app: { electron: { executable: "./my-app" } },
        devices: [{ name: "wide", width: 1600, height: 1000 }],
      },
      quiet,
    );
    expect(config.devices.map((d) => d.name)).toEqual(["wide"]);
  });

  it("turns off what only a website has, and runs one copy at a time", () => {
    const config = parseConfig({ app: { electron: { executable: "./my-app" } } }, quiet);
    expect(config.politeness.concurrency).toBe(1);
    expect(config.politeness.respectRobots).toBe(false);
    expect(config.discovery.useSitemap).toBe(false);
    expect(config.discovery.mobileStates).toBe(false);
  });

  it("names the run folder after the app", () => {
    const vscode = parseConfig(
      { app: { electron: { executable: "/Applications/Visual Studio Code.app" } } },
      quiet,
    );
    expect(vscode.output.site).toBe("visual-studio-code");
    const named = parseConfig(
      { app: { name: "Mail", electron: { executable: "./x" } }, output: { site: "mine" } },
      quiet,
    );
    expect(named.output.site).toBe("mine");
    expect(appName({ android: { package: "com.example.app" } } as never)).toBe("com.example.app");
  });

  it("refuses a target and an app together, two kinds of app, or another engine", () => {
    expect(() =>
      parseConfig({ target: "https://x.test", app: { electron: { executable: "a" } } }, quiet),
    ).toThrow(/target.*or `app`/);
    expect(() =>
      parseConfig(
        { app: { electron: { executable: "a" }, android: { package: "com.a.b" } } },
        quiet,
      ),
    ).toThrow(/one of app.electron or app.android/);
    expect(() =>
      parseConfig(
        {
          app: { electron: { executable: "a" } },
          devices: [{ name: "fx", width: 800, height: 600, browser: "firefox" }],
        },
        quiet,
      ),
    ).toThrow(/runs in its own engine/);
  });

  it("only takes names that are safe to pass to adb", () => {
    expect(() => parseConfig({ app: { android: { package: "com.a;rm -rf /" } } }, quiet)).toThrow();
    expect(() =>
      parseConfig({ app: { android: { package: "com.a.b", activity: ".Main; reboot" } } }, quiet),
    ).toThrow();
    expect(
      parseConfig({ app: { android: { package: "com.a.b", activity: ".MainActivity" } } }, quiet)
        .app?.android?.activity,
    ).toBe(".MainActivity");
  });
});

describe("an app's pages as routes", () => {
  afterEach(() => setAppRoot(undefined));

  it("names routes from the folder the app opens in, not the root of the disk", () => {
    setAppRoot("file:///Users/me/app/dist/index.html");
    expect(appRootHref()).toBe("file:///Users/me/app/dist");
    const settings = new URL("file:///Users/me/app/dist/index.html#/settings");
    expect(canonicalPath(settings, "auto")).toBe("/index.html#/settings");
    expect(scopePath(new URL("file:///Users/me/app/dist/sub/page.html"))).toBe("/sub/page.html");
    expect(originOf(settings)).toBe("file:///Users/me/app/dist");
  });

  it("resolves a route back to the app's own file", () => {
    setAppRoot("vscode-file://vscode-app/Applications/Code.app/out/workbench/workbench.html");
    const base = "vscode-file://vscode-app/Applications/Code.app/out/workbench/workbench.html";
    expect(resolveUrl(base, "/workbench.html")).toBe(base);
    expect(originOf(base) + "/workbench.html").toBe(base);
  });

  it("keeps links outside the app's folder out of its pages", () => {
    setAppRoot("file:///app/index.html");
    const links = dedupeLinks(
      ["file:///app/about.html", "file:///etc/hosts", "https://example.com/"],
      originOf("file:///app/index.html"),
    );
    expect(links).toEqual(["/about.html"]);
  });

  it("leaves websites, and an app served over http, as they were", () => {
    setAppRoot("http://localhost:5173/");
    expect(appRootHref()).toBeUndefined();
    expect(originOf("https://example.com/a")).toBe("https://example.com");
    expect(canonicalPath(new URL("https://example.com/a/b/"))).toBe("/a/b");
    expect(resolveUrl("https://example.com/x", "/y")).toBe("https://example.com/y");
  });

  it("gives an opaque page outside any root its scheme and host", () => {
    expect(originOf("capacitor://localhost/index.html")).toBe("capacitor://localhost");
  });
});

describe("writes from an app", () => {
  const req = (method: string, url: string) => ({
    method: () => method,
    url: () => url,
    resourceType: () => "fetch",
    postData: () => null,
  });

  it("counts a write to any host while the app's backend isn't named", () => {
    const rules = writeRules("file:///app/index.html", []);
    expect(rules.sites).toBe("any");
    expect(writeOf(req("POST", "https://api.backend.test/save"), rules)).toBe("POST /save");
  });

  it("counts only the named backends once apiHosts lists them", () => {
    const rules = writeRules("file:///app/index.html", [], ["api.backend.test"]);
    expect(writeOf(req("POST", "https://eu.backend.test/save"), rules)).toBe("POST /save");
    expect(writeOf(req("POST", "https://telemetry.other.test/e"), rules)).toBeUndefined();
  });

  it("adds apiHosts to a website's own site", () => {
    const rules = writeRules("https://www.example.com/", [], ["api.example.net"]);
    expect(rules.sites).toEqual(["example.com", "example.net"]);
    expect(writeOf(req("PUT", "https://api.example.net/x"), rules)).toBe("PUT /x");
  });
});

describe("finding an Electron app's program", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("runs the program a macOS bundle's Info.plist names", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vz-test-"));
    const bundle = path.join(dir, "Thing.app");
    await fs.mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
    await fs.writeFile(path.join(bundle, "Contents", "MacOS", "Thing Helper"), "");
    await fs.writeFile(path.join(bundle, "Contents", "MacOS", "Thing"), "");
    await fs.writeFile(
      path.join(bundle, "Contents", "Info.plist"),
      "<plist><dict><key>CFBundleExecutable</key>\n<string>Thing</string></dict></plist>",
    );
    expect(await resolveElectron(bundle)).toEqual({
      executablePath: path.join(bundle, "Contents", "MacOS", "Thing"),
      appArgs: [],
    });
  });

  it("runs a project folder with the electron installed in it", async () => {
    const fixture = path.resolve(import.meta.dirname, "fixture-electron");
    const program = await resolveElectron(fixture);
    expect(program.appArgs).toEqual([fixture]);
    expect(program.executablePath).toMatch(/electron/i);
  });

  it("says what is missing", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vz-test-"));
    await expect(resolveElectron(path.join(dir, "nope"))).rejects.toThrow(/nothing at/);
    await expect(resolveElectron(dir)).rejects.toThrow(/no package.json/);
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ main: "main.js" }));
    await expect(resolveElectron(dir)).rejects.toThrow(/npm i -D electron/);
  });

  it("reads whether the Node inspector is switched off from the fuse wire", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vz-test-"));
    const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
    const binary = (fuses: string) =>
      Buffer.concat([
        Buffer.alloc(3_000_000, 7),
        sentinel,
        Buffer.from([1, fuses.length]),
        Buffer.from(fuses),
      ]);
    const locked = path.join(dir, "locked");
    const open = path.join(dir, "open");
    const old = path.join(dir, "old");
    await fs.writeFile(locked, binary("0100"));
    await fs.writeFile(open, binary("1011"));
    await fs.writeFile(old, Buffer.alloc(1000, 1));
    expect((await readFuseWire(locked))?.toString()).toBe("0100");
    expect(await inspectorAllowed(locked)).toBe(false);
    expect(await inspectorAllowed(open)).toBe(true);
    // An Electron from before fuses always allowed it.
    expect(await inspectorAllowed(old)).toBe(true);
  });
});

describe("connecting to an Electron app over CDP", () => {
  it("reads the port the app bound, and its endpoint, from its profile", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vz-test-"));
    try {
      expect(await devToolsEndpoint(dir)).toBeUndefined();
      await fs.writeFile(path.join(dir, "DevToolsActivePort"), "60396\n");
      expect(await devToolsEndpoint(dir)).toBeUndefined();
      await fs.writeFile(
        path.join(dir, "DevToolsActivePort"),
        "60396\n/devtools/browser/63afeb34-6e80-4240-b596-f195ae484115",
      );
      expect(await devToolsEndpoint(dir)).toBe(
        "ws://127.0.0.1:60396/devtools/browser/63afeb34-6e80-4240-b596-f195ae484115",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("an Android device profile", () => {
  it("becomes a screen size and density in the device's own pixels", () => {
    expect(screenFor({ width: 412, height: 915, dpr: 2.625 })).toEqual({
      size: "1082x2402",
      density: 420,
    });
    expect(screenFor({ width: 800, height: 1280, dpr: 2 })).toEqual({
      size: "1600x2560",
      density: 320,
    });
  });
});

describe("an app standing in for a browser", () => {
  const device = (name: string, width = 1280): Device =>
    ({ name, width, height: 800, dpr: 2 }) as Device;

  /** A driver whose copies of the app are plain objects, counted as they start and stop. */
  function fakeDriver() {
    let n = 0;
    const log: string[] = [];
    const driver: AppDriver = {
      kind: "electron",
      async launch(d) {
        const id = ++n;
        log.push(`start ${id} ${d.name}`);
        const context = {
          setDefaultTimeout: vi.fn(),
          addInitScript: vi.fn(async () => {}),
          cookies: vi.fn(async () => [{ name: `c${id}` }]),
        };
        const page = {
          id,
          url: () => "file:///app/index.html",
          reload: vi.fn(async () => null),
          context: () => context,
        };
        return {
          page,
          context,
          close: async () => void log.push(`stop ${id}`),
        } as unknown as AppInstance;
      },
      dispose: async () => void log.push("dispose"),
    };
    return { driver, log };
  }

  const config = (devices: Device[]) =>
    ({ app: { name: "Fake", electron: { executable: "x" } }, devices }) as never;

  it("hands the copy it started to find the start page to the first page asked for", async () => {
    const { driver, log } = fakeDriver();
    const host = new AppHost(driver, config([device("desktop")]));
    expect(await host.startUrl()).toBe("file:///app/index.html");
    setAppRoot(undefined);
    const page = (await host.newContext().newPage()) as unknown as { id: number };
    expect(page.id).toBe(1);
    expect(log).toEqual(["start 1 desktop"]);
  });

  it("starts a fresh copy for every page after that, closing the one before", async () => {
    const { driver, log } = fakeDriver();
    const host = new AppHost(driver, config([device("desktop")]));
    const ctx = host.newContext();
    await ctx.newPage();
    await ctx.newPage();
    const other = host.newContext();
    await other.newPage();
    await ctx.close(); // not its copy any more: nothing to close
    await other.close();
    await host.close();
    expect(log).toEqual([
      "start 1 desktop",
      "stop 1",
      "start 2 desktop",
      "stop 2",
      "start 3 desktop",
      "stop 3",
      "dispose",
    ]);
  });

  it("starts a copy at another device's size rather than reuse one", async () => {
    const { driver, log } = fakeDriver();
    const host = new AppHost(driver, config([device("desktop"), device("narrow", 800)]));
    await host.startUrl();
    setAppRoot(undefined);
    await host.newContext(device("narrow", 800)).newPage();
    expect(log).toEqual(["start 1 desktop", "stop 1", "start 2 narrow"]);
  });

  it("applies the context's timeout and init scripts to each copy, reloading for them", async () => {
    const { driver } = fakeDriver();
    const host = new AppHost(driver, config([device("desktop")]));
    const ctx = host.newContext();
    ctx.setDefaultTimeout(1234);
    await ctx.addInitScript({ content: "window.x = 1" });
    const page = (await ctx.newPage()) as unknown as {
      reload: ReturnType<typeof vi.fn>;
      context: () => {
        setDefaultTimeout: ReturnType<typeof vi.fn>;
        addInitScript: ReturnType<typeof vi.fn>;
      };
    };
    expect(page.context().setDefaultTimeout).toHaveBeenCalledWith(1234);
    expect(page.context().addInitScript).toHaveBeenCalledWith({ content: "window.x = 1" });
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(await ctx.cookies()).toEqual([{ name: "c1" }]);
    await expect(ctx.storageState()).rejects.toThrow(/own profile/);
  });
});
