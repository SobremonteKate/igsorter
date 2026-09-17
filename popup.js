/* ---------------------------------------------------------------------------
 * popup.js - UI for the three-phase workflow.
 * Reads its state straight out of chrome.storage.local and reacts to changes,
 * so it stays correct whether it is open while the worker runs or opened later.
 * ------------------------------------------------------------------------ */

"use strict";

const DEFAULT_CATEGORIES = [
  "food",
  "workout",
  "fashion",
  "memes",
  "travel",
  "study_tips",
  "other"
];

const $ = (id) => document.getElementById(id);

const els = {
  provider: $("provider"),
  providerHint: $("providerHint"),
  model: $("model"),
  baseUrl: $("baseUrl"),
  baseUrlRow: $("baseUrlRow"),
  apiKey: $("apiKey"),
  keyNote: $("keyNote"),
  keyLink: $("keyLink"),
  testProvider: $("testProvider"),
  testResult: $("testResult"),
  saveProvider: $("saveProvider"),
  categories: $("categories"),
  saveCategories: $("saveCategories"),
  start: $("start"),
  classify: $("classify"),
  sort: $("sort"),
  dryRun: $("dryRun"),
  resortUnconfirmed: $("resortUnconfirmed"),
  inspect: $("inspect"),
  reportWrap: $("reportWrap"),
  reportMeta: $("reportMeta"),
  report: $("report"),
  copyReport: $("copyReport"),
  diagnose: $("diagnose"),
  diagWrap: $("diagWrap"),
  diagMeta: $("diagMeta"),
  diag: $("diag"),
  copyDiag: $("copyDiag"),
  dismissDiag: $("dismissDiag"),
  stop: $("stop"),
  clear: $("clear"),
  phase: $("phase"),
  cCollected: $("cCollected"),
  cClassified: $("cClassified"),
  cSorted: $("cSorted"),
  cFailed: $("cFailed"),
  progressBar: $("progressBar"),
  jobLabel: $("jobLabel"),
  collectorLine: $("collectorLine"),
  verifyLine: $("verifyLine"),
  feedback: $("feedback"),
  errors: $("errors"),
  openWrap: $("openWrap"),
  openSaved: $("openSaved")
};

/* ------------------------------------------------------------------------- *
 * Feedback helpers
 * ------------------------------------------------------------------------- */

let feedbackTimer = null;

function feedback(message, kind = "") {
  els.feedback.textContent = message || "";
  els.feedback.className = kind;
  if (feedbackTimer) clearTimeout(feedbackTimer);
  if (message) {
    feedbackTimer = setTimeout(() => {
      els.feedback.textContent = "";
      els.feedback.className = "";
    }, 6000);
  }
}

function setBusy(busy) {
  for (const button of [els.start, els.classify, els.sort, els.inspect, els.testProvider]) {
    button.disabled = busy;
  }
  for (const field of [els.provider, els.model, els.baseUrl]) field.disabled = busy;
  els.stop.disabled = !busy;
  els.saveProvider.disabled = busy;
  els.saveCategories.disabled = busy;
  if (busy) disarm();
}

/* ------------------------------------------------------------------------- *
 * Two-click confirmation
 *
 * window.confirm() is unreliable inside an action popup (it can dismiss the
 * popup), so destructive actions require a second click on the same button
 * within a few seconds instead.
 * ------------------------------------------------------------------------- */

let armed = null;

function disarm() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed.button.textContent = armed.original;
  armed.button.classList.remove("armed");
  armed = null;
}

function armConfirm(button, confirmText, onConfirm) {
  if (armed && armed.button === button) {
    const run = armed.onConfirm;
    disarm();
    run();
    return;
  }
  disarm();
  armed = {
    button,
    original: button.textContent,
    onConfirm,
    timer: setTimeout(disarm, 6000)
  };
  button.textContent = confirmText;
  button.classList.add("armed");
  feedback("Click the same button again to confirm (6s).", "warn");
}

/* ------------------------------------------------------------------------- *
 * Messaging
 * ------------------------------------------------------------------------- */

async function send(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response || {};
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** Run an action, surfacing the background worker's response in the UI. */
async function act(message, successText) {
  const response = await send(message);
  if (!response.ok) {
    feedback(response.error || "Action failed.", "err");
    return response;
  }
  if (successText) feedback(successText, "ok");
  return response;
}

/* ------------------------------------------------------------------------- *
 * Rendering
 * ------------------------------------------------------------------------- */

function parseCategories(raw) {
  return String(raw || "")
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function renderLog(job) {
  const entries = Array.isArray(job.log) ? job.log.slice(-12).reverse() : [];
  els.errors.textContent = "";
  if (!entries.length) {
    els.errors.className = "muted";
    els.errors.textContent = "None.";
    return;
  }
  els.errors.className = "";
  for (const entry of entries) {
    const line = document.createElement("div");
    const level = entry.level === "error" ? "err" : entry.level === "warn" ? "warn" : "muted";
    line.className = level;
    const time = new Date(entry.t).toLocaleTimeString();
    line.textContent = `${time} · ${entry.message}`;
    els.errors.appendChild(line);
  }
}

/* ------------------------------------------------------------------------- *
 * Provider setup
 * ------------------------------------------------------------------------- */

/** Presets come from the service worker so the two cannot drift apart. */
let providerPresets = [];

const presetFor = (id) => providerPresets.find((preset) => preset.id === id) || null;

function renderProvider(settings) {
  if (!document.activeElement || document.activeElement !== els.provider) {
    els.provider.value = settings.provider || "deepseek";
  }
  if (document.activeElement !== els.model) els.model.value = settings.model || "";
  if (document.activeElement !== els.baseUrl) els.baseUrl.value = settings.baseUrl || "";
  if (document.activeElement !== els.apiKey) els.apiKey.value = settings.apiKey || "";

  const preset = presetFor(settings.provider);
  els.providerHint.textContent = preset && preset.hint ? preset.hint : "";
  els.baseUrlRow.style.display = settings.provider === "custom" ? "" : "none";

  // Ollama needs no key at all; say so instead of letting people hunt for one.
  const needsKey = preset ? preset.needsKey : true;
  els.keyNote.textContent = needsKey
    ? "(stored locally, per provider)"
    : "(not needed for this provider)";
  els.apiKey.placeholder = needsKey ? "paste key" : "leave empty";

  els.keyLink.textContent = "";
  if (preset && preset.keyUrl) {
    const anchor = document.createElement("a");
    anchor.href = preset.keyUrl;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = "Get a key →";
    els.keyLink.appendChild(anchor);
  }
}

function showTestResult(result) {
  els.testResult.style.display = "";
  els.testResult.className = result.ok ? "tiny ok" : "tiny err";
  els.testResult.textContent = "";

  const headline = result.ok
    ? `✓ ${result.provider} · ${result.model} · ${result.ms}ms · saw "${result.category}" (${result.confidence}) from ${result.source}`
    : `✗ ${result.error}`;
  els.testResult.appendChild(document.createTextNode(headline));

  if (result.warning) {
    const warn = document.createElement("div");
    warn.className = "warn";
    warn.textContent = `⚠ ${result.warning}`;
    els.testResult.appendChild(warn);
  }

  // Always show what the model actually replied: when parsing fails this is the
  // only way to see whether the JSON was truncated, fenced, or never emitted.
  if (result.raw) {
    const raw = document.createElement("div");
    raw.className = "muted";
    raw.style.marginTop = "4px";
    raw.style.fontFamily = "ui-monospace, Menlo, Consolas, monospace";
    raw.style.wordBreak = "break-word";
    raw.textContent = `model said: ${result.raw}`;
    els.testResult.appendChild(raw);
  }
}

/**
 * A tiny image to test with when nothing has been collected yet. Vision models
 * are happiest with a real raster image, so draw one instead of shipping a
 * binary asset.
 */
function makeTestImage() {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 64, 64);
    gradient.addColorStop(0, "#d62976");
    gradient.addColorStop(1, "#4f5bd5");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "#f4f4f4";
    ctx.beginPath();
    ctx.arc(32, 32, 16, 0, Math.PI * 2);
    ctx.fill();
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** The most recent probe report, whether from a dry-run sort or a manual inspect. */
function pickReport(state) {
  const candidates = [];
  if (state.probe && state.probe.lines) {
    candidates.push({
      at: state.probe.at || 0,
      source: "tab you inspected",
      report: state.probe
    });
  }
  for (const post of state.posts) {
    if (post.dryRunReport && post.dryRunReport.lines) {
      candidates.push({
        at: post.dryRunReport.at || 0,
        source: `post ${post.shortcode}`,
        report: post.dryRunReport
      });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.at || 0) - (a.at || 0));
  return candidates[0];
}

/**
 * The diagnosis panel renders on every popup refresh from a stored report, so
 * without bookkeeping of its own it would reappear forever — exactly the spam
 * the dismiss button exists to stop. Dismissal is tracked per report timestamp:
 * a NEW diagnosis (a different `at`) shows itself; re-opening the popup does
 * not resurrect the one you dismissed.
 */
let dismissedDiagAt = null;
let lastDiagnosisReport = null;

function renderDiagnosis(state) {
  const report = state.diagnosis;
  if (!report || !Array.isArray(report.lines)) {
    els.diagWrap.style.display = "none";
    els.diag.textContent = "";
    els.dismissDiag.style.display = "none";
    lastDiagnosisReport = null;
    return;
  }
  lastDiagnosisReport = report;
  // A new diagnosis always overrides any earlier dismissal — including one
  // made while this very report was being replaced by the in-progress run.
  if (state.diagnosisJustRan || report.at !== dismissedDiagAt) {
    dismissedDiagAt = null;
  }
  if (dismissedDiagAt === report.at) {
    els.diagWrap.style.display = "none";
    return;
  }
  els.diagWrap.style.display = "";
  els.dismissDiag.style.display = "";
  const when = report.at ? new Date(report.at).toLocaleTimeString() : "?";
  const verdict = report.problems
    ? `${report.problems} problem(s) to fix`
    : report.warnings
      ? `${report.warnings} warning(s), nothing broken`
      : "all clear";
  els.diagMeta.className = report.problems ? "tiny err" : report.warnings ? "tiny warn" : "tiny ok";
  const unchanged = report.sameAsPrevious ? " · unchanged since last run" : "";
  els.diagMeta.textContent = `${verdict} · ${report.provider || "?"} · ${report.model || "?"} · ${when}${unchanged}`;
  els.diag.textContent = report.lines.join("\n");
}

function renderReport(state) {
  const picked = pickReport(state);
  if (!picked) {
    els.reportWrap.style.display = "none";
    els.report.textContent = "";
    return;
  }
  els.reportWrap.style.display = "";

  const parts = [picked.source];
  if (picked.report.category) parts.push(picked.report.category);
  if (picked.at) parts.push(new Date(picked.at).toLocaleTimeString());

  const probed = state.posts.filter((post) => post.dryRunReport);
  if (probed.length > 1) {
    const bad = probed.filter((post) => !post.dryRunOk).length;
    parts.push(`dry run: ${probed.length} probed, ${bad} need attention`);
  }
  els.reportMeta.textContent = parts.join(" · ");
  els.report.textContent = picked.report.lines.join("\n");
}

function render(state) {
  const { posts, settings, job, username } = state;

  renderProvider(settings);
  if (document.activeElement !== els.categories) {
    els.categories.value = (settings.categories || DEFAULT_CATEGORIES).join(", ");
  }
  const dryRun = !!settings.dryRun;
  if (document.activeElement !== els.dryRun) els.dryRun.checked = dryRun;
  const resort = !!settings.resortUnconfirmed;
  if (document.activeElement !== els.resortUnconfirmed) els.resortUnconfirmed.checked = resort;
  els.sort.textContent = dryRun
    ? "3 · Dry-Run Sort (no clicks)"
    : "3 · Sort Into Collections";

  const collected = posts.length;
  const classified = posts.filter((post) => post.category).length;
  const sorted = posts.filter((post) => post.status === "written").length;
  const failed = posts.filter((post) => post.status === "failed").length;

  els.cCollected.textContent = String(collected);
  els.cClassified.textContent = String(classified);
  els.cSorted.textContent = String(sorted);
  els.cFailed.textContent = String(failed);

  // "Sorted" alone is not enough: a write whose collection state could not be
  // read back is counted as sorted, and saying nothing about those is how
  // "nothing happened" reaches the user with no warning at all.
  const unverified = posts.filter(
    (post) => post.status === "written" && post.writtenConfirmed === false
  ).length;
  const legacy = posts.filter(
    (post) => post.status === "written" && post.writtenConfirmed === undefined
  ).length;
  if (unverified || legacy) {
    els.verifyLine.className = "tiny warn";
    els.verifyLine.textContent = [
      unverified ? `${unverified} sorted post(s) were never confirmed` : null,
      legacy ? `${legacy} sorted before verification existed (outcome unknown)` : null
    ]
      .filter(Boolean)
      .join(" · ")
      .concat(" — open one on Instagram to check, then press Diagnose state.");
  } else {
    els.verifyLine.className = "tiny muted";
    els.verifyLine.textContent = "";
  }

  const running = !!job.running;
  setBusy(running);

  // Collecting is a phase without a job: it must not read as "idle", because
  // that is exactly what makes it look like nothing is happening.
  els.phase.textContent = running
    ? job.phase || "running"
    : job.phase === "collect"
      ? "collecting"
      : "idle";
  els.jobLabel.textContent = job.label || "Idle";

  const total = Number(job.total) || 0;
  const done = Number(job.done) || 0;
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  els.progressBar.style.width = `${percent}%`;

  if (username) {
    els.openWrap.style.display = "";
    // The bare /saved/ path is stable; the sub-tab slugs have changed over time.
    els.openSaved.href = `https://www.instagram.com/${encodeURIComponent(username)}/saved/`;
  } else {
    els.openWrap.style.display = "none";
  }

  renderLog(job);
  renderReport(state);
  renderDiagnosis(state);
  state.diagnosisJustRan = false;
}

/* ------------------------------------------------------------------------- *
 * State loading
 * ------------------------------------------------------------------------- */

let refreshTimer = null;

async function refresh() {
  // The service worker resolves the provider preset (and which stored key to
  // use) so the popup never duplicates that logic.
  const [data, settingsResponse] = await Promise.all([
    chrome.storage.local.get([
      "sortedPosts",
      "jobState",
      "lastUsername",
      "lastProbe",
      "lastDiagnosis"
    ]),
    send({ type: "GET_SETTINGS" })
  ]);
  render({
    posts: Array.isArray(data.sortedPosts) ? data.sortedPosts : [],
    settings: (settingsResponse && settingsResponse.settings) || {},
    job: data.jobState || {},
    username: data.lastUsername || null,
    probe: data.lastProbe || null,
    diagnosis: data.lastDiagnosis || null
  });
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 150);
}

/* ------------------------------------------------------------------------- *
 * Actions
 * ------------------------------------------------------------------------- */

async function saveProvider({ quiet = false, includeKey = true, includeModel = true } = {}) {
  const patch = {
    provider: els.provider.value,
    baseUrl: els.baseUrl.value.trim()
  };
  if (includeModel) patch.model = els.model.value.trim();
  if (includeKey) patch.apiKey = els.apiKey.value;

  const response = await act(
    { type: "SET_SETTINGS", patch },
    quiet ? undefined : "Provider settings saved."
  );
  if (response.ok) refresh();
  return response;
}

els.saveProvider.addEventListener("click", () => saveProvider());

/**
 * Switching provider must NOT carry the old key or model over: both are stored
 * per provider, so we change only the provider and let the resolved settings
 * refill the fields with whatever that provider already has (usually nothing).
 */
els.provider.addEventListener("change", async () => {
  const preset = presetFor(els.provider.value);
  els.testResult.style.display = "none";
  const response = await saveProvider({ quiet: true, includeKey: false, includeModel: false });
  if (response.ok) {
    feedback(`Now using ${preset ? preset.label : "your provider"}.`, "ok");
  }
});

els.testProvider.addEventListener("click", async () => {
  // Save first: the test must exercise what is on screen, not stale settings.
  const saved = await saveProvider({ quiet: true });
  if (!saved.ok) {
    showTestResult({ ok: false, error: saved.error || "Could not save settings." });
    return;
  }
  els.testProvider.disabled = true;
  els.testResult.style.display = "";
  els.testResult.className = "tiny muted";
  els.testResult.textContent = "Testing…";
  const response = await send({ type: "TEST_MODEL", fallbackImage: makeTestImage() });
  els.testProvider.disabled = false;
  if (!response.ok) {
    showTestResult({ ok: false, error: response.error || "Test failed." });
    return;
  }
  showTestResult(response);
  refresh();
});

els.saveCategories.addEventListener("click", async () => {
  const categories = parseCategories(els.categories.value);
  if (!categories.length) {
    feedback("Add at least one category.", "warn");
    return;
  }
  await act(
    { type: "SET_SETTINGS", patch: { categories } },
    `Saved ${categories.length} categories.`
  );
});

/**
 * Say, in plain language, whether a collector is actually listening. This is the
 * difference between "the extension is broken" and "you have not scrolled yet".
 */
function renderCollector(summary) {
  if (!summary) {
    els.collectorLine.className = "tiny muted";
    els.collectorLine.textContent = "";
    return;
  }

  if (!summary.tabs) {
    els.collectorLine.className = "tiny warn";
    els.collectorLine.textContent =
      "Collector: no Instagram tab open — open your Saved page.";
    return;
  }

  if (!summary.live) {
    els.collectorLine.className = "tiny err";
    els.collectorLine.textContent = `Collector: not running in ${summary.stale} tab(s) — reload the Instagram tab (F5). If it persists, set Site access to "On all sites".`;
    return;
  }

  const parts = [`Collector: live in ${summary.live} tab(s)`];
  if (summary.seen) parts.push(`${summary.seen} tile(s) recorded`);
  if (summary.savedPages) parts.push("Saved page open");
  else if (summary.targets) parts.push("post page open");
  else parts.push("not a Saved page");
  if (summary.targets && !summary.anchors) parts.push("no tiles found yet");

  const healthy = summary.savedPages > 0 || summary.seen > 0;
  els.collectorLine.className = healthy ? "tiny ok" : "tiny warn";
  els.collectorLine.textContent = parts.join(" · ");
}

let collectorTimer = null;

async function pingCollectors() {
  const response = await send({ type: "PING_COLLECTORS" });
  if (response && response.ok) renderCollector(response);
}

async function startCollecting() {
  const response = await act({ type: "START_COLLECTING" });
  if (!response.ok) return;

  renderCollector(response);
  if (!response.live) {
    feedback(
      response.tabs
        ? "Started, but the collector is not running in your Instagram tab — reload that tab, then scroll."
        : "Started. Now open your Saved page in a tab and scroll it.",
      "warn"
    );
  } else if (!response.targets) {
    feedback(
      "Started, but the open Instagram tab is not a Saved page — open Saved and scroll there.",
      "warn"
    );
  } else {
    feedback(
      "Collecting. Scroll your Saved page slowly — the toolbar badge counts what gets recorded.",
      "ok"
    );
  }
  refresh();
}

els.start.addEventListener("click", async () => {
  const { sortedPosts } = await chrome.storage.local.get("sortedPosts");
  const count = Array.isArray(sortedPosts) ? sortedPosts.length : 0;
  if (!count) {
    await startCollecting();
    return;
  }
  armConfirm(els.start, `Clear ${count} post(s) & restart`, startCollecting);
});

els.classify.addEventListener("click", async () => {
  const response = await act(
    { type: "START_CLASSIFY" },
    "Classification started — progress updates below."
  );
  if (response.ok) setTimeout(scheduleRefresh, 300);
});

els.sort.addEventListener("click", async () => {
  const dryRun = els.dryRun.checked;
  const response = await act(
    { type: "START_WRITEBACK", dryRun },
    dryRun
      ? "Dry run started — each post is inspected, nothing is clicked."
      : "Sorting started — background tabs will open and close automatically."
  );
  if (response.ok) setTimeout(scheduleRefresh, 300);
});

els.dryRun.addEventListener("change", async () => {
  const dryRun = els.dryRun.checked;
  els.sort.textContent = dryRun
    ? "3 · Dry-Run Sort (no clicks)"
    : "3 · Sort Into Collections";
  await act({ type: "SET_SETTINGS", patch: { dryRun } });
});

els.resortUnconfirmed.addEventListener("change", async () => {
  await act({
    type: "SET_SETTINGS",
    patch: { resortUnconfirmed: els.resortUnconfirmed.checked }
  });
});

/**
 * Probe the tab the user is already on. This is how the picker-only steps get
 * verified: open a post, click the bookmark yourself, then inspect.
 */
els.inspect.addEventListener("click", async () => {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (error) {
    feedback(`Cannot read the active tab: ${(error && error.message) || error}`, "err");
    return;
  }
  const tab = tabs[0];
  if (!tab || !/^https:\/\/www\.instagram\.com\//.test(tab.url || "")) {
    feedback("Open an Instagram post page in this tab first.", "warn");
    return;
  }

  const response = await send({
    type: "PROBE_TAB",
    tabId: tab.id,
    url: tab.url,
    category: parseCategories(els.categories.value)[0]
  });
  if (!response.ok) {
    feedback(response.error || "Probe failed.", "err");
    return;
  }
  const report = response.report || {};
  feedback(
    report.ok
      ? "Save icon found — full report below."
      : "Save icon not found — see the report below.",
    report.ok ? "ok" : "warn"
  );
  refresh();
});

/**
 * Copy text with a fallback chain, because clipboard access in a popup is not
 * guaranteed: the async Clipboard API may be denied, so fall back to a hidden
 * textarea and finally to selecting the report so Ctrl+C works.
 */
async function copyText(text, element) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    feedback("Copied to the clipboard.", "ok");
    return;
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    feedback("Copied to the clipboard.", "ok");
  } catch {
    if (element) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    feedback("Report selected — press Ctrl/Cmd+C to copy.", "warn");
  }
}

els.copyReport.addEventListener("click", () =>
  copyText(els.report.textContent, els.report)
);

els.copyDiag.addEventListener("click", () => copyText(els.diag.textContent, els.diag));

/**
 * Hide the report until the next one runs. Only the panel is hidden: the stored
 * report is kept so Copy and Diagnose-state still have something to work from,
 * and the storage watcher's refresh() must not bring it back.
 */
els.dismissDiag.addEventListener("click", () => {
  const report = lastDiagnosisReport;
  dismissedDiagAt = report ? report.at : Date.now();
  els.diagWrap.style.display = "none";
  els.diag.textContent = "";
  feedback("Diagnosis hidden — press Diagnose state to run a new one.", "warn");
});

/**
 * Inspect the whole pipeline and print what to do next. Deliberately allowed to
 * run while a job is running: that is exactly when a stuck run needs explaining
 * (it then skips the network test and says so).
 */
els.diagnose.addEventListener("click", async () => {
  els.diagnose.disabled = true;
  els.diagWrap.style.display = "";
  els.diagMeta.className = "tiny muted";
  els.diagMeta.textContent = "inspecting…";
  els.diag.textContent = "Checking provider, permissions, collected data and tabs…";

  const response = await send({ type: "DIAGNOSE", fallbackImage: makeTestImage() });
  els.diagnose.disabled = false;

  if (!response.ok) {
    els.diagMeta.textContent = "diagnosis failed";
    els.diag.textContent = response.error || "Unknown error.";
    return;
  }
  renderDiagnosis({ diagnosis: response.report, diagnosisJustRan: true });
  const report = response.report || {};
  feedback(
    report.problems
      ? `Diagnosis found ${report.problems} problem(s) - see the report below.`
      : "Diagnosis: no problems found.",
    report.problems ? "err" : "ok"
  );
});

els.stop.addEventListener("click", async () => {
  await act({ type: "STOP_JOB" }, "Stopping after the current item…");
});

els.clear.addEventListener("click", async () => {
  armConfirm(els.clear, "Really delete everything?", async () => {
    await act({ type: "CLEAR_ALL" }, "All stored data cleared.");
    refresh();
  });
});

/* ------------------------------------------------------------------------- *
 * Wiring
 * ------------------------------------------------------------------------- */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes.sortedPosts ||
    changes.settings ||
    changes.jobState ||
    changes.lastUsername ||
    changes.lastProbe ||
    changes.lastDiagnosis
  ) {
    scheduleRefresh();
  }
});

// The background worker also broadcasts progress; storage.onChanged alone is
// usually enough, but this keeps the UI snappy if a write is coalesced.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "JOB") scheduleRefresh();
});

/* ------------------------------------------------------------------------- *
 * Boot
 * ------------------------------------------------------------------------- */

async function boot() {
  // Poll the collector while the popup is open so the line stays truthful while
  // the user scrolls in another tab and checks back here.
  await pingCollectors();
  collectorTimer = setInterval(pingCollectors, 3000);

  const response = await send({ type: "GET_PROVIDERS" });
  if (response.ok && Array.isArray(response.providers)) {
    providerPresets = response.providers;
    els.provider.textContent = "";
    for (const preset of providerPresets) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      els.provider.appendChild(option);
    }
  }
  refresh();
}

boot();
