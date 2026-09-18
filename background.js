/* ---------------------------------------------------------------------------
 * background.js - MV3 service worker
 *
 * Responsibilities
 *   1. Own the data model in chrome.storage.local ("sortedPosts").
 *   2. Receive passively collected posts from content-scripts/collector.js.
 *   3. Classify un-classified posts with the DeepSeek vision model.
 *   4. Write classified posts into Instagram collections by injecting
 *      content-scripts/writer.js into a background tab per post.
 *
 * Nothing here ever touches the user's Instagram credentials: the write-back
 * phase reuses the cookies the browser already holds for instagram.com.
 * ------------------------------------------------------------------------ */

"use strict";

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

const INSTAGRAM_TABS_URL = "https://www.instagram.com/*";

const KEYS = {
  posts: "sortedPosts",
  settings: "settings",
  job: "jobState",
  probe: "lastProbe",
  diagnosis: "lastDiagnosis"
};

const DEFAULT_CATEGORIES = [
  "food",
  "workout",
  "fashion",
  "memes",
  "travel",
  "study_tips",
  "other"
];

const REQUEST_TIMEOUT_MS = 60000;

const CLASSIFY_RETRIES = 3;
const DEFAULT_CONCURRENCY = 3;
// The JSON answer is ~30 tokens, but "thinking" models (Gemini Flash and
// friends) spend output tokens on reasoning first, so a tight cap truncates the
// JSON mid-object. We start roomy and grow further if the provider says the
// output was cut off.
const MAX_OUTPUT_TOKENS = 1000;

/**
 * Model providers. Every one of them speaks the OpenAI chat-completions shape
 * with image_url content parts, so a single code path drives all of them.
 *
 * needsKey controls the *warning* only - the Authorization header is attached
 * whenever a key is present and omitted entirely when it is not (Ollama ignores
 * keys, and a bare "Bearer " upsets some servers). jsonMode is off for Ollama
 * because its compatibility layer is the least predictable about
 * response_format; the parser handles un-fenced JSON either way.
 *
 * Concurrency stays low for the free tiers on purpose: they rate limit per
 * minute, and a 429 storm is slower than simply being patient.
 */
const PROVIDERS = {
  deepseek: {
    label: "DeepSeek (paid)",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    needsKey: true,
    jsonMode: true,
    concurrency: 3,
    keyUrl: "https://platform.deepseek.com",
    hint: "Paid, but cheap and the widest-known vision model name."
  },
  gemini: {
    label: "Google Gemini (free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-flash-latest",
    needsKey: true,
    jsonMode: true,
    concurrency: 2,
    keyUrl: "https://aistudio.google.com/apikey",
    hint: "Free key from AI Studio. Free tier is rate limited per minute and per day."
  },
  openrouter: {
    label: "OpenRouter (free models)",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/free",
    needsKey: true,
    jsonMode: true,
    concurrency: 2,
    keyUrl: "https://openrouter.ai/keys",
    hint: "The free router picks a free vision model for you; or name one ending in :free.",
    extraHeaders: {
      "HTTP-Referer": "https://github.com/ig-saved-sorter",
      "X-Title": "IG Saved Sorter"
    }
  },
  omniroute: {
    label: "OmniRoute (local gateway, free pools)",
    baseUrl: "http://localhost:20128/v1",
    model: "auto",
    needsKey: false,
    jsonMode: true,
    concurrency: 2,
    keyUrl: null,
    hint: "Run `npm install -g omniroute` then `omniroute` (window stays open). Dashboard: localhost:20128 — connect free providers there. Model 'auto' routes across all of them."
  },
  ollama: {
    label: "Ollama (local, no key)",
    baseUrl: "http://localhost:11434/v1",
    model: "llava:7b",
    needsKey: false,
    jsonMode: false,
    concurrency: 1,
    keyUrl: null,
    hint: "Runs on this computer. Free and private. Needs OLLAMA_ORIGINS set (see README)."
  },
  custom: {
    label: "Custom OpenAI-compatible",
    baseUrl: "",
    model: "",
    needsKey: false,
    jsonMode: true,
    concurrency: 2,
    keyUrl: null,
    hint: "Any /chat/completions endpoint. Add its host to host_permissions in manifest.json first."
  }
};

const DEFAULT_PROVIDER = "deepseek";

const WRITE_DELAY_MIN_MS = 2000;
const WRITE_DELAY_MAX_MS = 4000;
const LONG_PAUSE_EVERY = 20;
const LONG_PAUSE_MIN_MS = 15000;
const LONG_PAUSE_MAX_MS = 20000;
const TAB_LOAD_TIMEOUT_MS = 30000;
const TAB_SETTLE_MS = 1500;

/*
 * How each post's tab is opened during the sort.
 *
 * Chrome throttles timers in tabs nobody is looking at (a `setTimeout(150)`
 * really fires after ~1000ms there) and does not render some offscreen UI, so a
 * hidden tab fails more often than a watched one - a run started while you
 * scroll elsewhere used to fail while the same run watched worked.
 *
 *   "never"      every tab stays in the background: quietest, but the most
 *                failures, which the writer can only partly compensate for.
 *   "on-failure" start hidden, and the moment a post fails while its tab was in
 *                the background, retry that post with the tab in front and keep
 *                the rest of the run there. (default)
 *   "always"     every post's tab opens in front, so you watch the whole run.
 */
const TAB_FOCUS_DEFAULT = "on-failure";
const TAB_FOCUS_VALUES = ["never", "on-failure", "always"];

const LOG_LIMIT = 200;

/* The classification system prompt is fixed by design - do not translate or
 * reformat it, the parser and the category guarantee both depend on it. */
const SYSTEM_PROMPT = `You are an image classifier for organizing a personal Instagram saved-posts library. You will receive one image and a fixed list of categories. Respond with ONLY valid JSON in this exact schema, nothing else: {"category": "<one of the provided categories>", "confidence": <float 0-1>}. You must choose exactly one category from the provided list. Never invent a new one. If the image doesn't clearly match any category, pick the closest fit and lower the confidence score. Do not include markdown or any text outside the JSON object.`;

/* ------------------------------------------------------------------------- *
 * Generic helpers
 * ------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

/** Error that must not be retried (bad data, not a transient failure). */
class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermanentError";
    this.permanent = true;
  }
}

/**
 * Serialises every read-modify-write of the posts array. Without this, two
 * concurrent classification results would clobber each other.
 * Never call withLock() from inside a locked function - it deadlocks.
 */
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

const log = (...args) => console.log("[IG-Sorter/bg]", ...args);

/* ------------------------------------------------------------------------- *
 * Storage layer
 * ------------------------------------------------------------------------- */

async function loadPosts() {
  const data = await chrome.storage.local.get(KEYS.posts);
  const posts = data[KEYS.posts];
  return Array.isArray(posts) ? posts : [];
}

async function savePosts(posts) {
  await chrome.storage.local.set({ [KEYS.posts]: posts });
}

/** Run `mutator(posts)` under the write lock, then persist the array. */
function updatePosts(mutator) {
  return withLock(async () => {
    const posts = await loadPosts();
    const result = await mutator(posts);
    await savePosts(posts);
    return result;
  });
}

/**
 * Merge stored settings with the provider preset. A stored model always wins,
 * so switching provider in the popup is enough to move to a free endpoint.
 */
async function getSettings() {
  const data = await chrome.storage.local.get(KEYS.settings);
  const stored = data[KEYS.settings] || {};
  const provider = PROVIDERS[stored.provider] ? stored.provider : DEFAULT_PROVIDER;
  const preset = PROVIDERS[provider];

  let baseUrl = provider === "custom" ? stored.baseUrl : preset.baseUrl;
  baseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");

  const storedKey = pickPerProvider(stored.apiKeys, provider, stored.apiKey);
  const storedModel = pickPerProvider(stored.models, provider, stored.model);

  return {
    provider,
    providerLabel: preset.label,
    providerHint: preset.hint,
    baseUrl,
    model: String(storedModel || preset.model || "").trim(),
    apiKey: storedKey,
    needsKey: !!preset.needsKey,
    jsonMode: !!preset.jsonMode,
    concurrency: preset.concurrency || DEFAULT_CONCURRENCY,
    keyUrl: preset.keyUrl || null,
    extraHeaders: preset.extraHeaders || null,
    categories:
      Array.isArray(stored.categories) && stored.categories.length
        ? stored.categories
        : DEFAULT_CATEGORIES.slice(),
    dryRun: !!stored.dryRun,
    // Every setting must be listed here: this object is a whitelist, and a field
    // missing from it is silently always-undefined no matter what the popup saved.
    resortUnconfirmed: !!stored.resortUnconfirmed,
    tabFocus: TAB_FOCUS_VALUES.includes(stored.tabFocus)
      ? stored.tabFocus
      : TAB_FOCUS_DEFAULT
  };
}

/**
 * Per-provider values with a legacy single-value fallback (only meaningful for
 * DeepSeek, which is what the first version of this extension shipped with).
 */
function pickPerProvider(map, provider, legacyValue) {
  if (map && typeof map[provider] === "string" && map[provider]) return map[provider];
  if (provider === DEFAULT_PROVIDER && typeof legacyValue === "string" && legacyValue) {
    return legacyValue;
  }
  return "";
}

/** Reject a config that cannot work before a batch starts failing post by post. */
function validateProvider(settings) {
  if (!settings.baseUrl) return "Set a base URL for the custom provider.";
  if (!settings.model) return "Set a model name.";
  if (settings.needsKey && !settings.apiKey) {
    return `Add your ${settings.providerLabel} API key first.`;
  }
  return null;
}

async function setSettings(patch) {
  return withLock(async () => {
    const data = await chrome.storage.local.get(KEYS.settings);
    const stored = data[KEYS.settings] || {};
    const next = { ...stored };

    for (const key of [
      "provider",
      "baseUrl",
      "categories",
      "dryRun",
      "resortUnconfirmed",
      "tabFocus"
    ]) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    if (Array.isArray(next.categories)) next.categories = sanitizeCategories(next.categories);
    // An unknown value would silently behave like the default; drop it so the
    // stored settings only ever hold a value the popup can also render.
    if (next.tabFocus !== undefined && !TAB_FOCUS_VALUES.includes(next.tabFocus)) {
      delete next.tabFocus;
    }

    const provider = PROVIDERS[next.provider] ? next.provider : DEFAULT_PROVIDER;

    // Models and keys are stored per provider: switching between a free endpoint
    // and a paid one must not carry the other one's model or key across.
    if (typeof patch.model === "string") {
      const models = { ...(stored.models || {}) };
      const trimmed = patch.model.trim();
      if (trimmed) models[provider] = trimmed;
      else delete models[provider];
      next.models = models;
      // Legacy single-model field, kept so pre-existing data keeps working.
      if (provider === "deepseek") next.model = models[provider] || "";
    }

    if (typeof patch.apiKey === "string") {
      const keys = { ...(stored.apiKeys || {}) };
      const trimmed = patch.apiKey.trim();
      if (trimmed) keys[provider] = trimmed;
      else delete keys[provider];
      next.apiKeys = keys;
      if (provider === "deepseek") next.apiKey = keys[provider] || "";
    }

    await chrome.storage.local.set({ [KEYS.settings]: next });
    return next;
  });
}

/** The resolved shape the popup renders. */
async function publicSettings() {
  const settings = await getSettings();
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    needsKey: settings.needsKey,
    categories: settings.categories,
    dryRun: settings.dryRun,
    tabFocus: settings.tabFocus
  };
}

function sanitizeCategories(input) {
  const cleaned = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().replace(/\s+/g, "_");
    if (!name || name.length > 40) continue;
    if (!cleaned.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      cleaned.push(name);
    }
  }
  return cleaned.length ? cleaned.slice(0, 30) : DEFAULT_CATEGORIES.slice();
}

/* ------------------------------------------------------------------------- *
 * Job state (rendered by the popup)
 * ------------------------------------------------------------------------- */

const runtime = { running: false, phase: null, stop: false };

// Chrome may terminate an idle service worker; the resumable design means a
// terminated run is never data loss, but a cheap keepalive keeps long write-back
// runs (which sleep for up to 20s at a time) in one piece.
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
}
function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

function freshJob() {
  return {
    running: false,
    phase: null,
    label: "Idle",
    done: 0,
    total: 0,
    startedAt: null,
    finishedAt: null,
    log: []
  };
}

function getJob() {
  return chrome.storage.local
    .get(KEYS.job)
    .then((data) => ({ ...freshJob(), ...(data[KEYS.job] || {}) }));
}

function patchJob(patch) {
  return withLock(async () => {
    const data = await chrome.storage.local.get(KEYS.job);
    const next = { ...freshJob(), ...(data[KEYS.job] || {}), ...patch };
    await chrome.storage.local.set({ [KEYS.job]: next });
    return next;
  });
}

/** Append to the popup-visible log without racing on jobState. */
async function pushLog(level, message) {
  await withLock(async () => {
    const data = await chrome.storage.local.get(KEYS.job);
    const job = { ...freshJob(), ...(data[KEYS.job] || {}) };
    job.log = [...job.log, { t: Date.now(), level, message }].slice(-LOG_LIMIT);
    await chrome.storage.local.set({ [KEYS.job]: job });
  });
}

async function isStopRequested() {
  if (runtime.stop) return true;
  const { stopRequested } = await chrome.storage.local.get("stopRequested");
  runtime.stop = !!stopRequested;
  return runtime.stop;
}

async function beginJob(phase, label, total) {
  runtime.running = true;
  runtime.phase = phase;
  runtime.stop = false;
  await chrome.storage.local.set({ stopRequested: false });
  startKeepAlive();
  await patchJob({
    running: true,
    phase,
    label,
    done: 0,
    total,
    startedAt: Date.now(),
    finishedAt: null
  });
}

async function endJob(label) {
  runtime.running = false;
  runtime.phase = null;
  stopKeepAlive();
  await patchJob({ running: false, phase: null, label, finishedAt: Date.now() });
}

/* ------------------------------------------------------------------------- *
 * Phase 1 - collection (passive)
 * ------------------------------------------------------------------------- */

async function addCollectedPosts(incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return { added: 0, refreshed: 0 };

  return updatePosts((posts) => {
    const index = new Map(posts.map((post, i) => [post.shortcode, i]));
    let added = 0;
    let refreshed = 0;

    for (const record of incoming) {
      const shortcode = record && record.shortcode;
      if (!shortcode) continue;

      const existingIdx = index.get(shortcode);
      if (existingIdx != null) {
        const existing = posts[existingIdx];
        // Instagram CDN thumbnail URLs are signed and expire, so refresh a
        // stale URL while re-scrolling. Never touch posts already written.
        if (
          record.thumbnailUrl &&
          record.thumbnailUrl !== existing.thumbnailUrl &&
          existing.status !== "written"
        ) {
          existing.thumbnailUrl = record.thumbnailUrl;
          if (existing.error === "thumbnail_expired" || existing.error === "no_thumbnail") {
            existing.error = null;
            existing.status = "collected";
          }
          refreshed++;
        }
        continue;
      }

      posts.push({
        postId: record.postId || shortcode,
        shortcode,
        mediaType: record.mediaType || "p",
        thumbnailUrl: record.thumbnailUrl || null,
        category: null,
        confidence: null,
        status: "collected",
        source: record.source || "saved-grid",
        collectedAt: record.collectedAt || Date.now(),
        classifiedAt: null,
        writtenAt: null,
        error: null,
        failedStage: null
      });
      index.set(shortcode, posts.length - 1);
      added++;
    }

    return { added, refreshed, total: posts.length };
  });
}

/** Tell every open Instagram tab to forget what it has already sent. */
async function resetCollectors() {
  const patterns = [INSTAGRAM_TABS_URL];
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: patterns });
  } catch (error) {
    log("tab query failed", error);
  }
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs
        .sendMessage(tab.id, { type: "RESET_COLLECTOR" })
        .catch(() => {})
    )
  );
}

/**
 * Ask the collector in every Instagram tab what it can see. This is the check
 * that separates the three ways "I scrolled and nothing was collected" happens:
 * no tab open, the script missing/stale in the tab, or the script alive on a page
 * that is not a Saved page. No network calls, no writes - safe to poll.
 */
async function pingCollectors() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: [INSTAGRAM_TABS_URL] });
  } catch (error) {
    log("pingCollectors: tab query failed", error);
  }

  const collectors = [];
  let stale = 0;
  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "COLLECTOR_PING" });
      if (response && response.ok) {
        collectors.push({ tabId: tab.id, url: tab.url, ...response });
        continue;
      }
    } catch {
      /* no content script in that tab */
    }
    stale++;
  }

  // The scan report is nested under `report` in the collector's reply. Reading
  // `item.anchors` off the top level (as an earlier version did) always yielded
  // undefined, which made the diagnosis claim the grid had not rendered even
  // when the page was full of posts.
  const reports = collectors.map((item) => item.report).filter(Boolean);
  const sum = (key) =>
    reports.reduce((total, report) => total + (Number(report[key]) || 0), 0);
  const pick = (key) => reports.map((report) => report[key]).find((value) => value) || null;

  return {
    tabs: tabs.length,
    stale,
    live: collectors.length,
    targets: collectors.filter((item) => item.isTarget).length,
    savedPages: collectors.filter((item) => item.onSavedPage).length,
    seen: collectors.reduce((total, item) => total + (Number(item.seen) || 0), 0),
    anchors: sum("anchors"),
    parsed: sum("parsed"),
    withThumbnail: sum("withThumbnail"),
    linksWithImage: sum("linksWithImage"),
    totalAnchors: sum("totalAnchors"),
    awaitingThumbnail: collectors.reduce(
      (total, item) => total + (Number(item.awaitingThumbnail) || 0),
      0
    ),
    unmatchedHrefs: reports.flatMap((report) => report.unmatchedHrefs || []).slice(0, 6),
    sampleHrefs: reports.flatMap((report) => report.sampleHrefs || []).slice(0, 12),
    sampleShortcodes: reports.flatMap((report) => report.sampleShortcodes || []).slice(0, 6),
    sampleTileHtml: pick("sampleTileHtml"),
    scanRoot: pick("root"),
    scanError: pick("lastScanError"),
    collectors
  };
}

/** The badge is the only live feedback the user gets while scrolling. */
async function setBadgeCount(count) {
  try {
    await chrome.action.setBadgeText({ text: count ? String(count) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#d62976" });
  } catch (error) {
    log("badge update failed", error);
  }
}

/* ------------------------------------------------------------------------- *
 * Phase 2 - classification
 * ------------------------------------------------------------------------- */

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function guessMimeType(url) {
  if (/\.png(\?|$)/i.test(url)) return "image/png";
  if (/\.webp(\?|$)/i.test(url)) return "image/webp";
  if (/\.gif(\?|$)/i.test(url)) return "image/gif";
  return "image/jpeg";
}

/** Download a thumbnail and turn it into a data: URL for the vision model. */
async function fetchImageAsDataUrl(url) {
  const response = await fetch(url, { credentials: "omit", redirect: "follow" });
  if (!response.ok) {
    if (response.status === 403 || response.status === 401 || response.status === 410) {
      throw new PermanentError("thumbnail_expired");
    }
    throw new Error(`image_http_${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) throw new Error("image_empty");
  const contentType = (response.headers.get("content-type") || guessMimeType(url))
    .split(";")[0]
    .trim();
  return `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
}

/** Generic exponential-backoff retry. Honours PermanentError and the stop flag. */
async function withRetries(fn, attempts, label) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (error && error.permanent) break;
      if (await isStopRequested()) break;
      if (attempt < attempts - 1) {
        const delay = Math.min(8000, 700 * Math.pow(2, attempt)) + rand(0, 400);
        log(`${label}: attempt ${attempt + 1} failed (${error.message}), retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A short, readable excerpt of what the model actually said. */
function summarizeText(text, limit = 160) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "(empty reply)";
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Every complete, brace-balanced JSON object in arbitrary text.
 *
 * A first-{ to last-} slice is not good enough: models echo the schema from the
 * system prompt, write reasoning first, or answer twice, and a slice spanning
 * two objects is invalid JSON. This scans character by character, is aware of
 * strings and escapes, and only yields objects that actually close.
 */
function extractJsonCandidates(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

/** Validate a parsed object against the configured category list. */
function normalizeClassification(parsed, categories) {
  const rawCategory = String(parsed.category || "").trim();
  const match = categories.find(
    (candidate) => candidate.toLowerCase() === rawCategory.toLowerCase()
  );

  let category = match;
  let confidence = Number(parsed.confidence);

  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  if (!category) {
    // The prompt forbids inventing categories, but never trust the model.
    const fallback = categories.find((candidate) => /^other$/i.test(candidate));
    if (!fallback) throw new Error(`category_not_in_list:${rawCategory}`);
    category = fallback;
    confidence = confidence * 0.5;
  }

  const result = { category, confidence: Number(confidence.toFixed(3)) };
  if (!match) result.warning = `category_not_in_list:${rawCategory}->${category}`;
  return result;
}

/**
 * Turn whatever the model said into a category, or fail with an explanation.
 * Robust because model output formatting is the least reliable part of this
 * pipeline: fences, schema echoes, reasoning, prose and truncation all happen.
 */
function parseClassification(raw, categories) {
  const text = String(raw || "").trim();
  const candidates = [];

  // An explicit fenced block is the strongest signal when present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(...extractJsonCandidates(fenced[1]));
  candidates.push(...extractJsonCandidates(text));

  const isListed = (value) =>
    categories.find(
      (candidate) => candidate.toLowerCase() === String(value || "").trim().toLowerCase()
    );

  // Two passes of the same list: an object whose category is one of ours is a
  // real answer, so it beats an earlier object that merely *parsed* - models
  // sometimes echo an example like {"category":"example"} before answering.
  let firstParseable = null;
  for (const candidate of candidates) {
    let parsed = null;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // A trailing comma is the most common model slip; one cheap retry.
      try {
        parsed = JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
      } catch {
        continue;
      }
    }
    if (!parsed || typeof parsed !== "object") continue;
    if (typeof parsed.category === "string") {
      if (isListed(parsed.category)) return normalizeClassification(parsed, categories);
      if (!firstParseable) firstParseable = parsed;
    } else if (!firstParseable) {
      firstParseable = parsed;
    }
  }

  if (firstParseable && typeof firstParseable.category !== "undefined") {
    return normalizeClassification(firstParseable, categories);
  }

  // The JSON never closed, but the category field itself may be intact. Reading
  // the field the model actually wrote beats failing the post; the low
  // confidence and the warning are what keep this honest.
  const fieldMatch = text.match(/"category"\s*:\s*"([^"]+)"/i);
  const recovered = fieldMatch && isListed(fieldMatch[1]);
  if (recovered) {
    return {
      category: recovered,
      confidence: 0.3,
      warning: "category_recovered_from_partial_json"
    };
  }

  // Last resort: the answer is prose naming exactly one of the categories. With
  // two or more named (usually because the prompt itself was echoed) guessing
  // would be worse than failing.
  const mentioned = categories.filter((category) =>
    new RegExp(`(^|[^\\w])${escapeRegExp(category)}([^\\w]|$)`, "i").test(text)
  );
  if (mentioned.length === 1) {
    return {
      category: mentioned[0],
      confidence: 0.3,
      warning: "category_inferred_from_text"
    };
  }

  throw new Error(
    `classification_not_json: expected {"category":…,"confidence":…}, got: ${summarizeText(text)}`
  );
}

/**
 * A provider-wide failure (bad key, unknown model, no vision support). Retrying
 * it for every remaining post just burns time, so the batch is aborted instead.
 */
class FatalError extends Error {
  constructor(message) {
    super(message);
    this.name = "FatalError";
    this.permanent = true;
    this.fatal = true;
  }
}

/**
 * Does a 429 body describe an exhausted *daily* quota rather than a per-minute
 * rate limit? Waiting fixes one and not the other, so the two must not be
 * handled the same way. Providers name the bucket in the body: Gemini says
 * "... requests per day" / "per minute", OpenRouter says "free-models-per-day"
 * / "free-models-per-min".
 */
function isDailyQuota(body) {
  return /per[\s_-]?day|\bdaily\b/i.test(String(body || ""));
}

/**
 * The informative part of a rate-limit body.
 *
 * Providers bury the answer - which limit, and how long until it resets - behind
 * a paragraph of boilerplate. A blanket 300-character excerpt cut off exactly
 * that clause, because it sits *after* the preamble, so the user saw "Quota
 * exceeded fo…" and could not tell a per-minute limit from a daily one.
 */
function quotaSummary(body) {
  const text = String(body || "");
  const bits = [];
  const limit = text.match(/limit\s*'([^']+)'/i);
  const metric = text.match(/quota metric\s*'([^']+)'/i);
  const quotaId = text.match(/"quotaId"\s*:\s*"([^"]+)"/i);
  const retry = text.match(/"retryDelay"\s*:\s*"([^"]+)"/i);
  if (limit) bits.push(limit[1]);
  else if (metric) bits.push(metric[1]);
  else if (quotaId) bits.push(quotaId[1]);
  if (retry) bits.push(`retry after ${retry[1]}`);
  return bits.length
    ? bits.join(" · ")
    : text.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Turn an HTTP failure into an error that says what the user should do. */
function providerError(status, body, settings) {
  const detail = String(body || "").replace(/\s+/g, " ").slice(0, 300);
  const who = settings.provider;
  if (status === 401 || status === 403) {
    return new FatalError(`${who}_auth_${status}: the API key was rejected (${detail})`);
  }
  if (status === 404) {
    return new FatalError(
      `${who}_404: model "${settings.model}" was not found at ${settings.baseUrl} (${detail})`
    );
  }
  if (status === 400 && /vision|image|multimodal|modality/i.test(detail)) {
    return new FatalError(
      `${who}_no_vision: model "${settings.model}" refused the image (${detail})`
    );
  }
  if (status === 429) {
    const summary = quotaSummary(body);
    if (isDailyQuota(body)) {
      // A per-day free quota does not recover while this run is going, so treat
      // it like a bad key: abort once rather than retry it for every remaining
      // post and mark the whole library failed.
      return new FatalError(
        `${who}_quota_exhausted: this provider's free quota is used up (${summary}). ` +
          `Switch provider, or wait for the reset and re-run - nothing already classified is lost.`
      );
    }
    // Per-minute limits are worth waiting out.
    return new Error(`${who}_rate_limited_429: ${summary}`);
  }
  return new Error(`${who}_http_${status}: ${detail}`);
}

/**
 * Flatten an OpenAI-compatible `message` into plain text.
 *
 * The spec says content is a string, but real implementations also return an
 * array of parts ({type:"text",text:"..."}) or an object, and thinking models
 * may put the answer in reasoning_content with content left empty. Stringifying
 * any of those yields "[object Object]" and a bogus "not JSON" error.
 */
function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const parts = [];
  const collect = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (typeof value === "object") {
      for (const key of ["text", "content", "value"]) {
        if (typeof value[key] === "string") {
          parts.push(value[key]);
          return;
        }
      }
    }
  };
  collect(message.content);
  // Reasoning models sometimes leave content empty and answer in the reasoning.
  if (!parts.join("").trim()) {
    collect(message.reasoning_content || message.reasoning);
  }
  return parts.join("\n").trim();
}

async function callModel(settings, categories, dataUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  if (settings.extraHeaders) Object.assign(headers, settings.extraHeaders);

  const body = (jsonMode, budget) => {
    const payload = {
      model: settings.model,
      stream: false,
      temperature: 0,
      max_tokens: budget,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Categories (choose exactly one): ${categories.join(", ")}`
            },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    };
    if (jsonMode) payload.response_format = { type: "json_object" };
    return payload;
  };

  try {
    let jsonMode = settings.jsonMode;
    let budget = MAX_OUTPUT_TOKENS;
    let retries = 0;

    for (;;) {
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body(jsonMode, budget)),
        signal: controller.signal
      });

      if (response.ok) {
        const payload = await response.json();
        const choice = (payload && payload.choices && payload.choices[0]) || {};
        const finish = choice.finish_reason || null;
        const text = extractMessageText(choice.message);

        // Truncated output is worth one automatic retry with a roomier budget
        // rather than burning a post on a thinking model's reasoning tokens.
        if (finish === "length" && retries < 2) {
          retries++;
          budget = budget * 4;
          log(`${settings.provider}: output hit max_tokens, retrying with ${budget}`);
          continue;
        }
        if (finish === "length") {
          // Out of retries. If the cap cut the JSON mid-object there is nothing
          // usable to parse, and "not JSON" would be a misleading error.
          const complete = extractJsonCandidates(text).some((candidate) => {
            try {
              JSON.parse(candidate);
              return true;
            } catch {
              return false;
            }
          });
          if (!complete) {
            throw new Error(
              `${settings.provider}_truncated: model "${settings.model}" hit the ${budget}-token output cap before finishing the JSON (thinking models need a larger MAX_OUTPUT_TOKENS)`
            );
          }
        }
        if (!text) {
          throw new Error(
            `${settings.provider}_empty_response${finish ? ` (finish_reason: ${finish})` : ""}`
          );
        }
        return text;
      }

      const errorText = await response.text().catch(() => "");
      if (jsonMode && /response_format|json_object|json mode/i.test(errorText) && retries < 2) {
        log(`${settings.provider}: server rejected response_format, retrying without it`);
        jsonMode = false;
        retries++;
        continue;
      }
      throw providerError(response.status, errorText, settings);
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${settings.provider}_timeout after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    if (error instanceof TypeError && /localhost|127\.0\.0\.1/.test(settings.baseUrl)) {
      // A refused connection to a local gateway reads as "Failed to fetch",
      // which says nothing about the actual cause: the gateway is not running.
      throw new Error(
        `${settings.provider}_not_running: nothing answered at ${settings.baseUrl}. ` +
          `Start the gateway first ("omniroute" or "ollama serve" in a terminal, window left open), then press Test.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function classifyOne(post, settings, categories) {
  if (!post.thumbnailUrl) throw new PermanentError("no_thumbnail");
  return withRetries(
    async () => {
      const dataUrl = await fetchImageAsDataUrl(post.thumbnailUrl);
      const raw = await callModel(settings, categories, dataUrl);
      return parseClassification(raw, categories);
    },
    CLASSIFY_RETRIES,
    `classify ${post.shortcode}`
  );
}

/** Simple bounded-concurrency pool. */
async function runPool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (await isStopRequested()) return;
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function runClassifyJob() {
  const settings = await getSettings();

  const configProblem = validateProvider(settings);
  if (configProblem) {
    await pushLog("error", configProblem);
    await endJob(configProblem);
    return;
  }
  const categories = settings.categories;

  const posts = await loadPosts();
  const pending = posts.filter((post) => !post.category && post.error !== "no_thumbnail");
  if (!pending.length) {
    await endJob("Nothing to classify - collect some posts first.");
    return;
  }

  await beginJob(
    "classify",
    `Classifying ${pending.length} post(s) with ${settings.providerLabel}`,
    pending.length
  );
  let done = 0;
  let failures = 0;
  let fatal = null;
  // Consecutive rate-limit failures. A per-minute limit usually clears on its
  // own, but if request after request is refused the pool cannot make progress,
  // and grinding through the rest of the library just marks every post failed.
  let rateLimitStreak = 0;
  const RATE_LIMIT_STREAK_LIMIT = 10;
  //
  // A free-tier provider limits requests per MINUTE. When a post is refused for
  // that reason the failure is the schedule's, not the post's: the request was
  // never scored. Instead of marking the post failed, it is requeued for this
  // same run and every worker honours a shared cool-down so the remaining
  // requests fit inside the next minute window. A per-DAY quota is different -
  // no pacing recovers it - so providerError() raises a fatal error for that
  // case and the batch aborts with nothing marked failed.
  let cooldownUntil = 0;
  const RATE_LIMIT_COOLDOWN_MS = 65000;

  await runPool(pending, settings.concurrency, async (post) => {
    try {
      // Honour the shared cool-down after a per-minute refusal. Read fresh here
      // rather than sleeping once, so a requeued post cannot start early just
      // because another worker reset the clock after it queued.
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait + rand(0, 1500));

      if (!post.thumbnailUrl) throw new PermanentError("no_thumbnail");
      const { category, confidence, warning } = await classifyOne(post, settings, categories);
      rateLimitStreak = 0;
      await updatePosts((all) => {
        const target = all.find((item) => item.shortcode === post.shortcode);
        if (target) {
          target.category = category;
          target.confidence = confidence;
          target.status = "classified";
          target.classifiedAt = Date.now();
          target.error = null;
          target.failedStage = null;
          target.warning = warning || null;
        }
      });
      if (warning) await pushLog("warn", `${post.shortcode}: ${warning}`);
    } catch (error) {
      const message = String((error && error.message) || error);
      if (error && error.fatal) {
        // A bad key / unknown model fails identically for every post, so stop
        // instead of burning the whole batch on the same error.
        fatal = message;
        runtime.stop = true;
        await pushLog("error", `Batch aborted: ${message}`);
      } else {
        failures++;
        await updatePosts((all) => {
          const target = all.find((item) => item.shortcode === post.shortcode);
          if (target) {
            target.status = "failed";
            target.error = message;
            target.failedStage = "classify";
          }
        });
        await pushLog("error", `${post.shortcode}: ${message}`);

        rateLimitStreak = /rate_limited_429|quota_exhausted/.test(message)
          ? rateLimitStreak + 1
          : 0;
        if (/_rate_limited_429/.test(message)) {
          // Per-minute refusal: requeue this post and pace the whole pool.
          // The post is NOT marked failed - its classification simply has not
          // happened yet, and it will be retried later in this same run.
          const index = pending.indexOf(post);
          if (index >= 0) pending.push(post);
          cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          await pushLog(
            "warn",
            `${post.shortcode}: per-minute limit hit - requeued, waiting ~${Math.round(
              RATE_LIMIT_COOLDOWN_MS / 1000
            )}s before the next request`
          );
        }
        if (rateLimitStreak >= RATE_LIMIT_STREAK_LIMIT && !fatal) {
          fatal = `${message} (stopped early: ${rateLimitStreak} posts in a row were refused)`;
          runtime.stop = true;
          await pushLog(
            "warn",
            "Stopping: the provider is refusing requests. Everything classified so far is kept - re-run later, or switch provider."
          );
        }
      }
    }
    done++;
    await patchJob({ done, label: `Classified ${done}/${pending.length}` });
  });

  if (fatal) {
    await endJob(`Aborted after ${done} post(s): ${fatal}`);
    return;
  }

  const stopped = await isStopRequested();
  await endJob(
    stopped
      ? `Stopped after classifying ${Math.min(done - failures, pending.length)}/${pending.length}` +
          (rateLimitStreak >= RATE_LIMIT_STREAK_LIMIT
            ? " - the provider kept refusing requests"
            : "")
      : `Classified ${Math.min(done - failures, pending.length)}/${pending.length} post(s)` +
          (failures ? ` - ${failures} failed (click Classify again to retry)` : "")
  );
}

/* ------------------------------------------------------------------------- *
 * Preflight: one real request against the configured provider
 * ------------------------------------------------------------------------- */

/**
 * Classify a single image so a wrong key / model / endpoint is discovered now
 * rather than 200 posts into a batch. Prefers a real thumbnail (which also
 * proves the CDN fetch works) and falls back to an image the popup drew.
 */
async function testProvider(fallbackImage) {
  const settings = await getSettings();
  const configProblem = validateProvider(settings);
  if (configProblem) return { ok: false, error: configProblem };

  const posts = await loadPosts();
  const sample = posts.find((post) => post.thumbnailUrl);
  let dataUrl = null;
  let source = null;
  let thumbnailError = null;

  if (sample) {
    try {
      dataUrl = await fetchImageAsDataUrl(sample.thumbnailUrl);
      source = `thumbnail of ${sample.shortcode}`;
    } catch (error) {
      // An expired CDN link says nothing about the provider, so fall through to
      // the generated image instead of reporting a false provider failure.
      thumbnailError = String((error && error.message) || error);
    }
  }
  if (!dataUrl && fallbackImage) {
    dataUrl = fallbackImage;
    source = thumbnailError
      ? `generated image (a stored thumbnail could not be read: ${thumbnailError})`
      : "generated test image (nothing collected yet)";
  }
  if (!dataUrl) {
    return {
      ok: false,
      error: thumbnailError
        ? `Could not read a thumbnail and no test image was supplied: ${thumbnailError}`
        : "Nothing collected yet, and no test image was supplied."
    };
  }

  const started = Date.now();
  try {
    const raw = await callModel(settings, settings.categories, dataUrl);
    const parsed = parseClassification(raw, settings.categories);
    return {
      ok: true,
      provider: settings.providerLabel,
      model: settings.model,
      source,
      ms: Date.now() - started,
      category: parsed.category,
      confidence: parsed.confidence,
      warning: parsed.warning || null,
      raw: String(raw).slice(0, 300)
    };
  } catch (error) {
    return {
      ok: false,
      provider: settings.providerLabel,
      model: settings.model,
      source,
      ms: Date.now() - started,
      error: String((error && error.message) || error)
    };
  }
}

/* ------------------------------------------------------------------------- *
 * Phase 3 - write-back into collections
 * ------------------------------------------------------------------------- */

function postUrl(post) {
  const kind = post.mediaType === "reel" ? "reel" : "p";
  return `https://www.instagram.com/${kind}/${post.shortcode}/`;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ ok, reason });
    };
    const listener = (id, info) => {
      if (id === tabId && info && info.status === "complete") finish(true, "complete");
    };
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // The tab may already have finished loading before we attached the listener.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === "complete") finish(true, "already_complete");
      })
      .catch(() => finish(false, "tab_gone"));
  });
}

/**
 * Inject writer.js into the post tab and invoke it with the category.
 * The file defines __IG_SORTER_WRITE__ on the isolated-world global; the second
 * injection calls it so the result comes back through executeScript.
 */
async function writePostToCollection(tabId, post, options = {}) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-scripts/writer.js"]
  });

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (category, shortcode, writerOptions) => {
      const writer = globalThis.__IG_SORTER_WRITE__;
      if (typeof writer !== "function") {
        return { success: false, error: "writer_not_loaded" };
      }
      try {
        return await writer(category, shortcode, writerOptions);
      } catch (error) {
        return { success: false, error: String((error && error.message) || error) };
      }
    },
    args: [post.category, post.shortcode, options]
  });

  return (injection && injection.result) || { success: false, error: "no_result" };
}

/**
 * Load one post's page in its own tab, run the writer there, and always close
 * the tab again.
 *
 * Split out of the batch loop so the same post can be retried with the tab moved
 * to the front when a background tab turned out to be the reason it failed.
 * `active: true` alone is not always enough to get a rendering tab: Chrome also
 * treats tabs as hidden while their window is minimised or completely covered,
 * so the window is focused too. Failures to load the page throw (they are not a
 * writer verdict), everything else comes back as the writer's result object.
 */
async function drivePost(post, { dryRun, active }) {
  const tab = await chrome.tabs.create({ url: postUrl(post), active });
  const tabId = tab.id;
  try {
    if (active && tab.windowId != null) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        /* focusing is best-effort; the page still reports whether it worked */
      }
    }
    const loaded = await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    if (!loaded.ok) throw new Error(`post_page_${loaded.reason}`);

    // Give the React app a moment to hydrate before the writer starts polling.
    await sleep(TAB_SETTLE_MS + rand(0, 800));

    return await writePostToCollection(tabId, post, { dryRun });
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* tab already closed by the user */
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Dry-run probe against the tab the user is already looking at
 *
 * The picker only exists after someone clicks the bookmark, so a headless dry
 * run can never verify the panel/row/checkbox strategies. The user can click
 * the bookmark themselves and then probe that tab - still no automated clicks.
 * ------------------------------------------------------------------------- */

const INSTAGRAM_URL_RE = /^https:\/\/www\.instagram\.com\//;

function shortcodeFromUrl(url) {
  const match = String(url || "").match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

async function probeTab({ tabId, url, category }) {
  let target = tabId;
  let tabUrl = url;

  if (target == null) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs.length) return { ok: false, error: "No active tab found." };
    target = tabs[0].id;
    tabUrl = tabs[0].url;
  }

  if (!INSTAGRAM_URL_RE.test(tabUrl || "")) {
    return { ok: false, error: "Open an instagram.com post page in this tab first." };
  }

  const settings = await getSettings();
  const chosen = category || settings.categories[0];

  try {
    await chrome.scripting.executeScript({
      target: { tabId: target },
      files: ["content-scripts/writer.js"]
    });
  } catch (error) {
    return {
      ok: false,
      error: `Cannot inject into this tab: ${(error && error.message) || error}`
    };
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: target },
    func: async (cat, code, cats) => {
      const writer = globalThis.__IG_SORTER_WRITE__;
      if (typeof writer !== "function") return { success: false, error: "writer_not_loaded" };
      try {
        return await writer(cat, code, { dryRun: true, categories: cats });
      } catch (error) {
        return { success: false, error: String((error && error.message) || error) };
      }
    },
    args: [chosen, shortcodeFromUrl(tabUrl), settings.categories]
  });

  const report = (injection && injection.result) || { success: false, error: "no_result" };
  await chrome.storage.local.set({
    [KEYS.probe]: { ...report, at: Date.now(), source: "current-tab", tabUrl, category: chosen }
  });
  await pushLog(
    report.ok ? "info" : "warn",
    `Probe ${tabUrl}: ${report.ok ? "save icon found" : "save icon NOT found"}${
      report.panelOpen ? " (picker open)" : ""
    }`
  );
  return { ok: true, report };
}

/**
 * Did this writer/probe result come from a tab nobody was looking at?
 *
 * The writer reports it two ways: inside `trace` for a real write, at the top
 * level for the non-destructive probe. Either one counts, because Chrome
 * throttles hidden tabs and Instagram renders less offscreen - so a failure
 * there is not evidence about the page.
 */
function resultWasHidden(result) {
  if (!result) return false;
  if (result.trace && result.trace.pageHidden === true) return true;
  return result.pageHidden === true;
}

/** One-line verdict for a probe report, used in the log and the popup. */
function dryRunReportSummary(result) {
  if (!result) return "no report";
  if (!result.steps && result.error) return `probe failed: ${result.error}`;
  if (!result.ok) return "save icon NOT found - no step could be verified";
  const steps = result.steps || [];
  const resolved = steps.filter((step) => step.status === "RESOLVED").length;
  const missed = steps.filter((step) => step.status === "MISS").length;
  const gated = steps.filter(
    (step) => step.status === "SKIPPED" || step.status === "NOT-OPEN"
  ).length;
  // The single most useful fact in one line: did the hover (the route current
  // builds need) open the picker, and if not, was a popover at least present but
  // hidden, or absent entirely?
  const hoverStep = steps.find((step) => step.step.startsWith("1b."));
  const hiddenStep = steps.find((step) => step.step.startsWith("1c."));
  const picker = hoverStep && hoverStep.status === "RESOLVED"
    ? "picker opened by hovering the bookmark"
    : hiddenStep && hiddenStep.status === "RESOLVED"
      ? "picker was mounted but CSS-hidden; the writer reveals it instead of hovering"
      : hiddenStep && hiddenStep.status === "MISS"
        ? "picker is mounted but could not be revealed - the run will fail here"
        : "no picker in the DOM (real pointer hover only)";
  const hidden = resultWasHidden(result)
    ? " - ran in a BACKGROUND tab (Instagram renders less offscreen): a MISS here is not proof the writer is broken"
    : "";
  return `${picker} - ${resolved} step(s) resolved, ${missed} miss, ${gated} gated behind a click${hidden}`;
}

/** Store a probe report on the post without touching its pipeline status. */
function recordDryRunReport(post, result, summary) {
  return updatePosts((all) => {
    const target = all.find((item) => item.shortcode === post.shortcode);
    if (!target) return;
    target.dryRunAt = Date.now();
    target.dryRunOk = !!(result && result.ok);
    target.dryRunSummary = summary;
    // Only the text report is kept (the structured steps would be redundant and
    // would multiply storage by the post count); capped so a 1000-post dry run
    // cannot bloat chrome.storage.local.
    target.dryRunReport = {
      at: Date.now(),
      ok: !!(result && result.ok),
      url: (result && result.url) || postUrl(post),
      panelOpen: !!(result && result.panelOpen),
      summary,
      // 80 lines rather than 40: the hover probe and the row inventory push the
    // actionable steps (row match, click target, category map) past line 40.
    lines: ((result && result.lines) || []).slice(0, 80)
    };
  });
}

async function runWritebackJob(options = {}) {
  const settings = await getSettings();
  const dryRun =
    typeof options.dryRun === "boolean" ? options.dryRun : !!settings.dryRun;

  const posts = await loadPosts();
  // Resumable: anything already marked "written" is skipped, so re-running the
  // button continues where the previous run stopped.
  //
  // Posts written WITHOUT confirmation are the exception, and only when the user
  // opts in ("Re-sort posts that were never confirmed"). Re-clicking a collection
  // that did land would toggle the post back out of it, so this is never
  // automatic - but it is the only way to recover posts a previous build claimed
  // to sort. `undefined` counts as unconfirmed: those were written before the
  // writer verified anything.
  const recheck = !!settings.resortUnconfirmed;
  const pending = posts.filter(
    (post) =>
      post.category &&
      (post.status !== "written" || (recheck && post.writtenConfirmed !== true))
  );

  if (!pending.length) {
    const neverConfirmed = posts.filter(
      (post) => post.status === "written" && post.writtenConfirmed !== true
    ).length;
    await endJob(
      posts.length
        ? neverConfirmed
          ? `All classified posts are sorted - but ${neverConfirmed} were never confirmed. Tick "Re-sort posts that were never confirmed" to retry them.`
          : "All classified posts are already sorted."
        : "Nothing to sort - collect and classify posts first."
    );
    return;
  }

  await beginJob(
    "writeback",
    dryRun
      ? `Inspecting ${pending.length} post(s) - no clicks`
      : `Sorting ${pending.length} post(s)`,
    pending.length
  );
  let written = 0;
  let failures = 0;
  let inspected = 0;
  let problems = 0;
  // Which picker route each post actually used (hover popover / ⋯ menu /
  // bookmark click). Rolled up into one log line at the end instead of one line
  // per post, so a 500-post sort cannot push everything else out of the log.
  const routeCounts = {};
  // If several posts in a row fail at the SAME step, the page flow itself is
  // broken (a deploy moved the picker), and grinding on just churns through the
  // library and looks like automation. The phase stops with an explanation;
  // failed posts retry on the next run of the same button.
  let identicalFailures = 0;
  let lastFailure = null;
  const WRITE_FAILURE_BREAKER = 6;
  // Strip the retry suffix so "timeout_waiting_for_panel_retry" and
  // "timeout_waiting_for_panel" count as the same broken step.
  const failureSignature = (message) =>
    String(message).replace(/_retry.*$/, "");
  // Clicked, but the writer could not read the collection's state back. Counted
  // separately from both success and failure: claiming these are "sorted" is how
  // a run reports 20/20 while Instagram shows nothing.
  let unconfirmed = 0;
  // Tab visibility bookkeeping (see TAB_FOCUS_DEFAULT). `foreground` flips to
  // true the first time a post fails while its tab was in the background, and
  // stays true for the rest of the run - the posts that follow would fail the
  // same way.
  let foreground = settings.tabFocus === "always";
  const foregroundOnFailure = settings.tabFocus === "on-failure";
  const maxAttempts = settings.tabFocus === "never" ? 1 : 2;
  let hiddenFailures = 0;
  let switchedToForeground = false;
  let stillHiddenInFront = 0;
  // Posts whose page reported itself as hidden at all (they usually still work;
  // this is the number that explains a run which behaved differently from the
  // same run with the browser watched).
  let hiddenRuns = 0;

  for (let i = 0; i < pending.length; i++) {
    if (await isStopRequested()) break;
    const post = pending[i];

    try {
      /*
       * Try the post the quiet way first, then once more with the tab in front
       * if the failure was caused by the page being hidden. A hidden failure
       * (writer reports pageHidden) says nothing about the post: Chrome throttles
       * that tab's timers and Instagram may skip rendering offscreen UI.
       */
      let result = null;
      for (let attempt = 1; ; attempt++) {
        result = await drivePost(post, { dryRun, active: foreground });
        // A probe reports `ok`, a real write reports `success`; both can fail
        // because the tab was hidden rather than because the page changed.
        const failed = dryRun ? !!result && result.ok === false : !!result && !result.success;
        if (!failed || !resultWasHidden(result)) break;
        if (attempt === 1) hiddenFailures++;
        if (!foregroundOnFailure || attempt >= maxAttempts) break;
        foreground = true;
        switchedToForeground = true;
        await pushLog(
          "warn",
          `${post.shortcode}: failed while its tab was in the background - bringing the tab to the front and retrying this post`
        );
      }
      // Report visibility honestly, in both directions. A page that says it is
      // hidden while we are supposedly in front means the window is minimised or
      // completely covered by another window, which is the one thing bringing
      // the tab to the front cannot fix.
      const wasHidden = resultWasHidden(result);
      if (wasHidden) hiddenRuns++;
      if (foreground && wasHidden) stillHiddenInFront++;

      if (dryRun) {
        // Dry run: keep the report, leave the pipeline status untouched, and
        // never touch the page beyond loading it.
        inspected++;
        if (!result || !result.ok) problems++;
        const summary = dryRunReportSummary(result);
        await recordDryRunReport(post, result, summary);
        await pushLog(result && result.ok ? "info" : "warn", `${post.shortcode}: ${summary}`);
      } else {
        if (!result || !result.success) {
          /*
           * Carry the writer's trace out with the failure. The trace is what the
           * popup's per-post audit renders (route used, rows seen, controls
           * considered, the step that died), and until now it was thrown away with
           * the error message - which is why a failed run could only be read as
           * one line per post.
           */
          const failure = new Error((result && result.error) || "write_failed");
          failure.trace = (result && result.trace) || null;
          throw failure;
        }
        written++;
        if (!result.confirmed) unconfirmed++;
        await updatePosts((all) => {
          const target = all.find((item) => item.shortcode === post.shortcode);
          if (target) {
            target.status = "written";
            target.writtenAt = Date.now();
            target.error = null;
            target.failedStage = null;
            // Kept so an unverified write can be audited afterwards. The status
            // stays "written" on purpose: re-clicking a collection that did
            // land would toggle the post back OUT of it.
            target.writtenConfirmed = result.confirmed === true;
            target.writeTrace = result.trace || null;
            if (result.warning) target.warning = result.warning;
          }
        });
        /*
         * One line per post that names HOW it was written, so the popup log
         * answers "which route worked and what did it click?" without a
         * DevTools trip: hover / ⋯menu / click, the row selector the writer
         * acted on, and the signal it read the selection state from.
         */
        const trace = result.trace || {};
        const route = trace.panelRevealed
          ? "popover revealed (CSS :hover build)"
          : trace.openedViaHover
            ? "hover popover"
            : trace.openedViaMenu
              ? "⋯ menu"
              : "bookmark click";
        routeCounts[route] = (routeCounts[route] || 0) + 1;
        // Only the posts that need attention get their own line; the routine
        // case is the roll-up at the end of the run.
        if (!result.confirmed || result.warning) {
          const facts = [route];
          if (trace.rowSelector) facts.push(`row=${trace.rowSelector}`);
          if (trace.selectionSignal) facts.push(`state=${trace.selectionSignal}`);
          await pushLog(
            "warn",
            `${post.shortcode}: "${post.category}" ${result.confirmed ? "confirmed" : "UNCONFIRMED"}` +
              (result.warning ? ` (${result.warning})` : "") +
              ` - ${facts.join(", ")}`
          );
        }
      }
    } catch (error) {
      const message = String((error && error.message) || error);
      if (dryRun) {
        // A probe that could not even load the page is a finding, not a failure.
        problems++;
        await recordDryRunReport(
          post,
          { ok: false, lines: [`probe failed: ${message}`] },
          `probe failed (${message})`
        );
        await pushLog("warn", `${post.shortcode}: probe failed (${message})`);
      } else {
        failures++;
        await updatePosts((all) => {
          const target = all.find((item) => item.shortcode === post.shortcode);
          if (target) {
            target.status = "failed";
            target.error = message;
            target.failedStage = "write";
            // Kept so the failure can be audited post by post in the popup.
            target.writeTrace = (error && error.trace) || target.writeTrace || null;
          }
        });
        await pushLog("error", `${post.shortcode}: ${message}`);

        // Circuit breaker: the same failure over and over means the page flow
        // is broken, not the posts. Stop rather than churn through the rest.
        const signature = failureSignature(message);
        if (signature === lastFailure) identicalFailures++;
        else {
          identicalFailures = 1;
          lastFailure = signature;
        }
        if (identicalFailures >= WRITE_FAILURE_BREAKER) {
          const remaining = pending.length - (i + 1);
          await pushLog(
            "warn",
            `Stopping: ${identicalFailures} posts in a row failed with "${signature}". ` +
              `The remaining ${remaining} post(s) were not attempted - they stay unsorted and retry next run. ` +
              'Use "Inspect the tab I\'m on" on one of these posts to see which step no longer matches Instagram.'
          );
          break;
        }
      }
    }

    const progress = dryRun
      ? `Inspected ${inspected}/${pending.length}`
      : `Sorted ${written}/${pending.length}`;
    await patchJob({ done: i + 1, label: progress });

    const isLast = i === pending.length - 1;
    if (!isLast) {
      if (await isStopRequested()) break;
      // Dry runs click nothing, so they can safely run much faster. A real run
      // uses a randomised 2-4s between posts with a 15-20s breather every 20
      // posts so Instagram does not rate-limit or lock the account.
      const pause = dryRun
        ? rand(400, 900)
        : (i + 1) % LONG_PAUSE_EVERY === 0
          ? rand(LONG_PAUSE_MIN_MS, LONG_PAUSE_MAX_MS)
          : rand(WRITE_DELAY_MIN_MS, WRITE_DELAY_MAX_MS);
      await patchJob({ label: `${progress} - next in ${Math.round(pause / 1000)}s` });
      await sleep(pause);
    }
  }

  const stopped = await isStopRequested();
  if (dryRun) {
    await endJob(
      (stopped
        ? `Dry run stopped after ${inspected}/${pending.length} post(s)`
        : `Dry run: ${inspected} post(s) inspected, ${problems} need attention - nothing was clicked`) +
        (hiddenRuns
          ? ` - ${hiddenRuns} of them ran in a background tab, where Instagram renders less: a MISS there is not proof the writer is broken`
          : "")
    );
    return;
  }
  const routeSummary = Object.entries(routeCounts)
    .map(([route, count]) => `${count}× ${route}`)
    .join(", ");
  if (routeSummary) await pushLog("info", `Picker routes used: ${routeSummary}`);
  if (unconfirmed) {
    await pushLog(
      "warn",
      `${unconfirmed} post(s) were clicked, but the collection could not be confirmed afterwards. ` +
        'Open one of them on Instagram to check, then use the dry run (or "Inspect the tab I\'m on") to see which element the writer clicks for the collection row.'
    );
  }
  if (hiddenFailures) {
    await pushLog(
      "warn",
      `${hiddenFailures} post(s) failed while their tab was in the background. ` +
        (settings.tabFocus === "never"
          ? 'Chrome throttles background tabs and Instagram skips rendering some offscreen UI, so that is expected - set "Post tabs" to "Bring to the front on failure" to retry them.'
          : "They were retried with the tab brought to the front.")
    );
  }
  if (switchedToForeground) {
    await pushLog(
      "info",
      "The rest of this run kept each post's tab in front, because the background tab was the reason for the failure. Set \"Post tabs\" to \"Never\" if you would rather the run stayed quiet."
    );
  }
  if (stillHiddenInFront) {
    await pushLog(
      "warn",
      `${stillHiddenInFront} post(s) still reported themselves as hidden with the tab in front - the Chrome window is probably minimised or completely covered by another window. Chrome does not render tabs in that state, so keep the window where it can be seen.`
    );
  }
  await endJob(
    stopped
      ? `Stopped after sorting ${written}/${pending.length}`
      : `Sorted ${written}/${pending.length} post(s)` +
          (unconfirmed ? ` - ${unconfirmed} unverified` : "") +
          (failures ? ` - ${failures} failed (click Sort again to retry)` : "") +
          (hiddenRuns && !foreground ? ` - ${hiddenRuns} ran hidden` : "") +
          (identicalFailures >= WRITE_FAILURE_BREAKER
            ? " - stopped early: every attempt failed at the same step"
            : "")
  );
}

/* ------------------------------------------------------------------------- *
 * Self-diagnosis
 *
 * Reads the extension's own state and explains, in plain language, what to do
 * next. It runs one real provider request (the only way to know an endpoint is
 * actually reachable) and pings the content script in every Instagram tab, which
 * is what separates "you have not scrolled yet" from "the content script died
 * when you reloaded the extension".
 * ------------------------------------------------------------------------- */

const DIAG_ICONS = { ok: "✓", warn: "!", error: "✗", info: "·" };

/** Does a manifest host permission pattern cover this URL? (ports are ignored) */
function hostPatternMatches(url, pattern) {
  try {
    const target = new URL(url);
    const match = String(pattern).match(/^(https?):\/\/([^/]+)\//);
    if (!match) return false;
    const [, scheme, hostPattern] = match;
    if (scheme !== target.protocol.replace(":", "")) return false;
    const host = target.hostname.toLowerCase();
    const wanted = hostPattern.toLowerCase();
    if (wanted.startsWith("*.")) {
      const suffix = wanted.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return wanted === host;
  } catch {
    return false;
  }
}

/** The host_permissions entry a custom endpoint would need, port-free. */
function hostPermissionHint(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

async function runDiagnosis(fallbackImage) {
  const settings = await getSettings();
  const posts = await loadPosts();
  const job = await getJob();

  const checks = [];
  const nextSteps = [];
  const add = (level, title, detail) => checks.push({ level, title, detail: detail || null });

  /* ---- 1. provider configuration ---- */
  add("info", `Provider: ${settings.providerLabel}`);
  add("info", `Endpoint: ${settings.baseUrl || "(not set)"}`);
  add("info", `Model: ${settings.model || "(not set)"}`);

  if (!settings.needsKey) add("ok", "API key: not required for this provider");
  else if (settings.apiKey) add("ok", "API key: stored for this provider");
  else add("error", "API key: missing", settings.keyUrl ? `Get one at ${settings.keyUrl}` : null);

  /* ---- 2. is the endpoint even allowed by the manifest? ---- */
  let hostOk = true;
  if (settings.baseUrl) {
    const patterns = chrome.runtime.getManifest().host_permissions || [];
    if (patterns.some((pattern) => hostPatternMatches(settings.baseUrl, pattern))) {
      add("ok", "Endpoint host is allowed by manifest.json");
    } else {
      hostOk = false;
      const hint = hostPermissionHint(settings.baseUrl);
      add("error", "Endpoint host is NOT in host_permissions", `${settings.baseUrl} would be blocked by Chrome`);
      if (hint) {
        nextSteps.push(
          `Add "${hint}" to host_permissions in manifest.json, then reload the extension on chrome://extensions.`
        );
      }
    }
  }

  /* ---- 3. can Instagram's CDN still be read? (independent of the provider) ---- */
  const samplePost = posts.find((post) => post.thumbnailUrl);
  if (samplePost) {
    try {
      await fetchImageAsDataUrl(samplePost.thumbnailUrl);
      add("ok", "A stored thumbnail downloads fine");
    } catch (error) {
      const message = String((error && error.message) || error);
      add("warn", "A stored thumbnail could not be downloaded", message);
      if (/expired/.test(message)) {
        nextSteps.push(
          "Thumbnail links expire: re-scroll your Saved page while collecting so the signed URLs are refreshed, then classify again."
        );
      } else if (/http_4/.test(message)) {
        nextSteps.push(
          "Instagram refused the download - check the cdninstagram/fbcdn host permissions in manifest.json."
        );
      }
    }
  }

  /* ---- 4. reachability: one real request ---- */
  const configProblem = validateProvider(settings);
  if (configProblem) {
    add("warn", "Reachability: not tested", configProblem);
    nextSteps.push(configProblem);
  } else if (!hostOk) {
    add("warn", "Reachability: not tested", "fix the host permission first");
  } else if (runtime.running) {
    add("warn", "Reachability: not tested", "a job is running; diagnose again when it finishes");
  } else {
    const test = await testProvider(fallbackImage);
    if (test.ok) {
      add(
        "ok",
        `Reachability: reachable in ${test.ms}ms`,
        `answered "${test.category}" (${test.confidence})${test.warning ? ` - ${test.warning}` : ""}`
      );
    } else {
      add("error", "Reachability: FAILED", test.error);
      nextSteps.push(`Fix the provider connection: ${test.error}`);
    }
    if (test.raw) add("info", "Last model reply", summarizeText(test.raw, 120));
  }

  /* ---- 5. collected data ---- */
  const total = posts.length;
  const pendingClassify = posts.filter((post) => !post.category && post.error !== "no_thumbnail").length;
  const classified = posts.filter((post) => post.category).length;
  const written = posts.filter((post) => post.status === "written").length;
  const failedClassify = posts.filter(
    (post) => post.status === "failed" && post.failedStage === "classify"
  ).length;
  const failedWrite = posts.filter(
    (post) => post.status === "failed" && post.failedStage === "write"
  ).length;
  const noThumbnail = posts.filter((post) => post.error === "no_thumbnail").length;
  const lowConfidence = posts.filter((post) => post.category && post.confidence < 0.5).length;
  // Marked written, but the writer never saw the collection become selected.
  const unconfirmedWrites = posts.filter(
    (post) => post.status === "written" && post.writtenConfirmed === false
  ).length;
  // Inspected by a dry run but never actually sorted.
  const dryRunWrites = posts.filter(
    (post) => post.dryRunAt && post.status !== "written"
  ).length;
  // Written by a build that did not verify the collection afterwards, so their
  // outcome is simply unknown - report that instead of implying they are fine.
  const legacyWrites = posts.filter(
    (post) => post.status === "written" && post.writtenConfirmed === undefined
  ).length;
  // Failures the writer itself attributed to the tab being in the background.
  // Worth separating, because those say nothing about the page - the fix is the
  // "Post tabs" setting, not a selector (see [page_hidden]).
  const hiddenWriteFailures = posts.filter(
    (post) =>
      post.status !== "written" &&
      ((post.failedStage === "write" && /\[page_hidden\]/.test(post.error || "")) ||
        (post.writeTrace && post.writeTrace.pageHidden === true))
  ).length;

  if (!total) {
    add("warn", "No posts collected yet", "nothing has been recorded from your Saved page");
    nextSteps.push('Press "1 · Start Collecting", open your Saved page and scroll through it.');
  } else {
    add("ok", `${total} post(s) collected`);
    if (pendingClassify) {
      add("warn", `${pendingClassify} still need a category`);
      nextSteps.push('Click "2 · Classify Collected Posts" to classify the remaining posts.');
    }
    if (failedClassify) {
      add("warn", `${failedClassify} failed while classifying`);
      nextSteps.push(
        'Re-run "2 · Classify Collected Posts" - failures are retried. If the same error repeats, it is in the log above.'
      );
    }
    if (classified) add("ok", `${classified} classified, ${written} already in collections`);
    if (unconfirmedWrites) {
      add(
        "warn",
        `${unconfirmedWrites} post(s) were clicked but never confirmed`,
        "the writer could not read the collection's selected state back, so they may not have landed - check a couple by hand on Instagram"
      );
      nextSteps.push(
        'Run "3 · Dry-Run Sort", or open one post, click its bookmark yourself and press "Inspect the tab I\'m on", to see the exact element the writer clicks for the collection row.'
      );
    }
    if (legacyWrites) {
      add(
        "info",
        `${legacyWrites} sorted post(s) were written before the extension verified collections`,
        "their outcome is unknown, not necessarily wrong - spot-check a few on Instagram"
      );
    }
    if (dryRunWrites) {
      add("info", `${dryRunWrites} post(s) have only been dry-run inspected`, "nothing was clicked for those");
    }
    if (failedWrite) {
      add(
        "warn",
        `${failedWrite} failed during write-back`,
        hiddenWriteFailures
          ? `${hiddenWriteFailures} of them in a background tab, where Chrome throttles timers and Instagram renders less`
          : null
      );
      nextSteps.push('Re-run "3 · Sort Into Collections" - already-sorted posts are skipped, failures are retried.');
      if (hiddenWriteFailures) {
        nextSteps.push(
          `${hiddenWriteFailures} of those failures were tagged [page_hidden]: their tab was in the background, so they say nothing about the page. Keep "Post tabs" on its default (the first hidden failure is retried in front) or set it to "Always watch each post".`
        );
      }
    }
    if (noThumbnail) add("info", `${noThumbnail} post(s) had no usable thumbnail (skipped by design)`);
    if (lowConfidence) {
      add("info", `${lowConfidence} classification(s) below 0.5 confidence`, "worth a spot check");
    }
  }

  /* ---- 6. is the collector actually alive in a tab? ---- */
  let ping = {
    tabs: 0,
    stale: 0,
    live: 0,
    targets: 0,
    savedPages: 0,
    seen: 0,
    anchors: 0,
    parsed: 0,
    withThumbnail: 0,
    linksWithImage: 0,
    totalAnchors: 0,
    awaitingThumbnail: 0,
    unmatchedHrefs: [],
    sampleHrefs: [],
    sampleShortcodes: [],
    sampleTileHtml: null,
    scanRoot: null,
    scanError: null,
    collectors: []
  };
  try {
    ping = await pingCollectors();
  } catch (error) {
    log("diagnosis: collector ping failed", error);
  }

  // Chrome can withhold site access (Extensions → Details → Site access), which
  // silently stops content scripts from being injected at all.
  try {
    const allowed = await chrome.permissions.contains({ origins: [INSTAGRAM_TABS_URL] });
    if (allowed) {
      add("ok", "Instagram site access granted");
    } else {
      add("error", "Chrome is withholding site access to instagram.com", "content scripts cannot be injected, so nothing can ever be collected");
      nextSteps.push(
        'chrome://extensions -> IG Saved Sorter -> Details -> Site access -> set it to "On all sites".'
      );
    }
  } catch {
    /* permissions API unavailable - not worth failing the diagnosis over */
  }

  if (!ping.tabs) {
    add("warn", "No Instagram tab is open", "the collector needs a real page to read");
    nextSteps.push("Open instagram.com/<you>/saved/ in a tab, then scroll it while collecting.");
  } else if (!ping.live) {
    add(
      "error",
      `Instagram tab open, but the collector is not running in ${ping.stale} of them`,
      "the content script is missing - normally a stale tab after reloading the extension"
    );
    nextSteps.push("Reload your Instagram tab(s) with F5 so the content script is injected.");
  } else {
    add(
      "ok",
      `Collector live in ${ping.live} tab(s)`,
      `it has recorded ${ping.seen} tile(s) since that page loaded`
    );
    if (!ping.savedPages) {
      add("warn", "No Saved page is open", "scrolling any other Instagram page records nothing");
      nextSteps.push("Open your Saved page (profile → Saved → All posts) and scroll there.");
    } else if (!ping.anchors) {
      add("warn", "Saved page open, but no links are rendered yet", "the grid has not loaded");
      nextSteps.push("Wait for the grid to appear, then scroll slowly.");
    } else if (!ping.parsed) {
      // Links exist but not one of them is a post permalink. This is the failure
      // that looks like "the extension is doing nothing" while the screen is full
      // of tiles, so name the cause and hand over the raw evidence needed to fix
      // the link pattern.
      add(
        "error",
        `${ping.anchors} link(s) on the page, but none is a post address`,
        ping.linksWithImage
          ? `${ping.linksWithImage} of them contain an image, so the grid is really there`
          : "the links are not post addresses either - the grid shape has changed"
      );
      if (ping.sampleHrefs.length) {
        add("info", "links the page does contain", ping.sampleHrefs.join("\n      "));
      }
      if (ping.sampleTileHtml) add("info", "first tile markup", ping.sampleTileHtml);
      nextSteps.push("Paste this whole report back: the tile link pattern needs updating.");
    } else if (!ping.withThumbnail) {
      add(
        "warn",
        `${ping.parsed} post(s) found but no thumbnail could be read from them`,
        `${ping.awaitingThumbnail} tile(s) still waiting for a lazily-loaded image`
      );
      if (ping.sampleTileHtml) add("info", "first tile markup", ping.sampleTileHtml);
      nextSteps.push(
        "Keep scrolling: thumbnails load lazily and are recorded once an image appears. If it stays at 0, paste this report back."
      );
    } else if (!ping.seen && !total) {
      add(
        "warn",
        `${ping.parsed} post(s) are readable but none were recorded`,
        "the scan has not reported them yet, or the send failed"
      );
      nextSteps.push("Open the Instagram tab's console and look for [IG-Sorter/collector] lines.");
    } else {
      add(
        "info",
        `${ping.anchors} post tile(s) visible, ${ping.parsed} readable, ${ping.withThumbnail} with a thumbnail`
      );
      if (ping.sampleShortcodes.length) {
        add("info", "shortcodes seen here", ping.sampleShortcodes.join(", "));
      }
    }
    if (ping.scanError) add("warn", "The last scan hit an error", ping.scanError);
    if (ping.stale) add("info", `${ping.stale} other Instagram tab(s) have no live collector`);
  }

  /* ---- 7. current run + mode ---- */
  if (job.running) {
    add("info", `A job is running: ${job.phase} ${job.done}/${job.total}`);
  } else {
    add("info", `Idle - last run: ${job.label || "nothing yet"}`);
  }

  const errors = ((job.log || []).filter((entry) => entry.level === "error")).slice(-20);
  if (errors.length) {
    add("warn", `${errors.length} error(s) in the log`, `most recent: ${summarizeText(errors[errors.length - 1].message, 90)}`);
  }

  if (settings.dryRun) {
    add("warn", "Dry run is ON", "the sort phase will inspect each post but click nothing");
    if (classified > written) {
      nextSteps.push('Untick "Dry run" when you are ready for the real sort.');
    }
  }
  if (settings.dryRun === false && classified > written && !failedWrite) {
    nextSteps.push('Click "3 · Sort Into Collections" to file the classified posts into collections.');
  }

  const problems = checks.filter((check) => check.level === "error").length;
  const warnings = checks.filter((check) => check.level === "warn").length;

  const lines = [
    "=== IG Saved Sorter self-diagnosis ===",
    `time : ${new Date().toISOString()}`,
    ""
  ];
  for (const check of checks) {
    lines.push(`${DIAG_ICONS[check.level]} ${check.title}`);
    if (check.detail) lines.push(`    ${check.detail}`);
  }
  lines.push("");
  lines.push("--- what to do next ---");
  if (!nextSteps.length) {
    lines.push("Nothing to fix: the pipeline is configured and idle.");
  } else {
    // De-duplicate: several checks can recommend the same action.
    const unique = [...new Set(nextSteps)];
    unique.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }

  return {
    ok: problems === 0,
    problems,
    warnings,
    checks,
    nextSteps,
    lines,
    at: Date.now(),
    source: "self-diagnosis",
    provider: settings.providerLabel,
    model: settings.model
  };
}

/* ------------------------------------------------------------------------- *
 * Message handling
 * ------------------------------------------------------------------------- */

/**
 * Start a job and answer the popup immediately. Long jobs are deliberately not
 * awaited here: keeping a message channel open for minutes is fragile.
 */
function launch(phase, label, runner) {
  if (runtime.running) return { ok: false, error: "A job is already running." };
  runtime.running = true; // set synchronously so a double click cannot race
  runner().catch(async (error) => {
    await pushLog("error", `${label}: ${(error && error.message) || error}`);
    await endJob(`${label} crashed: ${(error && error.message) || error}`);
  });
  return { ok: true, started: phase };
}

async function handleMessage(message, sender) {
  if (!message || typeof message !== "object") return { ok: false, error: "bad_message" };

  switch (message.type) {
    case "COLLECT_POSTS": {
      const stats = await addCollectedPosts(message.posts);
      if (stats.added || stats.refreshed) {
        log(`collected +${stats.added} (refreshed ${stats.refreshed})`);
      }
      // Remember the username purely so the popup can link to the Saved page.
      const username = message.page && message.page.username;
      if (username && typeof username === "string") {
        await chrome.storage.local.set({ lastUsername: username, collecting: true });
      }
      if (stats.added) await setBadgeCount(stats.total);
      // Keep the popup honest: "Collecting - 42 post(s) recorded" beats "Idle".
      if (stats.added && !runtime.running) {
        await patchJob({
          phase: "collect",
          label: `Collecting - ${stats.total} post(s) recorded`
        });
      }
      return { ok: true, ...stats };
    }

    case "PING_COLLECTORS":
      return { ok: true, ...(await pingCollectors()) };

    case "START_COLLECTING": {
      if (runtime.running) return { ok: false, error: "A job is already running." };
      await withLock(async () => {
        await savePosts([]);
        await chrome.storage.local.set({
          [KEYS.job]: {
            ...freshJob(),
            phase: "collect",
            label: "Collecting - scroll your Saved page"
          },
          stopRequested: false,
          collecting: true,
          collectingStartedAt: Date.now()
        });
      });
      runtime.stop = false;
      await setBadgeCount(0);
      await resetCollectors();
      // Report whether anything is actually listening, so the popup never claims
      // success while nothing is collecting.
      const summary = await pingCollectors();
      return { ok: true, started: "collect", ...summary };
    }

    case "START_CLASSIFY":
      return launch("classify", "Classification", runClassifyJob);

    case "START_WRITEBACK":
      return launch("writeback", message.dryRun ? "Dry run" : "Write-back", () =>
        runWritebackJob({ dryRun: message.dryRun })
      );

    // Dry-run probe of the tab the user is looking at (nothing is clicked).
    case "PROBE_TAB":
      return probeTab({
        tabId: typeof message.tabId === "number" ? message.tabId : null,
        url: message.url,
        category: message.category
      });

    // Resolved settings (provider merged in), so the popup does no resolution.
    case "GET_SETTINGS":
      return { ok: true, settings: await publicSettings() };

    // The provider list lives here so the popup cannot drift out of sync with it.
    case "GET_PROVIDERS":
      return {
        ok: true,
        providers: Object.keys(PROVIDERS).map((id) => ({
          id,
          label: PROVIDERS[id].label,
          baseUrl: PROVIDERS[id].baseUrl,
          model: PROVIDERS[id].model,
          needsKey: !!PROVIDERS[id].needsKey,
          keyUrl: PROVIDERS[id].keyUrl,
          hint: PROVIDERS[id].hint
        }))
      };

    // One real request, so a bad key or model is found before a long batch.
    case "TEST_MODEL":
      if (runtime.running) return { ok: false, error: "A job is already running." };
      return testProvider(message.fallbackImage);

    // Full state inspection with a plain-language plan for what to do next.
    case "DIAGNOSE": {
      const report = await runDiagnosis(message.fallbackImage);
      // Re-running to check a fix should not re-shout the same verdict. When
      // the findings are equivalent to the previous run, stamp it as such (the
      // popup's meta line reads it) instead of looking like fresh spam.
      // Only the volatile numbers are normalised away - the latency and
      // confidence inside the Reachability check drift on every run. Counts
      // elsewhere ("12 post(s) collected") are findings and must stay literal,
      // so collecting more posts between runs still reads as a change.
      const previous = (await chrome.storage.local.get(KEYS.diagnosis))[KEYS.diagnosis];
      const normalizeCheck = (check) =>
        JSON.stringify({
          ...check,
          title: /^Reachability:/.test(check.title || "")
            ? check.title.replace(/\d+/g, "#")
            : check.title,
          detail: /^answered/.test(check.detail || "")
            ? check.detail.replace(/\d+/g, "#")
            : check.detail
        });
      const signature = (report) => JSON.stringify({
        problems: report.problems,
        warnings: report.warnings,
        checks: (report.checks || []).map(normalizeCheck),
        nextSteps: report.nextSteps
      });
      report.sameAsPrevious = !!(previous && previous.checks && signature(previous) === signature(report));
      await chrome.storage.local.set({ [KEYS.diagnosis]: report });
      return { ok: true, report };
    }

    case "STOP_JOB": {
      runtime.stop = true;
      await chrome.storage.local.set({ stopRequested: true });
      await patchJob({ label: "Stopping after the current post..." });
      return { ok: true };
    }

    case "SET_SETTINGS": {
      const next = await setSettings(message.patch || {});
      return { ok: true, settings: next };
    }

    case "CLEAR_ALL": {
      if (runtime.running) return { ok: false, error: "A job is already running." };
      await withLock(async () => {
        await savePosts([]);
        await chrome.storage.local.set({ [KEYS.job]: freshJob(), collecting: false });
      });
      await setBadgeCount(0);
      return { ok: true };
    }

    // Sent by content-scripts/writer.js. The authoritative result travels back
    // through executeScript, this is the audit trail required by the design.
    case "WRITE_RESULT": {
      if (message.result && message.result.success) {
        log(`writer reported success for ${message.postId}`);
      } else {
        log(`writer reported failure for ${message.postId}`, message.result);
      }
      return { ok: true };
    }

    // Sent by writer.js in dry-run mode; the report itself travels back through
    // executeScript, this is the audit trail.
    case "PROBE_RESULT": {
      log(
        `probe for ${message.postId}: ${(message.result && message.result.ok) ? "ok" : "no save icon"}`
      );
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown_message:${message.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch(async (error) => {
      log("message handler error", error);
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    });
  return true; // keep the channel open for the async response
});

/* ------------------------------------------------------------------------- *
 * Startup
 * ------------------------------------------------------------------------- */

/** A run cannot survive a service-worker restart, so clear the stale "running" flag. */
async function reconcileOnStartup() {
  const job = await getJob();
  const stale = job.running || runtime.running;
  runtime.running = false;
  runtime.phase = null;
  if (stale) {
    await pushLog("warn", "A previous run was interrupted; click the button again to resume.");
    await patchJob({
      running: false,
      phase: null,
      label: "Interrupted - re-run to resume"
    });
  }
  const settings = await getSettings();
  await chrome.storage.local.set({
    [KEYS.settings]: { ...settings, categories: settings.categories }
  });
}

chrome.runtime.onStartup.addListener(reconcileOnStartup);
chrome.runtime.onInstalled.addListener(reconcileOnStartup);
