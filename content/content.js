/**
 * PageGobbler — Content Script
 * Injected on demand (not auto-injected) into the target page. Handles:
 *   - Measuring full page dimensions
 *   - Scrolling through the page viewport-by-viewport
 *   - Signaling the background to capture each viewport
 *   - Collecting page context metadata (title, URL, headings, meta)
 *   - Hiding fixed/sticky elements after first capture to avoid duplication
 *   - Collecting the page's console output ONLY during active capture
 *     (relayed from a MAIN-world hook injected by the background worker)
 *
 * IMPORTANT: Chrome enforces a hard limit of 2 captureVisibleTab calls/sec.
 * The background worker handles this, but we add a 350ms settle delay here
 * to ensure repaint completes before signaling capture.
 */

(() => {
  if (window.__gobbleInjected) return;
  window.__gobbleInjected = true;

  const SETTLE_DELAY_MS = 350;
  // ~33s at Chrome's 2 captures/sec. Stops endless feeds and huge pages from
  // running for minutes; the result says where it was cut off.
  const MAX_VIEWPORTS = 60;
  const MAX_CONSOLE_ENTRIES = 200;

  let scrollIndex = 0;
  let totalScrolls = 0;
  let pageHeight = 0;
  let viewportHeight = 0;
  let fullPageHeight = 0; // the page's real height, before any cap
  let coveredBottom = 0;  // lowest page row captured so far
  let previousCoveredBottom = 0;
  let initialPageHeight = 0;
  let originalScrollY = 0;
  let originalScrollBehavior = '';
  let originalHtmlOverflow = '';
  let originalBodyOverflow = '';
  let settings = {};
  let fixedElements = [];
  let capturedPageInfo = null;

  // Console capture state — only active during capture. The content script
  // runs in an isolated world, so the page's own console calls are observed by
  // a MAIN-world hook the background injects (see pageConsoleHook in
  // background.js) and relayed here over window.postMessage on a per-capture
  // channel token.
  let capturedConsole = [];
  let consoleToken = null;
  let consoleListener = null;
  const CONSOLE_STOP_TIMEOUT_MS = 500;
  const MAX_CONSOLE_MESSAGE_CHARS = 4000; // same cap as the MAIN-world hook
  const CONSOLE_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug', 'uncaught-error', 'unhandled-rejection']);

  // ── Console Capture (on-demand only) ─────────────────────────────────

  function startConsoleCapture(token) {
    stopConsoleCapture();
    capturedConsole = [];
    if (!token) return;

    consoleToken = token;
    consoleListener = (event) => {
      const data = event.data;
      if (event.source !== window || !data || data.channel !== consoleToken) return;
      if (data.type !== 'entry' || !data.entry) return;
      if (capturedConsole.length >= MAX_CONSOLE_ENTRIES) return;
      // The page can see the token once an entry is posted and forge its own,
      // so accept only plain strings and apply the hook's limits here too.
      const { level, timestamp, message } = data.entry;
      if (typeof message !== 'string') return;
      capturedConsole.push({
        level: CONSOLE_LEVELS.has(level) ? level : 'log',
        timestamp: typeof timestamp === 'string' ? timestamp.slice(0, 40) : new Date().toISOString(),
        message: message.slice(0, MAX_CONSOLE_MESSAGE_CHARS),
      });
    };
    window.addEventListener('message', consoleListener);
  }

  /**
   * Ask the MAIN-world hook to restore the page's console, and resolve once it
   * acknowledges. window.postMessage delivers in order, so every entry the page
   * logged before the stop has been received by then.
   */
  function stopConsoleCapture() {
    if (!consoleToken) return Promise.resolve();
    const token = consoleToken;
    const listener = consoleListener;

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onAck);
        window.removeEventListener('message', listener);
        if (consoleToken === token) {
          consoleToken = null;
          consoleListener = null;
        }
        resolve();
      };
      const onAck = (event) => {
        const data = event.data;
        if (event.source === window && data && data.channel === token && data.type === 'stopped') {
          finish();
        }
      };
      const timer = setTimeout(finish, CONSOLE_STOP_TIMEOUT_MS);
      window.addEventListener('message', onAck);
      window.postMessage({ channel: token, type: 'stop' }, '*');
    });
  }

  // ── Message Handler ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handlers = {
      'begin-scroll-capture': () => beginCapture(msg.settings, msg.consoleToken),
      'next-scroll': () => captureNextViewport(),
      'capture-error': () => cleanupCapture(msg.error),
      'capture-done': () => cleanup(),
    };
    if (!handlers[msg.action]) return false;
    try {
      handlers[msg.action]();
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false;
  });

  // ── Capture Orchestration ───────────────────────────────────────────────

  function beginCapture(cfg, token) {
    settings = cfg;
    originalScrollY = window.scrollY;

    // Start relaying the page's console output for this session
    startConsoleCapture(token);

    // Disable smooth scrolling — we need instant jumps
    originalScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';

    // Hide scrollbar to avoid it appearing in captures
    originalHtmlOverflow = document.documentElement.style.overflow;
    originalBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'visible';

    // Measure full page
    viewportHeight = window.innerHeight;
    updatePageHeight();
    initialPageHeight = fullPageHeight;
    scrollIndex = 0;
    coveredBottom = 0;
    previousCoveredBottom = 0;

    // Capture page context before we hide fixed/sticky chrome for screenshot stitching.
    // Otherwise headers/nav/cookie bars can disappear from text, links, and DOM exports.
    capturedPageInfo = collectPageInfo();

    detectFixedElements();

    // Scroll to top and start
    window.scrollTo(0, 0);
    waitForSettleThenCapture();
  }

  function captureNextViewport() {
    scrollIndex++;

    // After the first viewport is captured, hide fixed/sticky elements
    // so they don't repeat in every subsequent frame
    if (scrollIndex === 1) {
      applyFixedElementHiding();
    }

    // Pages that load more content as you scroll (feeds, lazy sections)
    // grow mid-capture; keep going until the cap instead of dropping it.
    updatePageHeight();

    // If the last scroll made no progress, the page can't scroll further:
    // treat what we have as the whole page.
    const stalled = scrollIndex > 1 && coveredBottom === previousCoveredBottom;
    previousCoveredBottom = coveredBottom;

    // Continue from what was actually captured, not from index * height: if
    // the page hadn't grown yet when we scrolled, the browser clamped the
    // scroll, and stepping by index would leave a blank band in the image.
    const targetY = coveredBottom;
    if (scrollIndex >= MAX_VIEWPORTS || targetY >= pageHeight || stalled) {
      finishCapture({ atLimit: scrollIndex >= MAX_VIEWPORTS && !stalled });
      return;
    }

    window.scrollTo(0, targetY);
    waitForSettleThenCapture();
  }

  function measurePageHeight() {
    return Math.max(
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.scrollHeight,
      document.documentElement.offsetHeight,
      document.documentElement.clientHeight
    );
  }

  function updatePageHeight() {
    fullPageHeight = measurePageHeight();
    pageHeight = Math.min(fullPageHeight, MAX_VIEWPORTS * viewportHeight);
    totalScrolls = Math.ceil(pageHeight / viewportHeight);
  }

  function waitForSettleThenCapture() {
    // Wait for the next animation frame (ensures scroll has applied),
    // then wait SETTLE_DELAY for lazy-loaded images and repaint
    requestAnimationFrame(() => {
      setTimeout(() => requestCaptureOfCurrentViewport(), SETTLE_DELAY_MS);
    });
  }

  function requestCaptureOfCurrentViewport() {
    const currentY = window.scrollY;
    const remaining = pageHeight - currentY;
    const clipHeight = Math.min(viewportHeight, remaining);
    coveredBottom = Math.max(coveredBottom, currentY + clipHeight);

    chrome.runtime.sendMessage({
      action: 'capture-viewport',
      scrollY: currentY,
      viewportHeight,
      clipHeight,
      index: scrollIndex,
      totalScrolls,
    });
  }

  async function finishCapture({ atLimit = false } = {}) {
    // Restore the page's console before packaging, so the log is complete.
    await stopConsoleCapture();

    // If the page loaded more content while scrolling, the screenshots show
    // it, so re-read the page context too. Fixed/sticky chrome is restored
    // first (capturing is over) so headers and nav stay in the text exports.
    // Feeds that virtualize (drop early rows as new ones load) are left with
    // only the bottom of the feed in the DOM; keep the first snapshot there
    // rather than lose the top of the page from the exports.
    const grew = measurePageHeight() > initialPageHeight;
    if (grew) {
      restoreFixedElements();
      const fresh = collectPageInfo();
      if (keepsInitialText(capturedPageInfo?.visibleText || '', fresh.visibleText)) {
        capturedPageInfo = fresh;
      }
    }

    // A page that kept growing until the viewport limit may have more to
    // load even if the last capture reached its current bottom.
    const limitReached = atLimit && grew;

    const pageInfo = {
      ...(capturedPageInfo || collectPageInfo()),
      // Height may have grown while scrolling; report what was captured.
      pageHeight: coveredBottom,
      fullPageHeight,
      captureTruncated: fullPageHeight > coveredBottom || limitReached,
      captureLimitReached: limitReached,
      capturedAt: new Date().toISOString(),
      consoleLogs: [...capturedConsole],
    };

    chrome.runtime.sendMessage({
      action: 'capture-complete',
      pageInfo,
    });
  }

  // Whether a re-read page still has the text first collected. Samples are
  // taken through the whole first snapshot, not just its opening, so a
  // header that stays mounted can't hide feed rows that were dropped.
  function keepsInitialText(initial, fresh) {
    const SAMPLE = 120;
    const starts = [0, 0.25, 0.5, 0.75].map(f => Math.floor(f * Math.max(0, initial.length - SAMPLE)));
    return starts.every(start => {
      const sample = initial.slice(start, start + SAMPLE);
      return !sample.trim() || fresh.includes(sample);
    });
  }

  function cleanupCapture(error) {
    if (error) console.error('PageGobbler capture error:', error);
    cleanup();
  }

  function cleanup() {
    restoreFixedElements();
    stopConsoleCapture();
    capturedPageInfo = null;
    fullPageHeight = 0;
    coveredBottom = 0;
    document.documentElement.style.scrollBehavior = originalScrollBehavior;
    document.documentElement.style.overflow = originalHtmlOverflow;
    document.body.style.overflow = originalBodyOverflow;
    window.scrollTo(0, originalScrollY);
  }

  // ── Page Info Collector ─────────────────────────────────────────────────

  function collectPageInfo() {
    const headings = [];
    document.querySelectorAll('h1, h2, h3').forEach((h) => {
      headings.push({
        level: parseInt(h.tagName[1]),
        text: h.textContent.trim().slice(0, 200),
        offsetTop: h.offsetTop,
      });
    });

    const metaTags = {};
    document.querySelectorAll('meta[name], meta[property]').forEach((m) => {
      const key = m.getAttribute('name') || m.getAttribute('property');
      const val = m.getAttribute('content');
      if (key && val) metaTags[key] = val.slice(0, 500);
    });

    const links = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href;
      const text = a.textContent.trim().slice(0, 100);
      if (href && text && !href.startsWith('javascript:')) {
        links.push({ href, text });
      }
    });

    const visibleText = extractVisibleText();
    const domStructure = extractDOMStructure();
    const imageAssets = extractImageAssets();
    const structuredData = extractStructuredData();
    const designTokens = extractDesignTokens();
    const markdown = extractMarkdown();

    return {
      url: window.location.href,
      title: document.title,
      pageHeight,
      viewportHeight,
      viewportWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
      headings,
      metaTags,
      linkCount: links.length,
      topLinks: links.slice(0, 50),
      capturedAt: new Date().toISOString(),
      documentLang: document.documentElement.lang || 'unknown',
      visibleText: visibleText.slice(0, 50000),
      markdown,
      domStructure,
      imageAssets,
      structuredData,
      designTokens,
      consoleLogs: [...capturedConsole],
      stylesheets: extractStylesheets(),
      externalResources: extractExternalResources(),
      forms: extractForms(),
      allLinks: links.slice(0, 200),
    };
  }

  function extractVisibleText() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const tag = parent.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) {
            return NodeFilter.FILTER_REJECT;
          }

          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return NodeFilter.FILTER_REJECT;
          }

          const text = node.textContent.trim();
          return text.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );

    const chunks = [];
    while (walker.nextNode()) {
      chunks.push(walker.currentNode.textContent.trim());
    }
    return chunks.join('\n');
  }

  // ── Markdown Distillation ──────────────────────────────────────────────

  const MAX_MARKDOWN_CHARS = 500000;

  function isRenderedHidden(el) {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
    const style = getComputedStyle(el);
    return style.display === 'none'
      || style.visibility === 'hidden'
      || Number(style.opacity) === 0
      || parseFloat(style.fontSize) === 0;
  }

  function extractMarkdown() {
    if (!globalThis.PageGobblerMarkdown) return null;
    try {
      return globalThis.PageGobblerMarkdown.pageToMarkdown(document, {
        url: window.location.href,
        capturedAt: new Date().toISOString(),
        isHidden: isRenderedHidden,
        maxLength: MAX_MARKDOWN_CHARS,
      });
    } catch (err) {
      return { markdown: '', source: 'error', wordCount: 0, truncated: false, error: err.message };
    }
  }

  // ── DOM Structure Extractor ────────────────────────────────────────────

  function extractDOMStructure() {
    const SEMANTIC_TAGS = new Set([
      'html', 'head', 'body', 'header', 'nav', 'main', 'section', 'article',
      'aside', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'form',
      'table', 'ul', 'ol', 'dl', 'figure', 'details', 'dialog',
    ]);

    function walk(el, depth) {
      if (depth > 6) return '';
      const tag = el.tagName.toLowerCase();
      if (!SEMANTIC_TAGS.has(tag)) {
        let childHTML = '';
        for (const child of el.children) {
          childHTML += walk(child, depth);
        }
        return childHTML;
      }

      const indent = '  '.repeat(depth);
      const attrs = [];
      if (el.id) attrs.push(`id="${escapeHTML(el.id)}"`);
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim();
        if (cls) attrs.push(`class="${escapeHTML(cls.slice(0, 80))}"`);
      }
      if (el.getAttribute('role')) attrs.push(`role="${escapeHTML(el.getAttribute('role'))}"`);
      if (el.getAttribute('aria-label')) attrs.push(`aria-label="${escapeHTML(el.getAttribute('aria-label').slice(0, 60))}"`);

      const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
      let childHTML = '';
      for (const child of el.children) {
        childHTML += walk(child, depth + 1);
      }

      if (childHTML) {
        return `${indent}<${tag}${attrStr}>\n${childHTML}${indent}</${tag}>\n`;
      }

      const text = el.textContent.trim().slice(0, 60);
      if (text) {
        return `${indent}<${tag}${attrStr}>${escapeHTML(text)}</${tag}>\n`;
      }
      return `${indent}<${tag}${attrStr} />\n`;
    }

    return walk(document.documentElement, 0).slice(0, 30000);
  }

  function escapeHTML(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── Image Assets Extractor ────────────────────────────────────────────

  function extractImageAssets() {
    const images = [];
    document.querySelectorAll('img').forEach((img) => {
      images.push({
        src: img.src || img.dataset.src || '',
        alt: img.alt || '',
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        loading: img.loading || 'eager',
      });
    });

    const bgImages = [];
    document.querySelectorAll('[style*="background"], section, div, header, footer').forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none' && bg.startsWith('url(')) {
        const url = bg.slice(4, -1).replace(/["']/g, '');
        if (!url.startsWith('data:')) {
          bgImages.push({ src: url, element: el.tagName.toLowerCase(), class: (el.className || '').toString().slice(0, 60) });
        }
      }
    });

    return { images: images.slice(0, 100), backgroundImages: bgImages.slice(0, 30) };
  }

  // ── Structured Data Extractor ─────────────────────────────────────────

  function extractStructuredData() {
    const results = [];

    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const data = JSON.parse(script.textContent);
        results.push({ type: 'json-ld', data });
      } catch (_) { /* malformed JSON-LD */ }
    });

    const og = {};
    document.querySelectorAll('meta[property^="og:"]').forEach((m) => {
      og[m.getAttribute('property')] = m.getAttribute('content');
    });
    if (Object.keys(og).length > 0) {
      results.push({ type: 'open-graph', data: og });
    }

    const twitter = {};
    document.querySelectorAll('meta[name^="twitter:"]').forEach((m) => {
      twitter[m.getAttribute('name')] = m.getAttribute('content');
    });
    if (Object.keys(twitter).length > 0) {
      results.push({ type: 'twitter-card', data: twitter });
    }

    return results;
  }

  // ── Design Tokens Extractor ───────────────────────────────────────────

  function extractDesignTokens() {
    const colorSamples = new Map();
    const fontSamples = new Map();

    const sampleElements = document.querySelectorAll(
      'body, header, nav, main, footer, h1, h2, h3, p, a, button, .btn, [class*="hero"], [class*="cta"]'
    );

    sampleElements.forEach((el) => {
      const style = getComputedStyle(el);

      const color = style.color;
      const bg = style.backgroundColor;
      if (color && color !== 'rgba(0, 0, 0, 0)') {
        colorSamples.set(color, (colorSamples.get(color) || 0) + 1);
      }
      if (bg && bg !== 'rgba(0, 0, 0, 0)') {
        colorSamples.set(bg, (colorSamples.get(bg) || 0) + 1);
      }

      const font = style.fontFamily;
      const size = style.fontSize;
      const weight = style.fontWeight;
      const key = `${font}|${size}|${weight}`;
      fontSamples.set(key, (fontSamples.get(key) || 0) + 1);
    });

    const colors = [...colorSamples.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([color, count]) => ({ color, count }));

    const fonts = [...fontSamples.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => {
        const [family, size, weight] = key.split('|');
        return { family, size, weight, count };
      });

    const customProps = {};
    try {
      const sheets = document.styleSheets;
      for (const sheet of sheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText === ':root' || rule.selectorText === ':root, :host') {
              for (const prop of rule.style) {
                if (prop.startsWith('--')) {
                  customProps[prop] = rule.style.getPropertyValue(prop).trim();
                }
              }
            }
          }
        } catch (_) { /* cross-origin stylesheet */ }
      }
    } catch (_) { /* stylesheet access error */ }

    return { colors, fonts, customProperties: customProps };
  }

  // ── Stylesheet Extractor ───────────────────────────────────────────────

  function extractStylesheets() {
    const sheets = [];

    document.querySelectorAll('style').forEach((style, i) => {
      const text = style.textContent.trim();
      if (text) {
        sheets.push({ type: 'inline', index: i, css: text.slice(0, 50000) });
      }
    });

    for (const sheet of document.styleSheets) {
      if (!sheet.href) continue;
      try {
        const rules = [];
        for (const rule of sheet.cssRules) {
          rules.push(rule.cssText);
        }
        sheets.push({ type: 'external', href: sheet.href, css: rules.join('\n').slice(0, 50000) });
      } catch (_) {
        sheets.push({ type: 'external', href: sheet.href, css: null, crossOrigin: true });
      }
    }

    return sheets;
  }

  // ── External Resources Extractor ──────────────────────────────────────

  function extractExternalResources() {
    const resources = { scripts: [], stylesheets: [], fonts: [], preloads: [] };

    document.querySelectorAll('script[src]').forEach((s) => {
      resources.scripts.push({
        src: s.src,
        async: s.async,
        defer: s.defer,
        type: s.type || 'text/javascript',
      });
    });

    document.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
      resources.stylesheets.push({ href: l.href, media: l.media || 'all' });
    });

    document.querySelectorAll('link[rel="preconnect"], link[rel="preload"], link[rel="dns-prefetch"]').forEach((l) => {
      resources.preloads.push({ rel: l.rel, href: l.href, as: l.getAttribute('as') || '' });
    });

    try {
      document.fonts.forEach((font) => {
        resources.fonts.push({
          family: font.family,
          style: font.style,
          weight: font.weight,
          status: font.status,
        });
      });
    } catch (_) { /* fonts API not available */ }

    return resources;
  }

  // ── Form Extractor ────────────────────────────────────────────────────

  function extractForms() {
    const forms = [];
    document.querySelectorAll('form').forEach((form) => {
      const fields = [];
      form.querySelectorAll('input, select, textarea, button').forEach((el) => {
        const field = {
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          name: el.name || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          required: el.required || false,
        };
        if (el.tagName === 'SELECT') {
          field.options = [...el.options].slice(0, 20).map(o => ({ value: o.value, text: o.text }));
        }
        fields.push(field);
      });

      forms.push({
        action: form.action || '',
        method: form.method || 'get',
        id: form.id || '',
        name: form.name || '',
        fields,
      });
    });
    return forms.slice(0, 20);
  }

  // ── Fixed Element Management ────────────────────────────────────────────

  function detectFixedElements() {
    fixedElements = [];
    // Target likely fixed/sticky elements instead of scanning entire DOM
    const candidates = document.querySelectorAll(
      'header, footer, nav, aside, ' +
      '[role="banner"], [role="navigation"], [role="toolbar"], ' +
      '[class*="fixed"], [class*="sticky"], [class*="toolbar"], ' +
      '[class*="header"], [class*="footer"], [class*="nav-"], [class*="navbar"], ' +
      '[class*="cookie"], [class*="banner"], [class*="toast"], ' +
      '[class*="chat"], [class*="widget"], [class*="float"], ' +
      '[class*="dock"], [class*="sidebar"], [class*="overlay"], ' +
      '[style*="position"]'
    );
    candidates.forEach((el) => {
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        fixedElements.push({
          el,
          origVisibility: el.style.visibility,
        });
      }
    });

    // Also check direct children of body (common for fixed overlays)
    for (const child of document.body.children) {
      if (fixedElements.some(f => f.el === child)) continue;
      const style = getComputedStyle(child);
      if (style.position === 'fixed' || style.position === 'sticky') {
        fixedElements.push({
          el: child,
          origVisibility: child.style.visibility,
        });
      }
    }
  }

  function applyFixedElementHiding() {
    fixedElements.forEach(({ el }) => {
      el.style.visibility = 'hidden';
    });
  }

  function restoreFixedElements() {
    fixedElements.forEach(({ el, origVisibility }) => {
      el.style.visibility = origVisibility;
    });
    fixedElements = [];
  }

})();
