# Chrome Web Store Listing — PageGobbler

## Short Name
PageGobbler

## Summary (132 char max)
Gobble full pages into screenshots, clean Markdown, AI briefs, text, design tokens, and metadata in one local ZIP.

## Description (for store listing)

PageGobbler captures entire web pages in one click — not just what's visible, but everything from top to bottom, stitched into a single image.

But screenshots are just the beginning. PageGobbler reverse-engineers the full page into a structured ZIP containing:

★ FULL-PAGE SCREENSHOTS
• Scroll-and-stitch capture of the entire page
• Smart compression — iteratively reduces format/quality/scale to hit your target file size
• Smart section splitting — breaks tall pages at natural visual boundaries
• Supports WebP, JPEG, and PNG output
• Capture presets for fast, balanced, or high-detail output

★ COMPLETE PAGE EXTRACTION
• Clean Markdown — the page's main content as GitHub Flavored Markdown (page.md), with tables, code blocks, and links kept and trackers stripped
• AI Brief — Markdown context pack ready to paste into AI tools
• Page text — all visible text from the DOM
• Metadata — URL, title, headings, meta tags, dimensions, timestamps
• Design tokens — colors, fonts, CSS custom properties
• Structured data — JSON-LD, Open Graph, Twitter Card
• DOM structure — semantic HTML skeleton
• Stylesheets — inline and same-origin external CSS
• Asset catalog — every image with src, alt text, and dimensions
• External resources — scripts, fonts, preloads
• Form definitions — field types, names, and structure
• Links — every link on the page
• Console output — what the page itself logged while it was being captured

★ EASY TO USE
• One click to capture any page
• 1-Click mode — skip the popup entirely
• Keyboard shortcut (Alt+Shift+G)
• Built-in viewer with image preview, text, and metadata tabs
• Copy or download the AI Brief from the results page
• Download everything as a single ZIP

★ PRIVACY FIRST
• Zero data collection — no analytics, no tracking, no telemetry
• No external servers — everything runs locally in your browser
• Recent captures stay on your device and are cleared automatically
• No accounts or sign-in required

Perfect for designers, developers, researchers, archivists, and anyone who needs more than just a screenshot.

## Category
Developer Tools

## Language
English

## Privacy Policy URL
https://github.com/willsigmon/PageGobbler/blob/main/PRIVACY.md

## Homepage URL
https://github.com/willsigmon/PageGobbler

## Support URL
https://github.com/willsigmon/PageGobbler/issues

---

## Privacy Practices Tab (developer dashboard)

Suggested answers; the owner confirms them when filling in the form.

**Single purpose:** Capture the current web page as full-page screenshots plus the page's text, metadata, and design context, and let the user download them.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `activeTab` | Capture only the tab the user clicked the toolbar icon (or pressed Alt+Shift+G) on, with `chrome.tabs.captureVisibleTab`, and inject the capture script into it. No access to other tabs or background browsing. |
| `scripting` | Inject the on-demand content script that scrolls and measures the page and reads its text/metadata, and a temporary hook in the page context that records the page's own console output during the capture and removes itself afterwards. |
| `storage` | Save the user's capture settings (size target, compression, quality, 1-click mode) with `chrome.storage.local`. |

**Remote code:** No. All code ships in the package; nothing is fetched or evaluated at runtime.

**Data usage:** Captures (screenshots, page text, Markdown, metadata, console output) are processed and kept only on the user's device, in the extension's IndexedDB, and pruned automatically (newest 5 plus anything under 24 hours, 20 at most). Nothing is sent to the developer or any third party, nothing is sold, and nothing is used for purposes unrelated to the single purpose. The data-type checkboxes cover data *collected*, meaning transmitted off the device; PageGobbler transmits nothing, so the expected answer is none ticked. If a reviewer asks, "website content" is handled locally only. Tick the three certification boxes.

**Privacy policy URL:** the PRIVACY.md link above. It must be on `main` (merge this branch first) so the hosted policy mentions local capture storage.

---

## Screenshot Requirements

Chrome Web Store requires **1280x800** or **640x400** pixels exactly, up to 5 screenshots.

Ready to upload, in this order (all 1280x800, Aug 14 design, generated from the real extension UI by `scripts/store-screenshots.mjs`):

| # | File | Shows |
|---|------|-------|
| 1 | `screenshot-1-popup-1280x800.png` | Popup over a long-read article, ready to gobble |
| 2 | `screenshot-2-viewer-1280x800.png` | Results page: stitched sections, summary strip, page info |
| 3 | `screenshot-3-markdown-1280x800.png` | Markdown tab with the page.md front matter and body |
| 4 | `screenshot-4-brief-1280x800.png` | AI Brief tab |
| 5 | `screenshot-5-settings-1280x800.png` | Popup with presets and settings expanded |

The captured page is `demo-page.html`, a fictional magazine article made for these shots (no real brand or person). The 127.0.0.1 address in the popup and viewer is the local test server the script uses.

To regenerate after a UI change:

```bash
xvfb-run -a node scripts/store-screenshots.mjs
```

---

## Promotional Images (Optional but recommended)

| Asset | Size | Status |
|-------|------|--------|
| Small promo tile | 440x280 | Ready: `promo-small-440x280.png`, rendered from `promo-tile-440x280.html` by the same script |
| Large promo tile | 920x680 | Not made (optional) |
| Marquee promo | 1400x560 | Not made (optional) |

---

## Submission Checklist

Done in the repo:
- [x] manifest.json is Manifest V3, no new permissions (activeTab, scripting, storage)
- [x] Packaging script: `./scripts/package.sh` builds `dist/PageGobbler-v<version>.zip` (runtime files only; `dist/` is git-ignored, so build it fresh)
- [x] Packaged zip passes the e2e test: `node tests/e2e.mjs --from-package`
- [x] Privacy policy written (PRIVACY.md) and store description written (this doc)
- [x] Five 1280x800 screenshots and the 440x280 promo tile regenerated with the Aug 14 design and the Markdown tab

Owner still has to do:
- [ ] Merge to `main` so the hosted PRIVACY.md link shows the current policy
- [ ] Set the version in manifest.json if this upload needs a new one (currently 2.1.3), then run `./scripts/package.sh`
- [ ] Chrome Developer account ($5 one-time), https://chrome.google.com/webstore/devconsole
- [ ] Upload `dist/PageGobbler-v<version>.zip` to the developer console
- [ ] Fill in listing details from this doc (summary, description, category, URLs) and upload the 5 screenshots and promo tile from `store-assets/`
- [ ] Fill in the Privacy practices tab (single purpose, activeTab/scripting/storage justifications, remote code: no, data usage)
- [ ] Submit for review (usually a few business days)
