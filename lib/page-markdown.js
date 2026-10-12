/**
 * PageGobbler — Page-to-Markdown Distiller
 * Converts a live DOM into clean, token-efficient GitHub Flavored Markdown:
 *   - Picks the main content (article / main / body) and drops site chrome
 *   - Preserves headings, lists, quotes, code blocks (with language), and tables
 *   - Resolves links and images to absolute URLs and strips tracking params
 *   - Removes hidden elements, tracking pixels, and invisible zero-width /
 *     bidi control characters that can smuggle prompt injections
 *   - Walks open Shadow DOM roots and slotted content
 *
 * Injected into the page alongside content/content.js (exposes
 * globalThis.PageGobblerMarkdown) and loadable from Node for unit tests.
 */

(function (root) {
  'use strict';

  // Zero-width space, word joiner, BOM, soft hyphen, and bidi override/isolate
  // controls. ZWNJ/ZWJ (U+200C/U+200D) are kept: Persian, Indic scripts, and
  // emoji sequences need them.
  const INVISIBLE_CHARS = /[\u00AD\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
  const TRACKING_PARAM = /^(utm_[a-z_]+|fbclid|gclid|gclsrc|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|twclid|_hsenc|_hsmi|_ga|_gl|mkt_tok|oly_anon_id|oly_enc_id|vero_id|ref_src|__cf_chl_[a-z_]+|jsessionid|phpsessid|aspsessionid)$/i;
  const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'ftp:']);

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'math', 'canvas', 'iframe',
    'object', 'embed', 'video', 'audio', 'source', 'track', 'map', 'button',
    'input', 'select', 'textarea', 'option', 'dialog', 'link', 'meta', 'head', 'title',
    'nav',
  ]);
  const SKIP_ROLES = new Set(['navigation', 'search', 'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar']);
  // Site chrome: dropped unless it is the chosen content root itself.
  const CHROME_TAGS = new Set(['footer', 'aside']);
  const CHROME_ROLES = new Set(['banner', 'contentinfo', 'complementary']);

  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details',
    'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'ol', 'p', 'pre',
    'section', 'summary', 'table', 'ul',
  ]);

  const HARD_BREAK = '\u0000BR\u0000';

  // ── URL helpers ─────────────────────────────────────────────────────────

  /**
   * Resolve `href` against `baseUrl`, keep only safe protocols, and strip
   * tracking parameters. Pass { dropHash: true } for canonical page URLs.
   * Returns null for unsafe or unparseable URLs.
   */
  function normalizeUrl(href, baseUrl, { dropHash = false } = {}) {
    if (!href) return null;
    let url;
    try {
      url = new URL(String(href).trim(), baseUrl || undefined);
    } catch (_) {
      return null;
    }
    if (!SAFE_PROTOCOLS.has(url.protocol)) return null;
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      for (const key of [...url.searchParams.keys()]) {
        if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
      }
      // URL-rewritten Java sessions: /app;jsessionid=SECRET
      url.pathname = url.pathname.replace(/;jsessionid=[^/?#;]*/gi, '');
      if (dropHash) url.hash = '';
    }
    let out = url.toString();
    if (url.search === '' && out.includes('?')) out = out.replace('?', '');
    return out;
  }

  function markdownUrl(url) {
    return url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  }

  // ── Text helpers ────────────────────────────────────────────────────────

  function stripInvisible(text) {
    return String(text || '').replace(INVISIBLE_CHARS, '');
  }

  function escapeInline(text) {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/([`*~[\]<])/g, '\\$1')
      // Literal entity notation (e.g. "&lt;div&gt;" in docs) must not be decoded by renderers.
      .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&')
      // Underscores only matter at word boundaries in GFM; leave snake_case alone.
      .replace(/(^|[^A-Za-z0-9])_/g, '$1\\_')
      .replace(/_(?=[^A-Za-z0-9]|$)/g, '\\_');
  }

  // Keep paragraph text from being read as a heading, quote, list, or rule.
  function escapeLineStart(line) {
    return line
      .replace(/^(\s*)(#{1,6}\s|>|[-+]\s|=+\s*$|-{3,}\s*$)/, '$1\\$2')
      .replace(/^(\s*\d+)([.)]\s)/, '$1\\$2');
  }

  function fenceFor(content, char = '`') {
    const runs = content.match(new RegExp(`${char === '`' ? '`' : '~'}+`, 'g')) || [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return char.repeat(Math.max(3, longest + 1));
  }

  function inlineCode(content) {
    const text = content.replace(/\s+/g, ' ');
    if (!text.trim()) return '';
    const runs = text.match(/`+/g) || [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    const ticks = '`'.repeat(longest + 1);
    const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    return `${ticks}${pad}${text}${pad}${ticks}`;
  }

  function wrapEmphasis(content, marker) {
    const match = content.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!match[2]) return content;
    return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────

  function tagOf(node) {
    return (node.localName || node.nodeName || '').toLowerCase();
  }

  function childNodesOf(el) {
    if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
    if (tagOf(el) === 'slot' && typeof el.assignedNodes === 'function') {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(el.childNodes);
  }

  function defaultIsHidden(el) {
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const style = (el.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
    return style.includes('display:none') || style.includes('visibility:hidden');
  }

  function isBlock(el) {
    const tag = tagOf(el);
    // Custom elements (web components) usually wrap block content.
    return BLOCK_TAGS.has(tag) || tag.includes('-');
  }

  function isTrackingPixel(img) {
    // Intrinsic size, once loaded (stylesheet-sized pixels are caught by isHidden).
    if (img.complete && img.naturalWidth > 0 && img.naturalWidth <= 1 && img.naturalHeight <= 1) return true;
    const w = parseInt(img.getAttribute('width'), 10);
    const h = parseInt(img.getAttribute('height'), 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w <= 1 && h <= 1) return true;
    const style = (img.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
    return /(^|;)width:[01]px/.test(style) && /(^|;)height:[01]px/.test(style);
  }

  // Lazy loaders often park a data: placeholder in src; take the first safe URL.
  function imageCandidates(img) {
    return [
      img.currentSrc,
      img.getAttribute('src'),
      img.getAttribute('data-src'),
      img.getAttribute('data-lazy-src'),
      img.getAttribute('data-original'),
    ].filter(Boolean);
  }

  // ── Converter ───────────────────────────────────────────────────────────

  class Converter {
    constructor(options = {}) {
      this.baseUrl = options.baseUrl || '';
      this.isHidden = options.isHidden || defaultIsHidden;
      this.root = null;
    }

    shouldSkip(el) {
      const tag = tagOf(el);
      if (SKIP_TAGS.has(tag)) return true;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (SKIP_ROLES.has(role)) return true;
      if (el !== this.root) {
        if (CHROME_TAGS.has(tag) || CHROME_ROLES.has(role)) return true;
        // A page-level <header> is site chrome; an article's or section's <header> holds its title.
        if (tag === 'header' && !el.closest('article, main, section, [role="main"]')) return true;
      }
      try {
        return this.isHidden(el);
      } catch (_) {
        return false;
      }
    }

    convert(rootEl) {
      this.root = rootEl;
      const md = this.blocks(rootEl);
      return md
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, (m) => (m === '  ' ? m : '')))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    // Render an element's children as Markdown blocks separated by blank lines.
    // tight: true joins every block with one newline (table cells);
    // tight: 'item' keeps paragraphs apart but hugs nested lists (list items).
    blocks(el, { tight = false } = {}) {
      const out = [];
      const kinds = [];
      let inlineBuffer = '';

      const flush = () => {
        const para = this.finishParagraph(inlineBuffer);
        if (para) { out.push(para); kinds.push('p'); }
        inlineBuffer = '';
      };

      for (const node of childNodesOf(el)) {
        if (node.nodeType === 3) {
          inlineBuffer += this.text(node);
          continue;
        }
        if (node.nodeType !== 1 || this.shouldSkip(node)) continue;

        if (isBlock(node)) {
          flush();
          const block = this.block(node);
          if (block) { out.push(block); kinds.push(tagOf(node)); }
        } else {
          inlineBuffer += this.inline(node);
        }
      }
      flush();
      if (tight === true) return out.join('\n');
      if (tight === 'item') {
        return out.reduce((acc, block, i) => {
          if (i === 0) return block;
          const hug = kinds[i] === 'ul' || kinds[i] === 'ol';
          return `${acc}${hug ? '\n' : '\n\n'}${block}`;
        }, '');
      }
      return out.join('\n\n');
    }

    finishParagraph(raw) {
      const text = raw
        .replace(/[ \t\n\r\f]+/g, ' ')
        .replace(new RegExp(`\\s*${HARD_BREAK}\\s*`, 'g'), HARD_BREAK)
        .trim()
        .replace(new RegExp(`^(${HARD_BREAK})+|(${HARD_BREAK})+$`, 'g'), '');
      if (!text) return '';
      return text
        .split(HARD_BREAK)
        .map(escapeLineStart)
        .join('  \n');
    }

    block(el) {
      const tag = tagOf(el);
      switch (tag) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
          const text = this.inlineChildren(el).replace(new RegExp(HARD_BREAK, 'g'), ' ').replace(/\s+/g, ' ').trim();
          return text ? `${'#'.repeat(Number(tag[1]))} ${text}` : '';
        }
        case 'p':
          return this.finishParagraph(this.inlineChildren(el));
        case 'hr':
          return '---';
        case 'pre':
          return this.codeBlock(el);
        case 'blockquote': {
          const inner = this.blocks(el);
          if (!inner) return '';
          return inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
        }
        case 'ul':
        case 'ol':
          return this.list(el, tag === 'ol');
        case 'li': {
          // Stray <li> outside a list.
          const body = this.blocks(el, { tight: 'item' });
          return body ? `- ${indent(body, 2).slice(2)}` : '';
        }
        case 'table':
          return this.table(el);
        case 'dt': {
          const text = this.finishParagraph(this.inlineChildren(el));
          return text ? `**${text}**` : '';
        }
        case 'dl':
          return this.blocks(el, { tight: false });
        default:
          return this.blocks(el);
      }
    }

    codeBlock(pre) {
      const code = Array.from(pre.querySelectorAll('code')).find((el) => {
        for (let node = el; node && node !== pre; node = node.parentElement) {
          if (this.isHiddenSafe(node)) return false;
        }
        return true;
      });
      const dataLang = (pre.getAttribute('data-lang') || '').trim();
      const langSource = `${pre.getAttribute('class') || ''} ${code?.getAttribute('class') || ''}`;
      const langMatch = langSource.match(/(?:^|\s)(?:language|lang)-([\w+#-]+)/i)
        || langSource.match(/brush:\s*([\w+#-]+)/i)
        // data-lang goes into the fence info string, so accept a single safe token only.
        || dataLang.match(/^([\w+#-]{1,32})$/);
      const lang = langMatch ? langMatch[1].toLowerCase() : '';
      const content = stripInvisible(this.rawText(code || pre)).replace(/^\n+|\s+$/g, '');
      if (!content) return '';
      const fence = fenceFor(content);
      return `${fence}${lang}\n${content}\n${fence}`;
    }

    // textContent, but honoring <br> and skipping hidden nodes (e.g. line-number gutters).
    rawText(el) {
      let out = '';
      for (const node of childNodesOf(el)) {
        if (node.nodeType === 3) out += node.nodeValue;
        else if (node.nodeType === 1) {
          const tag = tagOf(node);
          if (tag === 'br') out += '\n';
          else if (!SKIP_TAGS.has(tag) && !this.isHiddenSafe(node)) out += this.rawText(node);
        }
      }
      return out;
    }

    isHiddenSafe(el) {
      try { return this.isHidden(el); } catch (_) { return false; }
    }

    list(el, ordered) {
      const startAttr = parseInt(el.getAttribute('start'), 10);
      let counter = Number.isFinite(startAttr) ? startAttr : 1;
      const items = [];
      for (const child of Array.from(el.children)) {
        if (tagOf(child) !== 'li') {
          // Nested list placed directly inside a list (invalid but common).
          if (['ul', 'ol'].includes(tagOf(child)) && !this.shouldSkip(child) && items.length) {
            const nested = this.list(child, tagOf(child) === 'ol');
            if (nested) items[items.length - 1] += `\n${indent(nested, 2)}`;
          }
          continue;
        }
        if (this.shouldSkip(child)) continue;
        const explicit = parseInt(child.getAttribute('value'), 10);
        if (ordered && Number.isFinite(explicit)) counter = explicit;
        const marker = ordered ? `${counter}. ` : '- ';
        counter += 1;
        const body = this.blocks(child, { tight: 'item' });
        if (!body) continue;
        items.push(marker + indent(body, marker.length).slice(marker.length));
      }
      return items.join('\n');
    }

    table(table) {
      const rows = Array.from(table.rows || []).filter((row) => {
        // A hidden <thead>/<tbody>/<tfoot> hides its rows without changing their own style.
        for (let node = row; node && node !== table; node = node.parentElement) {
          if (this.shouldSkip(node)) return false;
        }
        return true;
      });
      if (!rows.length) return '';

      // Layout tables read better as plain blocks than as grids.
      if (isLayoutTable(table, rows)) {
        return rows
          .flatMap((row) => Array.from(row.cells).map((cell) => this.blocks(cell)))
          .filter(Boolean)
          .join('\n\n');
      }

      // Build a grid that honors colspan and rowspan.
      const grid = [];
      const aligns = [];
      rows.forEach((row, r) => {
        grid[r] = grid[r] || [];
        let c = 0;
        for (const cell of Array.from(row.cells)) {
          while (grid[r][c] !== undefined) c += 1;
          const colspan = Math.max(1, parseInt(cell.getAttribute('colspan'), 10) || 1);
          const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan'), 10) || 1);
          const text = this.shouldSkip(cell) ? '' : this.cellText(cell);
          const align = cellAlign(cell);
          for (let dr = 0; dr < rowspan && r + dr < rows.length; dr++) {
            grid[r + dr] = grid[r + dr] || [];
            for (let dc = 0; dc < colspan; dc++) {
              grid[r + dr][c + dc] = dr === 0 && dc === 0 ? text : '';
              if (aligns[c + dc] === undefined && align) aligns[c + dc] = align;
            }
          }
          c += colspan;
        }
      });

      const width = Math.max(...grid.map((row) => row.length));
      const normalized = grid
        .map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''))
        .filter((row, i) => i === 0 || row.some(Boolean));
      const [header, ...body] = normalized;
      const separator = Array.from({ length: width }, (_, i) => {
        switch (aligns[i]) {
          case 'center': return ':---:';
          case 'right': return '---:';
          case 'left': return ':---';
          default: return '---';
        }
      });
      const line = (cells) => `| ${cells.join(' | ')} |`;

      const caption = table.querySelector('caption');
      const captionText = caption && !this.shouldSkip(caption) ? this.finishParagraph(this.inlineChildren(caption)) : '';
      const md = [line(header), line(separator), ...body.map(line)].join('\n');
      return captionText ? `${captionText}\n\n${md}` : md;
    }

    cellText(cell) {
      return this.blocks(cell, { tight: true })
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('<br>')
        .replace(/\|/g, '\\|');
    }

    inlineChildren(el) {
      return childNodesOf(el)
        .map((node) => {
          if (node.nodeType === 3) return this.text(node);
          if (node.nodeType === 1 && !this.shouldSkip(node)) return this.inline(node);
          return '';
        })
        .join('');
    }

    text(node) {
      const value = stripInvisible(node.nodeValue).replace(/[ \t\n\r\f]+/g, ' ');
      return escapeInline(value);
    }

    inline(el) {
      const tag = tagOf(el);
      switch (tag) {
        case 'br':
          return HARD_BREAK;
        case 'strong': case 'b':
          return wrapEmphasis(this.inlineChildren(el), '**');
        case 'em': case 'i': case 'cite': case 'dfn':
          return wrapEmphasis(this.inlineChildren(el), '*');
        case 'del': case 's': case 'strike':
          return wrapEmphasis(this.inlineChildren(el), '~~');
        case 'code': case 'kbd': case 'samp': case 'tt':
          return inlineCode(stripInvisible(this.rawText(el)));
        case 'a':
          return this.link(el);
        case 'img':
          return this.image(el);
        case 'picture':
          return this.inlineChildren(el);
        default:
          // Block content nested in inline context (e.g. a card link) — flatten.
          if (isBlock(el)) return ` ${this.inlineChildren(el)} `;
          return this.inlineChildren(el);
      }
    }

    link(a) {
      const content = this.inlineChildren(a);
      const label = content.replace(new RegExp(HARD_BREAK, 'g'), ' ').replace(/\s+/g, ' ').trim();
      const rawHref = a.getAttribute('href') || '';
      if (!label) return '';
      if (!rawHref || rawHref.startsWith('#')) return content;
      const href = normalizeUrl(rawHref, this.baseUrl);
      if (!href) return content;
      const title = stripInvisible(a.getAttribute('title') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
      const lead = /^\s/.test(content) ? ' ' : '';
      const trail = /\s$/.test(content) ? ' ' : '';
      return `${lead}[${label}](${markdownUrl(href)}${title ? ` "${title}"` : ''})${trail}`;
    }

    image(img) {
      if (isTrackingPixel(img)) return '';
      const src = imageCandidates(img)
        .map((candidate) => normalizeUrl(candidate, this.baseUrl))
        .find(Boolean);
      if (!src) return '';
      const alt = escapeInline(stripInvisible(img.getAttribute('alt') || '').replace(/\s+/g, ' ').trim());
      return `![${alt}](${markdownUrl(src)})`;
    }
  }

  function indent(text, spaces) {
    const pad = ' '.repeat(spaces);
    return text.split('\n').map((line) => (line ? pad + line : line)).join('\n');
  }

  /**
   * Data tables announce themselves with header cells, a <thead>, a caption,
   * or a table role. Anything else — or anything nesting another table or
   * spanning a single column — is treated as layout scaffolding.
   */
  function isLayoutTable(table, rows) {
    const role = (table.getAttribute('role') || '').toLowerCase();
    if (role === 'presentation' || role === 'none') return true;
    if (table.querySelector('table')) return true;
    const maxCols = Math.max(...rows.map((row) => Array.from(row.cells)
      .reduce((n, c) => n + (parseInt(c.getAttribute('colspan'), 10) || 1), 0)));
    if (maxCols < 2) return true;
    if (role === 'table' || role === 'grid' || role === 'treegrid') return false;
    return !(table.tHead || table.caption || table.querySelector('th'));
  }

  function cellAlign(cell) {
    const attr = (cell.getAttribute('align') || '').toLowerCase();
    const style = (cell.getAttribute('style') || '').toLowerCase().match(/text-align\s*:\s*(left|right|center)/);
    const align = attr || (style && style[1]) || '';
    return ['left', 'right', 'center'].includes(align) ? align : '';
  }

  /**
   * Visible text length of every element under `root`, computed in one pass
   * with the same visibility rules as conversion. Hidden subtrees count as 0.
   */
  function visibleTextLengths(root, isHidden) {
    const lengths = new Map();
    const walk = (el) => {
      let total = 0;
      for (const node of el.childNodes) {
        if (node.nodeType === 3) {
          total += node.nodeValue.replace(/\s+/g, ' ').trim().length;
        } else if (node.nodeType === 1 && !SKIP_TAGS.has(tagOf(node))) {
          let hidden = false;
          try { hidden = isHidden(node); } catch (_) { /* visible */ }
          if (!hidden) total += walk(node);
        }
      }
      lengths.set(el, total);
      return total;
    };
    walk(root);
    return (el) => lengths.get(el) || 0;
  }

  /**
   * Choose the element that holds the page's main content. Prefers the
   * largest <article>, then <main>/[role=main], falling back to <body> when
   * no candidate holds a meaningful share of the page's text.
   */
  function pickContentRoot(doc, isHidden = defaultIsHidden) {
    const body = doc.body || doc.documentElement;
    const visible = (el) => {
      for (let node = el; node && node !== body; node = node.parentElement) {
        try { if (isHidden(node)) return false; } catch (_) { /* treat as visible */ }
      }
      return true;
    };
    const textLength = visibleTextLengths(body, isHidden);
    const bodyLength = textLength(body) || 1;
    const meaningful = (el) => el && visible(el) && (textLength(el) >= 500 || textLength(el) / bodyLength >= 0.3);

    const articles = Array.from(doc.querySelectorAll('article'))
      .filter((el) => !el.parentElement?.closest('article') && visible(el))
      .sort((a, b) => textLength(b) - textLength(a));
    if (articles.length && meaningful(articles[0])) {
      return { element: articles[0], source: 'article' };
    }

    const main = Array.from(doc.querySelectorAll('main, [role="main"]')).find(visible);
    if (meaningful(main)) return { element: main, source: 'main' };

    return { element: body, source: 'body' };
  }

  /**
   * Cut at the last block boundary before `limit` so tables, lists, and
   * emphasis stay intact; close a code fence left open by the cut.
   */
  function truncateMarkdown(md, limit) {
    let cut = md.lastIndexOf('\n\n', limit);
    if (cut < limit / 2) cut = md.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    let out = md.slice(0, cut).replace(/\s+$/, '');

    let openFence = null;
    for (const line of out.split('\n')) {
      const match = line.match(/^(`{3,}|~{3,})/);
      if (!match) continue;
      if (!openFence) openFence = match[1];
      else if (match[1][0] === openFence[0] && match[1].length >= openFence.length && line.trim() === match[1]) openFence = null;
    }
    if (openFence) out += `\n${openFence}`;
    return `${out}\n\n… [truncated by PageGobbler]`;
  }

  function yamlString(value) {
    return JSON.stringify(stripInvisible(String(value ?? '')).replace(/\s+/g, ' ').trim());
  }

  /**
   * Convert a document to Markdown with a YAML front matter header.
   * @param {Document} doc
   * @param {Object} [options]
   * @param {string} [options.url] - page URL (defaults to doc.URL)
   * @param {string} [options.capturedAt] - ISO timestamp for the header
   * @param {Function} [options.isHidden] - (el) => boolean visibility check
   * @param {number} [options.maxLength] - truncate body to this many characters
   * @returns {{ markdown: string, source: string, wordCount: number, truncated: boolean }}
   */
  function pageToMarkdown(doc, options = {}) {
    const pageUrl = options.url || doc.URL || '';
    const { element, source } = pickContentRoot(doc, options.isHidden);
    const converter = new Converter({ baseUrl: doc.baseURI || pageUrl, isHidden: options.isHidden });
    let body = converter.convert(element);

    let truncated = false;
    if (options.maxLength && body.length > options.maxLength) {
      body = truncateMarkdown(body, options.maxLength);
      truncated = true;
    }

    const lang = doc.documentElement?.getAttribute('lang');
    const header = [
      '---',
      `title: ${yamlString(doc.title)}`,
      `url: ${yamlString(normalizeUrl(pageUrl, undefined, { dropHash: true }) || pageUrl)}`,
      lang ? `lang: ${yamlString(lang)}` : null,
      options.capturedAt ? `captured_at: ${yamlString(options.capturedAt)}` : null,
      `content_root: ${source}`,
      '---',
    ].filter(Boolean).join('\n');

    const wordCount = body ? body.split(/\s+/).filter(Boolean).length : 0;
    return { markdown: `${header}\n\n${body}\n`, source, wordCount, truncated };
  }

  /** Convert a single element's contents to Markdown (no header). */
  function elementToMarkdown(el, options = {}) {
    return new Converter(options).convert(el);
  }

  const api = { pageToMarkdown, elementToMarkdown, pickContentRoot, normalizeUrl, stripInvisible };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PageGobblerMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
