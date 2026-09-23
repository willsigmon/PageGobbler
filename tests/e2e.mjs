#!/usr/bin/env node
/**
 * PageGobbler end-to-end test (Playwright + Chromium, no npm install needed).
 *
 *   node tests/e2e.mjs                 # test the working tree
 *   node tests/e2e.mjs --from-package  # build dist zip, unzip it, test that
 *
 * What it checks:
 *   1. A capture of a tall local page reaches the viewer's done state with
 *      more than one section.
 *   2. console.log calls the page itself makes during the capture are stored
 *      with the capture and written to console.log in the ZIP export.
 *   3. The page's console methods are restored after the capture.
 *   4. After the service worker is stopped (CDP ServiceWorker.stopAllWorkers),
 *      reloading the viewer still loads the capture from IndexedDB, and
 *      viewer.html without an id falls back to the latest capture.
 *
 * Automation cannot grant activeTab, so the test copies the extension into a
 * temp directory and adds host_permissions: ["<all_urls>"] to that copy only.
 *
 * Playwright is resolved from node_modules, $PLAYWRIGHT_PATH, or the global
 * install at /opt/node22/lib/node_modules/playwright.
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_PATHS = ['manifest.json', 'background.js', 'content', 'lib', 'popup', 'viewer', 'ui', 'icons'];
const CONSOLE_MARKER = 'pagegobbler-e2e-marker';
const TIMEOUT_MS = 90_000;

const fromPackage = process.argv.includes('--from-package');
const keepTemp = process.argv.includes('--keep') || process.env.PG_E2E_KEEP === '1';

function loadPlaywright() {
  const candidates = ['playwright', process.env.PLAYWRIGHT_PATH, '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (_) { /* try the next one */ }
  }
  throw new Error('Playwright not found. Install it globally or set PLAYWRIGHT_PATH.');
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) throw new Error(`Assertion failed: ${name}${detail ? ` (${detail})` : ''}`);
}

function prepareExtension(workDir) {
  const extDir = path.join(workDir, 'extension');
  if (fromPackage) {
    const out = execFileSync(path.join(ROOT, 'scripts', 'package.sh'), { cwd: ROOT, encoding: 'utf8' });
    const zipPath = path.join(ROOT, out.match(/Built (\S+)/)[1]);
    fs.mkdirSync(extDir, { recursive: true });
    execFileSync('unzip', ['-q', zipPath, '-d', extDir]);
    console.log(`Testing packaged build: ${path.relative(ROOT, zipPath)}`);
  } else {
    for (const entry of RUNTIME_PATHS) {
      fs.cpSync(path.join(ROOT, entry), path.join(extDir, entry), { recursive: true });
    }
  }
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return extDir;
}

function tallPageHtml() {
  const blocks = Array.from({ length: 40 }, (_, i) =>
    `<h2 style="margin:0;height:200px;background:hsl(${i * 9},60%,70%)">Section ${i}</h2>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PageGobbler E2E Tall Page</title></head>
<body style="margin:0">${blocks}
<script>
  let logged = 0;
  window.addEventListener('scroll', () => {
    if (logged < 5) {
      logged += 1;
      console.log('${CONSOLE_MARKER} scroll', Math.round(window.scrollY));
    }
  });
</script></body></html>`;
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(tallPageHtml());
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitForViewerDone(viewer) {
  await viewer.waitForFunction(() => {
    const bar = document.getElementById('status-bar');
    return bar && (bar.classList.contains('done') || bar.classList.contains('error'));
  }, null, { timeout: TIMEOUT_MS });
  const status = (await viewer.textContent('#status-text')).trim();
  const isDone = await viewer.evaluate(() => document.getElementById('status-bar').classList.contains('done'));
  const sectionCards = await viewer.locator('.section-card').count();
  const statusSections = Number((status.match(/Done — (\d+) section/) || [])[1] || 0);
  return { status, isDone, sectionCards, statusSections };
}

function zipEntries(buffer) {
  // PageGobbler writes stored (uncompressed) ZIPs; walk the local headers.
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, buffer.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
}

async function main() {
  const { chromium } = loadPlaywright();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagegobbler-e2e-'));
  const extDir = prepareExtension(workDir);
  const server = await startServer();
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  let context;

  try {
    context = await chromium.launchPersistentContext(path.join(workDir, 'profile'), {
      headless: true,
      channel: 'chromium',
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });

    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: TIMEOUT_MS });
    const extensionId = new URL(worker.url()).host;
    const extUrl = (p) => `chrome-extension://${extensionId}/${p}`;

    const page = await context.newPage();
    await page.goto(pageUrl);

    // Drive the capture the same way the popup does.
    const popup = await context.newPage();
    await popup.goto(extUrl('popup/popup.html'));
    const viewerPromise = context.waitForEvent('page', {
      predicate: (p) => p.url().includes('/viewer/viewer.html'),
      timeout: TIMEOUT_MS,
    });
    const start = await popup.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: `${url}*` });
      await chrome.tabs.update(tab.id, { active: true });
      return chrome.runtime.sendMessage({ action: 'start-capture', tabId: tab.id });
    }, pageUrl);
    check('capture starts', start?.ok === true, JSON.stringify(start));

    const viewer = await viewerPromise;
    const captureId = new URL(viewer.url()).searchParams.get('id');
    check('viewer opens with a capture id', Boolean(captureId), viewer.url());

    const first = await waitForViewerDone(viewer);
    check('viewer reaches done state', first.isDone, first.status);
    check('capture has more than one section', first.statusSections > 1 && first.sectionCards > 1,
      `${first.statusSections} in status, ${first.sectionCards} cards`);

    // Stored record: blobs, not data URLs, and the page's own console output.
    const stored = await viewer.evaluate(async (id) => {
      const record = await globalThis.PageGobblerCaptureStore.getCapture(id);
      return {
        viewports: record.captures.length,
        blobs: record.captures.every((c) => c.blob instanceof Blob),
        consoleLogs: record.pageInfo.consoleLogs || [],
      };
    }, captureId);
    check('capture stored in IndexedDB as blobs', stored.viewports > 1 && stored.blobs, `${stored.viewports} viewports`);
    const pageLogs = stored.consoleLogs.filter((e) => e.level === 'log' && e.message.includes(CONSOLE_MARKER));
    check("page's console.log captured from the MAIN world", pageLogs.length > 0,
      `${stored.consoleLogs.length} entries, first: ${JSON.stringify(stored.consoleLogs[0] || null)}`);

    const restored = await page.evaluate(() => console.log.name !== 'pageGobblerConsole'
      && !Object.getOwnPropertySymbols(window).some((s) => s.description === 'pagegobbler.consoleHook'));
    check("page's console restored after capture", restored);

    // ZIP export includes console.log with the page's entries.
    const downloadPromise = viewer.waitForEvent('download', { timeout: TIMEOUT_MS });
    await viewer.click('#btn-download-all');
    const download = await downloadPromise;
    const zipPath = path.join(workDir, 'capture.zip');
    await download.saveAs(zipPath);
    const entries = zipEntries(fs.readFileSync(zipPath));
    const consoleFile = entries.get('console.log')?.toString('utf8') || '';
    check('ZIP contains sections, brief and metadata',
      entries.has('section_1.webp') || entries.has('section_1.jpeg') || entries.has('section_1.png'),
      [...entries.keys()].join(', '));
    check('ZIP console.log contains the page log', consoleFile.includes(CONSOLE_MARKER), consoleFile.split('\n')[0]);
    check('ZIP has ai_brief.md and metadata.json', entries.has('ai_brief.md') && entries.has('metadata.json'));

    // Kill the service worker, then reload: the viewer must not need it.
    const cdp = await context.newCDPSession(viewer);
    const workerStatus = new Map();
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      versions.forEach((v) => workerStatus.set(v.versionId, v.runningStatus));
    });
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    const stopDeadline = Date.now() + 10_000;
    while (Date.now() < stopDeadline
      && !(workerStatus.size > 0 && [...workerStatus.values()].every((s) => s === 'stopped'))) {
      await viewer.waitForTimeout(100);
    }
    check('service worker stopped via CDP', workerStatus.size > 0
      && [...workerStatus.values()].every((s) => s === 'stopped'),
      JSON.stringify(Object.fromEntries(workerStatus)));
    await viewer.reload();
    const afterStop = await waitForViewerDone(viewer);
    check('capture survives a stopped service worker', afterStop.isDone && afterStop.statusSections === first.statusSections,
      afterStop.status);

    const latest = await context.newPage();
    await latest.goto(extUrl('viewer/viewer.html'));
    const latestState = await waitForViewerDone(latest);
    check('viewer without id falls back to the latest capture', latestState.isDone && latestState.sectionCards > 1,
      latestState.status);

    const missing = await context.newPage();
    await missing.goto(extUrl('viewer/viewer.html?id=does-not-exist'));
    await missing.waitForFunction(() => document.getElementById('status-bar').classList.contains('error'),
      null, { timeout: TIMEOUT_MS });
    check('unknown capture id shows a clear message',
      (await missing.textContent('#status-text')).includes('no longer stored'));
  } finally {
    await context?.close().catch(() => {});
    server.close();
    if (keepTemp) {
      console.log(`Kept temp files in ${workDir}`);
    } else {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

main()
  .then(() => {
    console.log(`\n${results.length} checks passed.`);
  })
  .catch((err) => {
    console.error(`\nE2E FAILED: ${err.message}`);
    process.exitCode = 1;
  });
