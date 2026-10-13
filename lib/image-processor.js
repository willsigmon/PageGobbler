/**
 * PageGobbler — Image Processing Module
 * Handles stitching viewport captures, compression, and smart sectioning.
 * Runs in the viewer page context (has access to Canvas, OffscreenCanvas, etc.)
 */

const ImageProcessor = {
  MAX_FILE_SIZE: 3 * 1024 * 1024, // 3 MB
  SECTION_MAX_HEIGHT: 4096,
  MAX_CANVAS_DIMENSION: 32767,
  MAX_CANVAS_AREA: 268435456,

  /**
   * Line up viewport captures as one virtual full-page image.
   * Nothing is drawn into a single page-sized canvas: Chrome caps a canvas at
   * 32767px tall, which a long page (or a shorter one on a 2x display) easily
   * exceeds. Sections are drawn straight from the captures instead.
   * @param {Array} captures - [{dataUrl, scrollY, viewportHeight, clipHeight, index}]
   * @param {Object} pageInfo - {pageHeight, viewportWidth, devicePixelRatio}
   * @returns {Promise<{width: number, height: number, pieces: Array}>}
   */
  async stitch(captures, pageInfo) {
    if (!Array.isArray(captures) || captures.length === 0) {
      throw new Error('No viewport captures were received.');
    }

    // Sort by scroll position
    captures.sort((a, b) => a.scrollY - b.scrollY);

    // Load all images
    const images = await Promise.all(
      captures.map(c => this._loadImage(c.dataUrl))
    );

    // The captured images are at device pixel ratio scale
    const dpr = pageInfo.devicePixelRatio || 1;
    const width = images[0].naturalWidth;
    const height = Math.ceil(pageInfo.pageHeight * dpr);

    // Each capture covers [destY, destY + srcHeight) of the page; the last
    // capture might be partial, so only its valid region is used.
    const pieces = captures.map((cap, i) => {
      const img = images[i];
      const destY = Math.round(cap.scrollY * dpr);
      const srcHeight = Math.min(Math.round(cap.clipHeight * dpr), img.naturalHeight, height - destY);
      return { img, destY, srcHeight };
    }).filter(p => p.srcHeight > 0);

    return { width, height, pieces };
  },

  /** Whether the whole stitched page fits in one canvas. */
  fitsSingleCanvas(page) {
    return page.width <= this.MAX_CANVAS_DIMENSION
      && page.height <= this.MAX_CANVAS_DIMENSION
      && page.width * page.height <= this.MAX_CANVAS_AREA;
  },

  /**
   * Draw the whole stitched page into one canvas (sections turned off).
   * @returns {HTMLCanvasElement}
   */
  toCanvas(page) {
    if (!this.fitsSingleCanvas(page)) {
      throw new Error(
        `Page is too large for a single image (${page.width} x ${page.height}px). Turn on section splitting to keep the whole page.`
      );
    }
    return this._renderRegion(page, 0, page.height, page.width).canvas;
  },

  /**
   * Draw page rows [startY, startY + height) into a new canvas, scaled to
   * outWidth across (rows are never scaled vertically).
   */
  _renderRegion(page, startY, height, outWidth, contextOptions) {
    const canvas = document.createElement('canvas');
    canvas.width = outWidth;
    canvas.height = height;
    const ctx = canvas.getContext('2d', contextOptions);
    if (outWidth !== page.width) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'medium';
    }
    const endY = startY + height;
    for (const { img, destY, srcHeight } of page.pieces) {
      const top = Math.max(startY, destY);
      const bottom = Math.min(endY, destY + srcHeight);
      if (bottom <= top) continue;
      ctx.drawImage(
        img,
        0, top - destY, img.naturalWidth, bottom - top, // source rect
        0, top - startY, outWidth, bottom - top,         // dest rect
      );
    }
    return { canvas, ctx };
  },

  /**
   * Compress a canvas to meet the target file size.
   * Tries WebP first, then JPEG with decreasing quality, then scales down.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} options
   * @returns {Promise<{blob: Blob, format: string, quality: number, scaled: boolean}>}
   */
  async compress(canvas, options = {}) {
    const maxSize = (options.maxFileSizeMB || 3) * 1024 * 1024;
    const strategy = options.compressionStrategy || 'auto';
    const baseQuality = this._clampQuality(options.quality ?? 0.92);

    // Lossless means "do not degrade." If the PNG is over target, report it
    // honestly instead of returning null and breaking the viewer.
    if (strategy === 'lossless') {
      const blob = await this._canvasToBlob(canvas, 'image/png', 1.0);
      return {
        blob,
        format: 'image/png',
        quality: 1,
        scaled: false,
        overLimit: blob.size > maxSize,
      };
    }

    const isAggressive = strategy === 'aggressive';
    const webpStart = isAggressive ? Math.min(baseQuality, 0.82) : baseQuality;
    const webpFloor = isAggressive ? 0.2 : 0.3;
    const jpegStart = isAggressive ? Math.min(baseQuality, 0.78) : Math.min(baseQuality, 0.9);
    const jpegFloor = isAggressive ? 0.2 : 0.3;

    // Try WebP first (best compression). The slider is the starting quality,
    // not decoration: users choosing 70% should not get an attempted 92% first.
    for (const q of this._qualitySteps(webpStart, webpFloor, isAggressive ? 0.08 : 0.07)) {
      const result = await this._tryFormat(canvas, 'image/webp', q, maxSize);
      if (result) return result;
    }

    // Try JPEG next for pages where WebP is not the smallest.
    for (const q of this._qualitySteps(jpegStart, jpegFloor, isAggressive ? 0.08 : 0.07)) {
      const result = await this._tryFormat(canvas, 'image/jpeg', q, maxSize);
      if (result) return result;
    }

    // Still too large — scale down. Aggressive starts smaller and steps down
    // faster; auto preserves more pixels before conceding.
    let scale = isAggressive ? 0.7 : 0.85;
    const scaleStep = isAggressive ? 0.12 : 0.1;
    while (scale >= 0.25) {
      const scaled = this._scaleCanvas(canvas, scale);
      const scaledStart = isAggressive ? Math.min(baseQuality, 0.7) : Math.min(baseQuality, 0.82);
      const scaledFloor = isAggressive ? 0.18 : 0.35;
      for (const q of this._qualitySteps(scaledStart, scaledFloor, isAggressive ? 0.1 : 0.12)) {
        const result = await this._tryFormat(scaled, 'image/webp', q, maxSize);
        if (result) return { ...result, scaled: true, scaleFactor: scale };
      }
      scale -= scaleStep;
    }

    // Last resort: force JPEG at very low quality. Mark it if even this misses.
    const lastScale = isAggressive ? 0.35 : 0.5;
    const lastQuality = isAggressive ? 0.2 : 0.3;
    const lastResort = this._scaleCanvas(canvas, lastScale);
    const blob = await this._canvasToBlob(lastResort, 'image/jpeg', lastQuality);
    return {
      blob,
      format: 'image/jpeg',
      quality: lastQuality,
      scaled: true,
      scaleFactor: lastScale,
      overLimit: blob.size > maxSize,
    };
  },

  /**
   * Split the stitched page into smart sections.
   * Tries to find natural break points (whitespace rows) near section boundaries.
   * @param {{width: number, height: number, pieces: Array}} page - from stitch()
   * @param {Object} options
   * @returns {Array<{canvas: HTMLCanvasElement, startY: number, endY: number, index: number}>}
   */
  smartSection(page, options = {}) {
    const maxSectionHeight = options.sectionMaxHeight || this.SECTION_MAX_HEIGHT;
    const totalHeight = page.height;

    const sections = [];
    let currentY = 0;
    let index = 0;

    while (currentY < totalHeight) {
      let endY = Math.min(currentY + maxSectionHeight, totalHeight);

      // Try to find a natural break point (row of mostly similar/white pixels)
      if (endY < totalHeight) {
        endY = this._findBreakPoint(page, currentY, endY, maxSectionHeight);
      }

      const sectionHeight = endY - currentY;
      const { canvas: section } = this._renderRegion(page, currentY, sectionHeight, page.width);

      sections.push({ canvas: section, startY: currentY, endY, index });
      currentY = endY;
      index++;
    }

    return sections;
  },

  /**
   * Find a good break point near the target endY.
   * Scans ±200px around endY for rows with low variance (whitespace/dividers).
   */
  _findBreakPoint(page, startY, targetEndY, maxHeight) {
    const searchRange = 200; // px to search above/below target
    const scanStart = Math.max(startY + Math.floor(maxHeight * 0.7), targetEndY - searchRange);
    const scanEnd = Math.min(targetEndY + searchRange, page.height);
    const scanHeight = Math.max(1, scanEnd - scanStart);
    const sampleWidth = Math.max(1, Math.min(page.width, 512));

    // Read pixels from a small dedicated readback canvas (willReadFrequently),
    // downscaled across, so section detection stays fast.
    const { ctx: sampleCtx } = this._renderRegion(
      page, scanStart, scanHeight, sampleWidth, { willReadFrequently: true },
    );

    const sampledRows = sampleCtx.getImageData(0, 0, sampleWidth, scanHeight).data;
    const rowStride = sampleWidth * 4;

    let bestY = targetEndY;
    let bestVariance = Infinity;

    // Sample every 4th row for performance
    for (let localY = 0; localY < scanHeight; localY += 4) {
      const rowStart = localY * rowStride;
      const rowData = sampledRows.subarray(rowStart, rowStart + rowStride);
      const variance = this._rowVariance(rowData);

      if (variance < bestVariance) {
        bestVariance = variance;
        bestY = scanStart + localY;
      }
    }

    return bestY;
  },

  /**
   * Calculate color variance of a pixel row (lower = more uniform = better break point).
   */
  _rowVariance(pixelData) {
    let sumR = 0, sumG = 0, sumB = 0;
    const count = pixelData.length / 4;

    for (let i = 0; i < pixelData.length; i += 4) {
      sumR += pixelData[i];
      sumG += pixelData[i + 1];
      sumB += pixelData[i + 2];
    }

    const avgR = sumR / count;
    const avgG = sumG / count;
    const avgB = sumB / count;

    let variance = 0;
    for (let i = 0; i < pixelData.length; i += 4) {
      variance += (pixelData[i] - avgR) ** 2;
      variance += (pixelData[i + 1] - avgG) ** 2;
      variance += (pixelData[i + 2] - avgB) ** 2;
    }

    return variance / count;
  },

  _scaleCanvas(canvas, scale) {
    const scaled = document.createElement('canvas');
    scaled.width = Math.round(canvas.width * scale);
    scaled.height = Math.round(canvas.height * scale);
    const ctx = scaled.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    return scaled;
  },

  async _tryFormat(canvas, format, quality, maxSize) {
    const blob = await this._canvasToBlob(canvas, format, quality);
    if (!blob) return null;
    if (blob.size <= maxSize) {
      return { blob, format, quality, scaled: false, overLimit: false };
    }
    return null;
  },

  _clampQuality(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.92;
    return Math.max(0.1, Math.min(1, n));
  },

  _qualitySteps(start, floor, step) {
    const steps = [];
    let q = this._clampQuality(start);
    const min = this._clampQuality(floor);
    while (q >= min) {
      steps.push(Number(q.toFixed(2)));
      q -= step;
    }
    if (!steps.includes(min)) steps.push(min);
    return steps;
  },

  _canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    });
  },

  _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  },
};
