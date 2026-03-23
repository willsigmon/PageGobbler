/**
 * PageGobbler — Image Processing Module
 * Handles stitching viewport captures, compression, and smart sectioning.
 * Runs in the viewer page context (has access to Canvas, OffscreenCanvas, etc.)
 */

const ImageProcessor = {
  MAX_FILE_SIZE: 3 * 1024 * 1024, // 3 MB
  SECTION_MAX_HEIGHT: 4096,

  /**
   * Stitch an array of viewport captures into a single full-page canvas.
   * @param {Array} captures - [{dataUrl, scrollY, viewportHeight, clipHeight, index}]
   * @param {Object} pageInfo - {pageHeight, viewportWidth, devicePixelRatio}
   * @returns {Promise<HTMLCanvasElement>}
   */
  async stitch(captures, pageInfo) {
    // Sort by scroll position
    captures.sort((a, b) => a.scrollY - b.scrollY);

    // Load all images
    const images = await Promise.all(
      captures.map(c => this._loadImage(c.dataUrl))
    );

    // Determine output dimensions
    // The captured images are at device pixel ratio scale
    const dpr = pageInfo.devicePixelRatio || 1;
    const canvasWidth = images[0].naturalWidth;
    const scaledPageHeight = Math.ceil(pageInfo.pageHeight * dpr);

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = scaledPageHeight;
    const ctx = canvas.getContext('2d');

    // Draw each capture at its scroll offset
    captures.forEach((cap, i) => {
      const img = images[i];
      const destY = Math.round(cap.scrollY * dpr);
      const srcHeight = Math.round(cap.clipHeight * dpr);

      // Clip to only the valid region (last capture might be partial)
      ctx.drawImage(
        img,
        0, 0, img.naturalWidth, srcHeight,  // source rect
        0, destY, canvasWidth, srcHeight     // dest rect
      );
    });

    return canvas;
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

    // Strategy: try formats in order of efficiency
    const attempts = [];

    if (strategy === 'lossless') {
      return this._tryFormat(canvas, 'image/png', 1.0, maxSize);
    }

    // Try WebP first (best compression)
    for (let q = 0.92; q >= 0.3; q -= 0.1) {
      const result = await this._tryFormat(canvas, 'image/webp', q, maxSize);
      if (result) return result;
    }

    // Try JPEG
    for (let q = 0.85; q >= 0.3; q -= 0.1) {
      const result = await this._tryFormat(canvas, 'image/jpeg', q, maxSize);
      if (result) return result;
    }

    // Still too large — scale down
    let scale = 0.75;
    while (scale >= 0.25) {
      const scaled = this._scaleCanvas(canvas, scale);
      for (let q = 0.8; q >= 0.4; q -= 0.15) {
        const result = await this._tryFormat(scaled, 'image/webp', q, maxSize);
        if (result) return { ...result, scaled: true, scaleFactor: scale };
      }
      scale -= 0.1;
    }

    // Last resort: force JPEG at very low quality, scaled to 50%
    const lastResort = this._scaleCanvas(canvas, 0.5);
    const blob = await this._canvasToBlob(lastResort, 'image/jpeg', 0.3);
    return { blob, format: 'image/jpeg', quality: 0.3, scaled: true, scaleFactor: 0.5 };
  },

  /**
   * Split a canvas into smart sections.
   * Tries to find natural break points (whitespace rows) near section boundaries.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} options
   * @returns {Array<{canvas: HTMLCanvasElement, startY: number, endY: number, index: number}>}
   */
  smartSection(canvas, options = {}) {
    const maxSectionHeight = options.sectionMaxHeight || this.SECTION_MAX_HEIGHT;
    const dpr = options.devicePixelRatio || 1;
    const totalHeight = canvas.height;

    if (totalHeight <= maxSectionHeight) {
      return [{ canvas, startY: 0, endY: totalHeight, index: 0 }];
    }

    const sections = [];
    let currentY = 0;
    let index = 0;

    while (currentY < totalHeight) {
      let endY = Math.min(currentY + maxSectionHeight, totalHeight);

      // Try to find a natural break point (row of mostly similar/white pixels)
      if (endY < totalHeight) {
        endY = this._findBreakPoint(canvas, currentY, endY, maxSectionHeight);
      }

      const sectionHeight = endY - currentY;
      const section = document.createElement('canvas');
      section.width = canvas.width;
      section.height = sectionHeight;
      const ctx = section.getContext('2d');
      ctx.drawImage(canvas, 0, currentY, canvas.width, sectionHeight, 0, 0, canvas.width, sectionHeight);

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
  _findBreakPoint(canvas, startY, targetEndY, maxHeight) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const searchRange = 200; // px to search above/below target
    const scanStart = Math.max(startY + Math.floor(maxHeight * 0.7), targetEndY - searchRange);
    const scanEnd = Math.min(targetEndY + searchRange, canvas.height);

    let bestY = targetEndY;
    let bestVariance = Infinity;

    // Sample every 4th row for performance
    for (let y = scanStart; y < scanEnd; y += 4) {
      // Sample pixels across the row
      const rowData = ctx.getImageData(0, y, canvas.width, 1).data;
      const variance = this._rowVariance(rowData);

      if (variance < bestVariance) {
        bestVariance = variance;
        bestY = y;
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
    if (blob.size <= maxSize) {
      return { blob, format, quality, scaled: false };
    }
    return null;
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
