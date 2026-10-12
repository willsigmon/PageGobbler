/**
 * PageGobbler — Background Service Worker
 * Orchestrates the full-page screenshot capture pipeline:
 *   1. Tells content script to measure page & start scrolling
 *   2. Captures each viewport via chrome.tabs.captureVisibleTab
 *   3. Saves the finished capture to the extension's IndexedDB and opens the
 *      viewer at viewer.html?id=<captureId>; the viewer reads it from there,
 *      so results survive the service worker being stopped.
 */

import './lib/capture-store.js';

const CaptureStore = globalThis.PageGobblerCaptureStore;

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
let lastCaptureTime = 0;
let captureClearTimer = null;
const MIN_CAPTURE_INTERVAL_MS = 550; // Chrome enforces 2 calls/sec max (500ms); add buffer
const ACTIVE_CAPTURE_PHASES = new Set(['measuring', 'capturing', 'processing']);
const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|edge|about|brave|vivaldi|opera):/i;

// Drop stale captures every time the worker starts (it starts on demand, so
// this runs regularly without timers that die with the worker).
pruneStoredCaptures();

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
  if (isRestrictedUrl(tab.url)) {
    chrome.action.setBadgeTextColor({ color: '#F5E6D0' });
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
    'get-progress': () => handleGetProgress(sendResponse),
    'get-settings': () => handleGetSettings(sendResponse),
    'save-settings': () => handleSaveSettings(msg.settings, sendResponse),
    'start-capture': () => handleStartCapture(msg.tabId ?? sender.tab?.id)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message })),
    // Answered only once the capture is saved: the open channel keeps the
    // service worker alive through image conversion and the IndexedDB write.
    'capture-complete': () => handleCaptureComplete(msg, sender)
      .finally(() => sendResponse({ ok: true })),
  };

  // Fire-and-forget handlers — no sendResponse needed
  const fireHandlers = {
    'capture-viewport': () => handleCaptureViewport(msg, sender),
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
  chrome.action.setBadgeTextColor({ color: '#1a1008' });
  chrome.action.setBadgeBackgroundColor({ color: '#D4762C' });
  chrome.action.setBadgeText({ text: '...' });

  const settings = await loadSettings();
  clearTimeout(captureClearTimer);
  const captureId = CaptureStore.createCaptureId();
  captureState = {
    captureId,
    tabId,
    windowId: tab.windowId,
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
      files: ['lib/page-markdown.js', 'content/content.js'],
    });
  } catch (_) {
    // The content script may already be injected. We confirm by messaging below.
  }

  // The content script lives in an isolated world and cannot see the page's
  // own console calls, so wrap console.* in the page's MAIN world for the
  // duration of this capture. Entries are relayed back over window.postMessage
  // on a per-capture channel token; the content script restores the originals.
  const consoleToken = await installPageConsoleHook(tabId);

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'begin-scroll-capture',
      settings,
      consoleToken,
    });
    if (response?.ok === false) {
      throw new Error(response.error || 'Page rejected the capture request.');
    }
  } catch (err) {
    captureState = null;
    if (consoleToken) removePageConsoleHook(tabId, consoleToken);
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
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      throw new Error('Keep the tab being gobbled active until capture finishes.');
    }

    lastCaptureTime = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
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

  // Every viewport is in hand: restore the page (scroll position, sticky
  // elements, overflow) now rather than after the slower storage work.
  chrome.tabs.sendMessage(tabId, { action: 'capture-done' }).catch(() => {});

  try {
    const captureId = captureState.captureId;
    const createdAt = Date.now();
    // Convert one viewport at a time and drop each data URL once its Blob
    // exists, so a tall page never holds every base64 copy at once.
    const storedCaptures = [];
    for (const c of captures) {
      const image = await storableImage(c.dataUrl);
      c.dataUrl = null;
      storedCaptures.push({
        ...image,
        scrollY: c.scrollY,
        viewportHeight: c.viewportHeight,
        clipHeight: c.clipHeight,
        index: c.index,
      });
    }
    const record = {
      id: captureId,
      createdAt,
      captures: storedCaptures,
      pageInfo,
      settings,
      timestamp: createdAt,
      elapsedMs: createdAt - captureState.startTime,
    };

    // Persist before opening the viewer: it reads straight from IndexedDB.
    await CaptureStore.saveCapture(record);
    captureState.captures = [];
    await pruneStoredCaptures();

    // Signal done so the popup can show completion if it is still open
    captureState.phase = 'done';

    await chrome.tabs.create({
      url: chrome.runtime.getURL(`viewer/viewer.html?id=${encodeURIComponent(captureId)}`),
      active: true,
    });

    // Badge: brief success indicator
    chrome.action.setBadgeTextColor({ color: '#1a1008' });
    chrome.action.setBadgeBackgroundColor({ color: '#D4762C' });
    chrome.action.setBadgeText({ text: '✓' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
  } catch (err) {
    console.error('Processing failed:', err);
    if (captureState) {
      captureState.phase = 'error';
      captureState.error = err.message;
    }
    chrome.action.setBadgeTextColor({ color: '#F5E6D0' });
    chrome.action.setBadgeBackgroundColor({ color: '#C0392B' });
    chrome.action.setBadgeText({ text: 'X' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  } finally {
    // Delay nulling captureState so the popup can read the final state
    const completedCaptureId = captureState?.captureId;
    captureClearTimer = setTimeout(() => {
      if (captureState?.captureId === completedCaptureId) {
        captureState = null;
      }
    }, 3000);
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
  chrome.action.setBadgeTextColor({ color: '#F5E6D0' });
  chrome.action.setBadgeBackgroundColor({ color: '#C0392B' });
  chrome.action.setBadgeText({ text: '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
  return { ok: false, error: message };
}

// ── Capture Storage ──────────────────────────────────────────────────────────

// Screenshots arrive as PNG data URLs; store them as Blobs (about 25% smaller
// than base64 and cheap for IndexedDB). Fall back to the data URL if needed.
async function storableImage(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    return { blob };
  } catch (_) {
    return { dataUrl };
  }
}

async function pruneStoredCaptures() {
  try {
    await CaptureStore.pruneCaptures();
  } catch (err) {
    console.warn('PageGobbler: could not prune stored captures:', err);
  }
}

// ── Page Console Relay ───────────────────────────────────────────────────────

async function installPageConsoleHook(tabId) {
  const token = `pagegobbler-console-${CaptureStore.createCaptureId()}`;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: pageConsoleHook,
      args: [token],
    });
    return token;
  } catch (err) {
    // Console capture is best-effort; the screenshot still works without it.
    console.warn('PageGobbler: console capture unavailable on this page:', err);
    return null;
  }
}

// Used when the capture never starts, so the content script never stops the hook.
function removePageConsoleHook(tabId, token) {
  chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (channel) => window.postMessage({ channel, type: 'stop' }, '*'),
    args: [token],
  }).catch(() => { /* the hook's own safety timeout still restores the console */ });
}

/**
 * Runs in the page's MAIN world (serialized by chrome.scripting, so it must
 * be self-contained). Wraps console methods and error events until the
 * content script posts {type: 'stop'} on the same token, then restores the
 * originals and acknowledges with {type: 'stopped'}.
 */
function pageConsoleHook(token) {
  const STATE_KEY = Symbol.for('pagegobbler.consoleHook');
  const METHODS = ['log', 'info', 'warn', 'error', 'debug'];
  const MAX_ENTRIES = 200;
  const MAX_MESSAGE_CHARS = 4000;
  const SAFETY_TIMEOUT_MS = 5 * 60 * 1000;

  // A previous capture that never stopped cleanly: restore it first.
  const previous = window[STATE_KEY];
  if (previous && typeof previous.restore === 'function') previous.restore();

  const originals = {};
  let sent = 0;
  let active = true;

  // Like the DevTools console, never run page getters or walk a whole object
  // graph: show own data properties only, a few levels deep, within a budget.
  const MAX_DEPTH = 3;
  const MAX_KEYS = 20;
  const preview = (value, depth, seen) => {
    if (value === null || typeof value !== 'object') {
      return typeof value === 'string' ? JSON.stringify(value) : String(value);
    }
    if (seen.has(value)) return '[Circular]';
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    if (depth >= MAX_DEPTH) return Array.isArray(value) ? `Array(${value.length})` : `[${tag}]`;
    seen.add(value);
    // Arrays: index the first few instead of listing every key of a huge array.
    const keys = Array.isArray(value)
      ? Array.from({ length: Math.min(value.length, MAX_KEYS) }, (_, i) => String(i))
      : Object.keys(value);
    const total = Array.isArray(value) ? value.length : keys.length;
    const parts = keys.slice(0, MAX_KEYS).map((key) => {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      const shown = desc && 'value' in desc ? preview(desc.value, depth + 1, seen) : '[Getter]';
      return Array.isArray(value) ? shown : `${key}: ${shown}`;
    });
    if (total > MAX_KEYS) parts.push(`… ${total - MAX_KEYS} more`);
    seen.delete(value);
    return Array.isArray(value) ? `[${parts.join(', ')}]` : `${tag === 'Object' ? '' : `${tag} `}{${parts.join(', ')}}`;
  };

  const describe = (value) => {
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    try {
      return preview(value, 0, new Set());
    } catch (_) {
      return Object.prototype.toString.call(value);
    }
  };

  const relay = (level, message) => {
    if (!active || sent >= MAX_ENTRIES) return;
    sent += 1;
    try {
      window.postMessage({
        channel: token,
        type: 'entry',
        entry: {
          level,
          timestamp: new Date().toISOString(),
          message: String(message).slice(0, MAX_MESSAGE_CHARS),
        },
      }, '*');
    } catch (_) { /* never break the page's logging */ }
  };

  METHODS.forEach((method) => {
    const original = console[method];
    if (typeof original !== 'function') return;
    originals[method] = original;
    console[method] = function pageGobblerConsole(...args) {
      try {
        relay(method, args.map(describe).join(' '));
      } catch (_) { /* never break the page's logging */ }
      return original.apply(this, args);
    };
  });

  const onError = (event) => {
    relay('uncaught-error', `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
  };
  const onRejection = (event) => relay('unhandled-rejection', describe(event.reason));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  const safetyTimer = setTimeout(() => restore(), SAFETY_TIMEOUT_MS);

  function restore() {
    if (!active) return;
    active = false;
    clearTimeout(safetyTimer);
    Object.keys(originals).forEach((method) => {
      console[method] = originals[method];
    });
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('message', onControl);
    if (window[STATE_KEY] === state) delete window[STATE_KEY];
  }

  function onControl(event) {
    if (event.source !== window || !event.data || event.data.channel !== token) return;
    if (event.data.type !== 'stop') return;
    restore();
    window.postMessage({ channel: token, type: 'stopped' }, '*');
  }

  const state = { restore };
  Object.defineProperty(window, STATE_KEY, { value: state, configurable: true });
  window.addEventListener('message', onControl);
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
