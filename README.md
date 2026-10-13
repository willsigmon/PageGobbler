# PageGobbler

A Chrome extension that gobbles up entire web pages — full-page screenshots with smart compression, section splitting, text extraction, and page context metadata.

## Features

- **Full-page scroll-and-stitch capture** — scrolls through the entire page, capturing each viewport and stitching into a single image
- **Smart compression** — iterative format/quality/scale reduction to hit a target file size (default 3 MB)
- **Smart section splitting** — breaks tall pages at natural visual boundaries (whitespace rows) into multiple images
- **Page text extraction** — extracts visible text content directly from the page DOM
- **Clean Markdown export** — distills the main content into GitHub Flavored Markdown (tables, code blocks, lists, absolute links) with tracking params, hidden elements, and invisible prompt-injection characters stripped
- **Page metadata** — collects URL, title, headings, meta tags, links, dimensions, and timestamps
- **Design tokens** — captures colors, fonts, and CSS custom properties
- **Structured data** — extracts JSON-LD, Open Graph, and Twitter Card data
- **Viewer page** — dedicated results page with image preview, download controls, text, and metadata tabs
- **AI Brief** — one-click Markdown context pack for sending the capture to AI tools
- **Download ZIP** — batch download all sections + metadata JSON + text + styles + assets catalog
- **Capture presets** — Balanced, Fast, and Crisp modes for common quality/file-size tradeoffs
- **1-Click mode** — skip the popup, gobble immediately on icon click
- **Keyboard shortcut** — `Alt+Shift+G` to gobble the current page

## What It Captures

For each screenshot, PageGobbler produces a ZIP containing:

| Output | Description |
|--------|-------------|
| Image section(s) | Compressed WebP/JPEG/PNG, each under your size target |
| `metadata.json` | Page URL, title, headings, meta tags, dimensions, compression stats |
| `ai_brief.md` | AI-ready Markdown summary with source, structure, screenshot files, design tokens, links, and text excerpt |
| `page.md` | Main content as clean GitHub Flavored Markdown with YAML front matter |
| `page_text.txt` | Extracted visible text from the DOM |
| `dom_structure.html` | Semantic HTML skeleton of the page |
| `design_tokens.json` | Colors, fonts, CSS custom properties |
| `styles.css` | Collected stylesheets (inline + same-origin external) |
| `assets.json` | Image catalog (src, alt, dimensions) |
| `structured_data.json` | JSON-LD, Open Graph, Twitter Card data |
| `resources.json` | External scripts, stylesheets, fonts, preloads |
| `forms.json` | Form structure and field definitions |
| `links.json` | All links on the page |
| `console.log` | What the page itself logged (`console.*`, uncaught errors, unhandled rejections) while it was being captured |

## Install

### Chrome Web Store

Chrome Web Store listing pending. Until it is published, install it in Developer Mode below.

### Developer Mode

1. Clone or download this repository
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked** and select the repo folder
5. The turkey icon appears in your toolbar

## Usage

1. Navigate to any webpage
2. Click the turkey icon in the toolbar (or press `Alt+Shift+G`)
3. (Optional) Expand **Settings** to configure:
   - **Presets** — Balanced, Fast, or Crisp defaults
   - **Max File Size** — target per-section limit (default 3 MB)
   - **Compression** — Auto (WebP then JPEG), Aggressive, or Lossless (PNG)
   - **Section Max Height** — pixel height before splitting (default 4096)
   - **Extract Page Text** — enable/disable DOM text extraction
   - **Smart Sections** — enable/disable automatic splitting
   - **Quality** — base quality slider (0.30–1.00)
   - **1-Click Gobble** — skip popup, capture on icon click
4. Click **Gobble This Page**
5. The viewer page opens automatically with results

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Access the current tab to capture its content when you click the extension |
| `scripting` | Inject the capture script into the page to scroll and measure it, plus a temporary console hook (in the page's own context) that records what the page logs during the capture and is removed when the capture ends |
| `storage` | Save your settings (compression, quality, etc.) locally |

Finished captures are kept on your device in the extension's own IndexedDB so the results page can be reloaded (even after Chrome stops the extension's background worker). The newest 5 captures are kept, plus any from the last 24 hours (20 at most); older ones are deleted automatically. No data is sent to any external server. Everything runs locally in your browser.

## Architecture

```
manifest.json (Manifest V3)
|
+-- background.js          -- Service worker: capture orchestration, rate limiting,
|                             saving captures, MAIN-world console hook
+-- content/content.js     -- Injected on demand: scrolling, measurement, metadata,
|                             collects relayed console entries
+-- lib/
|   +-- capture-store.js   -- IndexedDB store for finished captures (worker + viewer)
|   +-- image-processor.js -- Canvas stitching, compression, smart sectioning
|   +-- page-markdown.js   -- DOM-to-Markdown distiller (injected with content.js)
+-- popup/
|   +-- popup.html/css/js  -- Extension popup with capture button + settings
+-- viewer/
|   +-- viewer.html/css/js -- Results page: image preview, text, metadata, downloads
+-- icons/
|   +-- icon{16,32,48,128}.png, turkey-32.svg
+-- scripts/package.sh     -- Builds the Chrome Web Store zip into dist/
+-- tests/                 -- e2e.mjs (Playwright) and unit/ (node:test)
```

## Development

There is no build step: the repo folder is the extension. `npm install` only pulls dev tooling (jsdom for the Markdown unit tests). Load it unpacked (see Install) and reload it from `chrome://extensions/` after changes.

```bash
# Syntax-check every script
for f in $(git ls-files '*.js' '*.mjs'); do node --check "$f"; done

# Unit tests (Node 22+; the Markdown tests need `npm install` for jsdom)
npm test

# End-to-end test: loads a temp copy of the extension in Playwright's Chromium,
# gobbles a tall local page, checks sections, console capture, the ZIP export,
# and that the capture survives a stopped service worker. Exits non-zero on failure.
node tests/e2e.mjs
node tests/e2e.mjs --from-package   # same checks against the unzipped dist zip
node tests/e2e-markdown.mjs         # page.md export end to end

# Regenerate the Chrome Web Store screenshots and promo tile from the real UI
xvfb-run -a node scripts/store-screenshots.mjs

# Build the Chrome Web Store upload: dist/PageGobbler-v<version>.zip
./scripts/package.sh
```

The e2e test needs Playwright with its Chromium build. It uses `playwright` from `node_modules` if present, otherwise `$PLAYWRIGHT_PATH` or a global install (`npm i -g playwright && npx playwright install chromium`). Because automation cannot grant `activeTab`, the test adds `host_permissions: ["<all_urls>"]` to its temporary copy only; the shipped manifest is unchanged.

## Limitations

- Cannot capture `chrome://` or other extension pages
- Chrome's canvas max size is ~32,767 x 32,767 px (very tall pages may hit this)
- `captureVisibleTab` is limited to 2 calls/second — a 20-viewport page takes ~10 seconds minimum
- Lazy-loaded content may not be fully rendered if it requires user interaction beyond scrolling

## Privacy

PageGobbler collects **zero** user data. No analytics, no tracking, no external servers. Captures stay on your device and are pruned automatically. See [PRIVACY.md](PRIVACY.md) for details.
