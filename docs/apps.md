# Crawling apps

visualice can catalogue an app as well as a website: a desktop app built with
**Electron**, or an **Android app whose screens are a WebView** (Capacitor, Ionic,
Cordova, or a WebView of your own). Both are web pages inside, so discovery, recipes,
write blocking, probes and the viewer work the way they do for a site. This is
experimental: it rests on Playwright's Electron and Android support, which Playwright
itself marks experimental.

Native screens are out of reach: an app written in Swift, Kotlin, React Native or
Flutter has no web page to crawl, and neither do the native parts of a hybrid app.
iOS isn't supported at all, because Playwright can't attach to an iOS WebView.

## Electron

Point `app.electron.executable` at the app instead of setting a `target`:

```json
{
  "app": {
    "electron": { "executable": "/Applications/Visual Studio Code.app" }
  }
}
```

`executable` can be:

- a macOS `.app` bundle: the program its Info.plist names is run;
- the app's program itself (`C:\Program Files\Foo\Foo.exe`, `/opt/foo/foo`);
- the folder of an Electron project you are building: a package.json with a `main`, and
  `electron` installed in it (`npm i -D electron`).

Then crawl as usual, with no URL:

```bash
visualice crawl
```

Each shot starts a fresh copy of the app with an empty profile in a temporary folder,
which is deleted afterwards. The crawl never touches your own profile, so you won't
find yourself signed out, and there's nothing to clean up. The app's windows open on
screen while it runs.

| Option           | What it does                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `args`           | Extra command-line arguments, such as `["--disable-extensions"]` for VS Code.                                             |
| `env`            | Extra environment variables; `${ENV_VAR}` placeholders resolve.                                                           |
| `profile`        | A user-data folder to start every launch from, such as one already signed in. It's copied for each launch, never changed. |
| `connect`        | `auto` (default), `launch` or `cdp`: see below.                                                                           |
| `startTimeoutMs` | How long to wait for the first window (default 30000).                                                                    |

### Apps that switch off the inspector

Playwright starts an Electron app with its Node inspector, and an app can switch that
off when it's built (Slack and Discord do). visualice reads this from the app's binary
before starting it. If the inspector is off, it starts the app with Chromium's remote
debugging port instead and connects over CDP, and says so in the log. That's what
`connect: "auto"` does; `launch` and `cdp` force one or the other. An app that also
strips the remote debugging port can't be crawled.

While an app is connected over CDP, its debugging port is open on `127.0.0.1` for as
long as that copy runs, and any program on your computer could connect to it and
control the app. visualice has the app pick a free port itself and connects to the
endpoint the app writes into its private profile folder, but it can't close the port
to other local programs. Keep that in mind before crawling over CDP with a signed-in
`profile` on a shared machine.

### Screen sizes

An Electron app gets one device when the config names none: `desktop`, 1280×800 at
pixel ratio 2. Each device in `devices` is a window size. The pixel ratio is forced
with `--force-device-scale-factor`, so shots come out the same on any screen. `mobile`,
`touch`, `userAgent` and `browser` don't apply to an app. An app with a minimum window
size won't go smaller than it, and the log says when a window didn't reach the size
asked for.

## Android

```json
{
  "app": {
    "android": {
      "package": "com.example.app",
      "apk": "android/app/build/outputs/apk/debug/app-debug.apk"
    }
  }
}
```

You need:

- **adb**, from the Android SDK platform tools;
- **an emulator or a phone**: a running emulator, or a phone with USB debugging on. The
  first device adb lists is used, or the one `device` names (`emulator-5554`);
- **a debuggable WebView**: a debug build, or an app that calls
  `WebView.setWebContentsDebuggingEnabled(true)`. Release builds from a store mostly
  can't be crawled. visualice says so when it finds the app running without one.

`apk` is installed before the crawl; leave it out for an app that's already on the
device. Each launch stops the app, clears its data and starts it again, so every
shot starts like a fresh install. Set `clearData: false` to keep a session you signed
in to on the device.

| Option           | What it does                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `package`        | The app's package name. Required.                                                                            |
| `activity`       | The activity to start (`.MainActivity`). Default: the app's launcher activity.                               |
| `apk`            | An APK to install first.                                                                                     |
| `device`         | The adb serial to use.                                                                                       |
| `clearData`      | Clear the app's data before every launch (default `true`).                                                   |
| `frame`          | `webview` (default): shots show the WebView's page. `screen`: the whole screen, status bar and native parts. |
| `startTimeoutMs` | How long to wait for the WebView after starting the app (default 30000).                                     |

### Screen sizes

An Android app gets one device when the config names none: `phone`, 412×915 at pixel
ratio 2.625. Each device in `devices` sets the emulator's screen with `wm size` and
`wm density`, so one emulator stands in for a phone and a tablet alike. The screen
is put back when the crawl ends. With `frame: "webview"` a shot is the WebView,
which is the screen minus the app's own bars.

## What's different from a website

- **Pages are named from the app's folder.** An app loads its pages from disk, so a
  page's route is its path from the folder the first page is in: `/index.html`,
  `/index.html#/settings`. Hash routes are found from links, the way they are on a site.
  An app that is one page with no routes, like VS Code, has one route. Its screens are
  found by clicking, as states.
- **One copy at a time.** `politeness.concurrency` is 1, and a state marked `isolate`
  gets a fresh copy of the app.
- **No mobile pass, robots.txt or sitemap.** States are found at the size they're
  captured at.
- **Writes to any host count.** An app has no web host of its own, so while
  `discovery.interactions.apiHosts` is empty, a write to any host blocks the trigger
  and leaves it out. List the app's backend there to count only its writes.
- **No login recipes.** An app keeps its session in its own profile. Sign in once and
  start from that session: `app.electron.profile`, or `app.android.clearData: false`.
- **Run folder.** Runs go under `.visualice/sites/<app name>/`. Set `app.name` or
  `output.site` to choose the name.
