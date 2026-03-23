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
let progressWindowId = null;
const MIN_CAPTURE_INTERVAL_MS = 550; // Chrome enforces 2 calls/sec max (500ms); add buffer

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
  };

  // Fire-and-forget handlers — no sendResponse needed
  const fireHandlers = {
    'start-capture': () => handleStartCapture(msg.tabId ?? sender.tab?.id),
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
  if (!tabId) return;

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

  // Open progress window near top-right of the current window
  try {
    const currentWindow = await chrome.windows.getCurrent();
    const winWidth = 300;
    const winHeight = 100;
    const left = Math.max(0, (currentWindow.left + currentWindow.width) - winWidth - 20);
    const top = currentWindow.top + 80;

    const progressWin = await chrome.windows.create({
      url: chrome.runtime.getURL('progress/progress.html'),
      type: 'popup',
      width: winWidth,
      height: winHeight,
      left,
      top,
      focused: false,
    });
    progressWindowId = progressWin.id;
  } catch (_) {
    // Progress window is optional — capture works without it
  }

  // Inject and run the content script capture routine
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
    });
  } catch (_) {
    // content script may already be injected
  }

  chrome.tabs.sendMessage(tabId, {
    action: 'begin-scroll-capture',
    settings,
  });
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

    // Signal done so progress window can show completion
    captureState.phase = 'done';

    // Open viewer — it will request the data via messaging
    const viewerTab = await chrome.tabs.create({
      url: chrome.runtime.getURL('viewer/viewer.html'),
      active: true,
    });

    // Ensure the window containing the viewer is focused (handles multi-window setups)
    if (viewerTab.windowId) {
      chrome.windows.update(viewerTab.windowId, { focused: true });
    }

    // Tell content script we're done — restore page state
    chrome.tabs.sendMessage(tabId, { action: 'capture-done' });

    // Badge: brief success indicator
    chrome.action.setBadgeBackgroundColor({ color: '#27ae60' });
    chrome.action.setBadgeText({ text: '✓' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);

    // Close progress window after it has time to show "done"
    closeProgressWindow(2000);
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
    closeProgressWindow(3000);
  } finally {
    // Delay nulling captureState so progress window can read the final state
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

function closeProgressWindow(delayMs = 0) {
  if (!progressWindowId) return;
  const winId = progressWindowId;
  progressWindowId = null;
  setTimeout(() => {
    chrome.windows.remove(winId).catch(() => {});
  }, delayMs);
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
