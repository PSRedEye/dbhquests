/**
 * Preload script — bridges main-process IPC to the overlay renderer
 * via a safe contextBridge API.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  /** Called by main when F5 toggles interact mode. */
  onInteractionMode: (callback) => {
    ipcRenderer.on("interaction-mode", (_event, value) => callback(value));
  }
});

