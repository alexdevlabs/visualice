import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/shared/config";
import type { Device } from "../src/shared/types";

/**
 * The Android driver against fake adb devices: which commands each option sends,
 * and which device it picks. The emulator test (integration/app-android.test.ts)
 * covers a real device; this covers the options it doesn't use.
 */

const PKG = "com.example.app";

interface FakeDevice {
  serial: string;
  shell: string[];
  closed: boolean;
}

const devices: FakeDevice[] = [];

function fakeDevice(serial: string): FakeDevice {
  const state: FakeDevice = { serial, shell: [], closed: false };
  devices.push(state);
  return state;
}

/** What adb answers: a launcher activity, a running process, a started activity. */
function answer(command: string): string {
  if (command.startsWith("cmd package resolve-activity")) {
    return `priority=0 preferredOrder=0\n${PKG}/.MainActivity`;
  }
  if (command.startsWith("pidof")) return "4242";
  if (command.startsWith("am start")) return "Starting: Intent { }\nStatus: ok";
  return "";
}

vi.mock("playwright", () => ({
  _android: {
    devices: async () =>
      devices.map((state) => ({
        serial: () => state.serial,
        model: () => "Fake Phone",
        close: async () => void (state.closed = true),
        installApk: async () => void state.shell.push("install"),
        shell: async (command: string) => {
          state.shell.push(command);
          return Buffer.from(answer(command));
        },
        screenshot: async () => Buffer.from(""),
        webViews: () => [
          {
            pkg: () => PKG,
            pid: () => 4242,
            page: async () => ({
              waitForLoadState: async () => {},
              context: () => ({}),
            }),
          },
        ],
      })),
  },
  _electron: {},
}));

const { androidDriver } = await import("../src/crawl/app/android");

const phone = { name: "phone", width: 412, height: 915, dpr: 2.625 } as Device;

const driverFor = (android: Record<string, unknown>) => {
  const config = parseConfig({ app: { android: { package: PKG, ...android } } }, () => {});
  return androidDriver(config.app!.android!, () => {});
};

beforeEach(() => {
  devices.length = 0;
});

describe("the Android driver", () => {
  it("clears the app's data before each launch, unless clearData is off", async () => {
    const d = fakeDevice("emulator-5554");
    await driverFor({}).launch(phone);
    expect(d.shell).toContain(`pm clear ${PKG}`);

    const kept = fakeDevice("emulator-5554");
    devices.splice(0, 1);
    await driverFor({ clearData: false }).launch(phone);
    expect(kept.shell).toContain(`am force-stop ${PKG}`);
    expect(kept.shell).not.toContain(`pm clear ${PKG}`);
  });

  it("starts the activity it's given, without asking for the launcher's", async () => {
    const d = fakeDevice("emulator-5554");
    await driverFor({ activity: ".SettingsActivity" }).launch(phone);
    expect(d.shell).toContain(`am start -W -n ${PKG}/.SettingsActivity`);
    expect(d.shell.some((c) => c.includes("resolve-activity"))).toBe(false);
  });

  it("asks for the launcher activity once, when none is given", async () => {
    const d = fakeDevice("emulator-5554");
    const driver = driverFor({});
    await driver.launch(phone);
    await driver.launch(phone);
    expect(d.shell.filter((c) => c.includes("resolve-activity"))).toHaveLength(1);
    expect(d.shell.filter((c) => c === `am start -W -n ${PKG}/.MainActivity`)).toHaveLength(2);
  });

  it("uses the device it names and lets go of the others", async () => {
    const first = fakeDevice("emulator-5554");
    const named = fakeDevice("emulator-5556");
    await driverFor({ device: "emulator-5556" }).launch(phone);
    expect(named.shell).toContain(`am start -W -n ${PKG}/.MainActivity`);
    expect(first.shell).toEqual([]);
    expect(first.closed).toBe(true);
    expect(named.closed).toBe(false);
  });

  it("says which devices adb lists when the named one isn't there", async () => {
    fakeDevice("emulator-5554");
    await expect(driverFor({ device: "R58M123" }).launch(phone)).rejects.toThrow(
      "no device R58M123 (adb lists: emulator-5554)",
    );
  });

  it("sets the screen for the device, and puts it back afterwards", async () => {
    const d = fakeDevice("emulator-5554");
    const driver = driverFor({ apk: "app-debug.apk" });
    await driver.launch(phone);
    await driver.launch(phone);
    expect(d.shell.filter((c) => c === "install")).toHaveLength(1);
    expect(d.shell.filter((c) => c.startsWith("wm size 1082x2402"))).toHaveLength(1);
    await driver.dispose();
    expect(d.shell.slice(-2)).toEqual(["wm size reset", "wm density reset"]);
    expect(d.closed).toBe(true);
  });

  it("stops the app when the crawler closes its page", async () => {
    const d = fakeDevice("emulator-5554");
    const { page } = await driverFor({}).launch(phone);
    d.shell.length = 0;
    await page.close();
    expect(d.shell).toEqual([`am force-stop ${PKG}`]);
  });
});
