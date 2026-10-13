#!/usr/bin/env node
/**
 * Regenerate the Chrome Web Store images from the real extension UI.
 *
 *   xvfb-run -a node scripts/store-screenshots.mjs
 *
 * Loads the extension in Chromium, captures store-assets/demo-page.html with
 * it, and writes into store-assets/:
 *   screenshot-1-popup-1280x800.png     popup over the demo page
 *   screenshot-2-viewer-1280x800.png    viewer after a capture (Page Info)
 *   screenshot-3-markdown-1280x800.png  viewer on the Markdown tab (page.md)
 *   screenshot-4-brief-1280x800.png     viewer on the AI Brief tab
 *   screenshot-5-settings-1280x800.png  popup with settings expanded
 *   promo-small-440x280.png             rendered from promo-tile-440x280.html
 *
 * Like tests/e2e.mjs, it works on a temp copy of the extension that adds
 * host_permissions (automation cannot grant activeTab) and exposes popup/ as a
 * web-accessible resource so the real popup can be framed over the page.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'store-assets');
const RUNTIME_PATHS = ['manifest.json', 'background.js', 'content', 'lib', 'popup', 'viewer', 'ui', 'icons'];
const VIEWPORT = { width: 1280, height: 800 };
const POPUP_MAX_HEIGHT = 600; // Chrome caps action popups at 600px tall
const TIMEOUT_MS = 90_000;

function loadPlaywright() {
  const candidates = ['playwright', process.env.PLAYWRIGHT_PATH, '/opt/node22/lib/node_modules/playwright',
    '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (_) { /* try the next one */ }
  }
  throw new Error('Playwright not found. Install it globally or set PLAYWRIGHT_PATH.');
}

function prepareExtension(workDir) {
  const extDir = path.join(workDir, 'extension');
  for (const entry of RUNTIME_PATHS) {
    fs.cpSync(path.join(ROOT, entry), path.join(extDir, entry), { recursive: true });
  }
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  manifest.web_accessible_resources = [{ resources: ['popup/*', 'ui/*', 'icons/*'], matches: ['<all_urls>'] }];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return extDir;
}

function startServer() {
  const html = fs.readFileSync(path.join(ASSETS, 'demo-page.html'));
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Frame the real popup over the page, anchored top-right like Chrome's action popup.
async function showPopup(page, popupUrl, { expandSettings = false } = {}) {
  await page.evaluate((src) => {
    document.getElementById('pg-popup')?.remove();
    const frame = document.createElement('iframe');
    frame.id = 'pg-popup';
    frame.src = src;
    Object.assign(frame.style, {
      position: 'fixed', top: '10px', right: '16px', width: '340px', height: '200px', border: '0',
      borderRadius: '8px', zIndex: 2147483647, background: 'transparent',
      boxShadow: '0 12px 40px oklch(20% 0.02 50 / 0.35), 0 0 0 1px oklch(20% 0.02 50 / 0.12)',
    });
    document.body.appendChild(frame);
  }, popupUrl);
  const handle = await page.waitForSelector('#pg-popup');
  const frame = await handle.contentFrame();
  await frame.waitForLoadState('load');
  // Let popup.js fill in the active tab and settings.
  await frame.waitForFunction(() => document.getElementById('page-status-word')?.textContent !== 'Checking');
  await page.waitForTimeout(300);
  if (expandSettings) {
    await frame.click('#settings-toggle');
    await frame.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  }
  const height = await frame.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
  await page.evaluate((h) => { document.getElementById('pg-popup').style.height = `${h}px`; },
    Math.min(height, POPUP_MAX_HEIGHT));
  await page.waitForTimeout(200);
}

// Resize the window so the page content area (what captureVisibleTab grabs) is
// exactly VIEWPORT; the window size flag includes the browser's own toolbar.
async function fitWindowContent(page) {
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    if (w === VIEWPORT.width && h === VIEWPORT.height) return;
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: bounds.width + VIEWPORT.width - w, height: bounds.height + VIEWPORT.height - h },
    });
    await page.waitForTimeout(300);
  }
  const size = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
  throw new Error(`Window content is ${size}, expected ${VIEWPORT.width}x${VIEWPORT.height}`);
}

async function main() {
  const { chromium } = loadPlaywright();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagegobbler-shots-'));
  const extDir = prepareExtension(workDir);
  const server = await startServer();
  const pageUrl = `http://127.0.0.1:${server.address().port}/field-notes-on-slow-bread`;
  const out = (name) => path.join(ASSETS, name);
  let context;

  try {
    context = await chromium.launchPersistentContext(path.join(workDir, 'profile'), {
      headless: true,
      channel: 'chromium',
      // No viewport emulation: captureVisibleTab grabs the real window, and an
      // emulated viewport of a different size leaves a dark seam in the stitch.
      viewport: null,
      args: [`--window-size=${VIEWPORT.width},${VIEWPORT.height}`, '--force-device-scale-factor=1',
        `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });

    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: TIMEOUT_MS });
    const extUrl = (p) => `chrome-extension://${new URL(worker.url()).host}/${p}`;

    const page = await context.newPage();
    await page.goto(pageUrl);
    await page.bringToFront();
    await fitWindowContent(page);

    await showPopup(page, extUrl('popup/popup.html'));
    await page.screenshot({ path: out('screenshot-1-popup-1280x800.png') });

    await showPopup(page, extUrl('popup/popup.html'), { expandSettings: true });
    await page.screenshot({ path: out('screenshot-5-settings-1280x800.png') });

    await page.evaluate(() => document.getElementById('pg-popup')?.remove());

    // Run a real capture the same way the popup does.
    const viewerPromise = context.waitForEvent('page', {
      predicate: (p) => p.url().includes('/viewer/viewer.html'),
      timeout: TIMEOUT_MS,
    });
    const driver = await context.newPage();
    await driver.goto(extUrl('popup/popup.html'));
    const start = await driver.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: `${url}*` });
      await chrome.tabs.update(tab.id, { active: true });
      return chrome.runtime.sendMessage({ action: 'start-capture', tabId: tab.id });
    }, pageUrl);
    if (!start?.ok) throw new Error(`Capture did not start: ${JSON.stringify(start)}`);
    await driver.close();

    const viewer = await viewerPromise;
    await viewer.waitForFunction(() => document.getElementById('status-bar')?.classList.contains('done'),
      null, { timeout: TIMEOUT_MS });
    await viewer.waitForLoadState('networkidle');
    await viewer.waitForTimeout(500);
    await viewer.screenshot({ path: out('screenshot-2-viewer-1280x800.png') });

    for (const [tab, name] of [['markdown', 'screenshot-3-markdown-1280x800.png'], ['brief', 'screenshot-4-brief-1280x800.png']]) {
      await viewer.click(`.tab[data-tab="${tab}"]`);
      await viewer.waitForTimeout(300);
      await viewer.screenshot({ path: out(name) });
    }

    const promo = await context.newPage();
    await promo.goto(`file://${path.join(ASSETS, 'promo-tile-440x280.html')}`);
    await promo.waitForTimeout(300);
    await promo.screenshot({ path: out('promo-small-440x280.png'), clip: { x: 0, y: 0, width: 440, height: 280 } });

    console.log('Wrote store-assets/screenshot-{1-popup,2-viewer,3-markdown,4-brief,5-settings}-1280x800.png and promo-small-440x280.png');
  } finally {
    await context?.close();
    server.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
