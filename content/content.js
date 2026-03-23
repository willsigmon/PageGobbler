/**
 * PageGobbler — Content Script
 * Injected on demand (not auto-injected) into the target page. Handles:
 *   - Measuring full page dimensions
 *   - Scrolling through the page viewport-by-viewport
 *   - Signaling the background to capture each viewport
 *   - Collecting page context metadata (title, URL, headings, meta)
 *   - Hiding fixed/sticky elements after first capture to avoid duplication
 *   - Capturing console output ONLY during active capture
 *
 * IMPORTANT: Chrome enforces a hard limit of 2 captureVisibleTab calls/sec.
 * The background worker handles this, but we add a 350ms settle delay here
 * to ensure repaint completes before signaling capture.
 */

(() => {
  if (window.__gobbleInjected) return;
  window.__gobbleInjected = true;

  const SETTLE_DELAY_MS = 350;
  const MAX_CONSOLE_ENTRIES = 200;

  let scrollIndex = 0;
  let totalScrolls = 0;
  let pageHeight = 0;
  let viewportHeight = 0;
  let originalScrollY = 0;
  let originalScrollBehavior = '';
  let settings = {};
  let fixedElements = [];

  // Console capture state — only active during capture
  let capturedConsole = [];
  let originalConsole = {};
  let consoleCapturing = false;
  let errorHandler = null;
  let rejectionHandler = null;

  // ── Console Capture (on-demand only) ─────────────────────────────────

  function startConsoleCapture() {
    if (consoleCapturing) return;
    consoleCapturing = true;
    capturedConsole = [];

    ['log', 'warn', 'error', 'info', 'debug'].forEach((method) => {
      originalConsole[method] = console[method].bind(console);
      console[method] = (...args) => {
        if (capturedConsole.length < MAX_CONSOLE_ENTRIES) {
          capturedConsole.push({
            level: method,
            timestamp: new Date().toISOString(),
            message: args.map(a => {
              try {
                return typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a);
              } catch (_) {
                return String(a);
              }
            }).join(' '),
          });
        }
        originalConsole[method](...args);
      };
    });

    errorHandler = (e) => {
      if (capturedConsole.length < MAX_CONSOLE_ENTRIES) {
        capturedConsole.push({
          level: 'uncaught-error',
          timestamp: new Date().toISOString(),
          message: `${e.message} at ${e.filename}:${e.lineno}:${e.colno}`,
        });
      }
    };

    rejectionHandler = (e) => {
      if (capturedConsole.length < MAX_CONSOLE_ENTRIES) {
        capturedConsole.push({
          level: 'unhandled-rejection',
          timestamp: new Date().toISOString(),
          message: String(e.reason),
        });
      }
    };

    window.addEventListener('error', errorHandler);
    window.addEventListener('unhandledrejection', rejectionHandler);
  }

  function stopConsoleCapture() {
    if (!consoleCapturing) return;
    consoleCapturing = false;

    Object.entries(originalConsole).forEach(([method, fn]) => {
      console[method] = fn;
    });
    originalConsole = {};

    if (errorHandler) {
      window.removeEventListener('error', errorHandler);
      errorHandler = null;
    }
    if (rejectionHandler) {
      window.removeEventListener('unhandledrejection', rejectionHandler);
      rejectionHandler = null;
    }
  }

  // ── Message Handler ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    const handlers = {
      'begin-scroll-capture': () => beginCapture(msg.settings),
      'next-scroll': () => captureNextViewport(),
      'capture-error': () => cleanupCapture(msg.error),
      'capture-done': () => cleanup(),
    };
    handlers[msg.action]?.();
  });

  // ── Capture Orchestration ───────────────────────────────────────────────

  function beginCapture(cfg) {
    settings = cfg;
    originalScrollY = window.scrollY;

    // Start capturing console output for this session
    startConsoleCapture();

    // Disable smooth scrolling — we need instant jumps
    originalScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';

    // Hide scrollbar to avoid it appearing in captures
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'visible';

    // Measure full page
    pageHeight = Math.max(
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.scrollHeight,
      document.documentElement.offsetHeight,
      document.documentElement.clientHeight
    );
    viewportHeight = window.innerHeight;
    totalScrolls = Math.ceil(pageHeight / viewportHeight);
    scrollIndex = 0;

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

    if (scrollIndex >= totalScrolls) {
      finishCapture();
      return;
    }

    const targetY = scrollIndex * viewportHeight;
    window.scrollTo(0, targetY);
    waitForSettleThenCapture();
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

    chrome.runtime.sendMessage({
      action: 'capture-viewport',
      scrollY: currentY,
      viewportHeight,
      clipHeight,
      index: scrollIndex,
      totalScrolls,
    });
  }

  function finishCapture() {
    const pageInfo = collectPageInfo();

    chrome.runtime.sendMessage({
      action: 'capture-complete',
      pageInfo,
    });
  }

  function cleanupCapture(error) {
    if (error) console.error('PageGobbler capture error:', error);
    cleanup();
  }

  function cleanup() {
    restoreFixedElements();
    stopConsoleCapture();
    document.documentElement.style.scrollBehavior = originalScrollBehavior;
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
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
      if (el.id) attrs.push(`id="${el.id}"`);
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim();
        if (cls) attrs.push(`class="${cls.slice(0, 80)}"`);
      }
      if (el.getAttribute('role')) attrs.push(`role="${el.getAttribute('role')}"`);
      if (el.getAttribute('aria-label')) attrs.push(`aria-label="${el.getAttribute('aria-label').slice(0, 60)}"`);

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
        return `${indent}<${tag}${attrStr}>${text}</${tag}>\n`;
      }
      return `${indent}<${tag}${attrStr} />\n`;
    }

    return walk(document.documentElement, 0).slice(0, 30000);
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
