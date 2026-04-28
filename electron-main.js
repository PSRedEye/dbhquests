/**
 * DBH Quest Overlay — Electron main process
 *
 *   F6  →  Show / hide the overlay
 *   F5  →  Toggle interact (scroll) mode  ←→  pass-through mode
 *
 * Run via:  npm start   (starts server + hotkey tool + overlay together)
 *       or: npm run overlay
 */

const { app, BrowserWindow, globalShortcut, screen } = require("electron");
const path = require("path");

// Keep hard references so GC never collects them
let win = null;
let isVisible  = true;
let isInteract = false;

// ── Window creation ──────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const W = 268;
  const H = Math.min(520, height - 140);

  win = new BrowserWindow({
    width:  W,
    height: H,
    x: width  - W - 14,
    y: 70,
    // Appearance
    transparent: true,
    frame:       false,
    hasShadow:   false,
    backgroundColor: "#00000000",
    // Behaviour
    alwaysOnTop:  true,
    skipTaskbar:  true,
    focusable:    false,   // don't steal focus from game by default
    resizable:    true,    // user can resize by dragging corner
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, "overlay-preload.js")
    }
  });

  // 'screen-saver' level keeps the overlay above fullscreen/borderless games
  win.setAlwaysOnTop(true, "screen-saver");
  // Pass-through mode by default — mouse events go straight to the game
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, "public", "overlay.html"));

  // Uncomment to debug the overlay UI:
  // win.webContents.openDevTools({ mode: "detach" });
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

  // F6 — toggle overlay visibility
  globalShortcut.register("F6", () => {
    if (!win) return;
    isVisible = !isVisible;
    if (isVisible) {
      win.show();
    } else {
      // Exit interact mode when hiding so next show is always pass-through
      if (isInteract) {
        isInteract = false;
        win.setIgnoreMouseEvents(true, { forward: true });
        win.setFocusable(false);
        win.webContents.send("interaction-mode", false);
      }
      win.hide();
    }
  });

  // F5 — toggle interact (scroll) ↔ pass-through
  globalShortcut.register("F5", () => {
    if (!win || !isVisible) return;
    isInteract = !isInteract;
    if (isInteract) {
      win.setFocusable(true);
      win.setIgnoreMouseEvents(false);
      win.focus();
    } else {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.setFocusable(false);
    }
    win.webContents.send("interaction-mode", isInteract);
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// Quit when the single overlay window is closed
app.on("window-all-closed", () => {
  app.quit();
});

