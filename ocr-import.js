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
  "roof",
  // additions
  "beam",
  "filter",
  "bar",
  "engine",
  "ladder",
  "radiator",
  "seat",
  "bumper",
]);

const TITLE_LINE_NOISE_REGEX = /\b(deliver|requested|condition|rust|polished|recompense|reward|refuse|accept|to\s+win)\b/i;

// Short OCR fragments that must never start a valid standalone item title.
// These come from misread delivery-description text ("the" → "Te", "pi" etc.)
const NOISE_START_WORDS = new Set([
  "te", "is", "in", "of", "to", "an", "and", "the", "or", "at", "by",
  "it", "as", "on", "pi", "pis", "pa", "pe", "pu", "po", "p"
]);
const PRICE_IN_LINE_REGEX   = /\$?\s*(\d[\d,.' ]{1,10})\s*[-~]\s*[\$%]{0,2}\s*(\d[\d,.' ]{1,10})/;
const PRICE_IN_LINE_REGEX_G = new RegExp(PRICE_IN_LINE_REGEX.source, "g");

// Model names that must never be treated as quest-card car names.
// These come from persistent HUD elements (HORIZONS EXPRESS score counter)
// that Tesseract reads as "EXPRESS - 34" etc.
const BLOCKED_MODEL_NAMES = new Set([
  "EXPRESS", "HORIZONS", "ACCEPT", "REFUSE", "HOME", "SHOP", "PART", "RECOMPENSE"
]);

// ─── OCR correction table ────────────────────────────────────────────────────
// Applied to the raw Tesseract output before any parsing so that every
// downstream function sees consistent car/part names.
const OCR_CORRECTIONS = [
  // Car names
  [/\bCi8\b/g,       "C18"],
  [/\bC\|8\b/g,      "C18"],
  [/\bBonphlac\b/g,  "Bonphliac"],
  [/\bBonphiac\b/g,  "Bonphliac"],
  [/\bBonphilac\b/g, "Bonphliac"],
  // Part names
  [/\bTalllight\b/gi,  "Taillight"],
  [/\bTailliaht\b/gi,  "Taillight"],
  [/\bFiiter\b/gi,     "Filter"],
  [/\bFiIter\b/gi,     "Filter"],
  // Capitalisation / shorthand fixes
  [/\bBOLF\b/g, "Bolf"],
  // Common OCR misreads for vehicle names
  [/\bTraller\b/gi, "Trailer"],
  [/\bTreller\b/gi, "Trailer"],
];

function applyOcrCorrections(text) {
  let result = String(text || "");
  for (const [pattern, replacement] of OCR_CORRECTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Strip a trailing "NN Capital-word…" sidebar suffix from a text snippet.
 *   "Rakoun plush toy 11 Cow poop"  →  "Rakoun plush toy"
 *   "p= door pi 02 Bolf - …"        →  "p= door pi"    (still rejected by uppercase check)
 * This must run BEFORE looksLikeStandaloneTitle so we never evaluate a
 * sidebar-contaminated string as a single item name.
 */
function stripSidebarSuffix(text) {
  return String(text || "")
    .replace(/\s+\d{1,2}\s+[A-Z][A-Za-z\s]*$/, "")
    .trim();
}

/**
 * Strip trailing OCR noise tokens from the raw part string extracted from a
 * title line.  Two passes:
 *   1. Remove trailing isolated punctuation/symbols (e.g. "\", " or "(a").
 *   2. Repeatedly strip 1–3 char lowercase tokens that are not real words
 *      (yo, yy, py, po, a, 7 …).
 */
function cleanNoiseSuffix(rawPart) {
  let s = rawPart.trim();
  // Pass 1a: strip trailing parenthesised noise like "(a", "(7", "(EF"
  s = s.replace(/\s*\([A-Za-z0-9]*\)?$/, "").trim();
  // Pass 1b: strip trailing isolated punctuation/symbols
  s = s.replace(/[^A-Za-z0-9\s']+$/, "").trim();
  // Pass 2: repeatedly strip short lowercase/digit noise tokens
  //   matches: "yo", "yy", "py", "a", "7", "4a", "1a" etc.
  const noiseRe = /\s+(\d+[a-z]?|[a-z]?\d+|[a-z]{1,3})$/;
  for (let i = 0; i < 5; i++) {
    const m = s.match(noiseRe);
    if (!m) break;
    const tok = m[1].replace(/\d/g, "").toLowerCase();
    if (tok && (isPartSuffixWord(tok) || isDirectionWord(tok))) break; // real word – keep
    s = s.slice(0, s.length - m[0].length).trim();
  }
  return s;
}

function looksLikeStandaloneTitle(line) {
  const value = String(line || "").trim();
  if (!value || value.length < 4 || value.length > 55) return false;
  if (TITLE_LINE_NOISE_REGEX.test(value)) return false;
  if (value.includes(" - ")) return false;
  if (PRICE_IN_LINE_REGEX.test(value)) return false;
  if (!/^[A-Z]/.test(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  // Allow single-word items (e.g. "Dashboard") when they are long enough
  if (words.length < 1 || words.length > 6) return false;
  if (words.length === 1 && value.length < 5) return false;
  // Reject if the first word is a known noise fragment from OCR delivery text
  // e.g. "Te door light Light" where "Te" is a misread of "the"
  if (NOISE_START_WORDS.has(words[0].toLowerCase())) return false;
  // Reject if the first word is suspiciously short (≤2 chars) and not a
  // known direction or part suffix word  (avoids "Te …", "Pi …" etc.)
  const firstNorm = words[0].replace(/[^A-Za-z]/g, "").toLowerCase();
  if (firstNorm.length <= 2 && !isDirectionWord(firstNorm) && !isPartSuffixWord(firstNorm)) return false;
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

/**
 * Collect all part-suffix continuation words from the line(s) immediately
 * after `index`.  Returns an ordered array so the caller can pick the word
 * that corresponds to the column position (anchorIndex) of the item in its row.
 *
 * e.g. "\ door Bumper Deliver …"  →  ["door", "Bumper"]
 *      "Beam Light Wheel Deliver…"  →  ["Beam", "Light", "Wheel"]
 */
function collectContinuationWords(lines, index) {
  const collected = [];
  for (let offset = 1; offset <= 3; offset += 1) {
    let nextLine = String(lines[index + offset] || "").trim();
    if (!nextLine) continue;
    if (/\brecompense\b|\breward\b|\baccept\b|\brefuse\b/i.test(nextLine)) break;
    if (PRICE_IN_LINE_REGEX.test(nextLine)) break;

    // Strip leading non-alpha so "\  door…" is treated as starting with "door"
    const stripped = nextLine.replace(/^[^A-Za-z]+/, "");

    // Scan for part-suffix words, also capturing a preceding direction word
    // so that e.g. "Gis Right Turnsignal" → "Right Turnsignal" (not just "Turnsignal")
    const words = stripped.split(/\s+/).filter(w => /^[A-Za-z]{2,20}$/.test(w));
    for (let wi = 0; wi < words.length; wi++) {
      if (isPartSuffixWord(words[wi])) {
        const prefix = (wi > 0 && isDirectionWord(words[wi - 1])) ? words[wi - 1] + " " : "";
        collected.push(prefix + words[wi]);
      }
    }

    // Also check Pattern C (last word of a Deliver line)
    if (/\bdeliver\b/i.test(nextLine)) {
      let pm;
      // Pattern A – "(direction )? partSuffix  Deliver"
      const patA = /\b(?:([A-Za-z]{2,20})\s+)?([A-Za-z]{2,20})\s+[Dd]eliver\b/g;
      while ((pm = patA.exec(nextLine)) !== null) {
        if (isPartSuffixWord(pm[2])) {
          const prefix = (pm[1] && isDirectionWord(pm[1])) ? pm[1] + " " : "";
          const phrase = prefix + pm[2];
          if (!collected.includes(phrase)) collected.push(phrase);
        }
      }
      const patB = /\brequested\s+([A-Za-z]{2,20})\b/g;
      while ((pm = patB.exec(nextLine)) !== null) {
        if (isPartSuffixWord(pm[1]) && !collected.includes(pm[1])) collected.push(pm[1]);
      }
      const patCm = nextLine.match(/\b([A-Za-z]{2,20})\s*$/);
      if (patCm && isPartSuffixWord(patCm[1]) && !collected.includes(patCm[1])) {
        collected.push(patCm[1]);
      }
    }

    if (collected.length > 0) break; // found words on this line — stop early
  }
  return collected;
}

function extractContinuationFromNextLine(lines, index) {
  return collectContinuationWords(lines, index)[0] || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-screenshot deduplication
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact key used when comparing items across screenshots.
 * Strips punctuation/whitespace AND applies the same OCR confusion
 * corrections used elsewhere (0→o, 1/|/!→l, 5→s) so that two reads
 * of the same card text that differ only in those substitutions still
 * produce the same key.
 */
function normalizeForMatch(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[|!1]/g, "l")
    .replace(/0/g, "o")
    .replace(/5/g, "s")
    .replace(/[^a-z]/g, "");
}

/**
 * Minimal Levenshtein distance between two strings.
 * Space-optimised O(m·n) — strings here are short so this is fast.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  // Single-row rolling DP
  let row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}

/**
 * Two normalised title keys are considered the same card when they are
 * either identical or within a small edit-distance budget (≤15% of the
 * longer string, minimum 2).  This absorbs OCR noise that survives the
 * character-substitution step above.
 */
function titlesMatch(a, b) {
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return true;
  const budget = Math.max(2, Math.floor(maxLen * 0.15));
  return editDistance(a, b) <= budget;
}

/**
 * Find how many items at the END of listA appear in the same order at the
 * START of listB.  This is the scroll-overlap that should be skipped.
 *
 * Uses fuzzy title matching so minor OCR differences between two reads of
 * the same card (different screenshot, slightly different lighting/position)
 * don't invalidate the match.
 *
 * Returns 0 when there is no overlap (safe default — nothing is dropped).
 */
function findOverlapLength(listA, listB) {
  const keysA = listA.map(item => normalizeForMatch(item.title));
  const keysB = listB.map(item => normalizeForMatch(item.title));
  const maxPossible = Math.min(keysA.length, keysB.length);
  for (let L = maxPossible; L >= 1; L--) {
    const suffixA = keysA.slice(keysA.length - L);
    const prefixB = keysB.slice(0, L);
    if (suffixA.every((k, i) => titlesMatch(k, prefixB[i]))) return L;
  }
  return 0;
}

/**
 * Merge per-screenshot item lists.
 *
 * Overlap removal is applied ONLY between the last screenshot and the
 * second-to-last screenshot.  All other screenshots are added in full so
 * that genuine duplicate quests that happen to share a title across
 * non-adjacent screenshots are never silently dropped.
 *
 * @param {{ file: string, items: Array }[]} perImage  Chronological order.
 * @returns {{ items: Array, stats: Array }}
 */
function mergeScreenshotLists(perImage) {
  if (!perImage.length) return { items: [], stats: [] };

  const result = [];
  const stats  = [];

  // ── All screenshots except the last: add every item as-is ────────────────
  for (let i = 0; i < perImage.length - 1; i++) {
    result.push(...perImage[i].items);
    stats.push({ file: perImage[i].file, total: perImage[i].items.length, skipped: 0, added: perImage[i].items.length });
  }

  // ── Last screenshot: compare only against the immediately preceding one ──
  const last = perImage[perImage.length - 1];

  if (perImage.length === 1) {
    // Single screenshot — nothing to compare against.
    result.push(...last.items);
    stats.push({ file: last.file, total: last.items.length, skipped: 0, added: last.items.length });
  } else {
    const secondToLast = perImage[perImage.length - 2];
    const overlap  = findOverlapLength(secondToLast.items, last.items);
    const newItems = last.items.slice(overlap);
    result.push(...newItems);
    stats.push({ file: last.file, total: last.items.length, skipped: overlap, added: newItems.length });
  }

  return { items: result, stats };
}

// ─────────────────────────────────────────────────────────────────────────────

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
  // Apply OCR corrections first so all downstream code sees clean text
  const text = applyOcrCorrections(String(rawText || ""))
    .replace(/\r/g, "")
    .replace(/[|]/g, "I")
    .replace(/[—–]/g, "-");

  const lines = mergeWrappedTitleLines(
    text.split("\n").map(line => line.trim()).filter(Boolean)
  );
  const titleCandidates = [];
  const priceCandidates = [];

  /**
   * MODEL_ANCHOR_REGEX: finds every "ModelName - " anchor in a line.
   * Using a position-based approach (slice between anchors) rather than a
   * greedy regex with lookahead so the LAST item in a 3-column row is never
   * silently dropped.
   */
  const MODEL_ANCHOR_REGEX = /([A-Z][A-Za-z0-9']{2,16})\s*-\s*/g;
  const noisePrefixRegex   = /^(Deliver|Refuse|Accept|Recompense|Rcompense|Reward|Color|And|ToWin|Town)$/i;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const lineHasDeliver = /\bdeliver\b/i.test(line);

    // ── Price candidates ─────────────────────────────────────────────────
    const priceRegex = PRICE_IN_LINE_REGEX_G;
    priceRegex.lastIndex = 0;
    let priceMatch;
    while ((priceMatch = priceRegex.exec(line)) !== null) {
      const price = normalizePriceRange(`${priceMatch[1]} - ${priceMatch[2]}`);
      if (price) {
        // Filter out garbage prices from decorative "A. 4 A _4" spacing lines.
        // All real quest prices start at $100+.
        const lowVal = toNumber(price.split(" - ")[0]);
        if (lowVal >= 50) priceCandidates.push({ value: price, index: lineIndex });
      }
    }

    // ── Skip delivery / price description lines for title extraction ─────
    if (lineHasDeliver || /\brecompense\b|\breward\b/i.test(line)) continue;

    // ── Title candidates: find every "Model - " anchor, slice between them ─
    MODEL_ANCHOR_REGEX.lastIndex = 0;
    const anchors = [];
    let am;
    while ((am = MODEL_ANCHOR_REGEX.exec(line)) !== null) {
      // Blocked model names: HUD elements like "HORIZONS EXPRESS - 34"
      if (BLOCKED_MODEL_NAMES.has(am[1].toUpperCase())) continue;
      // Sidebar filter: real sidebar queue entries are preceded by a 2-digit
      // number (01–21).  Single stray digits from card-border OCR noise must
      // NOT trigger this filter, so we require exactly 2 consecutive digits.
      const textBefore = line.slice(0, am.index).trim();
      if (/\b\d{2}$/.test(textBefore)) continue;
      anchors.push({ matchIndex: am.index, partStart: am.index + am[0].length, model: am[1] });
    }

    for (let ai = 0; ai < anchors.length; ai++) {
      // ── Pre-anchor text: item whose car name OCR failed to read ──────────
      // e.g. "y- ™ Right rear light yo ~\ Bonphlac - Air Filter …"
      // The "Right rear light" before the first "Model -" has no car prefix.
      if (ai === 0 && anchors[0].matchIndex > 0) {
        const raw = line.slice(0, anchors[0].matchIndex);
        let cleaned = raw.trim();
        // Strip leading OCR card-border noise: lowercase char(s) followed by noise connectors
        // e.g. "y- ™ Right…" → strips "y- ™ " → "Right…"
        cleaned = cleaned.replace(/^[a-z]{1,3}[-\s/\\~]+/, "");
        cleaned = cleaned.replace(/^[^A-Za-z]+/, "");    // strip remaining leading non-alpha
        cleaned = cleaned.replace(/[^A-Za-z\s]+\s*$/, ""); // strip trailing non-alpha (e.g. ~\)
        cleaned = cleanNoiseSuffix(cleaned.trim());        // strip trailing noise tokens (yo, yy…)
        if (cleaned && /^[A-Z]/.test(cleaned)) {
          const words = cleaned.split(/\s+/).filter(Boolean);
          const firstNorm = (words[0] || "").replace(/[^A-Za-z]/g, "").toLowerCase();
          const validFirst = firstNorm.length >= 3
            || isDirectionWord(firstNorm)
            || isPartSuffixWord(firstNorm);
          if (
            words.length >= 2 && words.length <= 5 &&
            hasKnownPartWord(cleaned) &&
            !NOISE_START_WORDS.has(firstNorm) &&
            validFirst
          ) {
            titleCandidates.push({ value: normalizeTitle(cleaned), index: lineIndex - 0.1 });
          }
        }
      }
      const { model, partStart, matchIndex } = anchors[ai];
      const nextAnchorIdx = anchors[ai + 1]?.matchIndex ?? line.length;

      // Extract raw part text between this anchor and the next (or EOL)
      let rawPart = line.slice(partStart, nextAnchorIdx).trim();

      // Clean noise suffix (yo, yy, py, (a, etc.)
      rawPart = cleanNoiseSuffix(rawPart);

      const firstWord = (rawPart.split(/\s+/)[0] || "");
      if (noisePrefixRegex.test(firstWord)) continue;

      const partSplit = splitPartAndTail(rawPart);
      let part = cleanNoiseSuffix(partSplit.part);

      // Standalone title hidden in the tail (e.g. "Dashboard" after "Bolf - Tire").
      // Strip leading non-alphanum AND leading lowercase noise words (e.g. "py ", 'a ')
      // before the real capitalised title — apply in two sweeps.
      const cleanTail = partSplit.tail
        .replace(/^[^A-Za-z0-9]+/, "")  // sweep 1: strip leading symbols
        .replace(/^[a-z0-9]+\s+/, "")   // sweep 2: strip leading lowercase/digit noise word
        .replace(/^[^A-Za-z0-9]+/, "")  // sweep 3: strip any symbols revealed by sweep 2
        .trim();
      if (looksLikeStandaloneTitle(cleanTail)) {
        titleCandidates.push({ value: normalizeTitle(cleanTail), index: lineIndex + 0.1 });
      }

      // Continuation: trigger when part ends with a direction word OR has no
      // known part suffix word yet (e.g. "High", "Steering", "Driver's", "Armored").
      // Use position-aware lookup so each column in a 3-column row gets its own
      // continuation word (avoids "door" being reused for all 3 items).
      const lastWord = (part.split(/\s+/).pop() || "");
      if (isDirectionWord(lastWord) || !hasKnownPartWord(part)) {
        const continuations = collectContinuationWords(lines, lineIndex);
        const continuation = continuations[ai] ?? continuations[0] ?? "";
        if (continuation) part = `${part} ${continuation}`.trim();
      }

      const title = normalizeTitle(`${model} - ${part}`);
      if (title.length >= 5) titleCandidates.push({ value: title, index: lineIndex });
    }

    // ── Standalone titles (no hyphen) e.g. "Dashboard", "Funny rock" ────
    const lineClean = stripSidebarSuffix(line);
    if (!line.includes(" - ") && looksLikeStandaloneTitle(lineClean)) {
      if (/\bdeliver\b/i.test(lines[lineIndex + 1] || "")) {
        titleCandidates.push({ value: normalizeTitle(lineClean), index: lineIndex + 0.2 });
      }
    }

    if (lineHasDeliver) {
      const rawPrefix = line.split(/\bdeliver\b/i)[0].trim();
      const prefix = stripSidebarSuffix(rawPrefix);
      if (looksLikeStandaloneTitle(prefix)) {
        titleCandidates.push({ value: normalizeTitle(prefix), index: lineIndex - 0.2 });
      }
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
    const part  = title.slice(sepIndex + 3).trim();

    // A real part name always contains at least one letter.
    // Purely-numeric "parts" (e.g. "Express - 54") are OCR noise from HUD
    // elements like "HORIZONS EXPRESS" being misread with a garbled suffix.
    if (!/[a-zA-Z]/.test(part)) return false;

    // Remove directional-only stubs ("Poyopa - Left Rear") when the full
    // version ("Poyopa - Left Rear Light") is also present.
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
  return sharp(filePath)
    .grayscale()
    .normalize()
    .sharpen()
    .modulate({ brightness: 1.08 })
    .resize({ width: 2800, withoutEnlargement: false, fit: "inside" })
    .png()
    .toBuffer();
}

async function listImageFiles(folderPath) {
  await fs.mkdir(folderPath, { recursive: true });
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => path.join(folderPath, entry.name))
    .sort();
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
  const perImage = [];
  const skippedImages = [];
  const debugLines = [];

  try {
    for (const imagePath of imagePaths) {
      try {
        const preprocessed = await preprocessImage(imagePath);
        const result = await worker.recognize(preprocessed);
        const rawText = result.data.text || "";

        const debugPath = imagePath.replace(/\.[^.]+$/, ".ocr-raw.txt");
        await fs.writeFile(debugPath, rawText, "utf8").catch(() => {});

        debugLines.push(`=== ${path.basename(imagePath)} ===\n${rawText}\n`);
        const parsed = parseItemsFromText(rawText);
        perImage.push({ file: path.basename(imagePath), items: parsed });
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

  const { items: found, stats } = mergeScreenshotLists(perImage);

  // Log deduplication stats so the user can verify what was kept/dropped.
  if (perImage.length > 1) {
    console.log("[OCR dedup] Cross-screenshot overlap removal:");
    stats.forEach(s => {
      if (s.skipped > 0) {
        console.log(`  ${s.file}: ${s.total} items found, ${s.skipped} overlap removed → ${s.added} added`);
      } else {
        console.log(`  ${s.file}: ${s.total} items (no overlap with previous)`);
      }
    });
    console.log(`  Total after dedup: ${found.length} item(s)`);
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
