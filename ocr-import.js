const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);
const DIRECTION_WORDS = new Set(["front", "rear", "left", "right"]);
const PART_SUFFIX_WORDS = new Set([
  "door",
  "light",
  "headlight",
  "bumper",
  "grille",
  "dashboard",
  "seat",
  "hood",
  "steering",
  "wheel",
  "spoiler",
  "tire",
  "taillight",
  "signal",
  "turnsignal",
  "mirror",
  "fender",
  "window",
  "trunk",
  "gate",
  "panel",
  "roof"
]);
const TITLE_LINE_NOISE_REGEX = /\b(deliver|requested|condition|rust|polished|recompense|reward|refuse|accept|to\s+win)\b/i;
// Allow an optional % before the second number – Tesseract sometimes reads
// the $ sign in "- $618" as "-%$618" or "-%618".
const PRICE_IN_LINE_REGEX = /\$?\s*(\d[\d,.' ]{1,10})\s*[-~]\s*[\$%]{0,2}\s*(\d[\d,.' ]{1,10})/;

function normalizeWordToken(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/[|!1]/g, "l")
    .replace(/0/g, "o")
    .replace(/5/g, "s")
    .replace(/[^a-z]/g, "");
}

function isDirectionWord(word) {
  return DIRECTION_WORDS.has(normalizeWordToken(word));
}

function isPartSuffixWord(word) {
  const normalized = normalizeWordToken(word);
  if (PART_SUFFIX_WORDS.has(normalized)) return true;
  // Common OCR misses for "light" in screenshots.
  return normalized === "liaht" || normalized === "iight" || normalized === "llght";
}

function isLikelyModelWord(word) {
  const cleaned = String(word || "").replace(/[^A-Za-z0-9]/g, "");
  return /^[A-Z][a-z0-9]{2,}$/.test(cleaned);
}

function normalizeTitle(rawTitle) {
  return String(rawTitle || "")
    .replace(/[|]/g, "I")
    .replace(/[—–]/g, "-")
    .replace(/\bLiaht\b/gi, "Light")
    .replace(/\bIight\b/gi, "Light")
    .replace(/\bLlght\b/gi, "Light")
    .replace(/\bH0od\b/gi, "Hood")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\b([A-Za-z]{2,})\s+([A-Z0-9]{2,})\b/g, "$1 $2")
    .trim();
}

function toNumber(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (!digits) return null;
  return Number.parseInt(digits, 10);
}

function formatMoney(value) {
  return `$${Number(value).toLocaleString("en-US")}`;
}

function normalizePriceRange(rawPrice) {
  const compact = String(rawPrice || "")
    .replace(/[Oo]/g, "0")
    .replace(/[Ss]/g, "$")
    .replace(/\s+/g, " ");
  const match = compact.match(/\$?\s*(\d[\d,.' ]{1,10})\s*[-–~]\s*\$?\s*(\d[\d,.' ]{1,10})/);
  if (!match) return null;

  const low = toNumber(match[1]);
  const high = toNumber(match[2]);
  if (!low || !high) return null;

  return `${formatMoney(low)} - ${formatMoney(high)}`;
}

/**
 * Pre-merge pass: scan the raw OCR lines and stitch title words that Tesseract
 * placed on a separate line back onto the line where the title started.
 *
 * Two cases are handled:
 *   Case 1 – title split AFTER the hyphen:
 *     "UAZ -"          (model + hyphen, part pushed to next line)
 *     "Dashboard …"  → merged into  "UAZ - Dashboard …"
 *
 *   Case 2 – title split IN THE MIDDLE of the part text (direction word at EOL):
 *     "Poyopa - Left Rear"
 *     "Light Deliver …"  → merged into  "Poyopa - Left Rear Light"
 *     "Poyopa - Front"
 *     "Bumper …"         → merged into  "Poyopa - Front Bumper"
 */
function mergeWrappedTitleLines(lines) {
  const result = [...lines];

  for (let i = 0; i < result.length - 1; i += 1) {
    const line = result[i].trim();
    if (!line) continue;

    // ── Case 1 ──────────────────────────────────────────────────────────────
    // Line ends with "CapitalModel -" (part name is on the next line).
    if (/[A-Z][A-Za-z0-9]{1,16}\s*-\s*$/.test(line)) {
      const nextLine = result[i + 1].trim();
      if (
        nextLine &&
        !PRICE_IN_LINE_REGEX.test(nextLine) &&
        !/\brecompense\b|\breward\b|\baccept\b|\brefuse\b/i.test(nextLine) &&
        // Don't merge if the next line already looks like a fresh "Model - …" title.
        !/^[A-Z][A-Za-z0-9]{1,16}\s*-\s*/.test(nextLine)
      ) {
        result[i] = line + " " + nextLine;
        result[i + 1] = "";
      }
      continue; // already handled this line
    }

    // ── Case 2 ──────────────────────────────────────────────────────────────
    // Line ends with a direction word (e.g. "Left Rear", "Front", "Right")
    // AND the next line starts with a part-suffix word (e.g. "Light", "Bumper").
    // Skip description / noise lines – they can also end in a direction word.
    if (TITLE_LINE_NOISE_REGEX.test(line)) continue;

    const lineWords = line.split(/\s+/).filter(Boolean);
    const lastWord = lineWords[lineWords.length - 1] || "";
    if (!isDirectionWord(lastWord)) continue;

    const nextLine = (result[i + 1] || "").trim();
    if (!nextLine) continue;
    if (PRICE_IN_LINE_REGEX.test(nextLine)) continue;
    if (/\brecompense\b|\breward\b|\baccept\b|\brefuse\b/i.test(nextLine)) continue;

    const nextWords = nextLine.split(/\s+/).filter(Boolean);
    const firstNextWord = nextWords[0] || "";
    if (firstNextWord && isPartSuffixWord(firstNextWord)) {
      // Stitch the part-suffix word onto the current line and remove it from next.
      result[i] = line + " " + firstNextWord;
      result[i + 1] = nextWords.slice(1).join(" ");
    }
  }

  return result.filter(l => l.trim() !== "");
}

function looksLikeStandaloneTitle(line) {
  const value = String(line || "").trim();
  if (!value || value.length < 4 || value.length > 55) return false;
  if (TITLE_LINE_NOISE_REGEX.test(value)) return false;
  if (value.includes(" - ")) return false;
  if (PRICE_IN_LINE_REGEX.test(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 6) return false;
  // Keep phrases like "Rakoun plush toy" but avoid mostly numeric garbage.
  const alphaChars = (value.match(/[A-Za-z]/g) || []).length;
  return alphaChars >= Math.ceil(value.length * 0.55);
}

function splitPartAndTail(partRaw) {
  const words = String(partRaw || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { part: "", tail: "" };

  let splitAt = words.length;
  let seenPartWord = false;

  for (let i = 0; i < words.length; i += 1) {
    const current = words[i];
    if (isPartSuffixWord(current)) seenPartWord = true;

    const next = words[i + 1];
    if (!next) continue;

    // Once we have seen a real part-suffix word (e.g. "hood", "door", "light"),
    // any following word that is NOT itself a direction or part word starts a new
    // title (handles both "Cow poop" and "rakoun plush toy" regardless of case).
    if (
      seenPartWord &&
      !isDirectionWord(next) &&
      !isPartSuffixWord(next)
    ) {
      splitAt = i + 1;
      break;
    }
  }

  if (splitAt > 6) splitAt = 6;
  const part = words.slice(0, splitAt).join(" ");
  const tail = words.slice(splitAt).join(" ");
  return { part, tail };
}

function extractContinuationFromNextLine(lines, index) {
  // Look up to 3 lines ahead so we can skip past a card's description line
  // ("Deliver the part...") and still find a wrapped title word like "Light".
  for (let offset = 1; offset <= 3; offset += 1) {
    let nextLine = String(lines[index + offset] || "").trim();
    if (!nextLine) continue;

    // Hard stops – reward/price lines belong to a different card card section.
    if (/\brecompense\b|\breward\b|\baccept\b|\brefuse\b/i.test(nextLine)) return "";
    if (PRICE_IN_LINE_REGEX.test(nextLine)) return "";

    // Quick win: if the line starts with a part-suffix word it is almost certainly
    // the wrapped second line of the current card title (e.g. "Light" after "Left Rear").
    const firstWordMatch = nextLine.match(/^([A-Za-z]{2,20})/);
    const firstWord = firstWordMatch ? firstWordMatch[1] : "";
    if (firstWord && isPartSuffixWord(firstWord)) return firstWord;

    // Description lines ("Deliver the part…") don't terminate the search, but
    // the wrapped title word is often embedded directly inside them.
    // Two patterns seen in practice:
    //   Pattern A – word just BEFORE a "Deliver" keyword
    //     e.g. "pa Deliver … Light Deliver …"  →  parts: "Light"
    //   Pattern B – word just AFTER a "requested" keyword
    //     e.g. "Deliver … requested bumper"    →  parts: "bumper"
    //     e.g. "Deliver … requested Light Deliver …" → "Light"
    if (/\bdeliver\b/i.test(nextLine)) {
      let m;
      // Pattern A
      const patA = /\b([A-Za-z]{2,20})\s+[Dd]eliver\b/g;
      while ((m = patA.exec(nextLine)) !== null) {
        if (isPartSuffixWord(m[1])) return m[1];
      }
      // Pattern B
      const patB = /\brequested\s+([A-Za-z]{2,20})\b/g;
      while ((m = patB.exec(nextLine)) !== null) {
        if (isPartSuffixWord(m[1])) return m[1];
      }
      continue; // genuine description, keep looking in next lines
    }

    // Strip obvious concatenated title chunks like "GTR - Hood" so they don't
    // confuse the run-detection below.
    nextLine = nextLine.replace(/\b[A-Z0-9][A-Za-z0-9]{1,16}\s*-\s*[A-Za-z0-9][A-Za-z0-9 '/()]{1,40}/g, " ").trim();
    if (!nextLine) continue;

    const words = nextLine.match(/[A-Za-z]{2,20}/g) || [];
    if (!words.length) {
      // Unrecognisable line – stop looking to avoid walking past card boundary.
      break;
    }

    const runs = [];
    let currentRun = [];
    let startIndex = -1;

    for (let i = 0; i < words.length; i += 1) {
      const word = words[i];
      if (isPartSuffixWord(word) || isDirectionWord(word)) {
        if (currentRun.length === 0) startIndex = i;
        currentRun.push(word);
        if (currentRun.length >= 3) {
          runs.push({ words: [...currentRun], start: startIndex });
          currentRun = [];
          startIndex = -1;
        }
      } else if (currentRun.length) {
        runs.push({ words: [...currentRun], start: startIndex });
        currentRun = [];
        startIndex = -1;
      }
    }
    if (currentRun.length) runs.push({ words: [...currentRun], start: startIndex });
    if (!runs.length) {
      // No direction/part words in this line; it's unrelated content – stop.
      break;
    }

    // Prefer runs that contain a concrete part word; tie-break by earlier appearance.
    runs.sort((a, b) => {
      const aPart = a.words.some(isPartSuffixWord) ? 1 : 0;
      const bPart = b.words.some(isPartSuffixWord) ? 1 : 0;
      if (aPart !== bPart) return bPart - aPart;
      if (a.words.length !== b.words.length) return b.words.length - a.words.length;
      return a.start - b.start;
    });

    return runs[0].words.join(" ");
  }

  return "";
}

function hasKnownPartWord(partText) {
  const words = String(partText || "").toLowerCase().split(/\s+/).filter(Boolean);
  return words.some(word => isPartSuffixWord(word));
}

function isDirectionalOnlyPart(partText) {
  const words = String(partText || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  return words.every(word => isDirectionWord(word));
}

function parseItemsFromText(rawText) {
  const text = String(rawText || "")
    .replace(/\r/g, "")
    .replace(/[|]/g, "I")
    .replace(/[—–]/g, "-");
  // Pre-merge: stitch title words that OCR placed on a separate line back onto
  // the line where the title started (handles "UAZ -\nDashboard" and
  // "Left Rear\nLight" type wrapping).
  const lines = mergeWrappedTitleLines(
    text.split("\n").map(line => line.trim()).filter(Boolean)
  );
  const titleCandidates = [];
  const priceCandidates = [];

  // Matches multiple title chunks on one OCR line, e.g. "A - B C - D".
  const titleChunkRegex = /([A-Z0-9][A-Za-z0-9]{1,16})\s*-\s*([A-Za-z0-9][A-Za-z0-9 '/()]{1,60}?)(?=\s+[A-Z0-9][A-Za-z0-9]{1,16}\s*-\s*|$)/g;
  const noisePrefixRegex = /^(Deliver|Refuse|Accept|Recompense|Rcompense|Reward|Color|And|ToWin|Town)$/i;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];

    const lineHasDeliver = /\bdeliver\b/i.test(line);
    titleChunkRegex.lastIndex = 0;
    let titleMatch;
    while ((titleMatch = titleChunkRegex.exec(line)) !== null) {
      const model = titleMatch[1];
      let part = titleMatch[2].trim();
      const firstWord = part.split(/\s+/)[0] || "";
      if (noisePrefixRegex.test(firstWord)) continue;

      const partSplit = splitPartAndTail(part);
      part = partSplit.part;

      if (looksLikeStandaloneTitle(partSplit.tail)) {
        titleCandidates.push({ value: normalizeTitle(partSplit.tail), index: lineIndex + 0.1 });
      }

      const partWords = part.split(/\s+/);
      const lastWord = partWords[partWords.length - 1] || "";
      if (isDirectionWord(lastWord)) {
        const continuation = extractContinuationFromNextLine(lines, lineIndex);
        if (continuation) part = `${part} ${continuation}`;
      }

      const title = normalizeTitle(`${model} - ${part}`);
      if (title.length >= 5) titleCandidates.push({ value: title, index: lineIndex });
    }

    // Handle titles without a hyphen (for example plushy names) near each card's description line.
    if (!lineHasDeliver && looksLikeStandaloneTitle(line) && /\bdeliver\b/i.test(lines[lineIndex + 1] || "")) {
      titleCandidates.push({ value: normalizeTitle(line), index: lineIndex + 0.2 });
    }

    if (lineHasDeliver) {
      const prefix = line.split(/\bdeliver\b/i)[0].trim();
      if (looksLikeStandaloneTitle(prefix)) {
        titleCandidates.push({ value: normalizeTitle(prefix), index: lineIndex - 0.2 });
      }
    }

    const priceInLineRegex = new RegExp(PRICE_IN_LINE_REGEX.source, "g");
    let priceMatch;
    while ((priceMatch = priceInLineRegex.exec(line)) !== null) {
      const price = normalizePriceRange(`${priceMatch[1]} - ${priceMatch[2]}`);
      if (price) priceCandidates.push({ value: price, index: lineIndex });
    }
  }

  titleCandidates.sort((a, b) => a.index - b.index);

  const pairs = [];
  const pushed = new Set();
  const maxPairs = Math.min(titleCandidates.length, priceCandidates.length);
  for (let i = 0; i < maxPairs; i += 1) {
    const title = titleCandidates[i].value;
    const price = priceCandidates[i].value;
    const key = `${title}|${price}`;
    if (pushed.has(key)) continue;
    pushed.add(key);
    pairs.push({ title, price });
  }

  return pairs.filter((item, _, allItems) => {
    const title = String(item.title || "");
    const sepIndex = title.indexOf(" - ");
    if (sepIndex < 0) return true;
    const model = title.slice(0, sepIndex).trim();
    const part = title.slice(sepIndex + 3).trim();
    if (!isDirectionalOnlyPart(part)) return true;

    const prefix = `${model} - ${part} `;
    return !allItems.some(other => {
      if (other === item) return false;
      if (!String(other.title || "").startsWith(prefix)) return false;
      const otherPart = String(other.title).slice(sepIndex + 3).trim();
      return hasKnownPartWord(otherPart);
    });
  });
}

async function preprocessImage(filePath) {
  // Slight upscaling + grayscale helps OCR accuracy for compact card text.
  return sharp(filePath)
    .grayscale()
    .normalize()
    .sharpen()
    .modulate({ brightness: 1.08, saturation: 0 })
    .resize({ width: 2800, withoutEnlargement: false, fit: "inside" })
    .png()
    .toBuffer();
}

async function listImageFiles(folderPath) {
  await fs.mkdir(folderPath, { recursive: true });
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => path.join(folderPath, entry.name));
}

function toChecklistItems(extractedItems) {
  return extractedItems.map((item, index) => ({
    id: `item-ocr-${Date.now()}-${String(index + 1).padStart(4, "0")}-${crypto.randomBytes(2).toString("hex")}`,
    title: item.title,
    price: item.price,
    sent: false
  }));
}

async function extractItemsFromImages(folderPath) {
  const imagePaths = await listImageFiles(folderPath);
  if (!imagePaths.length) {
    return {
      imagesScanned: 0,
      extractedItems: [],
      skippedImages: [],
      message: "No images found in OCR folder."
    };
  }

  const worker = await createWorker("eng");
  const found = [];
  const skippedImages = [];
  // Accumulate raw OCR text for each image so it can be inspected when titles
  // are missing or mis-parsed.
  const debugLines = [];

  try {
    for (const imagePath of imagePaths) {
      try {
        const preprocessed = await preprocessImage(imagePath);
        const result = await worker.recognize(preprocessed);
        const rawText = result.data.text || "";

        // Save raw OCR text next to the source image (same folder, .txt extension).
        const debugPath = imagePath.replace(/\.[^.]+$/, ".ocr-raw.txt");
        await fs.writeFile(debugPath, rawText, "utf8").catch(() => {});

        debugLines.push(`=== ${path.basename(imagePath)} ===\n${rawText}\n`);
        const parsed = parseItemsFromText(rawText);
        found.push(...parsed);
      } catch (error) {
        skippedImages.push({
          file: path.basename(imagePath),
          error: error.message || "Could not OCR image"
        });
      }
    }
  } finally {
    await worker.terminate();
  }

  return {
    imagesScanned: imagePaths.length,
    extractedItems: toChecklistItems(found),
    skippedImages,
    message: found.length ? "OCR import completed." : "OCR completed, but no valid title/price pairs were found."
  };
}

module.exports = {
  extractItemsFromImages,
  parseItemsFromText
};
