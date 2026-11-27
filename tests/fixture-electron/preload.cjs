// Hands the page where its profile is and the greeting kept there, if any.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fixture", ipcRenderer.sendSync("profile"));
