/**
 * DBH Quest Screenshot Tool
 * Run alongside server.js:  npm run start:all
 *
 *   F8  →  Capture full screen → save to ocr-input/
 *   F9  →  Run OCR import (process queued screenshots)
 *   F7  →  Clear the ocr-input folder (fresh start for a new session)
 */

const fs   = require("fs/promises");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");

const { uIOhook, UiohookKey } = require("uiohook-napi");
const screenshot = require("screenshot-desktop");

const OCR_DIR   = path.join(__dirname, "ocr-input");
const IMAGE_EXT = /\.(png|jpg|jpeg|bmp|webp|tiff?)$/i;
const SERVER_URL = "http://localhost:3000";

function pad(n) { return String(n).padStart(2, "0"); }

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Short system beep – Windows only, silent no-op elsewhere. */
function beep(freq = 800, ms = 150) {
  if (process.platform !== "win32") return;
  execFile(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `[Console]::Beep(${freq},${ms})`],
    { windowsHide: true }, () => {}
  );
}

async function captureScreen() {
  await fs.mkdir(OCR_DIR, { recursive: true });
  const filename = `screenshot_${timestamp()}.png`;
  try {
    const buf = await screenshot({ format: "png" });
    await fs.writeFile(path.join(OCR_DIR, filename), buf);
    const count = (await fs.readdir(OCR_DIR)).filter(f => IMAGE_EXT.test(f)).length;
    beep(800, 120);
    console.log(`[F8] ✓ Saved: ${filename}  (${count} queued)`);
  } catch (err) {
    beep(300, 500);
    console.error(`[F8] ✗ Failed: ${err.message}`);
  }
}

async function clearFolder() {
  await fs.mkdir(OCR_DIR, { recursive: true });
  try {
    const files = await fs.readdir(OCR_DIR);
    const del = files.filter(f => IMAGE_EXT.test(f) || f.endsWith(".ocr-raw.txt"));
    await Promise.all(del.map(f => fs.unlink(path.join(OCR_DIR, f))));
    beep(600, 100);
    setTimeout(() => beep(600, 100), 160);
    console.log(`[F7] ✓ Cleared ${del.length} file(s) from OCR folder.`);
  } catch (err) {
    console.error(`[F7] ✗ Clear failed: ${err.message}`);
  }
}

async function runOcrImport() {
  console.log("[F9] Starting OCR import…");
  beep(1000, 80);

  return new Promise((resolve) => {
    const req = http.request(
      `${SERVER_URL}/api/items/import-ocr`,
      { method: "POST" },
      (res) => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            const count = (json.items || json.extractedItems || []).length;
            const scanned = json.imagesScanned || "?";
            beep(1000, 80);
            setTimeout(() => beep(1200, 120), 130);
            console.log(`[F9] ✓ Import done — ${scanned} image(s) scanned, ${count} item(s) loaded`);
            if ((json.skippedImages || []).length) {
              console.log(`[F9]   Skipped: ${json.skippedImages.map(s => s.file).join(", ")}`);
            }
          } catch {
            console.log(`[F9] ✓ Import done (raw: ${body.slice(0, 120)})`);
          }
          resolve();
        });
      }
    );
    req.on("error", (err) => {
      beep(300, 500);
      console.error(`[F9] ✗ Import failed: ${err.message} — is the server running?`);
      resolve();
    });
    req.end();
  });
}

async function main() {
  await fs.mkdir(OCR_DIR, { recursive: true });
  const queued = (await fs.readdir(OCR_DIR)).filter(f => IMAGE_EXT.test(f)).length;

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   DBH Quest Screenshot Tool                  ║");
  console.log("║                                              ║");
  console.log("║   F8  →  Screenshot (add to queue)           ║");
  console.log("║   F9  →  Run OCR import (process queue)      ║");
  console.log("║   F7  →  Clear OCR folder (new session)      ║");
  console.log("║   Ctrl+C to stop                             ║");
  console.log("╚══════════════════════════════════════════════╝");
  if (queued) console.log(`   ${queued} screenshot(s) already in queue.\n`);

  uIOhook.on("keydown", (e) => {
    if (e.keycode === UiohookKey.F8) captureScreen();
    if (e.keycode === UiohookKey.F9) runOcrImport();
    if (e.keycode === UiohookKey.F7) clearFolder();
  });

  uIOhook.start();

  process.on("SIGINT", () => {
    console.log("\nStopping...");
    uIOhook.stop();
    process.exit(0);
  });
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });

