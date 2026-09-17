# IG Saved Sorter

A Manifest V3 Chrome extension that sorts your Instagram **saved posts** into
**collections**, using a vision model to decide the category of each post.

It works in three phases that you drive from the popup:

| Phase | What happens | Who drives it |
| --- | --- | --- |
| **1 · Start Collecting** | A content script passively records every saved-post tile you scroll past (shortcode + thumbnail URL). | **You** — scroll your Saved page manually. |
| **2 · Classify Collected Posts** | The background worker sends each thumbnail to the DeepSeek vision model and stores the resulting category + confidence. | The extension. |
| **3 · Sort Into Collections** | For every classified post the worker opens a background tab, opens the *Collections* popover (it is mounted but CSS-hidden, so the writer reveals it), selects (or creates) the matching collection, then closes the tab. | The extension. |

The extension **never** reads, stores or transmits your Instagram password. Phase 3
reuses the session cookies your browser already has, exactly as if you had clicked
the buttons yourself.

---

## Files

```
manifest.json                    MV3 manifest (permissions, content script registration)
popup.html / popup.js            Control panel: provider, categories, 3 buttons, status, diagnosis
background.js                    Service worker: storage, model calls, write-back orchestration
content-scripts/collector.js     Passive DOM collection on the Saved page (+ /p/ pages)
content-scripts/writer.js        Programmatically injected; real write plus the inspect-only dry run
README.md
```

`content-scripts/writer.js` is **not** declared in `manifest.json`. It is injected on
demand with `chrome.scripting.executeScript({ files: [...] })`.

---

## 1. Load the extension unpacked

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Optionally pin the extension: click the puzzle-piece icon in the toolbar → pin
   *IG Saved Sorter*. There is no icon file in the project, so Chrome shows the
   default placeholder; drop a 128×128 `icon.png` in the folder and add an `icons`
   key to `manifest.json` if you want a custom one.
5. Log in to Instagram in the same Chrome profile (the extension has no login flow
   of its own — it rides on your existing session).

### One-time setup in the popup

1. Pick a **Model provider** from the dropdown. **Google Gemini's free tier is the
   easiest zero-cost option** — see [section 3](#3-choosing-a-model-provider-including-free-options)
   for the free choices and what each one costs you.
2. Paste that provider's **API key** (skipped entirely for Ollama) and press
   **Save**, then press **Test** to send one real image before you commit to a run.
3. Check the **category list**. Default:
   `food, workout, fashion, memes, travel, study_tips, other`.
   These names are used verbatim as Instagram collection names, so keep them short
   and avoid characters Instagram rejects. Press **Save**.

---

## 2. Use the three buttons in order

### Step 1 — “Start Collecting”

* If posts are already stored, the button arms itself: click it **again** within
  6 seconds to confirm. This **deletes** the previous run (including classification
  and sort results) before starting fresh.
* Now open your Saved page: `https://www.instagram.com/<your_username>/saved/` (pick the
  **All posts** tab there).
  After your first collection the popup shows a convenience link — the extension
  itself never navigates for you.
* **Scroll slowly down the grid.** Each tile that your browser renders is recorded
  once. Nothing is auto-scrolled and nothing is auto-navigated: if you don't scroll,
  nothing is collected. Scroll back up and down as much as you like; duplicates are
  ignored.
* **Watch the badge** on the extension's toolbar icon: it shows how many posts have
  been recorded, so you can see it working while you scroll without opening the popup.
* The Status card shows a **Collector:** line, which is the honest answer to "is this
  working?". It reads `Collector: live in 1 tab(s) · 24 tile(s) recorded · Saved page
  open` when all is well. If it says *not running*, the content script is missing from
  that tab - reload the tab (F5). If it says *no Instagram tab open* or *not a Saved
  page*, open your Saved page. If it says *no tiles found yet*, the grid has not
  rendered.
* Watch the **collected** counter in the popup.

### Step 2 — “Classify Collected Posts”

* Sends each unclassified thumbnail to the configured vision model with a fixed
  system prompt that forces JSON in the shape `{"category": "...", "confidence": 0.0-1.0}`.
* Runs up to **3 concurrent** requests with up to **3 retries** each (exponential
  backoff). Failures are logged and skipped — one bad image never stops the batch.
* A **per-minute** 429 is treated as a scheduling problem, not a post failure: the
  refused post is re-queued for the same run and all requests then wait out a
  shared ~65 s cool-down, so a free tier's 20-requests-per-minute window simply
  paces the batch instead of failing posts. A **per-day** quota still aborts the
  batch outright (nothing marked failed; see the troubleshooting table).
* Progress, per-post errors and warnings appear in the popup. Re-running the button
  retries anything that failed, so this phase is safely resumable.

### Step 3 — “Sort Into Collections”

* For each classified post that is not yet written: opens
  `https://www.instagram.com/reel/<shortcode>/` (or `/p/`) in an **inactive** tab,
  waits for it to load, injects `writer.js`, opens the collection picker, selects
  the matching row (creating the collection if it doesn't exist), then closes the
  tab.
* **The picker's reveal is pure CSS `:hover`, which no scripted event can
  produce — so the writer does not try to hover.** Hovering the bookmark shows a
  *Collections* list above it; clicking it on an already-saved post only toggles the
  post out of your library and opens nothing. But the popover is **already mounted
  in the DOM**, merely hidden. So the writer finds it and makes it visible itself:
  every element that is hiding it gets inline `!important` styles, the row is
  clicked, and then each of those styles is put back — the same thing a real pointer
  leaving the bookmark would have done. Routes, in order: **reveal the mounted
  popover** (instant, no waiting) → hover (for builds that reveal it from a JS
  handler) → **bookmark click, only when the post is not in your library yet**,
  where that click *is* the save action. If a click ever toggles a post out of the
  library it is clicked back, and on a total failure the post is restored to the
  state it was found in.
* **The ⋯ menu is no longer used.** On this build its menu has no *Save to
  collection* item on `/p/` **or** `/reels/` pages (Report / Go to post / Share to… /
  Copy link / Embed / About this account), so that route could never reach the
  picker — all it did was click the three-dots control. The dry run still reports
  whether the control exists, as information only.
* The panel is found by a ladder (dialog mentioning save/collection, dialog
  containing checkboxes, **the “Collections” popover — header plus its rows, no
  checkbox controls required**, that same popover force-revealed when it is mounted
  but hidden, or any visible container holding a group of 2+ checkboxes). The
  popover is identified as the **deepest** container whose text starts with
  “Collections” and which holds row labels: its wrappers contain the same text and
  are deliberately never adopted (a wrapper looks like a visible panel with no rows
  in it, which is how the writer used to end up clicking nothing). The row to click
  is the deepest clickable that carries the category's label, never an outer
  wrapper. When all routes miss, the error names **every** dead end and why, e.g.
  `save_panel_unreachable (reveal mounted popover: no mounted Collections popover in
  the DOM; bookmark hover: timeout_waiting_for_collections_popover_on_hover) - no
  Collections popover exists in the DOM on this page, …`.
* After clicking a row the writer reads the selection back — `input.checked`,
  then `aria-checked`, then a checkmark icon, in that order — and a click whose
  result cannot be read is reported as **unconfirmed**, not as sorted. If the
  popover closes or unmounts on the click, it is re-opened (revealed again) and read
  from there, which is stronger evidence than watching a stale element. The read method is stored
  per post in `writeTrace.selectionSignal`.
* The log gets a line **only for the posts that need attention** (unconfirmed, or
  carrying a warning) plus one roll-up at the end of the run:
  `Picker routes used: 20× popover revealed (CSS :hover build), 1× hover popover`.
  That single line tells you which route your build actually needs — if it says
  `bookmark click` for everything, the popover was not in the DOM and step `1c` of a
  dry run will say so.
* If several posts **in a row** fail with the *same* error (a deploy moved the
  picker, say), the run stops early with that explanation instead of grinding
  through the rest of the library; the untouched posts simply retry next run.
* Pacing: a randomised **2–4 s** between posts and a **15–20 s** pause after every
  **20** posts, to stay under Instagram's rate limits.
* **Fully resumable:** posts already marked `written` are skipped, so you can stop
  and restart at any time (posts that failed are retried). Posts that were written
  but never *confirmed* are also skipped by default; tick **Re-sort posts that were
  never confirmed** to bring those back, which is how you recover anything an older
  build claimed to sort. Confirmed posts are never re-clicked, because clicking a
  collection that already contains the post removes it again.
* Leave the browser focused on something else while this runs — Instagram's UI
  still works in background tabs, but the tabs do appear in your tab strip.
* **Tick “Dry run” first** if you have never run this: it performs the whole phase
  without clicking anything (see the next section).

Use **Stop** to end any run cleanly after the current item, and
**Clear all data** (armed, two clicks) to wipe `chrome.storage.local`.

#### Do I need to create the collections in Instagram first?

**No.** On the first post that needs a category with no matching row, the writer
clicks **New collection**, types the category name and confirms it, then carries on.

**But pre-creating them is worth doing**, for two reasons:

* **You get to choose the display name.** Names are compared after lowercasing and
  flattening spaces, underscores and hyphens into single spaces, so a collection you
  name **Study Tips** matches the category `study_tips` exactly. Pre-created names
  win over auto-created ones, which are used verbatim (`study_tips`).
* **It removes the most failure-prone step from the run.** Creating a collection is
  the only path in the writer that types text and can span two screens; doing it once
  by hand is cheaper than doing it in a background tab, where it also has to survive
  a 6 s wait for the name input.

One collision to know about: if no row matches exactly, the writer accepts a row
whose name **starts with** your category (within 24 extra characters). So a category
`food` reuses an existing **Food & drink** instead of creating **food**. Give a
category its own distinct row name if you care. The dry run's *category map* prints
exactly which of the two would happen for every category, and flags
the prefix matches.

---

## 3. Choosing a model provider (including free options)

The extension needs its **own** endpoint and key. A model you reach through some
other app or subscription is not transferable — an extension cannot call another
product's authenticated session. The good news is that everything the pipeline
needs is a plain OpenAI-shaped `/chat/completions` call, and several capable
vision models are free:

| Provider | Cost | Where to get a key | Notes |
| --- | --- | --- | --- |
| **Google Gemini** | free tier | [AI Studio](https://aistudio.google.com/apikey) | Best free option, but the **per-day** cap is easy to hit on a big library. Free-tier limits are per-minute *and* per-day, and Google may use free-tier data for training. |
| **OpenRouter** | free tier | [openrouter.ai/keys](https://openrouter.ai/keys) | One key, many models. The default model `openrouter/free` routes to a free vision model; you can also name a specific one (e.g. a model ending in `:free`). Some free models require enabling data-sharing in your OpenRouter settings. |
| **OmniRoute (local gateway)** | free tier pools | none (gateway manages keys) | One local endpoint (`http://localhost:20128/v1`) in front of 150+ free provider tiers with quota-aware fallback — when one runs dry, the next is used automatically. Setup notes below. |
| **Ollama (local)** | free, offline | none | Runs on your own machine, nothing leaves it. Highest privacy, zero cost, needs a few GB of RAM/VRAM. Setup notes below. |
| **DeepSeek** | paid | [platform.deepseek.com](https://platform.deepseek.com) | The original default (`deepseek-flash`). Cheap, but not free. |
| **Custom** | varies | varies | Any OpenAI-compatible `/chat/completions`. Add its host to `host_permissions` in `manifest.json` first, then reload the extension. |

Concurrency is per provider and deliberately low on the free tiers: a per-minute
`429` is retried with exponential backoff instead of hammering, because a
rate-limit storm ends up slower than being patient.

Model names and keys are stored **per provider**, so you can try Gemini, switch to
Ollama, and switch back without re-pasting anything.

### When a free quota runs out

Hosted free tiers limit **per minute and per day**, and a whole saved library is
easy to push past the daily one. The two cases are handled differently, because
only one of them is worth waiting for:

* **Per minute** → the request is retried with backoff. If 6 posts in a row are
  still refused, the batch stops early with a clear message rather than marching
  through the rest of your library marking every post `failed`.
* **Per day** → aborts immediately with `*_quota_exhausted`, naming the exact limit
  hit. Retrying cannot help, so it does not try.

In both cases the run is only *paused*: classified posts keep their category, posts
that were never attempted stay `collected`, and pressing **Classify** again later
tries only what is missing. If you have more than a few hundred posts, plan on
**Ollama** — it is the only unmetered option, and its limits are your CPU.

To switch provider mid-project: pick another one in the dropdown (keys and model
names are remembered per provider), press **Save**, press **Test**, then press
**2 · Classify Collected Posts** again.

### Fail fast: the Test button

Press **Test** next to **Save**. It sends one real image — the thumbnail of your
first collected post, or a small generated image if you have not collected
anything yet — and reports the model's category, the latency, or the exact error.
This matters because an unusable provider configuration (bad key, unknown model, a
model that refuses images) now **aborts the batch immediately** instead of failing
several hundred posts one at a time with the same message.

The test line also prints **what the model actually replied** (`model said: …`).
Model output formatting is the least reliable link in this pipeline, so when
something is off, that excerpt is the fastest way to see whether the answer was
prose, fenced, truncated, or never emitted at all. The parser is deliberately
forgiving — it handles fenced blocks, schema echoes, reasoning-first replies,
trailing commas, array-shaped content, and both `content` and `reasoning_content`
payload shapes — but it refuses to guess between two or more stated categories.

### OmniRoute setup (local gateway over many free pools)

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) is a local, MIT-licensed
gateway that pools dozens of providers' free tiers behind one OpenAI-compatible
endpoint, with quota-aware fallback between them. For this extension:

```powershell
npm install -g omniroute
omniroute          # keep this window open; dashboard opens at http://localhost:20128
```

1. In the dashboard's **Providers** page, connect whichever free providers you
   want pooled (some need just a login, some a pasted key — the gateway holds
   them, not the extension).
2. In the popup: **Model provider → OmniRoute**, leave the API key empty, press
   **Save**, then **Test**. The default model `auto` routes each request to a
   healthy connected provider.
3. **Vision matters:** `auto` may hand an image request to a text-only model. If
   Test fails with a modality error, set **Model** to a specific vision-capable
   id from the dashboard's catalog instead.
4. If Classify suddenly fails with `*_not_running`, the gateway window was closed
   — start `omniroute` again and re-run; posts stay retryable.

### Ollama setup (fully free, fully local)

```bash
ollama pull llava:7b     # or qwen3-vl / gemma4 / qwen2.5vl:7b — better, but bigger
ollama serve             # usually already running as a background service
```

Two gotchas:

1. Ollama's default CORS policy rejects `chrome-extension://` origins. If the test
   fails with a `403` mentioning `Origin`, restart it allowing extension origins:
   macOS/Linux `OLLAMA_ORIGINS='chrome-extension://*' ollama serve`, PowerShell
   `$env:OLLAMA_ORIGINS="chrome-extension://*"; ollama serve`.
2. Type the model name exactly as `ollama list` prints it. **Do not use
   `llama3.2-vision`** — Ollama's rewrite of its model loader left it broken
   (`unknown model architecture: mllama`, still open); prefer `qwen2.5vl:7b`,
   `qwen3-vl`, `gemma4` or `llava:7b`. If you specifically want a *Llama* vision
   model, the only working route is a hosted one such as OpenRouter's free tier,
   not local Ollama.
   Local models are slower and less accurate than the hosted free tiers, so expect
   to correct a few categories by hand or skip this phase for them.

---

## 4. Dry run: verifying the selectors against the live DOM

Instagram's markup changes without notice, so the sort phase has an inspect-only
mode. Tick **Dry run** under the third button (the button relabels itself to
*3 · Dry-Run Sort (no clicks)*) and press it: the extension opens each post in a
background tab and reports **which element each step would act on** — without
dispatching a single click. Statuses stay `classified`, so nothing looks sorted.

The probe first **hovers the bookmark** (step `1b`). Hovering changes nothing on
Instagram, but on current builds it also opens nothing: the popover is mounted and
hidden by CSS `:hover`, a state no scripted event can produce.

So when `1b` reports `MISS`, the next step (`1c. hidden popover`) finds the mounted
popover and **reveals it, exactly as the real run does** — and the rest of the
report then verifies the panel, every row, the row it would click and that row's
current selection state against the real popover. Nothing is clicked: only styles
are touched, and they are put back before the report is written.

* `1c. RESOLVED` — the normal case on current builds: the popover was mounted but
  CSS-hidden, and revealing it is precisely what the run does. Steps 2-6 are
  verified.
* `1c. MISS` — a popover exists but could not be made visible. The real run fails
  here too; press **Inspect the tab I'm on** and send the report.
* `1c. INFO` — no popover in the DOM at all, so either this build only renders it
  for a real pointer, or the post is not in your library.

The per-post verdict in the log says the same thing in one line: `picker was mounted
but CSS-hidden; the writer reveals it instead of hovering - 5 step(s) resolved, 0
miss, 0 gated`, or `picker opened by hovering the bookmark - …`, or `no picker in
the DOM (real pointer hover only) - …`. Reports are stored per post (up to 80 lines)
and can be copied out with the popup's Copy button.

Each step in the report is tagged:

| Tag | Meaning |
| --- | --- |
| `RESOLVED` | A strategy matched *right now*, with a copy-pasteable selector for the element that would be clicked. Paste it into the DevTools console to see the same node. |
| `MISS` | No strategy matched. The real run would throw at this step. The line under it lists how many elements every selector in the ladder matched, so you can see what to add. |
| `NOT-OPEN` | The element only exists after a click (e.g. the naming input), so a dry run cannot see it. |
| `SKIPPED` | Gated behind a step that needs a click. |
| `INFO` | Context: URL, login wall, row counts, the category map. |

### Verifying the picker-only steps

Step `1c` already reveals the picker, so on current builds the report covers the
panel, its rows and the row it would click with no help from you. On a build where
there is no popover in the DOM at all (the `1c` step reports `INFO`), verify steps
2-6 by opening the picker yourself:

1. Open any of your saved posts (`https://www.instagram.com/<you>/saved/` → click a post).
2. Open the picker the way you would by hand (hover the bookmark; on an older build, ⋯ → *Save to collection*).
3. Open the popup and press **Inspect the tab I'm on (no clicks)**.

The report then also includes the full row list and a **category map**: for each
of your configured categories it says whether the picker already has a matching
row or whether the writer would have to create it. That is the fastest way to
confirm your category names line up with your existing collections.

Reports appear in the popup (newest first, one per post), can be **copied** with
the Copy button, and the log gets a one-line verdict per post, for example:

```
[RESOLVED] 1. save icon — ladder hit: svg[aria-label="Remove"]
    selector   : svg[aria-label="Remove"]
    bookmark now: in the saved library (aria-label="Remove")
    ladder      : svg[aria-label="Save"]→0  svg[aria-label="Remove"]→1  ...

[MISS] 1b. hover route — hovering the bookmark opened nothing (timeout_waiting_for_popover_on_hover)
    bookmark    : in the saved library

[RESOLVED] 1c. hidden popover — a "Collections" popover was mounted but CSS-hidden, so it was revealed for this report ("Collections" popover - mounted but CSS-hidden, revealed it)
[RESOLVED] 2. save panel — strategy: "Collections" popover - mounted but CSS-hidden, revealed it
    rows found  : 6
      - "woah"
      - "other"
      - "study tips"
      - "memes"   <== matches the category
[RESOLVED] 3. collection row — row "memes" would be clicked
    element    : <div> role=button …
    would click : div[role="button"]
    selected now: false  (read via no selection mark while other rows have one)
[INFO] 6. category map — 2 configured categor(ies) resolved against this picker
    memes              existing row "memes"
    food               no row here → would create it
--- inventory: 0 dialog(s), 0 checkbox-ish, 0 text input(s) ---
--- visible [aria-label] controls (interesting ones first) ---
  svg[aria-label="Remove"]  "Remove"  24x24px
```

The trailing inventory (visible `[aria-label]` controls, dialogs, checkbox and
text-input counts) is there so that when Instagram ships a redesign you can see
exactly what the page now exposes instead of guessing.

---

## 5. Data model

Everything lives under one key in `chrome.storage.local` (`unlimitedStorage` is
requested so a few thousand records are never a problem):

```
sortedPosts: [
  {
    postId, shortcode, mediaType,       // "p" or "reel"
    thumbnailUrl,                       // only the URL is stored, never the image bytes
    category,                           // null until classified
    confidence,                         // 0-1
    status,                             // "collected" | "classified" | "written" | "failed"
    error, failedStage, warning,        // diagnostics when something goes wrong
    writtenConfirmed,                   // did the writer SEE the collection tick?
    writeTrace,                         // which selector it clicked, and the states it read
    collectedAt, classifiedAt, writtenAt
  }
]
```

`writtenConfirmed` matters more than it looks. A click that lands on the wrong
element, or on a row whose selected state cannot be read, is indistinguishable
from a successful one unless you check — so `status: "written"` alone does not
mean it landed. `writtenConfirmed: false` means the writer clicked and could not
prove the result, and `writeTrace` records which element it clicked
(`rowSelector`), whether it matched an existing row or created one
(`rowMatched`), and the selection state before/after. Those posts are counted and
surfaced separately (the Status card, the run summary, and Diagnose state) rather
than being folded into the sorted total. They are deliberately **not** retried
automatically: clicking a collection that did land would toggle the post back out
of it.

Other keys: `settings` (`apiKey`, `categories`, `model`, `dryRun`), `jobState`
(progress + the log rendered in the popup), `lastProbe` (the newest manual
dry-run report), `lastUsername`, `stopRequested`. After a dry-run sort each post
also carries `dryRunReport` / `dryRunOk` / `dryRunSummary` with the last verdict
for that post.

---

## 6. Permissions, and why one of them goes beyond the spec

`permissions`: `storage`, `scripting`, `tabs`, `unlimitedStorage`.

`host_permissions`:

| Host | Why |
| --- | --- |
| `https://www.instagram.com/*` | Read the Saved grid, inject the writer, open post tabs. |
| `https://api.deepseek.com/*` | Vision classification calls (DeepSeek provider). |
| `https://generativelanguage.googleapis.com/*` | Gemini free-tier provider. |
| `https://openrouter.ai/*` | OpenRouter free-model provider. |
| `http://localhost/*`, `http://127.0.0.1/*` | Ollama on this computer. Remove these two if you never use a local model. |
| `https://*.cdninstagram.com/*` | **Added beyond the original brief.** Thumbnails live on Instagram's CDN, and the service worker cannot fetch cross-origin images without a host permission — classification would fail with a CORS error for every post. |
| `https://*.fbcdn.net/*` | Same reason: some Instagram media is served from Facebook's CDN (`scontent.*.fbcdn.net`). |

If you remove the two CDN hosts, phase 2 will stop working entirely.

A **custom** provider is the one case that needs a manifest edit: add its origin to
`host_permissions` (for example `"https://my.host/*"`) and reload the extension, or
Chrome will block the request.

---

## 7. Assumptions about Instagram's current DOM

Instagram regenerates its obfuscated CSS class names on every deploy, so **no
selector in this project uses a class name**. Everything keys off ARIA labels,
`role` attributes, visible text and href shape, and each lookup has an ordered list
of fallbacks plus a timeout (documented inline in `writer.js`). The assumptions to
re-check if Instagram changes:

0. **The Saved page URL.** It has changed shape more than once
   (`/<user>/saved/`, `/<user>/saved/all-posts/`, `/saved/...`, `/saved/collections/<id>/`),
   and a too-narrow content-script match pattern fails *silently* — the script
   never runs and nothing is ever collected. So the manifest injects the collector
   on **all** of `instagram.com` and the script decides for itself whether the page
   is collectable, by path segment: a `/saved/` segment (any of the shapes above),
   or a `/p/`, `/reel/`, `/reels/<code>/` page. It stays inert on `/explore/`, profile
   grids, `/reels/audio/...`, DMs and the feed, so browsing cannot pollute the dataset.
1. **Grid tiles** are anchors that contain a post address — `/p/<shortcode>/`,
   `/reel/<shortcode>/`, `/reels/<code>/` or `/tv/<code>/`, accepted **anywhere** in
   the path (not only at the start, since some views prefix it with the current
   context). Tiles are found by sweeping every `a[href]` inside `<main>` and letting
   `parsePostHref` decide, rather than by a narrow attribute selector: a selector that
   is one deploy out of date finds nothing and looks exactly like a broken extension,
   which is what caused "45 tiles on screen, 0 collected". Each tile should contain an
   `<img>` (or a CSS `background-image`); a tile with no image is retried for a few
   scans, then recorded with a null thumbnail rather than dropped. The shortcode (not
   the numeric media id) is the post identifier.

   The mutation observer's container is inferred **separately** as *the element that
   is the direct parent of the most post anchors*, with `div[style*="grid"]` and
   `<main>` as fallbacks. Guessing that container wrong no longer changes *what* is
   collected — it only affects how promptly a change is noticed — because scanning is
   decoupled from observing.
2. **The bookmark control** is reachable by `svg[aria-label="Save"]`, or
   `svg[aria-label="Remove"]` on a post that is already in the library, or by a
   case-insensitive `aria-label*="save"` on an ancestor button.
3. **The picker on a saved post is a CSS-hover popover, not a dialog.** Hovering
   the bookmark shows a small *Collections* header with a **+** button and one row
   per collection; rows carry a thumbnail and a name, and nothing about that popover
   is labelled as a dialog or as a checkbox list (screenshot-verified). Because its
   show/hide is CSS `:hover` — a state the browser derives from real pointer input,
   not from dispatched events — the writer does not fake a hover: it locates the
   mounted popover and reveals it with inline `!important` styles, all of which are
   reverted right after the row click. Older builds instead open a
   `[role="dialog"]` titled *Save to collection* from a bookmark click, and those
   still work through the same ladder.
4. **Collection rows** are matched by normalised visible text: `study tips` and
   `study_tips` are treated as the same name, exact match preferred over a
   prefix match, and the deepest matching element wins so a wrapper containing
   several names can never be mistaken for a row.
5. **Selection state** is read from `input[type="checkbox"].checked`,
   `aria-checked` / `aria-selected` / `aria-pressed`, or a checkmark icon inside
   the row. The icon is only believed when the rows **disagree** — some show it,
   some do not — because some builds put an unchecked checkbox-looking icon in
   every row, and a mark that is always there proves nothing. If no signal is
   readable the writer still clicks, then reports `collection_state_unverifiable`
   (and marks the post *unconfirmed*) rather than silently guessing. The method
   used is recorded per post as `writeTrace.selectionSignal`.
6. **Creating a collection**: the *New collection* button opens a text input
   (found via a `collection` placeholder/`aria-label`, else the last text input),
   the name is typed with a React-compatible native value setter, then confirmed
   with a *Next / Create / Done* button, or Enter as a fallback.
7. **Post pages render** the bookmark icon within ~12 s of `load`
   (`document.readyState === "complete"` + a ~1.5 s hydration settle).
   Post pages are opened as `https://www.instagram.com/<p|reel>/<shortcode>/` so
   reels keep working.
8. **Thumbnail URLs are signed and expire.** Classify soon after collecting. If a
   URL has expired, the worker marks the post `thumbnail_expired` and skips it;
   scroll the Saved page again while *Collecting* is active and the refreshed URL
   is picked up automatically (a re-scroll also clears that error).

---

## 8. Known limits & troubleshooting

### Start here: the Diagnose button

**Diagnose state** in the popup inspects the pipeline and prints a plan. It runs
one real request, then reports:

* provider, endpoint, model, and whether a key is stored **for that provider**;
* whether the endpoint's host is allowed by `manifest.json` — this is what catches
  a custom endpoint Chrome would otherwise block silently;
* whether a stored thumbnail still downloads from Instagram's CDN, checked
  **separately** from the provider (expired signed links are the usual cause of
  "classification is broken" when the provider is actually fine);
* whether the provider answers, with the model's raw reply;
* counts for collected / classified / sorted / failed, including which stage
  failures came from;
* whether the content script is alive in your Instagram tabs (a reloaded
  extension leaves a stale, dead one behind) and whether a Saved page is even open;
* **what the collector can actually see on the page you have open** — how many
  links there are, how many parse as a post, how many contain an image, and the
  raw `href` values. This is the part that explains "45 tiles on screen, 0
  recorded" instead of leaving you to guess;
* the current or last run, the dry-run toggle, and recent errors.

It ends with a numbered **what to do next** list and a **Copy** button, so you can
see the state without opening a console. Nothing is changed by diagnosing.

The report is a single panel, not an ever-growing feed: **×** next to Copy hides
it, and it stays hidden across popup refreshes until a *new* diagnosis runs. A
re-run whose findings are unchanged (same checks and next steps, allowing for
latency drift) is tagged *unchanged since last run* in the report's header line
rather than presented as fresh output. Dismissing hides only the panel — the
stored report is kept, so Copy in a later session still works and **Diagnose
state** always produces a new one.


| Symptom | Cause / fix |
| --- | --- |
| `*_404` / model not found | The model name does not exist at that endpoint (providers rename models constantly). Fix the **Model** field — the error names the model and the base URL it tried. |
| `*_auth_401` / `403` | Bad or expired API key — re-save it in the popup and press Test. |
| `ollama_http_403` mentioning `Origin` | Ollama's CORS policy. Restart it with `OLLAMA_ORIGINS='chrome-extension://*'` (see section 3). |
| `*_rate_limited_429` | Free-tier **per-minute** limit. The refused post is **not** marked failed — it is re-queued for the same run and every request then waits out a shared ~65 s cool-down so the rest fit inside the next minute window, which is usually all a per-minute cap needs. If the provider still refuses 10 requests in a row the batch stops early rather than failing the rest of the library. |
| `*_quota_exhausted` | The provider's free quota is used up — a **per-day** cap, which waiting a minute will not fix. The batch aborts immediately (nothing already classified is lost, and untouched posts stay `collected` for a later run). Either wait for the reset and re-run, or switch provider — **Ollama is unmetered**, which is what makes it the right answer for a large library. |
| `*_no_vision` | That model cannot accept images. Pick a vision-capable model (the Test button tells you before a batch runs). |
| `*_truncated` | A thinking model spent the whole output budget on reasoning before finishing the JSON. The extension already retries with 4× the budget automatically; if it still happens, choose a non-thinking model or raise `MAX_OUTPUT_TOKENS` in `background.js`. |
| `classification_not_json: … got: …` | The reply was not usable JSON — the error quotes what the model actually sent, check it in the Test line or the log. Usually it is prose instead of JSON, or output cut off mid-object; try another model. |
| Warnings `category_recovered_from_partial_json` / `category_inferred_from_text` | The JSON was damaged or never emitted, so the category was salvaged from the model's own text at confidence 0.3 instead of failing the post. Review those posts; they are listed in the log. |
| Many `timeout_waiting_for_save_icon` failures | Instagram throttled rendering in the hidden tab. Set `WRITE_TABS_ACTIVE = true` in `background.js` (tabs will steal focus while sorting). Confirm with a **dry run** first — its report names the step that fails and what the page exposes. |
| `instagram_login_required` | The background tab was redirected to `/accounts/…`; log in to Instagram in this profile and re-run. |
| `post_page_timeout` | Slow connection; raise `TAB_LOAD_TIMEOUT_MS` in `background.js`. |
| Run stops part-way with “Interrupted” | Chrome recycled the idle service worker. Nothing is lost — click the same button again; both phases skip completed work. |
| A few posts never appear in the popup | Their tiles never got an image (lazy-load edge case) or the CDN URL was already expired. Re-scroll the Saved page while collecting. A tile with no image is still recorded (with a null thumbnail) after a few retries, so it is not silently dropped. |
| I scrolled but nothing was collected | Look at the popup's **Collector:** line, or press **Diagnose state**. It distinguishes the five causes: no Instagram tab open; the content script missing from the tab (reload it with F5, and if it persists set the extension's **Site access** to *On all sites* under Details); the tab not being a Saved page; the grid not having rendered any tiles yet; or the tiles existing but their links no longer looking like post addresses. |
| Diagnosis says *“45 link(s) on the page, but none is a post address”* | Instagram changed the shape of the links in the saved grid, so the collector cannot tell which posts the tiles belong to. The report prints the actual `href` values and the first tile's markup — paste that back and the link pattern in `parsePostHref` (`content-scripts/collector.js`) needs one more case. The collector already accepts any anchor whose href contains `/p/`, `/reel/`, `/reels/` or `/tv/` **anywhere** in the path, so this only triggers when the grid stops putting a post address in the link at all. |
| Diagnosis says *“N post(s) found but no thumbnail could be read”* | The tiles are readable but their images had not loaded yet. Thumbnails are recorded as soon as an image appears, so keep scrolling; if it stays at 0, the report's *first tile markup* shows what replaced the `<img>`. |
| Sorting stops early: *"every attempt failed at the same step"* | A circuit breaker: several posts in a row failed identically, so the page flow itself is broken and continuing would only churn. The remaining posts stay unsorted and retry on the next run — fix the cause first (the row above, or a dry run). |
| `save_panel_unreachable (…)` | No route could open the *Save to collection* picker. The error's parenthesised list names **each route that was tried and why it died** — `bookmark hover: timeout_waiting_for_collections_popover_on_hover` means hovering produced no popover, `reveal mounted popover: no mounted Collections popover in the DOM` means there was no popover to reveal, and the plain-language hint after the parenthesised list says whether one exists but could not be made visible. On current builds the picker for an already-saved post is a **CSS-hover popover** (a "Collections" list above the bookmark) that is mounted but hidden; the writer reveals it rather than hovering, and clicks the bookmark only for a post that is not in your library yet. Open a post, hover its bookmark yourself, then press **Inspect the tab I'm on** — the report shows every rung of the panel-detection ladder and the row inventory, and `writeTrace` on each post records which route/strategy won (`panelRevealed`, `openedViaHover`, or a click strategy). |
| **It said "Sorted" but my collection is still empty** | Check the Status card's *unconfirmed* line and the run summary (`Sorted 20/20 - 4 unverified`). It means the writer clicked but could not read the collection's state back, so it is no longer counted as proven. `writeTrace.selectionSignal` on each post names the signal that was available (or that none was). To retry those, tick **Re-sort posts that were never confirmed** and press the sort button again — posts that WERE confirmed are still skipped, so nothing gets toggled back out. To find out why they failed, run the **dry run**, or open a post, click its bookmark yourself and press **Inspect the tab I'm on**: the report's *category map* says whether a row for each category is found, and `writeTrace.rowSelector` on each post names the element that was clicked. |
| Warning `collection_state_unverifiable` | The picker's rows expose no `input[type=checkbox]`, no `aria-checked` and no checkmark that differs between rows, so selection cannot be confirmed even though the click was dispatched. The post is marked written but flagged; `writeTrace.selectionSignal` says what was (not) found, and `writeTrace.rowSelector` names the element that was clicked. Open a post, hover its bookmark yourself and press **Inspect the tab I'm on**: the report prints each row plus the selection signal it can read, which is what a build exposing something new will show. |
| Warning `post_was_unsaved_and_restored` | A bookmark click toggled the post OUT of the saved library during the run and the writer clicked again to put it back (a collection on an unsaved post is meaningless). The write itself succeeded. This should not happen on the current build — the bookmark is only clicked for a post that is *not* in your library. If it appears on every post, run a **dry run** and send the `1b`/`1c` lines. |
| Warning `collection_created_unconfirmed` | The create-a-collection flow ran but the picker did not list the new row afterwards, so the creation may not have committed. Pre-creating the collections yourself avoids this path entirely (see Step 3). |

Notes on scale: classification is 3 concurrent requests, so ~1000 posts is a long
but unattended job; write-back is deliberately slow (2–4 s per post) because that
is what keeps the account safe. A run of 500 posts takes roughly 25–40 minutes
including the long pauses.

---

## 9. Privacy

* API keys are stored in `chrome.storage.local` for this Chrome profile only
  (`chrome.storage.sync` is deliberately not used). Anyone with access to your
  Chrome profile directory can read them — treat them like any locally saved
  secret.
* Instagram credentials are never requested, read, logged or transmitted.
* Only post thumbnails and the category list are sent to the provider you chose.
  No profile data, no cookies, no usernames.
* Choosing **Ollama** means the images never leave your computer at all, which is
  the only option here with zero third-party exposure.
* Google's free tier may use submitted content to improve their products; paid
  tiers and Ollama do not. That is a real trade-off for using the free tier.
* Nothing is sent anywhere else; there is no analytics or third-party script.
