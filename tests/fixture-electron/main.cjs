// A tiny Electron app for the app-target integration tests: one window, a page
// loaded from disk, hash routes, a dialog and a button that writes to a server.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 600 });
  win.loadFile(path.join(__dirname, "index.html"));
});
app.on("window-all-closed", () => app.quit());
