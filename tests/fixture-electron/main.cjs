// A tiny Electron app for the app-target integration tests: one window, a page
// loaded from disk, hash routes, a dialog and a button that writes to a server.
// It also shows a greeting kept in its profile, to tell a copied profile apart from
// an empty one.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

ipcMain.on("profile", (event) => {
  const userData = app.getPath("userData");
  let greeting = "";
  try {
    greeting = fs.readFileSync(path.join(userData, "greeting.txt"), "utf8").trim();
  } catch {
    // An empty profile: no greeting.
  }
  event.returnValue = { userData, greeting };
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  win.loadFile(path.join(__dirname, "index.html"));
});
app.on("window-all-closed", () => app.quit());
