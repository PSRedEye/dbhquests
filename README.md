# DBH Quest Checklist

A local Node.js + Electron app that helps you track in-game quest delivery items.  
Screenshot your quest board in-game, auto-import via OCR, and track deliveries in your browser — with a live transparent overlay displayed above the game.

---

## Features

| Feature | Description |
|---------|-------------|
| **Web checklist** | Full quest item list in the browser with check/uncheck, filtering, and multi-column layout |
| **OCR import** | Drop screenshots into `ocr-input/` and import them with one click |
| **Global hotkeys** | F7/F8 work even while the game is fullscreen |
| **In-game overlay** | Compact translucent panel showing unchecked items, displayed above the game |
| **Persistent storage** | All changes saved automatically to `data/items.json` |

---

## First time setup on Windows (no Node.js installed)

### Step 1 — Install Node.js

**Option A — Official installer (easiest)**

1. Go to [https://nodejs.org](https://nodejs.org)
2. Click **"LTS"** to download the Windows installer (`.msi`).
3. Run the installer and click **Next** through all steps. Leave all defaults as-is.
4. When it asks *"Automatically install the necessary tools"*, you can leave it **unchecked** — it is not needed for this app.
5. Click **Install**, then **Finish**.

**Option B — Windows Package Manager (winget)**

Open **PowerShell** or **Command Prompt** and run:

```powershell
winget install OpenJS.NodeJS.LTS
```

Once installed, **close and reopen** your terminal so `node` and `npm` are available.

Verify Node.js is installed:

```powershell
node --version
npm --version
```

Both should print a version number (e.g. `v22.x.x`).

---

### Step 2 — Install app dependencies

1. Extract or copy the app folder somewhere on your PC (e.g. `C:\Users\YourName\dbhquests`).
2. Open **PowerShell** in that folder:
   - Hold **Shift**, right-click the folder in File Explorer → **"Open PowerShell window here"**
   - Or open PowerShell and type: `cd "C:\Users\YourName\dbhquests"`
3. Run:

```powershell
npm install
```

This downloads all required libraries into a `node_modules` folder. Only needed once.

---

### Step 3 — Start the app

```powershell
npm start
```

This launches **three services at once** with coloured output:

| Service | Colour | What it does |
|---------|--------|--------------|
| **server** | Cyan | Web server on `http://localhost:3000` |
| **hotkey** | Magenta | Listens for F7/F8 global hotkeys |
| **overlay** | Yellow | Electron overlay window above the game |

---

### Step 4 — Open the web checklist

Open your browser and go to:

```
http://localhost:3000
```

Leave the PowerShell window open while using the app. Close it (or press `Ctrl+C`) to stop everything.

---

## Global hotkeys

These work even when the game is in fullscreen or borderless-window mode.

| Key | Action |
|-----|--------|
| **F8** | Take a full-screen screenshot → save to `ocr-input/` with a timestamp filename |
| **F9** | Run OCR import — processes all queued screenshots, extracts quest items, and loads them into the checklist (two rising beeps confirm when done) |
| **F7** | Clear the `ocr-input/` folder (removes screenshots + any leftover `.ocr-raw.txt` files) |
| **F6** | Show / hide the in-game overlay |
| **F5** | Toggle **interact mode** ↔ **pass-through** for the overlay (see below) |

> A short beep confirms F8 (single beep) and F7 (double beep) on Windows.

---

## In-game overlay

The overlay is a compact translucent panel that sits on top of the game screen and shows only your **unchecked** quest items.

- **Default (pass-through) mode** — the overlay is visible but all mouse and keyboard input goes straight to the game. Zero interference.
- **Interact mode (F5)** — the overlay becomes interactive: you can scroll the list and drag it by the header bar. The border turns pink to indicate this mode. Press **F5** again to return to pass-through.
- **Hide/show (F6)** — toggle the overlay off when you don't need it. Hiding automatically exits interact mode.
- The overlay **auto-refreshes every 4 seconds** from the local server. Checked items disappear automatically.
- The window is resizable by dragging any corner.

---

## OCR screenshot workflow

### In-game
1. Open the quest board in the game.
2. Press **F8** to screenshot the current page (you'll hear a single beep).
3. Scroll down and press **F8** again for each page.
4. Repeat until the whole board is captured.
5. Press **F9** to run the OCR import straight from the game — no browser needed.  
   You'll hear **two rising beeps** when the import finishes successfully, or a long low beep if the server isn't reachable.

### In the web app
1. Go to `http://localhost:3000`.
2. The **"Import OCR queue"** button shows a badge with the number of queued screenshots.
3. Click **"Import OCR queue"** to extract all items via OCR and load them into the checklist (or just press **F9** — same action).
4. When done, click **"Clear OCR queue"** (or press **F7**) to clean up the screenshots for the next session.

> **Note:** When OCR finds at least one valid item, the import overwrites `data/items.json` with the newly extracted items. If no valid items are found, the existing data is kept unchanged.

---

## Available npm scripts

| Script | Command | What it runs |
|--------|---------|--------------|
| `npm start` | `npm start` | Server + hotkey tool + overlay (recommended) |
| `npm run server` | `npm run server` | Web server only |
| `npm run hotkey` | `npm run hotkey` | Hotkey tool only |
| `npm run overlay` | `npm run overlay` | Electron overlay only |

---

## Persistent saved data

All of the following are written to `data/items.json` automatically:

- Checked / delivered state
- Deleted items
- Manually added items
- OCR-imported items

---

## OCR import — technical notes

- Supported image formats: `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.tif`, `.tiff`
- You can also drop images manually into the `ocr-input/` folder instead of using F8.
- OCR looks for title formats like `CarBrand - Part Name` and price ranges like `$517 - $1,033`.
- Skipped / unparseable images are listed in the API response.
- A `.ocr-raw.txt` debug file is saved alongside each processed image so you can inspect what Tesseract read.

You can also trigger an import manually via PowerShell without the browser:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/items/import-ocr"
```
