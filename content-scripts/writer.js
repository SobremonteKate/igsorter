/* ---------------------------------------------------------------------------
 * content-scripts/writer.js
 *
 * NOT declared in manifest.json. It is injected on demand by background.js with
 *   chrome.scripting.executeScript({ target: { tabId }, files: ["content-scripts/writer.js"] })
 * while the post page https://www.instagram.com/p/<shortcode>/ is open in a
 * background tab.
 *
 * Because `files`-injections cannot receive arguments, this file only *defines*
 * a function on the extension's isolated-world global:
 *
 *     globalThis.__IG_SORTER_WRITE__(category, shortcode, options) -> Promise<result>
 *
 * background.js immediately follows up with a second executeScript({ func })
 * injection that calls it, so the (JSON-serialisable) result can be returned to
 * the service worker. The function *also* reports the outcome with
 * chrome.runtime.sendMessage({ type: "WRITE_RESULT", ... }) as required.
 *
 * options.dryRun === true switches to analyzePage(), which reports which element
 * every step WOULD act on and dispatches no events at all; it answers with
 * {type: "PROBE_RESULT"} instead. options.categories (an array) makes the report
 * say, for each configured category, whether an existing row was found.
 *
 * Both modes share the same strategy ladders, so a dry run verifies the code the
 * real run will use rather than a copy of it.
 *
 * ---------------------------------------------------------------------------
 * FALLBACK SELECTOR STRATEGY
 *
 * Instagram's CSS class names are obfuscated and rotate every deploy, so this
 * file never uses them. Everything is located by ARIA label, role, visible
 * text or href shape, and every lookup has an ordered list of fallbacks plus a
 * timeout. If all strategies fail we return a descriptive error instead of
 * clicking something random.
 * ------------------------------------------------------------------------ */

(() => {
  "use strict";

  // Guard against the file being injected twice into the same tab/isolated world.
  if (globalThis.__IG_SORTER_WRITE__) return;

  /**
   * Which selector in each fallback ladder actually matched. Populated during a
   * run and surfaced in the result so a real failure says *which* strategy won
   * instead of just "timeout".
   */
  const trace = { saveIconStrategy: null, panelStrategy: null };

  /* ---------------------------------------------------------------------- *
   * Small utilities
   * ---------------------------------------------------------------------- */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(element);
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0"
    );
  }

  /** Generic polling wait. Throws a descriptive timeout error. */
  async function waitFor(getValue, options = {}) {
    const { timeout = 10000, interval = 200, label = "element" } = options;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = getValue();
      if (value) return value;
      await sleep(interval);
    }
    throw new Error(`timeout_waiting_for_${label}`);
  }

  /**
   * Click something the way a user would. Instagram's handlers are React
   * synthetic listeners on ancestors, so we dispatch the full mouse event
   * sequence on the closest clickable ancestor rather than calling
   * element.click() (which skips the pointer events React sometimes needs).
   */
  function clickElement(element) {
    if (!element) return null;
    const target =
      element.closest('[role="button"], button, a, label, [tabindex]') || element;
    const rect = target.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    try {
      target.dispatchEvent(new PointerEvent("pointerdown", options));
      target.dispatchEvent(new MouseEvent("mousedown", options));
      target.dispatchEvent(new PointerEvent("pointerup", options));
      target.dispatchEvent(new MouseEvent("mouseup", options));
      target.dispatchEvent(new MouseEvent("click", options));
    } catch {
      target.click();
    }
    return target;
  }

  /** Set an input's value so React notices (native setter + input event). */
  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value"
    );
    input.focus();
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(element) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      element.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        })
      );
    }
  }

  function pressEscape() {
    for (const target of [document.activeElement, document.body, document]) {
      if (!target) continue;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true
        })
      );
    }
  }

  const normalizeName = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[\s\u00a0_\-]+/g, " ")
      .trim();

  function depthWithin(element, root) {
    let depth = 0;
    let node = element;
    while (node && node !== root) {
      depth++;
      node = node.parentElement;
    }
    return depth;
  }

  /** Find the most specific visible button whose visible text matches. */
  function findButtonByText(root, labels) {
    const wanted = labels.map((label) => normalizeName(label));
    const candidates = root.querySelectorAll('button, [role="button"], a');
    let best = null;
    let bestLength = Infinity;
    for (const candidate of candidates) {
      if (!isVisible(candidate)) continue;
      const text = normalizeName(candidate.textContent);
      if (!text || !wanted.includes(text)) continue;
      // The shortest matching text is the most specific (outer wrappers
      // contain the whole panel's text and must not win).
      if (text.length < bestLength) {
        bestLength = text.length;
        best = candidate;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------------- *
   * Step (a) - the bookmark / save control
   * ---------------------------------------------------------------------- */

  /*
   * Fallback ladder:
   *   1. svg[aria-label="Save"]      - post is not in the saved library yet
   *   2. svg[aria-label="Remove"]    - post is already saved
   *   3. [aria-label="Save"/"Remove"] - non-svg builds wrap the label on a div
   *   4. case-insensitive [aria-label*="save"] - wording drift ("Save post")
   *   5. last resort: a button containing an svg whose path draws a bookmark
   *      (only used when nothing is labelled at all).
   */
  const SAVE_ICON_SELECTORS = [
    'svg[aria-label="Save"]',
    'svg[aria-label="Remove"]',
    '[aria-label="Save"]',
    '[aria-label="Remove"]',
    'button[aria-label*="save" i]',
    'button[aria-label*="remove" i]',
    '[role="button"][aria-label*="save" i]'
  ];

  function findSaveIcon() {
    for (const selector of SAVE_ICON_SELECTORS) {
      const matches = [...document.querySelectorAll(selector)].filter(isVisible);
      if (matches.length) {
        trace.saveIconStrategy = selector;
        return matches[0];
      }
    }
    return null;
  }

  function isSaved() {
    return !!document.querySelector('svg[aria-label="Remove"]');
  }

  /* ---------------------------------------------------------------------- *
   * Step (b) - the "Save to collection" panel
   * ---------------------------------------------------------------------- */

  const PANEL_TEXT_RE = /save to collection|saved to collection|new collection|remove from saved/i;

  /*
   * Fallback ladder:
   *   1. any visible [role="dialog"] that mentions "New collection" / "Save to
   *      collection" / has a checkbox row  -> the normal picker
   *   2. the last visible [role="dialog"]  -> newest build, text changed
   *   3. a visible [role="menu"] / [role="listbox"] -> popover-style build
   */
  function findSavePanel() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);
    for (const dialog of dialogs.reverse()) {
      const text = dialog.textContent || "";
      if (PANEL_TEXT_RE.test(text)) {
        trace.panelStrategy = '[role="dialog"] mentioning Save to collection / New collection';
        return dialog;
      }
      if (dialog.querySelector('input[type="checkbox"], [role="checkbox"]')) {
        trace.panelStrategy = '[role="dialog"] containing checkbox rows';
        return dialog;
      }
    }
    if (dialogs.length) {
      trace.panelStrategy = '[role="dialog"] (last resort - no text/checkbox match)';
      return dialogs[0];
    }
    const popover = [...document.querySelectorAll('[role="menu"], [role="listbox"]')].find(
      isVisible
    );
    if (popover) {
      trace.panelStrategy = '[role="menu"] / [role="listbox"] popover';
      return popover;
    }
    return null;
  }

  /**
   * Click the bookmark control and wait for the collection panel to open.
   *
   * Behaviour differs between Instagram builds: on a post that is already in
   * the library a click may either open the picker (what we want) or toggle the
   * post out of the library. If the panel does not appear we click once more,
   * which lands back in a saved state and opens the picker.
   */
  async function openSavePanel(icon) {
    clickElement(icon);
    try {
      return await waitFor(findSavePanel, {
        timeout: 3500,
        interval: 150,
        label: "save_collection_panel"
      });
    } catch {
      const second = findSaveIcon();
      if (!second) throw new Error("save_icon_disappeared");
      clickElement(second);
      return waitFor(findSavePanel, {
        timeout: 6000,
        interval: 150,
        label: "save_collection_panel_retry"
      });
    }
  }

  /* ---------------------------------------------------------------------- *
   * Step (c) - locate the collection row for the category
   * ---------------------------------------------------------------------- */

  /*
   * The picker renders one row per collection. We cannot rely on markup shape,
   * so we look for the *deepest visible element inside the panel* whose
   * normalised text is the category name. Instagram displays spaces in
   * collection names as underscores, which normalizeName() flattens so
   * "study tips" matches "study_tips".
   *
   * Fallbacks: an exact text match first, then a "starts with" match limited to
   * short strings so a wrapper element containing many collection names can
   * never be mistaken for a row.
   */
  function findCollectionRow(panel, category) {
    const wanted = normalizeName(category);
    if (!wanted) return null;

    let exact = null;
    let exactDepth = -1;
    let loose = null;
    let looseDepth = -1;

    for (const element of panel.querySelectorAll("*")) {
      if (!isVisible(element)) continue;
      const text = normalizeName(element.textContent);
      if (!text) continue;
      const depth = depthWithin(element, panel);

      if (text === wanted) {
        if (depth > exactDepth) {
          exactDepth = depth;
          exact = element;
        }
      } else if (
        !exact &&
        text.startsWith(wanted) &&
        text.length <= wanted.length + 24 &&
        depth > looseDepth
      ) {
        looseDepth = depth;
        loose = element;
      }
    }

    const row = exact || loose;
    if (!row) return null;

    // Prefer the real checkbox control inside the row; fall back to the row
    // itself (Instagram makes the whole row a role="button" toggle).
    const toggle =
      row.querySelector('input[type="checkbox"], [role="checkbox"], button') || row;
    return { row, toggle };
  }

  /**
   * Is this collection already selected for the current post?
   * Returns true / false / null (unknown markup). A `null` means we may be
   * about to toggle the wrong way, which is reported as a warning.
   */
  function isRowSelected(row) {
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (checkbox) return !!checkbox.checked;
    const aria =
      row.getAttribute("aria-checked") ||
      (row.querySelector("[aria-checked]") &&
        row.querySelector("[aria-checked]").getAttribute("aria-checked"));
    if (aria === "true") return true;
    if (aria === "false") return false;
    return null;
  }

  /* ---------------------------------------------------------------------- *
   * Step (d) - create the collection when it does not exist
   * ---------------------------------------------------------------------- */

  /*
   * Fallback ladder for the "New collection" button:
   *   1. exact visible text "New collection"
   *   2. "Create new collection" / "New"
   * Name input:  1. input whose placeholder/aria-label mentions "collection"
   *              2. the last visible text input in the DOM (the freshly opened
   *                 one is appended last)
   * Confirmation: 1. a visible button labelled Next / Create / Done
   *               2. Enter keydown on the input
   */
  /**
   * The "name your collection" input.
   * Pass requireLabel:true (the probe) to only accept an input that is actually
   * labelled as a collection, so the comment box / search box cannot be mistaken
   * for it on a page where the flow has not started.
   */
  function findCollectionNameInput({ requireLabel = false } = {}) {
    const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')]
      .filter(isVisible)
      .filter((element) => !element.readOnly && !element.disabled);
    if (!inputs.length) return null;
    const labelled = inputs.find((element) =>
      /collection/i.test(
        `${element.placeholder || ""} ${element.getAttribute("aria-label") || ""}`
      )
    );
    if (requireLabel) return labelled || null;
    return labelled || inputs[inputs.length - 1];
  }

  async function createCollection(panel, category) {
    const newButton = findButtonByText(panel, [
      "new collection",
      "create new collection",
      "new"
    ]);
    if (!newButton) throw new Error("new_collection_button_not_found");
    clickElement(newButton);
    await sleep(300);

    const input = await waitFor(() => findCollectionNameInput(), {
      timeout: 6000,
      interval: 150,
      label: "collection_name_input"
    });

    setInputValue(input, category);
    await sleep(250);

    const confirmButton = findButtonByText(document, ["next", "create", "done", "add"]);
    if (confirmButton) clickElement(confirmButton);
    else pressEnter(input);

    // Some builds show a second confirmation screen ("Save to collection").
    try {
      const secondConfirm = await waitFor(
        () => {
          const button = findButtonByText(document, ["done", "save", "next"]);
          return button && button.isConnected ? button : null;
        },
        { timeout: 2500, interval: 200, label: "second_confirmation" }
      );
      clickElement(secondConfirm);
    } catch {
      /* single-screen flow - nothing to confirm */
    }
    await sleep(400);
  }

  /* ---------------------------------------------------------------------- *
   * Step (e) - close the panel
   * ---------------------------------------------------------------------- */

  /*
   * Fallback ladder: 1. the dialog's own Close control (svg then button),
   * 2. a visible "Done" button (which also commits the selection),
   * 3. Escape on the focused element. After all of that we verify the panel is
   * gone and, if not, report a warning rather than looping forever.
   */
  async function closePanel(panel) {
    const done = findButtonByText(panel, ["done", "close", "cancel"]);
    const closeIcon =
      panel.querySelector('svg[aria-label="Close"]') ||
      panel.querySelector('[aria-label="Close"]');

    if (done) clickElement(done);
    else if (closeIcon) clickElement(closeIcon);
    else pressEscape();

    await sleep(350);
    if (findSavePanel()) {
      pressEscape();
      await sleep(250);
    }
    return !findSavePanel();
  }

  /* ---------------------------------------------------------------------- *
   * Main entry point
   * ---------------------------------------------------------------------- */

  async function performWrite(category, shortcode) {
    trace.saveIconStrategy = null;
    trace.panelStrategy = null;
    const result = {
      success: false,
      category: category || null,
      shortcode: shortcode || null,
      warning: null,
      error: null,
      // Did we actually SEE the collection become selected? A click that lands on
      // the wrong node, or on a row whose state we cannot read, looks identical
      // to a successful one from the outside - which is how a run can report
      // "sorted 20/20" while Instagram shows nothing added. Anything not proven
      // here is reported as unconfirmed instead of being counted as done.
      confirmed: false,
      trace: {
        rowMatched: null,
        rowSelector: null,
        selectionBefore: null,
        selectionAfter: null
      }
    };

    try {
      if (!category) throw new Error("missing_category");
      if (/^\/accounts\//.test(location.pathname)) {
        throw new Error("instagram_login_required");
      }

      const icon = await waitFor(findSaveIcon, {
        timeout: 12000,
        interval: 250,
        label: "save_icon"
      });

      const panel = await openSavePanel(icon);
      const existingRow = findCollectionRow(panel, category);

      if (existingRow) {
        result.trace.rowMatched = "existing";
        result.trace.rowSelector = describe(existingRow.toggle).selector;
        const selected = isRowSelected(existingRow.row);
        result.trace.selectionBefore = selected;
        if (selected === true) {
          result.warning = "already_in_collection";
          result.confirmed = true; // already where we want it
        } else {
          clickElement(existingRow.toggle);
          await sleep(450);
          const verify = findCollectionRow(panel, category);
          const after = verify ? isRowSelected(verify.row) : null;
          result.trace.selectionAfter = after;
          if (after === true) result.confirmed = true;
          if (after === false) result.warning = "collection_checkbox_may_be_unchecked";
          if (selected === null) {
            result.warning = result.warning || "collection_state_unverifiable";
          }
        }
      } else {
        await createCollection(panel, category);
        result.trace.rowMatched = "created";
        // Creating a collection is the one path with no checkbox to read back, so
        // the proof it worked is that the picker now lists it. If it does not,
        // something was clicked that did not commit.
        const created = findCollectionRow(panel, category);
        result.confirmed = !!created;
        if (created) result.trace.rowSelector = describe(created.toggle).selector;
        else result.warning = "collection_created_unconfirmed";
      }

      // Ordering matters: a warning that says whether the write LANDED is worth
      // more than one about housekeeping, so the milder ones never overwrite it.
      const closed = await closePanel(panel);
      if (!closed && !result.warning) result.warning = "panel_did_not_close";

      // The post must still be in the saved library afterwards. If the bookmark
      // reads "Save" we toggled it out of the library - that outranks everything
      // else that happened here, so it deliberately overwrites.
      if (!isSaved()) {
        result.warning = "post_may_be_unsaved";
      }

      result.success = true;
      return result;
    } catch (error) {
      result.error = String((error && error.message) || error);
      return result;
    } finally {
      // Which fallback matched is the single most useful debugging fact.
      result.saveIconStrategy = trace.saveIconStrategy;
      result.panelStrategy = trace.panelStrategy;
      result.trace.saveIconStrategy = trace.saveIconStrategy;
      result.trace.panelStrategy = trace.panelStrategy;
    }
  }

  /* ---------------------------------------------------------------------- *
   * DRY RUN - "which element would each step act on?"
   *
   * analyzePage() follows the exact same strategy ladders as performWrite()
   * but NEVER dispatches an event, so you can run it against the live site and
   * see precisely what the writer would click. It reports, per step:
   *   RESOLVED  - matched now, with a copy-pasteable selector for the element
   *   MISS      - no strategy matched (the writer would throw at this step)
   *   NOT-OPEN  - the panel only exists after a click, so it cannot be verified
   *   SKIPPED   - gated behind a step that needs a click
   *   INFO      - context (URL, login wall, post page sanity)
   *
   * To verify the panel/row/checkbox steps without clicking, open a post, click
   * the bookmark yourself, then trigger "Inspect current tab" from the popup.
   * ---------------------------------------------------------------------- */

  const STABLE_ATTRS = ["aria-label", "role", "href", "placeholder", "type", "name"];

  /**
   * Build a selector for an element that survives in the DevTools console:
   * prefer the first stable attribute on the element itself, otherwise walk up
   * with nth-of-type until a stable ancestor is found. Obfuscated class names are
   * never used because they change every deploy.
   */
  function cssPath(element, maxDepth = 6) {
    if (!element) return null;
    const parts = [];
    let node = element;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < maxDepth) {
      const tag = node.tagName.toLowerCase();
      let anchor = "";
      for (const attr of STABLE_ATTRS) {
        const value = node.getAttribute ? node.getAttribute(attr) : null;
        if (value && value.length <= 60) {
          anchor = `[${attr}="${value.replace(/"/g, '\\"')}"]`;
          break;
        }
      }
      if (anchor) {
        parts.unshift(tag + anchor);
        break;
      }
      let suffix = "";
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (sameTag.length > 1) suffix = `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(tag + suffix);
      node = node.parentElement;
      depth++;
    }
    const path = parts.join(" > ").slice(0, 300);
    return path || element.tagName.toLowerCase();
  }

  /** Machine-readable + human-readable description of a DOM element. */
  function describe(element) {
    if (!element || !element.tagName) return null;
    const rect = element.getBoundingClientRect();
    const text = (element.textContent || "").trim().replace(/\s+/g, " ");
    return {
      selector: cssPath(element),
      tag: element.tagName.toLowerCase(),
      ariaLabel: element.getAttribute("aria-label") || null,
      role: element.getAttribute("role") || null,
      text: text ? text.slice(0, 60) : null,
      visible: isVisible(element),
      size: `${Math.round(rect.width)}x${Math.round(rect.height)}`
    };
  }

  /** How many visible elements each selector in a fallback ladder matches. */
  function ladderReport(ladder) {
    return ladder.map((selector) => {
      let matches = -1;
      try {
        matches = [...document.querySelectorAll(selector)].filter(isVisible).length;
      } catch {
        /* invalid selector - report as -1 */
      }
      return { selector, visibleMatches: matches };
    });
  }

  /**
   * Every visible collection row in an open picker, with a match flag.
   *
   * Instagram's rows are sometimes [role="button"], sometimes plain divs with a
   * custom checkbox, so we cannot filter by role: we take the *innermost* text
   * carrier in the panel (an element whose own children hold no text) and skip
   * every container above it. That yields one entry per visible label whatever
   * the markup looks like.
   */
  function rowInventory(panel, category) {
    const wanted = normalizeName(category);
    const rows = [];
    const seen = new Set();
    for (const element of panel.querySelectorAll("*")) {
      if (!isVisible(element)) continue;
      const text = normalizeName(element.textContent);
      if (!text || text.length > 60 || seen.has(text)) continue;
      const isContainer = [...element.children].some(
        (child) => normalizeName(child.textContent) !== ""
      );
      if (isContainer) continue;
      seen.add(text);
      rows.push({ text, matches: text === wanted });
    }
    return rows;
  }

  /** A snapshot of what the page exposes, for eyeballing selector drift. */
  function collectInventory() {
    const INTERESTING = /save|bookmark|collection|remove|close|dialog|checkbox/i;
    const labelled = [];
    for (const element of document.querySelectorAll("[aria-label]")) {
      const label = element.getAttribute("aria-label");
      if (!label || !isVisible(element)) continue;
      const info = describe(element);
      info.interesting = INTERESTING.test(label);
      labelled.push(info);
      if (labelled.length >= 300) break;
    }
    labelled.sort((a, b) => Number(b.interesting) - Number(a.interesting));
    return {
      labelled: labelled.slice(0, 30),
      dialogs: [...document.querySelectorAll('[role="dialog"]')]
        .filter(isVisible)
        .map(describe),
      checkboxes: [...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
        .filter(isVisible).length,
      textInputs: [...document.querySelectorAll("textarea, input[type=\"text\"], input:not([type])")]
        .filter(isVisible).length
    };
  }

  async function analyzePage(category, shortcode, allCategories = []) {
    const lines = [
      "=== IG Saved Sorter dry run (nothing is clicked) ===",
      `time        : ${new Date().toISOString()}`,
      `url         : ${location.href}`,
      `shortcode   : ${shortcode || "(unknown)"}`,
      `category    : ${category || "(none)"}`
    ];
    const steps = [];

    const addStep = (step, status, detail, element) => {
      const info = describe(element);
      steps.push({ step, status, detail: detail || null, element: info });
      lines.push("");
      lines.push(`[${status}] ${step}${detail ? ` — ${detail}` : ""}`);
      if (info) {
        lines.push(`    selector   : ${info.selector}`);
        lines.push(
          `    element    : <${info.tag}> role=${info.role || "-"} aria-label="${info.ariaLabel || "-"}" ${info.size}px visible=${info.visible}`
        );
        if (info.text) lines.push(`    text       : ${info.text}`);
      }
    };

    const loginWall = /^\/accounts\//.test(location.pathname);
    addStep("0. page", loginWall ? "MISS" : "INFO", `path ${location.pathname}`, null);
    if (loginWall) {
      lines.push("    Instagram redirected to a login/consent page, so nothing can be probed.");
    }

    // Step 1 - the bookmark control (fully verifiable without clicking).
    let icon = null;
    try {
      icon = await waitFor(findSaveIcon, {
        timeout: 8000,
        interval: 250,
        label: "save_icon"
      });
    } catch {
      /* reported as MISS below */
    }

    if (icon) {
      const button = icon.closest('[role="button"], button, a') || icon;
      addStep("1. save icon", "RESOLVED", `ladder hit: ${trace.saveIconStrategy}`, icon);
      lines.push(`    would click : ${describe(button).selector}`);
      lines.push(
        `    bookmark now: ${isSaved() ? 'in the saved library (aria-label="Remove")' : 'not saved yet (aria-label="Save")'}`
      );
    } else {
      addStep("1. save icon", "MISS", "nothing matched any strategy within 8s");
    }
    lines.push(
      `    ladder      : ${ladderReport(SAVE_ICON_SELECTORS)
        .map((entry) => `${entry.selector}→${entry.visibleMatches}`)
        .join("  ")}`
    );

    // Steps 2-5 - the picker. It only exists after a click, unless the user has
    // already opened it by hand (that is what "Inspect current tab" is for).
    const panel = findSavePanel();
    if (panel) {
      addStep("2. save panel", "RESOLVED", `strategy: ${trace.panelStrategy}`, panel);

      const rows = rowInventory(panel, category);
      const match = findCollectionRow(panel, category);
      lines.push(`    rows found  : ${rows.length}`);
      for (const row of rows.slice(0, 15)) {
        lines.push(`      - "${row.text}"${row.matches ? "   <== matches the category" : ""}`);
      }

      if (match) {
        const selected = isRowSelected(match.row);
        addStep(
          "3. collection row",
          "RESOLVED",
          `row "${category}" would be clicked`,
          match.toggle
        );
        lines.push(
          `    selected now: ${selected === null ? "unknown (no input.checked and no aria-checked in the row)" : String(selected)}`
        );
      } else {
        addStep(
          "3. collection row",
          "MISS",
          `no row matched "${category}" — the writer would create the collection instead`
        );
        const newButton = findButtonByText(panel, [
          "new collection",
          "create new collection",
          "new"
        ]);
        addStep(
          "4a. new collection btn",
          newButton ? "RESOLVED" : "MISS",
          newButton ? "would click" : "no visible button with that text",
          newButton
        );
        const nameInput = findCollectionNameInput({ requireLabel: true });
        addStep(
          "4b. name input",
          nameInput ? "RESOLVED" : "NOT-OPEN",
          nameInput
            ? "would type the category here"
            : "appears only after clicking New collection",
          nameInput
        );
        const confirm = findButtonByText(document, ["next", "create", "done", "add"]);
        addStep(
          "4c. create confirm",
          confirm ? "RESOLVED" : "NOT-OPEN",
          confirm ? "would click" : "no visible Next/Create/Done button",
          confirm
        );
      }

      const closeTarget =
        panel.querySelector('svg[aria-label="Close"]') ||
        panel.querySelector('[aria-label="Close"]') ||
        findButtonByText(panel, ["done", "close", "cancel"]);
      addStep(
        "5. close panel",
        closeTarget ? "RESOLVED" : "MISS",
        closeTarget ? "would click" : "would fall back to pressing Escape",
        closeTarget
      );

      // With the picker open we can answer the real question: for each configured
      // category, is there already a row, or would the writer have to create it?
      if (allCategories.length) {
        const rowTexts = rows.map((row) => row.text);
        addStep(
          "6. category map",
          "INFO",
          `${allCategories.length} configured categor(ies) resolved against this picker`
        );
        for (const name of allCategories) {
          const wanted = normalizeName(name);
          // Mirror findCollectionRow exactly: an exact row wins, otherwise a short
          // "starts with" row is what the real run would click. Checking exact
          // matches only made this map claim "would create it" for categories the
          // run would actually have satisfied from an existing row.
          const exactHit = rowTexts.find((text) => text === wanted);
          const looseHit =
            !exactHit &&
            rowTexts.find(
              (text) => text.startsWith(wanted) && text.length <= wanted.length + 24
            );
          const hit = exactHit || looseHit;
          lines.push(
            `    ${name.padEnd(18, " ")} ${
              hit
                ? `existing row "${hit}"${looseHit ? " (matched on the start of the name)" : ""}`
                : "no row here → would create it"
            }`
          );
        }
      }
    } else {
      addStep(
        "2. save panel",
        "NOT-OPEN",
        "opened only by clicking the bookmark, so a dry run cannot verify it"
      );
      addStep(
        "3. collection row",
        "SKIPPED",
        'needs the panel — open the picker by hand and use "Inspect current tab"'
      );
      addStep("4. new collection", "SKIPPED", "needs the panel");
      addStep("5. close panel", "SKIPPED", "needs the panel");
      lines.push(
        `    would click  : ${icon ? describe(icon.closest('[role="button"], button, a') || icon).selector : "(no save icon found)"} to open it`
      );
    }

    // Inventory - the fastest way to spot selector drift after an IG deploy.
    const inventory = collectInventory();
    lines.push("");
    lines.push(`--- inventory: ${inventory.dialogs.length} dialog(s), ${inventory.checkboxes} checkbox-ish, ${inventory.textInputs} text input(s) ---`);
    lines.push("--- visible [aria-label] controls (interesting ones first) ---");
    for (const item of inventory.labelled) {
      lines.push(`  ${item.selector}  "${item.ariaLabel}"  ${item.size}px`);
    }

    const skipped = steps.filter((step) => step.status === "SKIPPED").length;
    const notOpen = steps.filter((step) => step.status === "NOT-OPEN").length;
    return {
      success: true,
      dryRun: true,
      ok: !!icon && !loginWall,
      url: location.href,
      category: category || null,
      shortcode: shortcode || null,
      panelOpen: !!panel,
      unverifiable: skipped + notOpen,
      steps,
      inventory,
      lines
    };
  }

  /* ---------------------------------------------------------------------- *
   * Entry point: a real write, or the non-destructive probe
   * ---------------------------------------------------------------------- */

  async function entry(category, shortcode, options) {
    const dryRun = !!(options && options.dryRun);
    let result;
    try {
      result = dryRun
        ? await analyzePage(category, shortcode, (options && options.categories) || [])
        : await performWrite(category, shortcode);
    } catch (error) {
      result = {
        success: false,
        dryRun,
        category: category || null,
        shortcode: shortcode || null,
        error: String((error && error.message) || error)
      };
    }
    try {
      chrome.runtime.sendMessage({
        type: dryRun ? "PROBE_RESULT" : "WRITE_RESULT",
        postId: shortcode || null,
        category: category || null,
        result
      });
    } catch {
      /* extension context gone - the executeScript return value still reports it */
    }
    return result;
  }

  globalThis.__IG_SORTER_WRITE__ = entry;
})();
