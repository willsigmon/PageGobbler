/**
 * PageGobbler — Background Service Worker
 * Orchestrates the full-page screenshot capture pipeline:
 *   1. Tells content script to measure page & start scrolling
 *   2. Captures each viewport via chrome.tabs.captureVisibleTab
 *   3. Holds result in memory for the viewer to fetch via messaging
 */

const DEFAULT_SETTINGS = {
  quality: 0.92,          // jpeg/webp quality
  maxFileSizeMB: 3,       // target max per-section
  enableOCR: true,        // "extract page text" toggle
  enableSections: true,
  sectionMaxHeight: 4096, // px per section slice
  compressionStrategy: 'auto', // auto | aggressive | lossless
  oneClickMode: false,    // skip popup, gobble immediately on icon click
};

let captureState = null;
let lastCaptureResult = null; // holds completed capture for viewer to fetch
let lastCaptureTime = 0;
const MIN_CAPTURE_INTERVAL_MS = 550; // Chrome enforces 2 calls/sec max (500ms); add buffer
const ACTIVE_CAPTURE_PHASES = new Set(['measuring', 'capturing', 'processing']);
const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|edge|about|brave|vivaldi|opera):/i;

// ── 1-Click Mode ────────────────────────────────────────────────────────────

// On startup, apply the saved 1-click preference
chrome.runtime.onInstalled.addListener(() => applyOneClickMode());
chrome.runtime.onStartup.addListener(() => applyOneClickMode());

async function applyOneClickMode() {
  const settings = await loadSettings();
  if (settings.oneClickMode) {
    chrome.action.setPopup({ popup: '' });
  } else {
    chrome.action.setPopup({ popup: 'popup/popup.html' });
  }
}

// Fires only when popup is disabled (1-click mode)
chrome.action.onClicked.addListener((tab) => {
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) {
    chrome.action.setBadgeBackgroundColor({ color: '#C0392B' });
    chrome.action.setBadgeText({ text: 'X' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
    return;
  }
  handleStartCapture(tab.id);
});

// ── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Handlers that call sendResponse need the channel kept open (return true)
  const asyncHandlers = {
    'get-capture-data': () => handleGetCaptureData(sendResponse),
    'get-progress': () => handleGetProgress(sendResponse),
    'get-settings': () => handleGetSettings(sendResponse),
    'save-settings': () => handleSaveSettings(msg.settings, sendResponse),
    'start-capture': () => handleStartCapture(msg.tabId ?? sender.tab?.id)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message })),
  };

  // Fire-and-forget handlers — no sendResponse needed
  const fireHandlers = {
    'capture-viewport': () => handleCaptureViewport(msg, sender),
    'capture-complete': () => handleCaptureComplete(msg, sender),
  };

  if (asyncHandlers[msg.action]) {
    asyncHandlers[msg.action]();
    return true;
  }
  if (fireHandlers[msg.action]) {
    fireHandlers[msg.action]();
    return false;
  }
});

// ── Capture Flow ────────────────────────────────────────────────────────────

async function handleStartCapture(tabId) {
  if (!tabId) {
    return markStartFailed('No active tab found.');
  }

  if (captureState && ACTIVE_CAPTURE_PHASES.has(captureState.phase)) {
    return markStartFailed('A gobble is already running.');
  }

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return markStartFailed('Could not inspect the active tab.');
  }

  if (isRestrictedUrl(tab.url)) {
    return markStartFailed('Chrome blocks capture on browser/internal pages.');
  }

  // Badge: show capturing state
  chrome.action.setBadgeBackgroundColor({ color: '#D4762C' });
  chrome.action.setBadgeText({ text: '...' });

  const settings = await loadSettings();
  captureState = {
    tabId,
    settings,
    captures: [],
    phase: 'measuring',
    totalScrolls: 0,
    startTime: Date.now(),
  };

  // Inject and run the content script capture routine
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
    });
  } catch (_) {
    // The content script may already be injected. We confirm by messaging below.
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'begin-scroll-capture',
      settings,
    });
    if (response?.ok === false) {
      throw new Error(response.error || 'Page rejected the capture request.');
    }
  } catch (err) {
    captureState = null;
    return markStartFailed(
      err?.message?.includes('Receiving end does not exist')
        ? 'Could not inject PageGobbler into this page.'
        : err.message
    );
  }

  return { ok: true };
}

async function handleCaptureViewport(msg, sender) {
  if (!captureState) return;

  const tabId = sender.tab?.id ?? captureState.tabId;

  // Track progress from content script
  if (msg.totalScrolls) captureState.totalScrolls = msg.totalScrolls;
  captureState.phase = 'capturing';

  // Enforce rate limit: Chrome allows max 2 captureVisibleTab calls/sec
  const now = Date.now();
  const elapsed = now - lastCaptureTime;
  if (elapsed < MIN_CAPTURE_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_CAPTURE_INTERVAL_MS - elapsed));
  }

  try {
    lastCaptureTime = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'png',
      quality: 100,
    });

    captureState.captures.push({
      dataUrl,
      scrollY: msg.scrollY,
      viewportHeight: msg.viewportHeight,
      clipHeight: msg.clipHeight,
      index: msg.index,
    });

    // Tell content script to continue
    chrome.tabs.sendMessage(tabId, { action: 'next-scroll' });
  } catch (err) {
    console.error('captureVisibleTab failed:', err);
    captureState.phase = 'error';
    captureState.error = err.message;
    chrome.tabs.sendMessage(tabId, { action: 'capture-error', error: err.message });
  }
}

async function handleCaptureComplete(msg, sender) {
  if (!captureState) return;

  captureState.phase = 'processing';

  const tabId = sender.tab?.id ?? captureState.tabId;
  const { captures, settings } = captureState;
  const pageInfo = msg.pageInfo;

  try {
    // Hold result in memory — viewer fetches via 'get-capture-data' message
    lastCaptureResult = {
      captures: captures.map(c => ({
        dataUrl: c.dataUrl,
        scrollY: c.scrollY,
        viewportHeight: c.viewportHeight,
        clipHeight: c.clipHeight,
        index: c.index,
      })),
      pageInfo,
      settings,
      timestamp: Date.now(),
      elapsedMs: Date.now() - captureState.startTime,
    };

    // Signal done so the popup can show completion if it is still open
    captureState.phase = 'done';

    // Open viewer — it will request the data via messaging
    await chrome.tabs.create({
      url: chrome.runtime.getURL('viewer/viewer.html'),
      active: true,
    });

    // Tell content script we're done — restore page state
    chrome.tabs.sendMessage(tabId, { action: 'capture-done' });

    // Badge: brief success indicator
    chrome.action.setBadgeBackgroundColor({ color: '#27ae60' });
    chrome.action.setBadgeText({ text: '✓' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
  } catch (err) {
    console.error('Processing failed:', err);
    if (captureState) {
      captureState.phase = 'error';
      captureState.error = err.message;
    }
    chrome.tabs.sendMessage(tabId, { action: 'capture-error', error: err.message });
    chrome.action.setBadgeBackgroundColor({ color: '#C0392B' });
    chrome.action.setBadgeText({ text: 'X' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  } finally {
    // Delay nulling captureState so the popup can read the final state
    setTimeout(() => { captureState = null; }, 3000);
  }
}

// ── Progress Window ──────────────────────────────────────────────────────────

function handleGetProgress(sendResponse) {
  if (!captureState) {
    sendResponse({ phase: 'idle' });
    return;
  }
  sendResponse({
    phase: captureState.phase,
    current: captureState.captures.length,
    total: captureState.totalScrolls,
    error: captureState.error || null,
  });
}

function isRestrictedUrl(url = '') {
  return RESTRICTED_URL_PATTERN.test(url);
}

function markStartFailed(message) {
  chrome.action.setBadgeBackgroundColor({ color: '#C0392B' });
  chrome.action.setBadgeText({ text: '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
  return { ok: false, error: message };
}

// ── Capture Data Handoff ─────────────────────────────────────────────────────

function handleGetCaptureData(sendResponse) {
  const data = lastCaptureResult;
  lastCaptureResult = null; // one-time read
  sendResponse({ captureData: data });
}

// ── Settings ────────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function handleGetSettings(sendResponse) {
  const settings = await loadSettings();
  sendResponse({ settings });
}

async function handleSaveSettings(settings, sendResponse) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  await chrome.storage.local.set({ settings: merged });

  // Apply 1-click mode change immediately
  if (merged.oneClickMode) {
    chrome.action.setPopup({ popup: '' });
  } else {
    chrome.action.setPopup({ popup: 'popup/popup.html' });
  }

  sendResponse({ settings: merged });
}

// ── Keyboard shortcut ───────────────────────────────────────────────────────

chrome.commands?.onCommand?.addListener((command) => {
  if (command === 'take-screenshot') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) handleStartCapture(tab.id);
    });
  }
});
