# PageGobbler

A Chrome extension that gobbles up entire web pages — full-page screenshots with smart compression, section splitting, text extraction, and page context metadata.

## Features

- **Full-page scroll-and-stitch capture** — scrolls through the entire page, capturing each viewport and stitching into a single image
- **Smart compression** — iterative format/quality/scale reduction to hit a target file size (default 3 MB)
- **Smart section splitting** — breaks tall pages at natural visual boundaries (whitespace rows) into multiple images
- **Page text extraction** — extracts visible text content directly from the page DOM
- **Page metadata** — collects URL, title, headings, meta tags, links, dimensions, and timestamps
- **Design tokens** — captures colors, fonts, and CSS custom properties
- **Structured data** — extracts JSON-LD, Open Graph, and Twitter Card data
- **Viewer page** — dedicated results page with image preview, download controls, text, and metadata tabs
- **Download ZIP** — batch download all sections + metadata JSON + text + styles + assets catalog
- **1-Click mode** — skip the popup, gobble immediately on icon click
- **Keyboard shortcut** — `Alt+Shift+G` to gobble the current page

## What It Captures

For each screenshot, PageGobbler produces a ZIP containing:

| Output | Description |
|--------|-------------|
| Image section(s) | Compressed WebP/JPEG/PNG, each under your size target |
| `metadata.json` | Page URL, title, headings, meta tags, dimensions, compression stats |
| `page_text.txt` | Extracted visible text from the DOM |
| `dom_structure.html` | Semantic HTML skeleton of the page |
| `design_tokens.json` | Colors, fonts, CSS custom properties |
| `styles.css` | Collected stylesheets (inline + same-origin external) |
| `assets.json` | Image catalog (src, alt, dimensions) |
| `structured_data.json` | JSON-LD, Open Graph, Twitter Card data |
| `resources.json` | External scripts, stylesheets, fonts, preloads |
| `forms.json` | Form structure and field definitions |
| `links.json` | All links on the page |
| `console.log` | Console output captured during the screenshot |

## Install

### Chrome Web Store

Install from the [Chrome Web Store](https://chromewebstore.google.com/) (link coming soon).

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
| `scripting` | Inject the capture script into the page to scroll and measure it |
| `storage` | Save your settings (compression, quality, etc.) locally |

No data is sent to any external server. Everything runs locally in your browser.

## Architecture

```
manifest.json (Manifest V3)
|
+-- background.js          -- Service worker: capture orchestration, rate limiting
+-- content/content.js     -- Injected on demand: scrolling, measurement, metadata
+-- lib/
|   +-- image-processor.js -- Canvas stitching, compression, smart sectioning
+-- popup/
|   +-- popup.html/css/js  -- Extension popup with capture button + settings
+-- viewer/
|   +-- viewer.html/css/js -- Results page: image preview, text, metadata, downloads
+-- progress/
|   +-- progress.html/css/js -- Capture progress overlay
+-- icons/
    +-- icon{16,32,48,128}.png
```

## Limitations

- Cannot capture `chrome://` or other extension pages
- Chrome's canvas max size is ~32,767 x 32,767 px (very tall pages may hit this)
- `captureVisibleTab` is limited to 2 calls/second — a 20-viewport page takes ~10 seconds minimum
- Lazy-loaded content may not be fully rendered if it requires user interaction beyond scrolling

## Privacy

PageGobbler collects **zero** user data. No analytics, no tracking, no external servers. See [PRIVACY.md](PRIVACY.md) for details.
