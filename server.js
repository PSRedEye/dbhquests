const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { extractItemsFromImages } = require("./ocr-import");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "items.json");
const OCR_INPUT_DIR = path.join(ROOT, "ocr-input");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

async function readItems() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeItems([]);
      return [];
    }
    throw error;
  }
}

async function writeItems(items) {
  const sorted = [...items].sort((a, b) =>
    String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base" })
  );
  await fs.writeFile(DATA_FILE, JSON.stringify(sorted, null, 2), "utf-8");
}

async function ensureOcrInputDir() {
  await fs.mkdir(OCR_INPUT_DIR, { recursive: true });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1000000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function isSafePublicPath(filePath) {
  return path.resolve(filePath).startsWith(path.resolve(PUBLIC_DIR));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.join(PUBLIC_DIR, requestedPath);

  if (!isSafePublicPath(filePath)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/items" && req.method === "GET") {
      const items = await readItems();
      return sendJson(res, 200, { items });
    }

    if (url.pathname === "/api/items" && req.method === "POST") {
      const body = await parseBody(req);
      const title = String(body.title || "").trim();
      const price = String(body.price || "").trim();

      if (!title) return sendJson(res, 400, { error: "Title is required." });
      if (!price) return sendJson(res, 400, { error: "Price range is required." });

      const items = await readItems();
      const item = {
        id: `item-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
        title,
        price,
        sent: false
      };

      items.push(item);
      await writeItems(items);
      return sendJson(res, 201, { item });
    }

    if (url.pathname === "/api/items/sent" && req.method === "PATCH") {
      const body = await parseBody(req);
      const updates = Array.isArray(body.updates) ? body.updates : [];
      const items = await readItems();
      const sentById = new Map(updates.map(update => [String(update.id), Boolean(update.sent)]));
      const updatedItems = items.map(item =>
        sentById.has(item.id) ? { ...item, sent: sentById.get(item.id) } : item
      );
      await writeItems(updatedItems);
      return sendJson(res, 200, { items: updatedItems });
    }

    if (url.pathname === "/api/items/delete" && req.method === "DELETE") {
      const body = await parseBody(req);
      const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
      if (!ids.size) return sendJson(res, 400, { error: "No items selected for deletion." });

      const items = await readItems();
      const keptItems = items.filter(item => !ids.has(item.id));
      await writeItems(keptItems);
      return sendJson(res, 200, { deleted: items.length - keptItems.length, items: keptItems });
    }

    if (url.pathname === "/api/items/reorder" && req.method === "PUT") {
      const body = await parseBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (!ids.length) return sendJson(res, 400, { error: "No ids provided." });
      const items = await readItems();
      const byId = new Map(items.map(item => [item.id, item]));
      const reordered = ids.map(id => byId.get(id)).filter(Boolean);
      // Append any items whose ids were not included in the list, preserving them.
      const inList = new Set(ids);
      items.forEach(item => { if (!inList.has(item.id)) reordered.push(item); });
      await fs.writeFile(DATA_FILE, JSON.stringify(reordered, null, 2), "utf-8");
      return sendJson(res, 200, { items: reordered });
    }

    if (url.pathname === "/api/items/import-ocr" && req.method === "POST") {
      await ensureOcrInputDir();
      const result = await extractItemsFromImages(OCR_INPUT_DIR);
      if (!result.extractedItems.length) {
        return sendJson(res, 400, {
          error: result.message,
          folder: OCR_INPUT_DIR,
          imagesScanned: result.imagesScanned,
          skippedImages: result.skippedImages
        });
      }
      await writeItems(result.extractedItems);
      return sendJson(res, 200, {
        message: result.message,
        folder: OCR_INPUT_DIR,
        imagesScanned: result.imagesScanned,
        imported: result.extractedItems.length,
        skippedImages: result.skippedImages,
        items: result.extractedItems
      });
    }

    if (url.pathname === "/api/ocr/status" && req.method === "GET") {
      await ensureOcrInputDir();
      const files = await fs.readdir(OCR_INPUT_DIR);
      const images = files.filter(f => /\.(png|jpg|jpeg|bmp|webp|tiff?)$/i.test(f));
      return sendJson(res, 200, { count: images.length, files: images });
    }

    if (url.pathname === "/api/items/clear-all" && req.method === "DELETE") {
      await writeItems([]);
      return sendJson(res, 200, { cleared: true });
    }

    if (url.pathname === "/api/ocr/clear" && req.method === "DELETE") {
      await ensureOcrInputDir();
      const files = await fs.readdir(OCR_INPUT_DIR);
      const toDelete = files.filter(f =>
        /\.(png|jpg|jpeg|bmp|webp|tiff?)$/i.test(f) || f.endsWith(".ocr-raw.txt")
      );
      await Promise.all(toDelete.map(f => fs.unlink(path.join(OCR_INPUT_DIR, f))));
      return sendJson(res, 200, { cleared: toDelete.length });
    }

    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || "Server error" });
  }
});

ensureOcrInputDir()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Parts checklist running at http://localhost:${PORT}`);
      console.log(`OCR input folder: ${OCR_INPUT_DIR}`);
    });
  })
  .catch(error => {
    console.error("Failed to initialize OCR input folder", error);
    process.exit(1);
  });
