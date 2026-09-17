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
  const trace = {
    saveIconStrategy: null,
    panelStrategy: null,
    // Snapshot of panelStrategy at the moment the picker was OPENED (see
    // openSavePanel), so later lookups cannot rewrite the reported fact.
    panelOpenStrategy: null,
    moreStrategy: null,
    openedViaMenu: false,
    openedViaHover: false,
    // Set when the picker was found ALREADY MOUNTED in the DOM and merely made
    // visible by us (the CSS-`:hover` builds, where no dispatched event can ever
    // reveal it). Reported so the log says which route actually won.
    panelRevealed: false,
    // Set when findSavePanel() matches a container that carries the expected
    // texts but shows zero checkbox rows - the tell of a reel-page overlay that
    // merely talks about saving. Used to warn + gate the write below.
    panelSuspicious: false
  };

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

  /*
   * HOVER, not click. On current builds the collection picker on a post that
   * is ALREADY saved is a hover popover: holding the pointer over the bookmark
   * shows a small "Collections" list above the icon. Clicking the bookmark
   * only toggles the saved state and never opens anything, which is why every
   * click-based route timed out. React listens for pointer/mouse enter, so we
   * dispatch the full sequence a moving pointer produces.
   */
  function hoverElement(element) {
    if (!element) return null;
    // Dispatch on the element ITSELF (the <svg> the ladder matched), not on its
    // closest button. React synthesises mouseenter for the whole ancestor path
    // of the event target when relatedTarget lies outside the document, and the
    // popover's visibility lives on a wrapper ABOVE the icon - dispatching on
    // the button would only ever enter the button.
    const target = element;
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
      target.dispatchEvent(new PointerEvent("pointerover", options));
      target.dispatchEvent(new PointerEvent("pointerenter", { ...options, bubbles: false }));
      target.dispatchEvent(new PointerEvent("pointermove", options));
      target.dispatchEvent(new MouseEvent("mouseover", options));
      target.dispatchEvent(new MouseEvent("mouseenter", { ...options, bubbles: false }));
      target.dispatchEvent(new MouseEvent("mousemove", options));
    } catch {
      /* synthetic-event-less environments - nothing more we can do */
    }
    return target;
  }

  /**
   * The opposite of hoverElement(): what a real pointer leaving the icon sends.
   * React keeps its hover state until a leave event arrives, so this is what
   * dismisses a popover we opened ourselves (Escape does not close it).
   */
  function unhoverElement(element) {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      relatedTarget: document.body,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    try {
      element.dispatchEvent(new PointerEvent("pointerout", options));
      element.dispatchEvent(new MouseEvent("mouseout", options));
      element.dispatchEvent(
        new PointerEvent("pointerleave", { ...options, bubbles: false })
      );
      element.dispatchEvent(new MouseEvent("mouseleave", { ...options, bubbles: false }));
    } catch {
      /* synthetic-event-less environment - nothing more we can do */
    }
    return element;
  }

  /* ---------------------------------------------------------------------- *
   * Revealing a popover that is already in the DOM
   *
   * Measured on the live build (dry-run log, 5 posts):
   *   "picker exists but stayed hidden (CSS :hover?)"  x4
   *   "picker opened by hovering the bookmark"         x1
   * The popover is mounted the whole time; on most posts it stays hidden because
   * the reveal is driven by CSS `:hover`. That state is decided by the browser's
   * own hit-testing of REAL pointer input - a dispatched mouseenter can never
   * make `:hover` match - which is exactly why synthetic hovering opens nothing.
   *
   * So rather than asking for a state we cannot produce, we make the mounted
   * popover visible ourselves: inline styles with !important (which outrank the
   * page's stylesheet rules, so nothing can hide it again), applied only to the
   * elements that are actually hiding something, then reverted property by
   * property as soon as the row has been clicked.
   * ---------------------------------------------------------------------- */

  const REVEAL_VALUES = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    "pointer-events": "auto",
    "content-visibility": "visible",
    transform: "none",
    "clip-path": "none",
    "max-height": "none",
    height: "auto",
    overflow: "visible",
    filter: "none"
  };
  // Enough for anything hidden with display/visibility - i.e. nearly every
  // popover - and narrow enough that a normal page is left alone.
  const REVEAL_BASIC = [
    "display",
    "visibility",
    "opacity",
    "pointer-events",
    "content-visibility"
  ];

  let revealUndo = [];
  let revealTouched = new WeakMap();

  function styleHides(element) {
    const style = getComputedStyle(element);
    if (style.display === "none") return true;
    if (style.visibility === "hidden" || style.visibility === "collapse") return true;
    if (Number(style.opacity) === 0) return true;
    if (style.contentVisibility === "hidden") return true;
    // Collapsed rather than hidden - the usual zero-height popover tricks.
    if (style.maxHeight && Number.parseFloat(style.maxHeight) === 0) return true;
    if (
      element.getBoundingClientRect().height === 0 &&
      style.overflow !== "visible"
    ) {
      return true;
    }
    return false;
  }

  function applyRevealStyles(element, properties) {
    let touched = revealTouched.get(element);
    if (!touched) {
      touched = new Set();
      revealTouched.set(element, touched);
    }
    for (const property of properties) {
      if (!(property in REVEAL_VALUES)) continue;
      // Never record the same property twice: the second record would capture
      // our own value as the "original" and undo would leave the style behind.
      if (touched.has(property)) continue;
      touched.add(property);
      revealUndo.push({
        element,
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property)
      });
      try {
        element.style.setProperty(property, REVEAL_VALUES[property], "important");
      } catch {
        /* read-only style object - skip this property */
      }
    }
  }

  /** Make a mounted-but-hidden element visible. True when it worked. */
  function forceReveal(element) {
    undoReveal();
    if (!element) return false;
    const chain = [];
    for (
      let node = element;
      node && node !== document.documentElement;
      node = node.parentElement
    ) {
      chain.push(node);
    }
    for (const node of chain) {
      if (styleHides(node)) applyRevealStyles(node, REVEAL_BASIC);
    }
    if (isVisible(element)) return true;
    // Still invisible, so it is collapsed rather than display:none'd. Escalate
    // to the full property set along the whole chain, then measure again.
    for (const node of chain) {
      applyRevealStyles(node, Object.keys(REVEAL_VALUES));
    }
    if (isVisible(element)) return true;
    // Could not make it visible - leave the page exactly as it was.
    undoReveal();
    return false;
  }

  function undoReveal() {
    for (let index = revealUndo.length - 1; index >= 0; index--) {
      const { element, property, value, priority } = revealUndo[index];
      try {
        if (value) element.style.setProperty(property, value, priority || "");
        else element.style.removeProperty(property);
      } catch {
        /* the node is gone with its styles */
      }
    }
    revealUndo = [];
    revealTouched = new WeakMap();
  }

  /**
   * The picker as the writer needs to act on it: find the Collections popover
   * even when it is hidden, reveal it, and hand back the now-visible node.
   * Returns null when there is nothing mounted to reveal.
   */
  function revealMountedPopover() {
    const already = findCollectionsPopover();
    if (already) return already;
    const hidden = findCollectionsPopover({ includeHidden: true });
    if (!hidden) return null;
    if (!forceReveal(hidden)) return null;
    const visible = findCollectionsPopover() || (isVisible(hidden) ? hidden : null);
    if (visible) {
      // Recorded here so every caller (the write path, the dry run) reports the
      // same fact about how the picker was reached.
      trace.panelRevealed = true;
      trace.panelStrategy =
        '"Collections" popover - mounted but CSS-hidden (needs real :hover), revealed it';
    }
    return visible;
  }

  /*
   * The hover popover's signature: the SMALLEST container whose visible text
   * STARTS with "Collections" (its header) and which holds collection rows.
   *
   * Deliberately not anchored to role="dialog" - the popover has none - and
   * just as deliberately NOT anchored to checkboxes: on the build we captured
   * (screenshot-verified) the rows are plain clickable items with a thumbnail
   * and a name, and the selected state is shown with a checkmark, so requiring
   * checkbox controls here made the detector miss the real popover entirely.
   * One collection or thirty, the header is what identifies it.
   *
   * A second hard requirement is SIZE: the popover is a small floating panel
   * (~260x240 on the captured build, scroll-capped when the user has many
   * collections). Without that, a page-level wrapper whose text merely STARTS
   * with "Collections" - <main>, when the popover happens to be its first child -
   * would be adopted as the picker and clicked into, which is worse than failing.
   */
  function findCollectionsPopover({ includeHidden = false } = {}) {
    let best = null;
    let bestDepth = -1;
    let bestArea = Infinity;
    for (const node of document.querySelectorAll("*")) {
      if (!includeHidden && !isVisible(node)) continue;
      if (!/^collections/.test(normalizeName(node.textContent))) continue;
      const labels = rowLabelsIn(node, { includeHidden });
      if (!labels.length) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width > 640 || rect.height > 800) continue;
      /*
       * DEEPEST wins, not smallest: the popover is the innermost container that
       * holds BOTH the "Collections" header and the rows. Everything above it is
       * a wrapper - and because a wrapper contains the popover, its text starts
       * with "Collections" too, which is how a wrapper used to be adopted as the
       * picker (the popover inside it is display:none, so the wrapper looked like
       * a visible panel with no rows in it). Area only breaks ties at equal
       * depth, and for a hidden node depth is the only signal left: display:none
       * measures 0x0, so every hidden candidate would otherwise tie.
       */
      const depth = depthWithin(node, document.body);
      const area = rect.width * rect.height;
      if (depth > bestDepth || (depth === bestDepth && area < bestArea)) {
        bestDepth = depth;
        bestArea = area;
        best = node;
      }
    }
    return best;
  }

  /** Short collection labels inside a container (the popover header excluded). */
  function rowLabelsIn(container, { includeHidden = false } = {}) {
    const labels = [];
    for (const element of container.querySelectorAll("*")) {
      if (!includeHidden && !isVisible(element)) continue;
      const text = normalizeName(element.textContent);
      if (!text || text.length > 40 || text === "collections") continue;
      if ([...element.children].some((child) => normalizeName(child.textContent) !== "")) {
        continue;
      }
      /*
       * The popover's HEADER carries the create control ("+" / "New
       * collection"), and that control is not a collection. It matters: the
       * header is a smaller container than the popover, so counting its label
       * made the header itself qualify as a popover candidate - and a header
       * has no rows to click.
       */
      const ownLabel =
        typeof element.getAttribute === "function"
          ? normalizeName(element.getAttribute("aria-label"))
          : "";
      if (/^(new collection|create new collection|create|add|\+)$/.test(text)) continue;
      if (/new collection|create collection/i.test(ownLabel)) continue;
      labels.push(text);
    }
    return labels;
  }

  /*
   * The row ELEMENTS inside a panel: every innermost text carrier, climbed to
   * the biggest ancestor that still carries only that one label. This works for
   * the dialog picker (checkbox + label) and for the hover popover (thumbnail +
   * label) alike, because it never assumes a checkbox exists.
   */
  function panelRows(panel) {
    const seen = new Set();
    const rows = [];
    for (const element of panel.querySelectorAll("*")) {
      if (!isVisible(element)) continue;
      const text = normalizeName(element.textContent);
      if (!text || text.length > 40) continue;
      if ([...element.children].some((child) => normalizeName(child.textContent) !== "")) {
        continue;
      }
      if (seen.has(text)) continue;
      seen.add(text);
      let row = element;
      while (
        row.parentElement &&
        row.parentElement !== panel &&
        normalizeName(row.parentElement.textContent) === text
      ) {
        row = row.parentElement;
      }
      rows.push(row);
    }
    return rows;
  }

  /** The deepest visible element inside `root` whose text is exactly `wanted`. */
  function deepestTextCarrier(root, wanted) {
    let best = null;
    let bestDepth = -1;
    for (const element of root.querySelectorAll("*")) {
      if (!isVisible(element)) continue;
      if (normalizeName(element.textContent) !== wanted) continue;
      const depth = depthWithin(element, root);
      if (depth > bestDepth) {
        bestDepth = depth;
        best = element;
      }
    }
    return best;
  }

  /*
   * What to dispatch the click on: the INNERMOST clickable that contains the
   * row's label. Instagram sometimes makes the whole row a role="button" and
   * sometimes puts the handler on an inner control; a click dispatched on the
   * outer wrapper never reaches a handler that sits BELOW the event target
   * (events bubble up, not down), so the deepest candidate is always the safer
   * choice. We never dispatch twice - two clicks would toggle twice and land
   * the post exactly where it started, with nothing to show for it.
   */
  function rowClickTarget(row, label) {
    const clickables = [
      ...row.querySelectorAll('[role="button"], button, a, label, [tabindex]')
    ].filter(isVisible);
    const containing = clickables.filter((element) => element.contains(label));
    const pool = containing.length ? containing : clickables;
    let best = null;
    let bestDepth = -1;
    for (const element of pool) {
      const depth = depthWithin(element, row);
      if (depth > bestDepth) {
        bestDepth = depth;
        best = element;
      }
    }
    return best || row;
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

  /**
   * The picker's most durable property is not its role or its wording but its
   * contents: a GROUP of checkbox controls (one per collection). No other
   * post-page UI shows that. Walk the visible elements that contain two or
   * more visible checkbox-ish descendants and return the smallest one - the
   * panel body, whatever markup surrounds it. A single checkbox can be an
   * unrelated toggle, so two is the floor.
   */
  function findCheckboxGroupContainer() {
    const checkboxish = [
      ...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')
    ].filter(isVisible);
    if (checkboxish.length < 2) return null;
    // Walk up from every checkbox: the first ancestor holding 2+ of them is the
    // smallest container for that box. Taking the smallest across all boxes
    // avoids a full-DOM sweep (which would mean a getComputedStyle per element
    // on every 150ms poll).
    let best = null;
    let bestSize = Infinity;
    for (const box of checkboxish) {
      let node = box.parentElement;
      while (node && node !== document.body) {
        let count = 0;
        for (const other of checkboxish) {
          if (node.contains(other)) count++;
        }
        if (count >= 2) {
          const rect = node.getBoundingClientRect();
          const size = rect.width * rect.height;
          if (size < bestSize) {
            bestSize = size;
            best = node;
          }
          break; // further ancestors are only bigger
        }
        node = node.parentElement;
      }
    }
    return best;
  }

  /*
   * Fallback ladder:
   *   1. any visible [role="dialog"] that mentions "New collection" / "Save to
   *      collection" / has a checkbox row  -> the normal picker
   *   2. the last visible [role="dialog"]  -> newest build, text changed
   *   3. a visible [role="menu"] / [role="listbox"] -> popover-style build
   */
  /*
   * Notes on the ladder below (learned from a real failure on /reels/ pages):
   * the last-resort rungs deliberately DO NOT fall back to "any visible
   * dialog/popover". Reels pages keep ambient overlays open (share sheets,
   * "More posts" reels carousels), and adopting one of those as the picker
   * made the writer click inside the wrong overlay - clicking random rows is
   * worse than failing, because it cannot be undone. When nothing matches we
   * return null and the caller reports exactly which rung failed instead.
   */
  function findSavePanel({ allowReveal = false } = {}) {
    trace.panelSuspicious = false;
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
    // Rung 3: the hover popover (current builds). Visible only while the
    // pointer rests on the bookmark; identified by its "Collections" header
    // plus the collection rows under it.
    const popover = findCollectionsPopover();
    if (popover) {
      trace.panelStrategy = '"Collections" hover popover above the bookmark';
      return popover;
    }
    /*
     * Rung 3b: the popover is in the DOM but CSS-hidden. Only the OPENING path
     * asks for this (allowReveal) - closePanel() and the probe's "is it still
     * open?" checks must be able to see the page as it really is, or a revealed
     * popover could never be recognised as closed.
     */
    if (allowReveal) {
      const revealed = revealMountedPopover();
      if (revealed) {
        trace.panelStrategy =
          '"Collections" popover - mounted but CSS-hidden (needs real :hover), revealed it';
        trace.panelRevealed = true;
        return revealed;
      }
    }
    // Rung 4: a build may render the picker without role="dialog" and without
    // any of the expected texts. Its checkbox GROUP still gives it away.
    const group = findCheckboxGroupContainer();
    if (group) {
      trace.panelStrategy = "visible container holding 2+ checkbox controls";
      return group;
    }
    return null;
  }

  /*
   * A text-match or last-dialog hit with ZERO checkbox rows is very likely an
   * ambient overlay (a reels-page sheet can contain the word "save" without
   * being the picker). PerformWrite refuses to click rows inside one.
   */
  function panelLooksSuspicious(panel) {
    // The hover popover is identified by its own header plus its rows, so it is
    // trustworthy even when (as on the captured build) it has no checkbox
    // controls at all - the gate exists for overlays that only TALK about saving.
    if (/popover/.test(trace.panelStrategy || "")) return false;
    const hasCheckboxes = panel.querySelector(
      'input[type="checkbox"], [role="checkbox"]'
    );
    if (hasCheckboxes) return false;
    if (PANEL_TEXT_RE.test(panel.textContent || "")) return true;
    return false;
  }

  /*
   * The three-dot "More options" control in the post header. On builds where
   * the bookmark click only toggles the saved state, this menu's "Save to
   * collection…" item is the reliable way into the picker.
   */
  function findMoreOptionsButton() {
    const candidates = [
      'svg[aria-label="More options"]',
      '[aria-label="More options"]',
      '[aria-label*="more options" i]',
      // Shorter label on some builds.
      'svg[aria-label="More"]',
      '[aria-label="More"]'
    ];
    for (const selector of candidates) {
      const matches = [...document.querySelectorAll(selector)].filter(isVisible);
      if (matches.length) {
        trace.moreStrategy = selector;
        return matches[0].closest('[role="button"], button, a') || matches[0];
      }
    }
    const byText = findButtonByText(document, ["more options"]);
    if (byText) trace.moreStrategy = 'button whose text reads "More options"';
    return byText;
  }

  /** The most recently rendered visible popover/menu (the ⋯ menu we opened). */
  function findOptionsMenu() {
    const menus = [
      ...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')
    ].filter(isVisible);
    return menus.length ? menus[menus.length - 1] : null;
  }

  /*
   * Inside the ⋯ menu: the row that opens the picker. Wording drifts between
   * builds ("Save", "Save to collection…", "Add to collection"), so match on
   * the prefix and explicitly exclude unsave/remove wording. Like
   * findCollectionRow, only the innermost text carrier is considered so a
   * container wrapping the whole menu can never match.
   *
   * Recent builds may render the popover as a plain positioned DIV with no
   * role="menu" at all, so if no menu container can be found the same scan
   * runs over the whole document - on a post page with the picker closed,
   * nothing except that menu carries "Save to collection"-ish text.
   */
  function findMenuSaveItem(scope) {
    const seen = new Set();
    let best = null;
    let bestDepth = -1;
    for (const element of scope.querySelectorAll("*")) {
      if (!isVisible(element)) continue;
      const text = normalizeName(element.textContent);
      if (!text || text.length > 40) continue;
      if ([...element.children].some((child) => normalizeName(child.textContent) !== "")) {
        continue;
      }
      if (seen.has(text)) continue;
      seen.add(text);
      if (/^(save|add to collection)/.test(text) && !/(unsav|not saved|remove)/.test(text)) {
        const depth = depthWithin(element, scope);
        if (depth > bestDepth) {
          bestDepth = depth;
          best = element;
        }
      }
    }
    if (!best) return null;
    return best.closest('[role="menuitem"], [role="button"], button, a') || best;
  }

  /**
   * Open the "Save to collection" picker, in the order the user would do it by
   * hand:
   *
   *   1. Post already in the library -> HOVER the bookmark. The "Collections"
   *      popover appears above the icon (screenshot-verified on the /reels/
   *      layout, and it exists independently of any checkbox markup). Hovering is
   *      side-effect free: a CLICK on these posts only toggles the post out of
   *      the library and opens nothing at all, which is why every click-based
   *      route used to time out.
   *   2. Post not saved yet -> CLICK the bookmark (that is what saves it), then
   *      hover, because the popover is what lists the collections. Two states are
   *      told apart afterwards by the bookmark itself: if the post is no longer
   *      in the library the click toggled an already-saved post out, so it is
   *      clicked back into the saved state first.
   *   3. The ⋯ "More options" menu's "Save to collection…" item, for builds
   *      whose hover popover is missing or broken. A menu that IS open and holds
   *      no save item fails fast with that finding - on the /reels/ layout the
   *      menu genuinely has no save entry (Report / Go to post / Share / Copy
   *      link / Embed / About this account), so waiting the full timeout there
   *      would just burn time on every post.
   *   4. Last resort: the old double-click heuristic for builds where the panel
   *      is merely slow to appear.
   *
   * If every route misses, the post is put back into the saved state it was found
   * in before the error is thrown.
   *
   * Every route's failure is recorded in trace.routeErrors, so when all of
   * them miss, the thrown error names each dead end ("no More options
   * control" vs "menu opened but no picker appeared" vs "a dialog opened but
   * was not recognised") instead of one generic timeout that could mean
   * anything.
   */
  async function openSavePanel(icon) {
    trace.routeErrors = [];
    // Some routes click the bookmark, which TOGGLES the saved state on builds
    // where it opens no panel. Remembered here so a failing run can put the
    // post back exactly as it found it instead of quietly unsaving it.
    const wasSaved = isSaved();
    const attempt = async (name, fn) => {
      try {
        const panel = await fn();
        if (panel) return panel;
        throw new Error("panel_not_recognised");
      } catch (error) {
        trace.routeErrors.push(`${name}: ${error.message}`);
        return null;
      }
    };

    /*
     * The routes below mirror exactly what the user does by hand:
     *
     *   1. post already in the library -> HOVER the bookmark. A "Collections"
     *      popover appears above the icon; clicking instead toggles the post OUT
     *      of the library and opens nothing (which is why every click-based
     *      route used to time out on these posts).
     *   2. post not saved yet        -> CLICK the bookmark (that is what saves
     *      it), then hover, because the popover is what lists the collections.
     */

    const findPanelNow = () => findSavePanel({ allowReveal: true });
    /*
     * How the picker was OPENED is decided once, here. Later lookups (verifying
     * after the row click, asking whether the panel closed) would otherwise
     * overwrite the strategy, and the log would name whatever the last lookup
     * happened to match instead of the route that actually worked.
     */
    const opened = (panel) => {
      if (panel) trace.panelOpenStrategy = trace.panelStrategy;
      return panel;
    };

    /*
     * Route 1 (instant, no waiting) - the popover that is ALREADY IN THE DOM.
     *
     * Measured on the live build (dry-run log, 5 posts): 4 said "picker exists
     * but stayed hidden (CSS :hover?)", 1 said "picker opened by hovering the
     * bookmark". The popover is mounted the whole time; what reveals it is CSS
     * `:hover`, and that state is decided by the browser's hit-testing of REAL
     * pointer input, so no dispatched event can ever produce it. Rather than
     * fight for a state we cannot produce, we make the mounted popover visible
     * and put its styles back when we are done.
     */
    const revealed = await attempt("reveal mounted popover", async () => {
      const popover = revealMountedPopover();
      if (!popover) throw new Error("no mounted Collections popover in the DOM");
      return popover;
    });
    if (revealed) return opened(revealed);

    /*
     * Route 2 - the manual flow (hover the bookmark, wait for the list), kept
     * for builds whose popover is revealed by a JS mouseenter handler instead of
     * by CSS. Only worth a wait for a post that is already in the library: the
     * popover lists collections, so it does not exist before the post is saved.
     */
    if (wasSaved) {
      const target = findSaveIcon() || icon;
      hoverElement(target);
      // No pointerout is dispatched afterwards, so React keeps the hover state
      // while we poll for the popover.
      const viaHover = await attempt("bookmark hover", () =>
        waitFor(findPanelNow, {
          timeout: 2500,
          interval: 200,
          label: "collections_popover_on_hover"
        })
      );
      if (viaHover) {
        trace.openedViaHover = true;
        return opened(viaHover);
      }
    }

    /*
     * Route 3 - the bookmark CLICK, and ONLY for a post that is not in the
     * library yet, where that click IS the save action (and on older builds it
     * also opens the picker directly). Clicking an already-saved post is never
     * tried any more: on current builds it silently toggles the post OUT of the
     * library and opens nothing, which is how posts ended up unsaved after a run.
     */
    if (!wasSaved) {
      const direct = await attempt(
        "bookmark click (post was not in the library)",
        () => {
          clickElement(icon);
          return waitFor(findPanelNow, {
            timeout: 3500,
            interval: 150,
            label: "save_collection_panel"
          });
        }
      );
      if (direct) return opened(direct);

      // That click saved the post, and the collections live in the popover, so
      // try it once more now that the post has a saved state.
      hoverElement(findSaveIcon() || icon);
      const afterSave = await attempt("popover after saving the post", () =>
        waitFor(findPanelNow, {
          timeout: 2500,
          interval: 200,
          label: "collections_popover_after_save"
        })
      );
      if (afterSave) {
        trace.openedViaHover = true;
        return opened(afterSave);
      }
    }

    // If a route left an unrecognised overlay open, close it so the failure
    // report is about the picker and not about a stale sheet.
    if ([...document.querySelectorAll('[role="dialog"]')].some(isVisible)) {
      pressEscape();
      await sleep(200);
    }

    /*
     * The ⋯ menu route is deliberately GONE. Screenshot and log evidence from
     * this build: the ⋯ menu has no "Save to collection" item on /p/ OR /reels/
     * pages (Report / Go to post / Share to… / Copy link / Embed / About this
     * account), so the route could never reach the picker. All it did was click
     * the three-dots control - which is exactly what looked like the writer
     * "going to the 3 dots icon" - and in the double-click variant that followed
     * it, click the bookmark again and toggle the post out of the library.
     * findMoreOptionsButton() is kept for the dry-run report only.
     */

    // Safety net: never leave a post toggled OUT of the library because a route
    // clicked the bookmark. Restore the state we found the post in, then report
    // the failure with every dead end named.
    if (wasSaved && !isSaved()) {
      const restore = findSaveIcon();
      if (restore) {
        clickElement(restore);
        await sleep(350);
      }
      trace.restoredSavedState = isSaved();
    }

    // Leave no hover state behind, then name which of the two very different
    // worlds this is: a popover we could not reveal, or a build that never puts
    // one in the DOM at all.
    unhoverElement(findSaveIcon());
    const stillHidden = findCollectionsPopover({ includeHidden: true });
    throw new Error(
      `save_panel_unreachable (${trace.routeErrors.join("; ")})` +
        " - " +
        (stillHidden
          ? 'a Collections popover IS in the DOM but could not be made visible; open the picker by hand and press "Inspect the tab I\'m on" for the report'
          : "no Collections popover exists in the DOM on this page, so this build renders the picker only for real pointer hover")
    );
  }

  /* ---------------------------------------------------------------------- *
   * Step (c) - locate the collection row for the category
   * ---------------------------------------------------------------------- */

  /*
   * The picker renders one row per collection. We cannot rely on markup shape,
   * so panelRows() gives us the row elements and we match the category against
   * their normalised text. Instagram displays spaces in collection names as
   * underscores, which normalizeName() flattens so "study tips" matches
   * "study_tips".
   *
   * Fallbacks: an exact text match first, then a "starts with" match limited to
   * short strings so a wrapper element containing many collection names can
   * never be mistaken for a row.
   */
  function findCollectionRow(panel, category) {
    const wanted = normalizeName(category);
    if (!wanted) return null;

    let exact = null;
    let loose = null;
    for (const row of panelRows(panel)) {
      const text = normalizeName(row.textContent);
      if (text === wanted) {
        exact = row;
        break;
      }
      if (!loose && text.startsWith(wanted) && text.length <= wanted.length + 24) {
        loose = row;
      }
    }

    const row = exact || loose;
    if (!row) return null;

    const label = deepestTextCarrier(row, wanted) || row;
    const toggle = rowClickTarget(row, label);
    return {
      row,
      label,
      toggle,
      checkbox: row.querySelector('input[type="checkbox"], [role="checkbox"]')
    };
  }

  /*
   * Some builds show a row's selection with a checkmark icon instead of an
   * <input type=checkbox>. A mark on its own proves nothing - some builds put a
   * (permanently unchecked) checkbox-looking icon in EVERY row - so it is only
   * treated as a signal when the rows DISAGREE: then a mark means "in this
   * collection" and no mark means "not in it".
   */
  const SELECTION_MARK_RE = /check|selected|added|included|tick/i;

  function selectionMarkIn(row) {
    const candidates = row.querySelectorAll(
      'svg, [role="img"], [role="checkbox"], [aria-label], [data-testid]'
    );
    for (const element of candidates) {
      if (!isVisible(element)) continue;
      const haystack = [
        element.getAttribute("aria-label") || "",
        element.getAttribute("data-testid") || "",
        typeof element.className === "string" ? element.className : "",
        element.tagName.toLowerCase() === "svg" ? element.textContent || "" : ""
      ].join(" ");
      if (SELECTION_MARK_RE.test(haystack)) return element;
    }
    return null;
  }

  function marksAreMeaningful(panel) {
    const rows = panelRows(panel);
    if (rows.length < 2) return false;
    const marked = rows.filter((row) => !!selectionMarkIn(row)).length;
    return marked > 0 && marked < rows.length;
  }

  /**
   * Read one row's selection state. Returns { state, signal } where state is
   * true / false / null. A `null` means this markup simply does not expose the
   * state - the caller then reports the write as UNCONFIRMED rather than
   * claiming a post was sorted. Note that we may be about to toggle the wrong
   * way in that case, which is exactly why it is surfaced instead of guessed.
   */
  function readRowSelection(row, panel) {
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (checkbox) return { state: !!checkbox.checked, signal: "input.checked" };

    for (const attr of ["aria-checked", "aria-selected", "aria-pressed"]) {
      const carrier = row.querySelector(`[${attr}]`) || row;
      const value = carrier.getAttribute && carrier.getAttribute(attr);
      if (value === "true") return { state: true, signal: attr };
      if (value === "false") return { state: false, signal: attr };
    }

    const marked = marksAreMeaningful(panel);
    if (selectionMarkIn(row)) {
      return marked
        ? { state: true, signal: "selection mark present (rows disagree)" }
        : { state: null, signal: "a selection mark on every row reads as decoration" };
    }
    if (marked) {
      return { state: false, signal: "no selection mark while other rows have one" };
    }
    return { state: null, signal: "no checkbox, no aria-checked, no selection mark" };
  }

  /* ---------------------------------------------------------------------- *
   * Step (d) - create the collection when it does not exist
   * ---------------------------------------------------------------------- */

  /** Find the most specific visible control whose aria-label matches. */
  function findButtonByLabel(root, patterns) {
    const candidates = root.querySelectorAll(
      '[aria-label], [role="button"], button, a'
    );
    let best = null;
    let bestLength = Infinity;
    for (const candidate of candidates) {
      if (!isVisible(candidate)) continue;
      const label = candidate.getAttribute && candidate.getAttribute("aria-label");
      if (!label || !patterns.some((pattern) => pattern.test(label))) continue;
      if (label.length < bestLength) {
        bestLength = label.length;
        best = candidate.closest('[role="button"], button, a') || candidate;
      }
    }
    return best;
  }

  /*
   * Fallback ladder for the "New collection" button:
   *   1. exact visible text "New collection"
   *   3. the bare "+" in the hover popover's header (by text, then by
   *      aria-label - that control is often an unlabelled glyph)
   * Name input:  1. input labelled as a collection
   *              2. NEW text input that appeared after clicking "+", inside a
   *                 visible dialog or inside the panel at all
   *              (never a pre-existing page input: on reels that is the comment
   *               box, and typing the category there would post a comment)
   * Confirmation: 1. a visible button labelled Next / Create / Done
   *               2. Enter keydown on the input
   */
  /**
   * The "name your collection" input.
   *
   * `scope`        - look here first (the panel), then the document.
   * `exclude`      - inputs that existed BEFORE the "+" click. Those are only
   *                  accepted when properly labelled, so the comment box and the
   *                  search box can never be mistaken for the create form.
   * `requireLabel` - probe mode: only ever accept a labelled input.
   */
  function findCollectionNameInput({
    scope = null,
    exclude = null,
    requireLabel = false
  } = {}) {
    const roots = scope ? [scope, document] : [document];
    for (const root of roots) {
      const inputs = [...root.querySelectorAll('input[type="text"], input:not([type])')]
        .filter(isVisible)
        .filter((element) => !element.readOnly && !element.disabled);
      if (!inputs.length) continue;

      const labelled = inputs.find((element) =>
        /collection/i.test(
          `${element.placeholder || ""} ${element.getAttribute("aria-label") || ""}`
        )
      );
      if (labelled) return labelled;
      if (requireLabel) continue;

      const isNew = (element) => !exclude || !exclude.has(element);
      const inDialog = inputs.find((element) => {
        const dialog = element.closest('[role="dialog"]');
        return isNew(element) && dialog && isVisible(dialog);
      });
      if (inDialog) return inDialog;

      const freshlyRendered = inputs.find(isNew);
      if (freshlyRendered) return freshlyRendered;
    }
    return null;
  }

  async function createCollection(panel, category) {
    // The hover popover renders the create affordance as a bare "+" button in
    // the header rather than a "New collection" button.
    const newButton =
      findButtonByText(panel, [
        "new collection",
        "create new collection",
        "new",
        "+",
        "add"
      ]) || findButtonByLabel(panel, [/new collection/i, /^\+$/, /^create/i, /^add$/i]);
    if (!newButton) throw new Error("new_collection_button_not_found");

    // Snapshot what already exists: after this click, a NEW text input is the
    // create form. Anything pre-existing is page furniture and stays excluded.
    const preexisting = new Set(
      [...document.querySelectorAll('input[type="text"], input:not([type])')]
    );

    clickElement(newButton);
    await sleep(300);

    const input = await waitFor(
      () =>
        findCollectionNameInput({ scope: panel, exclude: preexisting }) ||
        findCollectionNameInput({ exclude: preexisting }),
      { timeout: 6000, interval: 150, label: "collection_name_input" }
    );

    setInputValue(input, category);
    await sleep(250);

    /*
     * Confirm buttons live in the same form as the name input - which, in the
     * hover-popover flow, may be its own dialog opened by the "+" button, not
     * the popover itself. Scanning only the panel missed it; scanning the whole
     * document misfired on reels pages, where ambient overlays carry "Next"
     * and "Done" of their own. The input's dialog is the precise middle.
     */
    const formScope = input.closest('[role="dialog"]') || panel;
    const confirmButton = findButtonByText(formScope, ["next", "create", "done", "add"]);
    if (confirmButton) clickElement(confirmButton);
    else pressEnter(input);

    // Some builds show a second confirmation screen ("Save to collection").
    try {
      const secondConfirm = await waitFor(
        () => {
          const button = findButtonByText(formScope, ["done", "save", "next"]);
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
    else unhoverElement(findSaveIcon());

    await sleep(350);
    /*
     * Undo the reveal LAST and only for the properties we touched: a popover we
     * made visible disappears the moment its own hiding styles are back, which
     * is what a real pointer leaving the bookmark would have done. (Hovering
     * document.body used to stand in for that, but a dispatched "hover" changes
     * no state the browser believes, so it never closed anything.)
     */
    undoReveal();
    if (findSavePanel()) {
      unhoverElement(findSaveIcon());
      await sleep(300);
    }
    if (findSavePanel()) {
      pressEscape();
      await sleep(250);
    }
    return !findSavePanel();
  }

  /**
   * The panel to READ THE RESULT from. Usually the one we already have; but on
   * some builds the hover popover closes the moment a row is clicked, and a
   * detached node reports nothing at all - which would look like a failure even
   * when the write landed. So if the panel is gone we hover the bookmark again
   * and wait for it to come back: reading a freshly opened panel is the
   * strongest evidence available that the row really is selected now.
   */
  async function ensurePanelForVerify(icon) {
    // The popover can close or unmount the moment a row is clicked, and a
    // detached node reports nothing at all - which would look like a failure
    // even when the write landed. So re-open it through the same routes the
    // writer uses, reveal included.
    const open = findSavePanel({ allowReveal: true });
    if (open) return open;
    const target = findSaveIcon() || icon;
    if (!target) return null;
    hoverElement(target);
    try {
      return await waitFor(() => findSavePanel({ allowReveal: true }), {
        timeout: 2500,
        interval: 200,
        label: "panel_reopen_for_verification"
      });
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------------- *
   * Main entry point
   * ---------------------------------------------------------------------- */

  async function performWrite(category, shortcode) {
    trace.saveIconStrategy = null;
    trace.panelStrategy = null;
    trace.panelOpenStrategy = null;
    trace.moreStrategy = null;
    trace.openedViaHover = false;
    trace.panelRevealed = false;
    trace.panelSuspicious = false;
    trace.restoredSavedState = null;
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
        selectionAfter: null,
        // HOW the state above was read ("input.checked", "aria-checked",
        // "selection mark present (rows disagree)", ...). When the answer is
        // "no checkbox, no aria-checked, no selection mark" the build simply
        // does not expose the state, and that is worth saying out loud.
        selectionSignal: null
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
      if (panelLooksSuspicious(panel)) {
        trace.panelSuspicious = true;
        pressEscape();
        throw new Error(
          "save_panel_not_trusted: a visible overlay mentions saving but shows " +
            "no collection checkboxes (ambient reel-page sheet?); refusing to " +
            "click inside it"
        );
      }
      let livePanel = panel;
      const existingRow = findCollectionRow(panel, category);

      if (existingRow) {
        result.trace.rowMatched = "existing";
        result.trace.rowSelector = describe(existingRow.toggle).selector;
        const before = readRowSelection(existingRow.row, panel);
        result.trace.selectionBefore = before.state;
        result.trace.selectionSignal = before.signal;
        if (before.state === true) {
          result.warning = "already_in_collection";
          result.confirmed = true; // already where we want it
        } else {
          clickElement(existingRow.toggle);
          await sleep(450);
          /*
           * Re-read from a FRESH panel (see ensurePanelForVerify): the popover
           * may have closed on the click, and a detached node would report
           * nothing - indistinguishable from a click that never landed.
           */
          const verifyPanel = await ensurePanelForVerify(icon, panel);
          if (verifyPanel) livePanel = verifyPanel;
          const verify = verifyPanel ? findCollectionRow(verifyPanel, category) : null;
          const after = verify
            ? readRowSelection(verify.row, verifyPanel)
            : { state: null, signal: "the row could not be found again after the click" };
          result.trace.selectionAfter = after.state;
          result.trace.selectionSignal = after.signal;
          if (after.state === true) result.confirmed = true;
          if (after.state === false) result.warning = "collection_checkbox_may_be_unchecked";
          if (after.state === null) {
            result.warning = result.warning || "collection_state_unverifiable";
          }
        }
      } else {
        await createCollection(panel, category);
        result.trace.rowMatched = "created";
        // Creating a collection is the one path where nothing was clicked in an
        // existing row, so the proof it worked is that the picker now lists it -
        // and, if the build exposes it, that its row reads as selected.
        const createdPanel = (await ensurePanelForVerify(icon, panel)) || panel;
        livePanel = createdPanel;
        const created = findCollectionRow(createdPanel, category);
        result.confirmed = !!created;
        if (created) {
          result.trace.rowSelector = describe(created.toggle).selector;
          const state = readRowSelection(created.row, createdPanel);
          result.trace.selectionAfter = state.state;
          result.trace.selectionSignal = state.signal;
        } else {
          result.warning = "collection_created_unconfirmed";
        }
      }

      // Ordering matters: a warning that says whether the write LANDED is worth
      // more than one about housekeeping, so the milder ones never overwrite it.
      const closed = await closePanel(livePanel);
      if (!closed && !result.warning) result.warning = "panel_did_not_close";

      // The post must still be in the saved library afterwards. If the bookmark
      // reads "Save" we toggled it out of the library somewhere along the way and
      // the collection membership is worthless, so put it back - and if even that
      // fails, say so. This outranks the milder warnings, so it deliberately
      // overwrites them.
      if (!isSaved()) {
        const restore = findSaveIcon();
        if (restore) {
          clickElement(restore);
          await sleep(350);
        }
        result.warning = isSaved() ? "post_was_unsaved_and_restored" : "post_may_be_unsaved";
      }

      result.success = true;
      return result;
    } catch (error) {
      result.error = String((error && error.message) || error);
      return result;
    } finally {
      // Whatever happened, the page must be left as we found it: release the
      // styles the reveal touched (a no-op when closePanel already did), so an
      // aborted run cannot leave a popover stuck open in the tab.
      undoReveal();
      // Which fallback matched is the single most useful debugging fact.
      result.saveIconStrategy = trace.saveIconStrategy;
      result.panelStrategy = trace.panelOpenStrategy || trace.panelStrategy;
      result.moreStrategy = trace.moreStrategy;
      result.trace.saveIconStrategy = trace.saveIconStrategy;
      result.trace.panelStrategy = trace.panelOpenStrategy || trace.panelStrategy;
      result.trace.moreStrategy = trace.moreStrategy;
      result.trace.openedViaMenu = trace.openedViaMenu;
      result.trace.openedViaHover = trace.openedViaHover;
      result.trace.panelRevealed = trace.panelRevealed;
      result.trace.routeErrors = trace.routeErrors || null;
      result.trace.panelSuspicious = trace.panelSuspicious;
      result.trace.restoredSavedState = trace.restoredSavedState;
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

    /*
     * Step 1b - the hover route, probed for real. Hovering dispatches events but
     * changes nothing (no clicks, nothing saved or unsaved), and on current
     * builds it is the ONLY way to open the picker. A probe that cannot see the
     * picker cannot verify the row strategies either, so we hover the bookmark
     * and report what appeared. When it opens, the rest of this report - rows,
     * the matching row, its click target and its selection state - becomes
     * verifiable without the user touching anything by hand.
     */
    let hoverPanel = null;
    let hoverError = null;
    let revealedMounted = false;
    if (icon) {
      hoverElement(icon);
      try {
        hoverPanel = await waitFor(findSavePanel, {
          timeout: 3000,
          interval: 200,
          label: "popover_on_hover"
        });
      } catch (error) {
        hoverError = error.message;
      }
      if (hoverPanel) {
        addStep(
          "1b. hover route",
          "RESOLVED",
          `hovering the bookmark opened: ${trace.panelStrategy}`,
          hoverPanel
        );
      } else {
        addStep(
          "1b. hover route",
          "MISS",
          `hovering the bookmark opened nothing (${hoverError}); the real run then clicks the bookmark, hovers again, tries the ⋯ menu and finally a double click`
        );
        lines.push(
          `    bookmark    : ${isSaved() ? "in the saved library" : "NOT saved yet - the popover usually only exists for saved posts"}`
        );
        /*
         * Two very different worlds look identical in a MISS, so tell them
         * apart: either the popover is rendered on hover only (the hover events
         * do not reach the handler), or it IS in the DOM but hidden by CSS
         * (a :hover-driven reveal no synthetic event can trigger). The fix
         * differs, so the report has to say which one this is.
         */
        const hiddenPopover = icon ? findCollectionsPopover({ includeHidden: true }) : null;
        if (hiddenPopover) {
          /*
           * The real run no longer fights CSS `:hover` - it makes the mounted
           * popover visible. Do the same here so the row / checkbox / close
           * steps below are verified against the REAL picker instead of being
           * reported as unverifiable. Every style this touches is put back
           * further down, and nothing is ever clicked in the probe.
           */
          const revealedNow = revealMountedPopover();
          if (revealedNow) {
            hoverPanel = revealedNow;
            revealedMounted = true;
            addStep(
              "1c. hidden popover",
              "RESOLVED",
              `a "Collections" popover was mounted but CSS-hidden, so it was revealed for this report (${trace.panelStrategy}) - the real run uses this same route, no real pointer involved`
            );
          } else {
            addStep(
              "1c. hidden popover",
              "MISS",
              'a "Collections" popover EXISTS in the DOM but could not be made visible - the real run would fail here too'
            );
          }
        } else {
          addStep(
            "1c. hidden popover",
            "INFO",
            'no "Collections" popover in the DOM, so either this build renders the picker only for real pointer hover or the post is not in the library'
          );
        }
      }
    }

    // Steps 2-5 - the picker: whatever the hover probe opened, or one the user
    // opened by hand before pressing "Inspect current tab".
    const panel = hoverPanel || findSavePanel();
    if (panel) {
      addStep("2. save panel", "RESOLVED", `strategy: ${trace.panelStrategy}`, panel);

      const rows = rowInventory(panel, category);
      const match = findCollectionRow(panel, category);
      lines.push(`    rows found  : ${rows.length}`);
      for (const row of rows.slice(0, 15)) {
        lines.push(`      - "${row.text}"${row.matches ? "   <== matches the category" : ""}`);
      }

      if (match) {
        const state = readRowSelection(match.row, panel);
        addStep(
          "3. collection row",
          "RESOLVED",
          `row "${category}" would be clicked`,
          match.toggle
        );
        lines.push(`    would click : ${describe(match.toggle).selector}`);
        lines.push(
          `    selected now: ${state.state === null ? "unknown" : String(state.state)}  (read via ${state.signal})`
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
        "on this build the picker is a HOVER popover - hover the bookmark (or let the real run do it); a dry run cannot verify it"
      );
      // On recent builds the bookmark click on an already-saved post only
      // toggles the saved state. The real run hovers the bookmark for the
      // Collections popover; report whether the ⋯ menu fallback also exists.
      const more = findMoreOptionsButton();
      addStep(
        "2b. more-options menu",
        "INFO",
        more
          ? "the ⋯ menu exists but is NOT used by the run - on this build it has no \"Save to collection\" item (Report / Go to post / Share / Copy link / Embed / About this account), so clicking it only opened the three-dots popover"
          : "no ⋯ menu control found, and none is needed - the run no longer uses that route"
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

    // Leave the page exactly as we found it: release any hover state we
    // dispatched, and put back every style the reveal touched.
    unhoverElement(icon);
    if (revealedMounted || trace.panelRevealed) undoReveal();

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
