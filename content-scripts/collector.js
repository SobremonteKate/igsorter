/* ---------------------------------------------------------------------------
 * content-scripts/collector.js
 *
 * PASSIVE collection phase.
 *
 * This script never scrolls and never navigates. It only watches whatever
 * Instagram has already rendered into the Saved page grid and reports each
 * post tile it has not reported before to the background service worker.
 *
 * The manifest injects this on every instagram.com page, because the Saved URL
 * has changed shape more than once (/<user>/saved/, /<user>/saved/all-posts/,
 * /saved/...) and a too-narrow match pattern fails silently - the script simply
 * never runs and nothing is ever collected. Instead the script is injected
 * everywhere and decides for itself whether the current page is collectable.
 *
 * Collects on: a Saved page  and  a post/reel page. Everywhere else it is inert.
 * ------------------------------------------------------------------------ */

(() => {
  "use strict";

  // Only the top-level document contains the posts grid. (The manifest already
  // sets all_frames: false, this is just belt and braces.)
  if (window.top !== window.self) return;

  const DEBUG = true;

  /** Shortcodes already handed to the background worker in this page lifetime. */
  const SEEN = new Set();
  /**
   * Tiles seen without a usable <img src> yet (Instagram lazy-loads them).
   * We retry a few times before giving up so we never silently drop a post
   * that simply had not rendered its thumbnail yet.
   */
  const ATTEMPTS = new Map();
  const MAX_THUMBLESS_ATTEMPTS = 6;

  const SCAN_DEBOUNCE_MS = 350;
  const WATCHDOG_INTERVAL_MS = 3000;

  // Fallback strategy #1 for finding tiles: match on the href *shape*, never on
  // Instagram's obfuscated class names (they are regenerated on every deploy).
  // One long selector beats three separate querySelectorAll calls.
  const ANCHOR_SELECTOR = 'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]';

  /**
   * Every link worth looking at. The post-shaped selector above is the fast path,
   * but we also hand over plainer anchors and let parsePostHref make the final
   * call. That removes a whole failure class: if Instagram changes a link prefix,
   * a too-narrow selector finds nothing and the user just sees "0 collected" with
   * no explanation. Extra anchors cost a little CPU and nothing else.
   */
  function candidateLinks(root) {
    const out = new Set();
    try {
      for (const anchor of root.querySelectorAll(ANCHOR_SELECTOR)) out.add(anchor);
    } catch {
      /* fall through to the broader sweep */
    }
    try {
      for (const anchor of root.querySelectorAll("a[href]")) out.add(anchor);
    } catch {
      /* nothing else we can do */
    }
    return out;
  }

  // Fallback strategy for "am I on the right page?": match the path SEGMENTS
  // rather than one exact URL, so any current or future Saved URL shape works.
  const SAVED_PATH_RE = /(^|\/)saved(\/|$)/;
  const POST_PATH_RE = /^\/(p|reel)\/[^/]+/;
  // /reels/audio/... and friends are browsing pages, not posts: without this
  // they would be collected as if the user had saved those reels.
  const REELS_SUBPAGE_RE = /^\/reels\/(audio|videos|trending|search|clips)(\/|$)/;

  let gridObserver = null;
  let observedContainer = null;
  let scanTimer = null;
  let lastTargetState = null;
  /** Last exception thrown while scanning, surfaced in the popup's diagnosis. */
  let lastScanError = null;

  /** Is this a page whose tiles we are allowed to record? */
  function isCollectionTarget() {
    const path = location.pathname;
    if (SAVED_PATH_RE.test(path)) return true;
    if (REELS_SUBPAGE_RE.test(path)) return false;
    return POST_PATH_RE.test(path) || /^\/reels\/[^/]+/.test(path);
  }

  /**
   * What we scan. Deliberately the whole content area rather than a guessed grid
   * container: guessing wrong meant "45 tiles visible, 0 recorded" with no clue
   * why. MutationObserver still watches the discovered container so scans are
   * instant, but correctness no longer depends on finding it.
   */
  function getScanRoot() {
    return document.querySelector("main") || document.body || document;
  }

  /**
   * A snapshot of exactly what this collector can and cannot see. Shown in the
   * popup's diagnosis, because "nothing collected" has several causes that look
   * identical from outside.
   */
  function buildScanReport() {
    const root = getScanRoot();
    const report = {
      target: isCollectionTarget(),
      pathname: location.pathname,
      root: root === document ? "document" : root.tagName.toLowerCase(),
      anchors: 0,
      parsed: 0,
      withThumbnail: 0,
      linksWithImage: 0,
      totalAnchors: 0,
      seen: SEEN.size,
      awaitingThumbnail: ATTEMPTS.size,
      lastScanError,
      sampleShortcodes: [],
      unmatchedHrefs: [],
      sampleHrefs: [],
      sampleTileHtml: null
    };

    let anchors = [];
    try {
      anchors = [...candidateLinks(root)];
    } catch (error) {
      report.lastScanError = `querySelectorAll: ${error.message}`;
      return report;
    }
    report.anchors = anchors.length;

    // Sample EVERY anchor in the content area, not just the ones the post
    // selector matched. When the tile link shape changes, the hrefs that would
    // reveal it are exactly the ones the post selector rejects - so without this
    // the report shows "0 parsed" and no way to find out what the links are.
    try {
      const everyAnchor = root.querySelectorAll("a[href]");
      report.totalAnchors = everyAnchor.length;
      const unique = new Set();
      for (const element of everyAnchor) {
        const raw = element.getAttribute("href") || "";
        if (!raw || raw === "#" || raw.startsWith("javascript:")) continue;
        const key = raw.split("?")[0];
        if (unique.has(key)) continue;
        unique.add(key);
        if (report.sampleHrefs.length < 12) report.sampleHrefs.push(raw.slice(0, 110));
      }
    } catch (error) {
      report.lastScanError = report.lastScanError || `href sample: ${error.message}`;
    }

    for (const anchor of anchors) {
      const raw = anchor.getAttribute("href") || anchor.href || "";
      const info = parsePostHref(raw);
      // Counted for every link, not just the ones that parse: "the grid is there
      // but the links are the wrong shape" is exactly the diagnosis we need, and
      // it only holds if images are seen independently of the link pattern.
      try {
        if (anchor.querySelector("img")) report.linksWithImage++;
      } catch {
        /* ignore */
      }
      if (!info) {
        if (report.unmatchedHrefs.length < 6) report.unmatchedHrefs.push(String(raw).slice(0, 140));
        continue;
      }
      report.parsed++;
      if (report.sampleShortcodes.length < 6) {
        report.sampleShortcodes.push(info.shortcode + (info.prefixed ? " (prefixed url)" : ""));
      }
      try {
        if (extractThumbnail(anchor)) report.withThumbnail++;
      } catch (error) {
        report.lastScanError = report.lastScanError || `thumbnail: ${error.message}`;
      }
      if (!report.sampleTileHtml) {
        try {
          report.sampleTileHtml = String(anchor.outerHTML || "").slice(0, 400);
        } catch {
          /* ignore */
        }
      }
    }
    return report;
  }

  const log = (...args) => {
    if (DEBUG) console.debug("[IG-Sorter/collector]", ...args);
  };

  /* ---------------------------------------------------------------------- *
   * Extraction helpers
   * ---------------------------------------------------------------------- */

  /**
   * Pull the shortcode + media kind out of an anchor href.
   * Accepts absolute (https://www.instagram.com/p/ABC/) and relative
   * (/p/ABC/) hrefs. We parse the pathname instead of regex-matching the raw
   * href so query strings such as "?next=/p/ABC/" cannot produce a false hit.
   */
  /** Path segments that look like a post prefix but are browsing pages. */
  const RESERVED_SEGMENTS = new Set([
    "audio",
    "videos",
    "trending",
    "search",
    "clips",
    "explore",
    "tags",
    "locations"
  ]);

  function parsePostHref(href) {
    if (!href) return null;
    let url = null;
    let pathname = href;
    try {
      url = new URL(href, location.origin);
      pathname = url.pathname;
    } catch {
      /* keep the raw string and let the regex try */
    }

    // Fallback strategy: prefer the permalink at the start of the path, but also
    // accept it anywhere in the path. Some views prefix the link with the current
    // context (e.g. /<user>/saved/<collection>/p/<code>/), and rejecting those
    // silently records nothing.
    const match =
      pathname.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) ||
      pathname.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (!match) return null;
    if (RESERVED_SEGMENTS.has(match[2].toLowerCase())) return null;

    const kind = match[1] === "reels" ? "reel" : match[1];
    return {
      shortcode: match[2],
      mediaType: kind,
      // The tile's own URL, used verbatim for write-back so an unusual link shape
      // still opens the right post instead of a reconstructed /p/<shortcode>/.
      permalink: url ? url.href : null,
      prefixed: !/^\/(p|reel|reels|tv)\//.test(pathname)
    };
  }

  /** Pick the largest URL out of a srcset attribute ("url 320w, url 640w"). */
  function largestFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null;
    let bestScore = -1;
    for (const entry of srcset.split(",")) {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0];
      if (!/^https?:/.test(url)) continue;
      const descriptor = parts[1] || "";
      const score = parseFloat(descriptor) || 1;
      if (score > bestScore) {
        bestScore = score;
        best = url;
      }
    }
    return best;
  }

  /** Last-resort thumbnail source: a CSS background-image on the tile. */
  function fromBackgroundImage(tile) {
    const inline = tile.getAttribute("style") || "";
    const inlineMatch = inline.match(/url\(["']?(https?:[^"')]+)["']?\)/);
    if (inlineMatch) return inlineMatch[1];
    const inner = tile.querySelector("div");
    if (inner) {
      const computed = getComputedStyle(inner).backgroundImage || "";
      const computedMatch = computed.match(/url\(["']?(https?:[^"')]+)["']?\)/);
      if (computedMatch) return computedMatch[1];
    }
    return null;
  }

  /**
   * Thumbnail URL for a tile.
   * Order of preference: what the browser actually loaded (currentSrc), then
   * src, then the highest-resolution srcset candidate, then data-src (lazy
   * attributes), then a CSS background-image fallback.
   */
  function extractThumbnail(tile) {
    const candidates = [];
    const img = tile.querySelector("img");

    if (img) {
      if (img.currentSrc) candidates.push(img.currentSrc);
      const src = img.getAttribute("src") || img.src || "";
      if (src && !src.startsWith("data:") && !src.startsWith("blob:")) candidates.push(src);
      const fromSet = largestFromSrcset(
        img.getAttribute("srcset") || img.getAttribute("data-srcset")
      );
      if (fromSet) candidates.push(fromSet);
      const dataSrc = img.getAttribute("data-src");
      if (dataSrc) candidates.push(dataSrc);
    }

    candidates.push(fromBackgroundImage(tile));
    for (const url of candidates) {
      if (url && /^https?:/.test(url)) return url;
    }
    return null;
  }

  /* ---------------------------------------------------------------------- *
   * Grid container discovery
   * ---------------------------------------------------------------------- */

  /**
   * Instagram ships no stable ids/classes for the posts grid, so we infer it:
   *  1. if a single element is the direct parent of >= 2 post anchors, that is
   *     the grid (this is the common case for the Saved page);
   *  2. otherwise fall back to a `div[style*="grid"]` inside <main>;
   *  3. otherwise observe <main> itself (covers the empty / single-post case).
   */
  function findGridContainer() {
    const main = document.querySelector("main") || document.body;
    if (!main) return null;

    const anchors = main.querySelectorAll(ANCHOR_SELECTOR);
    const counts = new Map();
    for (const anchor of anchors) {
      const parent = anchor.parentElement;
      if (parent) counts.set(parent, (counts.get(parent) || 0) + 1);
    }

    let best = null;
    let bestCount = 0;
    for (const [element, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        best = element;
      }
    }
    if (best && bestCount >= 2) return best;

    return main.querySelector('div[style*="grid"]') || main;
  }

  /* ---------------------------------------------------------------------- *
   * Reporting
   * ---------------------------------------------------------------------- */

  /**
   * Username from the current Saved URL so the popup can build a direct link.
   * Reserved paths are excluded so /p/<code>/ never looks like a username.
   */
  function currentUsername() {
    const match = location.pathname.match(/^\/([^/]+)\/saved/);
    if (!match) return null;
    const name = decodeURIComponent(match[1]);
    const reserved = ["p", "reel", "reels", "explore", "accounts", "direct", "stories"];
    return reserved.includes(name) ? null : name;
  }

  function send(posts) {
    try {
      const pending = chrome.runtime.sendMessage({
        type: "COLLECT_POSTS",
        posts,
        page: { username: currentUsername() }
      });
      if (pending && typeof pending.catch === "function") {
        pending.catch(() => {
          /* background asleep or extension reloading - the next scan retries */
        });
      }
      log(`sent ${posts.length} post(s)`);
      return true;
    } catch (error) {
      // Synchronous throw == invalidated extension context (e.g. after a
      // reload). Un-mark the shortcodes so a later scan can retry them.
      for (const post of posts) SEEN.delete(post.shortcode);
      log("sendMessage failed", error);
      return false;
    }
  }

  /** Scan the currently rendered tiles and report anything new. */
  function collect() {
    if (!isCollectionTarget()) return;
    const root = getScanRoot();
    if (!root) return;

    let anchors;
    try {
      // Deliberately the same candidate set the scan report measures, so the two
      // can never disagree about whether this page has readable tiles.
      anchors = [...candidateLinks(root)];
    } catch (error) {
      lastScanError = `querySelectorAll: ${error.message}`;
      return;
    }

    const batch = [];
    for (const anchor of anchors) {
      // One malformed tile must never abort the whole scan - that failure mode
      // looks exactly like "the extension is doing nothing".
      try {
        const info = parsePostHref(anchor.getAttribute("href") || anchor.href);
        if (!info || SEEN.has(info.shortcode)) continue;

        let thumbnailUrl = null;
        try {
          thumbnailUrl = extractThumbnail(anchor);
        } catch (error) {
          lastScanError = `thumbnail: ${error.message}`;
        }
        if (!thumbnailUrl) {
          const attempts = (ATTEMPTS.get(info.shortcode) || 0) + 1;
          ATTEMPTS.set(info.shortcode, attempts);
          if (attempts < MAX_THUMBLESS_ATTEMPTS) continue; // give lazy loading a chance
        }

        SEEN.add(info.shortcode);
        ATTEMPTS.delete(info.shortcode);
        batch.push({
          postId: info.shortcode,
          shortcode: info.shortcode,
          mediaType: info.mediaType,
          permalink: info.permalink,
          thumbnailUrl: thumbnailUrl || null,
          category: null,
          confidence: null,
          status: "collected",
          source: "saved-grid",
          collectedAt: Date.now()
        });
      } catch (error) {
        lastScanError = `${error.name || "Error"}: ${error.message}`;
      }
    }

    if (batch.length) send(batch);
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      collect();
    }, SCAN_DEBOUNCE_MS);
  }

  /* ---------------------------------------------------------------------- *
   * Observers
   * ---------------------------------------------------------------------- */

  function ensureObserver() {
    // Instagram is a single-page app: the URL can change without a reload, so
    // this runs on every watchdog tick and picks up a route into the Saved page.
    const target = isCollectionTarget();
    if (target !== lastTargetState) {
      lastTargetState = target;
      log(target ? `collectable page detected: ${location.pathname}` : `inert on ${location.pathname}`);
      if (!target) {
        observedContainer = null;
        if (gridObserver) {
          gridObserver.disconnect();
          gridObserver = null;
        }
      }
    }
    if (!target) return;

    const container = findGridContainer();
    if (!container) return;

    if (container === observedContainer) return;

    if (gridObserver) gridObserver.disconnect();
    observedContainer = container;
    gridObserver = new MutationObserver(scheduleScan);
    gridObserver.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      // Lazy images swap their src/srcset in after the tile markup exists, so
      // those attribute mutations are exactly what we want to hear about.
      attributeFilter: ["src", "srcset", "data-src", "data-srcset", "style"]
    });

    log("observing grid container", container);
    scheduleScan();
  }

  /**
   * Watchdog: Instagram is a single-page app and swaps <main>'s subtree on
   * navigation, which would silently detach a long-lived observer. A cheap
   * re-check also catches tiles rendered without any observable mutation
   * (e.g. contents restored from the bfcache).
   */
  function startWatchdog() {
    setInterval(() => {
      ensureObserver();
      scheduleScan();
    }, WATCHDOG_INTERVAL_MS);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;

    if (message.type === "RESET_COLLECTOR") {
      SEEN.clear();
      ATTEMPTS.clear();
      lastScanError = null;
      log("collector state reset");
      scheduleScan();
      return;
    }

    // Answered for the popup's self-diagnosis: proves the content script is
    // alive in this tab (a reloaded extension leaves a stale, dead one behind)
    // and reports how many tiles it has actually seen here.
    if (message.type === "COLLECTOR_PING") {
      sendResponse({
        ok: true,
        seen: SEEN.size,
        awaitingThumbnail: ATTEMPTS.size,
        url: location.href,
        pathname: location.pathname,
        isTarget: isCollectionTarget(),
        observing: !!gridObserver,
        report: buildScanReport(),
        // Explicit, because "the script is loaded but this is the wrong page"
        // and "the script is not loaded at all" look identical from outside.
        onSavedPage: SAVED_PATH_RE.test(location.pathname)
      });
    }
  });

  ensureObserver();
  startWatchdog();
  log("collector ready");
})();
