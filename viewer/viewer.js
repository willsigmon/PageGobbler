/**
 * PageGobbler — Viewer Page Controller
 * Processes the captured data: stitch -> compress -> section -> OCR -> display.
 */

// ── Lightweight ZIP Builder (no external deps) ─────────────────────────────

const ZipBuilder = (() => {
  function createZip(files) {
    // files: [{ name: string, data: Uint8Array }]
    const localHeaders = [];
    const centralEntries = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = new TextEncoder().encode(file.name);
      const crc = crc32(file.data);

      // Local file header (30 bytes + name + data)
      const local = new Uint8Array(30 + nameBytes.length + file.data.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);  // signature
      lv.setUint16(4, 20, true);            // version needed
      lv.setUint16(6, 0, true);             // flags
      lv.setUint16(8, 0, true);             // compression: store
      lv.setUint16(10, 0, true);            // mod time
      lv.setUint16(12, 0, true);            // mod date
      lv.setUint32(14, crc, true);          // crc-32
      lv.setUint32(18, file.data.length, true); // compressed size
      lv.setUint32(22, file.data.length, true); // uncompressed size
      lv.setUint16(26, nameBytes.length, true); // name length
      lv.setUint16(28, 0, true);            // extra length
      local.set(nameBytes, 30);
      local.set(file.data, 30 + nameBytes.length);
      localHeaders.push(local);

      // Central directory entry (46 bytes + name)
      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);  // signature
      cv.setUint16(4, 20, true);            // version made by
      cv.setUint16(6, 20, true);            // version needed
      cv.setUint16(8, 0, true);             // flags
      cv.setUint16(10, 0, true);            // compression: store
      cv.setUint16(12, 0, true);            // mod time
      cv.setUint16(14, 0, true);            // mod date
      cv.setUint32(16, crc, true);          // crc-32
      cv.setUint32(20, file.data.length, true); // compressed size
      cv.setUint32(24, file.data.length, true); // uncompressed size
      cv.setUint16(28, nameBytes.length, true); // name length
      cv.setUint16(30, 0, true);            // extra length
      cv.setUint16(32, 0, true);            // comment length
      cv.setUint16(34, 0, true);            // disk number
      cv.setUint16(36, 0, true);            // internal attrs
      cv.setUint32(38, 0, true);            // external attrs
      cv.setUint32(42, offset, true);       // local header offset
      central.set(nameBytes, 46);
      centralEntries.push(central);

      offset += local.length;
    }

    const centralDirOffset = offset;
    const centralDirSize = centralEntries.reduce((s, e) => s + e.length, 0);

    // End of central directory (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);     // signature
    ev.setUint16(4, 0, true);               // disk number
    ev.setUint16(6, 0, true);               // central dir disk
    ev.setUint16(8, files.length, true);     // entries on this disk
    ev.setUint16(10, files.length, true);    // total entries
    ev.setUint32(12, centralDirSize, true);  // central dir size
    ev.setUint32(16, centralDirOffset, true); // central dir offset
    ev.setUint16(20, 0, true);              // comment length

    const totalSize = offset + centralDirSize + 22;
    const result = new Uint8Array(totalSize);
    let pos = 0;
    for (const h of localHeaders) { result.set(h, pos); pos += h.length; }
    for (const e of centralEntries) { result.set(e, pos); pos += e.length; }
    result.set(eocd, pos);

    return new Blob([result], { type: 'application/zip' });
  }

  // CRC-32 lookup table
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    return table;
  })();

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  return { createZip };
})();

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const statusBar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');
  const progressFill = document.getElementById('progress-fill');
  const sectionsGrid = document.getElementById('sections-grid');
  const metaGrid = document.getElementById('meta-grid');
  const ocrText = document.getElementById('ocr-text');
  const jsonOutput = document.getElementById('json-output');
  const btnDownloadAll = document.getElementById('btn-download-all');
  const btnCopyText = document.getElementById('btn-copy-text');
  const btnCopyMeta = document.getElementById('btn-copy-metadata');

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // State
  let processedSections = [];
  let fullMetadata = {};
  let extractedText = '';

  // ── Load captured data (fetch from background via messaging) ────────────

  setStatus('Loading capture data...', 5);

  let captureData;
  try {
    const response = await chrome.runtime.sendMessage({ action: 'get-capture-data' });
    captureData = response?.captureData;
  } catch (err) {
    console.error('Failed to fetch capture data:', err);
  }

  if (!captureData) {
    setStatus('No capture data found. Gobble a page first!', 0, true);
    return;
  }

  const { captures, pageInfo, settings } = captureData;

  // ── Step 1: Stitch ────────────────────────────────────────────────────

  setStatus(`Stitching ${captures.length} viewport captures...`, 15);

  let fullCanvas;
  try {
    fullCanvas = await ImageProcessor.stitch(captures, pageInfo);
  } catch (err) {
    console.error('Stitch failed:', err);
    setStatus(`Stitch error: ${err.message}`, 15, true);
    return;
  }

  setStatus(`Stitched: ${fullCanvas.width} x ${fullCanvas.height}px`, 30);

  // ── Step 2: Smart Section ─────────────────────────────────────────────

  let sections;
  if (settings.enableSections) {
    setStatus('Finding smart section break points...', 40);
    sections = ImageProcessor.smartSection(fullCanvas, {
      sectionMaxHeight: settings.sectionMaxHeight,
      devicePixelRatio: pageInfo.devicePixelRatio,
    });
    setStatus(`Split into ${sections.length} section(s)`, 50);
  } else {
    sections = [{ canvas: fullCanvas, startY: 0, endY: fullCanvas.height, index: 0 }];
  }

  // ── Step 3: Compress each section ─────────────────────────────────────

  processedSections = [];
  for (let i = 0; i < sections.length; i++) {
    const pct = 50 + Math.round((i / sections.length) * 25);
    setStatus(`Compressing section ${i + 1} of ${sections.length}...`, pct);

    const result = await ImageProcessor.compress(sections[i].canvas, {
      maxFileSizeMB: settings.maxFileSizeMB,
      compressionStrategy: settings.compressionStrategy,
      quality: settings.quality,
    });

    const url = URL.createObjectURL(result.blob);
    processedSections.push({
      ...sections[i],
      blob: result.blob,
      url,
      format: result.format,
      quality: result.quality,
      scaled: result.scaled,
      scaleFactor: result.scaleFactor,
      sizeMB: (result.blob.size / (1024 * 1024)).toFixed(2),
    });
  }

  // ── Step 4: Extract Page Text ────────────────────────────────────────

  if (settings.enableOCR) {
    setStatus('Extracting page text...', 80);
    extractedText = buildDOMText(pageInfo);
  } else {
    extractedText = '(Text extraction disabled in settings)';
  }

  ocrText.textContent = extractedText || '(No text extracted)';

  // ── Step 5: Build metadata ────────────────────────────────────────────

  setStatus('Building metadata...', 90);

  fullMetadata = {
    source: {
      url: pageInfo.url,
      title: pageInfo.title,
      capturedAt: pageInfo.capturedAt,
      language: pageInfo.documentLang,
    },
    dimensions: {
      pageWidth: pageInfo.viewportWidth,
      pageHeight: pageInfo.pageHeight,
      devicePixelRatio: pageInfo.devicePixelRatio,
      capturedWidth: fullCanvas.width,
      capturedHeight: fullCanvas.height,
    },
    sections: processedSections.map((s, i) => ({
      index: i,
      format: s.format,
      quality: s.quality,
      sizeMB: s.sizeMB,
      scaled: s.scaled,
      scaleFactor: s.scaleFactor || 1,
      startY: s.startY,
      endY: s.endY,
      heightPx: s.endY - s.startY,
    })),
    pageStructure: {
      headings: pageInfo.headings,
      linkCount: pageInfo.linkCount,
      topLinks: pageInfo.topLinks?.slice(0, 20),
    },
    meta: pageInfo.metaTags,
    processing: {
      elapsedMs: captureData.elapsedMs,
      totalCaptures: captures.length,
      compressionStrategy: settings.compressionStrategy,
      textExtractionEnabled: settings.enableOCR,
    },
  };

  renderMetadata(pageInfo);
  jsonOutput.textContent = JSON.stringify(fullMetadata, null, 2);

  // ── Step 6: Render sections ───────────────────────────────────────────

  renderSections(processedSections);

  // ── Done ──────────────────────────────────────────────────────────────

  setStatus(`Done — ${processedSections.length} section(s), total ${totalSizeMB(processedSections)} MB`, 100);
  statusBar.classList.add('done');

  btnDownloadAll.disabled = false;
  btnCopyText.disabled = false;
  btnCopyMeta.disabled = false;

  // ── Event Handlers ────────────────────────────────────────────────────

  btnDownloadAll.addEventListener('click', () => downloadAllAsZip());
  btnCopyText.addEventListener('click', () => copyToClipboard(extractedText, btnCopyText));
  btnCopyMeta.addEventListener('click', () => copyToClipboard(JSON.stringify(fullMetadata, null, 2), btnCopyMeta));

  // ── Render Functions ──────────────────────────────────────────────────

  function renderSections(sectionList) {
    sectionsGrid.textContent = '';

    sectionList.forEach((s, i) => {
      const card = document.createElement('div');
      card.className = 'section-card';

      const formatLabel = s.format.split('/')[1].toUpperCase();
      const dims = `${s.canvas.width} x ${s.canvas.height}`;

      // Build header
      const header = document.createElement('div');
      header.className = 'section-card-header';

      const infoDiv = document.createElement('div');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `Section ${i + 1}`;
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'size';
      const scaleInfo = s.scaled ? ` · scaled ${Math.round((s.scaleFactor || 1) * 100)}%` : '';
      sizeSpan.textContent = `${dims} · ${s.sizeMB} MB · ${formatLabel} @ ${Math.round(s.quality * 100)}%${scaleInfo}`;
      infoDiv.appendChild(badge);
      infoDiv.appendChild(document.createTextNode(' '));
      infoDiv.appendChild(sizeSpan);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'section-card-actions';

      const dlBtn = document.createElement('button');
      dlBtn.textContent = 'Download';
      dlBtn.addEventListener('click', () => downloadSection(i));

      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', () => window.open(sectionList[i].url, '_blank'));

      actionsDiv.appendChild(dlBtn);
      actionsDiv.appendChild(openBtn);

      header.appendChild(infoDiv);
      header.appendChild(actionsDiv);
      card.appendChild(header);

      const img = document.createElement('img');
      img.src = s.url;
      img.alt = `Section ${i + 1}`;
      img.loading = 'lazy';
      card.appendChild(img);

      sectionsGrid.appendChild(card);
    });
  }

  function renderMetadata(info) {
    const items = [
      { label: 'URL', value: info.url, isLink: true },
      { label: 'Title', value: info.title },
      { label: 'Captured', value: info.capturedAt },
      { label: 'Page Size', value: `${info.viewportWidth} x ${info.pageHeight} px` },
      { label: 'Device Pixel Ratio', value: `${info.devicePixelRatio}x` },
      { label: 'Language', value: info.documentLang },
    ];

    metaGrid.textContent = '';

    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'meta-item';

      const label = document.createElement('div');
      label.className = 'meta-label';
      label.textContent = item.label;

      const val = document.createElement('div');
      val.className = 'meta-value';

      if (item.isLink) {
        const link = document.createElement('a');
        link.href = item.value;
        link.target = '_blank';
        link.textContent = item.value;
        val.appendChild(link);
      } else {
        val.textContent = item.value || '';
      }

      el.appendChild(label);
      el.appendChild(val);
      metaGrid.appendChild(el);
    });

    // Headings
    if (info.headings?.length > 0) {
      const el = document.createElement('div');
      el.className = 'meta-item';
      const label = document.createElement('div');
      label.className = 'meta-label';
      label.textContent = 'Page Structure';
      el.appendChild(label);

      const list = document.createElement('ul');
      list.className = 'headings-list';
      info.headings.forEach(h => {
        const li = document.createElement('li');
        li.className = `h${h.level}`;
        li.textContent = `${'\u2014'.repeat(h.level - 1)} ${h.text}`;
        list.appendChild(li);
      });

      const val = document.createElement('div');
      val.className = 'meta-value';
      val.appendChild(list);
      el.appendChild(val);
      metaGrid.appendChild(el);
    }

    // Meta tags
    if (info.metaTags) {
      const entries = Object.entries(info.metaTags).slice(0, 10);
      if (entries.length > 0) {
        const el = document.createElement('div');
        el.className = 'meta-item';
        const label = document.createElement('div');
        label.className = 'meta-label';
        label.textContent = 'Meta Tags';
        el.appendChild(label);

        const val = document.createElement('div');
        val.className = 'meta-value';
        entries.forEach(([k, v], idx) => {
          const strong = document.createElement('strong');
          strong.textContent = k;
          val.appendChild(strong);
          val.appendChild(document.createTextNode(`: ${v}`));
          if (idx < entries.length - 1) val.appendChild(document.createElement('br'));
        });
        el.appendChild(val);
        metaGrid.appendChild(el);
      }
    }
  }

  // ── Utility Functions ─────────────────────────────────────────────────

  function setStatus(text, pct, isError = false) {
    statusText.textContent = text;
    progressFill.style.width = `${pct}%`;
    if (isError) {
      statusBar.classList.add('error');
    }
  }

  function totalSizeMB(sectionList) {
    return sectionList.reduce((sum, s) => sum + parseFloat(s.sizeMB), 0).toFixed(2);
  }

  function downloadSection(index) {
    const section = processedSections[index];
    const ext = section.format.split('/')[1];
    const name = `gobble_${sanitizeFilename(fullMetadata.source.title)}_section${index + 1}.${ext}`;
    triggerDownload(section.url, name);
  }

  async function downloadAllAsZip() {
    const btn = btnDownloadAll;
    const origText = btn.textContent;
    btn.textContent = 'Bundling...';
    btn.disabled = true;

    try {
      const baseName = sanitizeFilename(fullMetadata.source.title);
      const files = [];

      // Add image sections
      for (let i = 0; i < processedSections.length; i++) {
        const s = processedSections[i];
        const ext = s.format.split('/')[1];
        const data = new Uint8Array(await s.blob.arrayBuffer());
        files.push({ name: `section_${i + 1}.${ext}`, data });
      }

      // Add metadata JSON
      const metaStr = JSON.stringify(fullMetadata, null, 2);
      files.push({
        name: 'metadata.json',
        data: new TextEncoder().encode(metaStr),
      });

      // Add full page text
      if (extractedText) {
        files.push({
          name: 'page_text.txt',
          data: new TextEncoder().encode(extractedText),
        });
      }

      // Add DOM structure
      if (captureData.pageInfo.domStructure) {
        files.push({
          name: 'dom_structure.html',
          data: new TextEncoder().encode(captureData.pageInfo.domStructure),
        });
      }

      // Add image assets catalog
      if (captureData.pageInfo.imageAssets) {
        files.push({
          name: 'assets.json',
          data: new TextEncoder().encode(JSON.stringify(captureData.pageInfo.imageAssets, null, 2)),
        });
      }

      // Add structured data (JSON-LD, Open Graph, Twitter)
      if (captureData.pageInfo.structuredData?.length > 0) {
        files.push({
          name: 'structured_data.json',
          data: new TextEncoder().encode(JSON.stringify(captureData.pageInfo.structuredData, null, 2)),
        });
      }

      // Add design tokens (colors, fonts, CSS vars)
      if (captureData.pageInfo.designTokens) {
        files.push({
          name: 'design_tokens.json',
          data: new TextEncoder().encode(JSON.stringify(captureData.pageInfo.designTokens, null, 2)),
        });
      }

      // Add stylesheets
      if (captureData.pageInfo.stylesheets?.length > 0) {
        const cssFiles = captureData.pageInfo.stylesheets
          .filter(s => s.css)
          .map(s => s.type === 'inline' ? `/* Inline style block ${s.index} */\n${s.css}` : `/* ${s.href} */\n${s.css}`)
          .join('\n\n');
        if (cssFiles) {
          files.push({
            name: 'styles.css',
            data: new TextEncoder().encode(cssFiles),
          });
        }
      }

      // Add external resources map
      if (captureData.pageInfo.externalResources) {
        files.push({
          name: 'resources.json',
          data: new TextEncoder().encode(JSON.stringify(captureData.pageInfo.externalResources, null, 2)),
        });
      }

      // Add forms
      if (captureData.pageInfo.forms?.length > 0) {
        files.push({
          name: 'forms.json',
          data: new TextEncoder().encode(JSON.stringify(captureData.pageInfo.forms, null, 2)),
        });
      }

      // Add full link map
      if (captureData.pageInfo.allLinks?.length > 0) {
        files.push({
          name: 'links.json',
          data: new TextEncoder().encode(JSON.stringify(captureData.pageInfo.allLinks, null, 2)),
        });
      }

      // Add console logs
      if (captureData.pageInfo.consoleLogs?.length > 0) {
        const logText = captureData.pageInfo.consoleLogs
          .map(e => `[${e.timestamp}] [${e.level.toUpperCase()}] ${e.message}`)
          .join('\n');
        files.push({
          name: 'console.log',
          data: new TextEncoder().encode(logText),
        });
      }

      const zipBlob = ZipBuilder.createZip(files);
      const zipUrl = URL.createObjectURL(zipBlob);
      triggerDownload(zipUrl, `gobble_${baseName}.zip`);

      btn.textContent = 'Downloaded!';
      setTimeout(() => {
        btn.textContent = origText;
        btn.disabled = false;
        URL.revokeObjectURL(zipUrl);
      }, 2000);
    } catch (err) {
      console.error('ZIP creation failed:', err);
      btn.textContent = origText;
      btn.disabled = false;

      // Fallback: download files individually
      processedSections.forEach((_, i) => {
        setTimeout(() => downloadSection(i), i * 300);
      });

      const metaBlob = new Blob([JSON.stringify(fullMetadata, null, 2)], { type: 'application/json' });
      const metaUrl = URL.createObjectURL(metaBlob);
      const title = sanitizeFilename(fullMetadata.source.title);
      setTimeout(() => triggerDownload(metaUrl, `gobble_${title}_metadata.json`), processedSections.length * 300);

      if (extractedText) {
        const textBlob = new Blob([extractedText], { type: 'text/plain' });
        const textUrl = URL.createObjectURL(textBlob);
        setTimeout(() => triggerDownload(textUrl, `gobble_${title}_text.txt`), (processedSections.length + 1) * 300);
      }
    }
  }

  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { /* best effort */ }
      ta.remove();
    }
  }

  function sanitizeFilename(str) {
    return (str || 'page').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  }

  function buildDOMText(info) {
    const parts = [];
    if (info.title) parts.push(`# ${info.title}\n`);
    if (info.url) parts.push(`URL: ${info.url}\n`);

    if (info.metaTags?.description) {
      parts.push(`## Description\n${info.metaTags.description}\n`);
    }

    if (info.headings?.length) {
      parts.push('## Page Structure\n');
      info.headings.forEach(h => {
        parts.push(`${'#'.repeat(h.level)} ${h.text}`);
      });
      parts.push('');
    }

    // Full visible text content (the main payload for AI agents)
    if (info.visibleText) {
      parts.push('## Full Page Text\n');
      parts.push(info.visibleText);
      parts.push('');
    }

    if (info.topLinks?.length) {
      parts.push('## Key Links\n');
      info.topLinks.slice(0, 30).forEach(l => {
        parts.push(`- [${l.text}](${l.href})`);
      });
    }

    return parts.join('\n');
  }
})();
