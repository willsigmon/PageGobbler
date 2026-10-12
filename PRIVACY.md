# PageGobbler — Privacy Policy

**Last updated:** September 23, 2026

## What PageGobbler Does

PageGobbler is a Chrome extension that captures full-page screenshots. It scrolls through the current tab, stitches viewport captures together, and extracts page metadata (title, headings, links, text content).

## Data Collection

PageGobbler does **not** collect or transmit any personal data. The only things it keeps are your settings and your own recent captures, both stored locally on your device (see below).

- **No analytics or tracking** — zero telemetry, no usage metrics.
- **No external servers** — all processing happens locally in your browser.
- **No accounts or sign-in** required.
- **No cookies** set by the extension.

## What Data Is Processed Locally

Only when you explicitly trigger a capture, the extension processes:

- Screenshots of the page you chose to capture
- Page metadata (URL, title, headings, meta tags, links)
- Visible text content from the page DOM
- An optional AI-ready Markdown brief generated locally from the capture
- A clean Markdown copy of the page's main content (`page.md`), distilled locally from the page DOM
- Console output the page itself logs while it is being captured (`console.*` calls, uncaught errors, unhandled promise rejections). The console hook is added only for the duration of the capture and removed when it ends.

## Where Captures Are Kept

- Finished captures are saved on your device in the extension's own IndexedDB storage, so the results page can be reopened or reloaded. This storage belongs to the extension, is not synced to your Google account, and is not readable by websites.
- Old captures are deleted automatically: PageGobbler keeps your 5 most recent captures plus any made in the last 24 hours (never more than 20), and prunes the rest whenever it starts up and after each new capture.
- Removing the extension deletes all stored captures.
- Captures are never transmitted anywhere. Files leave the extension only when you download them or copy text to your clipboard.
- Settings (compression, quality, and similar options) are saved with `chrome.storage.local` on your device.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Access the current tab to capture its content when you click the extension icon |
| `scripting` | Inject the capture script into the page to scroll and measure it, plus a temporary console hook that records what the page logs during the capture |
| `storage` | Save your extension settings (compression, quality, etc.) locally |

Stored captures use the extension's IndexedDB, which needs no extra permission.

## Third-Party Services

PageGobbler communicates with **zero** third-party services. Everything runs locally.

## Changes

If this policy changes, the update will be reflected here with a new date.

## Contact

For questions about this policy, open an issue at the project's GitHub repository.
