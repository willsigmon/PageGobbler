# PageGobbler — Handoff (October 12, 2026)

## What this is
Chrome MV3 extension (vanilla JS, no build step) that captures full-page screenshots with smart compression and section splitting, plus page text, clean Markdown (`page.md`), metadata, design tokens, an AI brief, and a ZIP export.

## Current state
Code is ready for Chrome Web Store submission. Version in `manifest.json` is still 2.1.3; the owner sets versions. The Chrome Web Store listing is pending (not submitted yet).

### What changed on October 12
- **Store images are ready.** Five 1280x800 screenshots (popup, viewer, Markdown tab, AI Brief tab, settings) and the 440x280 promo tile were regenerated from the real extension UI with the Aug 14 design. `scripts/store-screenshots.mjs` rebuilds them after any UI change. The old pre-redesign screenshots were removed so they can't be uploaded by mistake.
- **Merged with the Markdown export** (PR #2) so the store build includes `page.md`. The listing copy and PRIVACY.md mention it.
- **A full store no longer blocks new captures.** If saving hits the storage quota, the oldest earlier captures are deleted one at a time until the new one fits. The most recent earlier capture is always kept, so the store is never emptied.

### What changed on September 23
- **Captures survive the service worker stopping.** Finished captures used to live in a worker variable with a 10-minute timer, so reloading the results page after Chrome idled the worker showed "No capture data found." They are now saved to the extension's IndexedDB (`lib/capture-store.js`), and the viewer opens as `viewer.html?id=<captureId>` and reads the capture directly from there (no id: latest capture). Viewports are stored as PNG Blobs, not one big runtime message.
- **Automatic pruning:** keep the newest 5 captures plus anything under 24 hours, 20 at most. Runs on worker startup and after each save (no timers).
- **Console capture is real now.** The old wrapper ran in the content script's isolated world and never saw the page's own `console.log`. The worker now injects a temporary hook into the page's MAIN world (`chrome.scripting.executeScript` with `world: 'MAIN'`). It relays entries to the content script over `window.postMessage` on a per-capture token and restores the page's console when the capture ends (or after 5 minutes if a capture is abandoned). The README's `console.log` promise is now accurate.
- **Packaging:** `./scripts/package.sh` builds `dist/PageGobbler-v<version>.zip` with runtime files only. `dist/` is git-ignored.
- **Tests:** `node tests/e2e.mjs` (Playwright/Chromium: capture, sections, console capture, ZIP contents, survives a stopped service worker) and `node --test 'tests/unit/*.test.mjs'` (retention helpers). See README > Development.
- **Docs:** README (listing pending, Development section), PRIVACY.md (captures kept locally in IndexedDB and pruned automatically), STORE_LISTING.md (privacy-practices answers and an honest checklist).

No permissions were added: still `activeTab`, `scripting`, `storage`. IndexedDB needs no permission.

## What the owner must do to submit
1. Merge this branch to `main` so the hosted PRIVACY.md link (used as the store's privacy policy URL) shows the new local-storage wording.
2. Decide the version (manifest.json is 2.1.3), then run `./scripts/package.sh`.
3. Optional sanity check: `node tests/e2e.mjs --from-package`.
4. Register a Chrome Web Store developer account ($5 one-time): https://chrome.google.com/webstore/devconsole
5. Upload `dist/PageGobbler-v<version>.zip`.
6. Fill in the listing from `store-assets/STORE_LISTING.md`.
7. Fill in the **Privacy practices** tab: single purpose, justifications for `activeTab`, `scripting` (now also mentions the temporary page-console hook) and `storage`, remote code "No", data usage (nothing transmitted; captures stay on the device). Suggested wording is in STORE_LISTING.md.
8. Upload the five `store-assets/screenshot-*-1280x800.png` files in numbered order, plus `promo-small-440x280.png`.
9. Submit for review.

## What's next (after submission)
- Firefox port (manifest differences, `world: 'MAIN'` support)
- Infinite-scroll / lazy feeds: scroll-and-stitch can still miss content that needs interaction
- Optional: a "recent captures" list in the viewer, since captures are now stored
