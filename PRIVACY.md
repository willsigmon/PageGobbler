# PageGobbler — Privacy Policy

**Last updated:** March 7, 2026

## What PageGobbler Does

PageGobbler is a Chrome extension that captures full-page screenshots. It scrolls through the current tab, stitches viewport captures together, and extracts page metadata (title, headings, links, text content).

## Data Collection

PageGobbler does **not** collect, transmit, or store any personal data.

- **No analytics or tracking** — zero telemetry, no usage metrics.
- **No external servers** — all processing happens locally in your browser.
- **No accounts or sign-in** required.
- **No cookies** set by the extension.

## What Data Is Processed Locally

When you explicitly trigger a capture, the extension temporarily holds:

- Screenshots of the page you chose to capture
- Page metadata (URL, title, headings, meta tags, links)
- Visible text content from the page DOM
- Console log output generated during the capture

This data exists only in browser memory for the duration of the viewer session. It is not saved to disk unless you explicitly download the results.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Access the current tab to capture its content when you click the extension icon |
| `scripting` | Inject the capture script into the page to scroll and measure it |
| `storage` | Save your extension settings (compression, quality, etc.) locally |

## Third-Party Services

PageGobbler communicates with **zero** third-party services. Everything runs locally.

## Changes

If this policy changes, the update will be reflected here with a new date.

## Contact

For questions about this policy, open an issue at the project's GitHub repository.
