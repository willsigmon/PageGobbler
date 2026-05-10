/**
 * PageGobbler — Popup Controller
 */

document.addEventListener('DOMContentLoaded', () => {
  const btnCapture = document.getElementById('btn-capture');
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsPanel = document.getElementById('settings-panel');
  const status = document.getElementById('status');
  const pageCard = document.getElementById('page-card');
  const pageTitle = document.getElementById('page-title');
  const pageUrl = document.getElementById('page-url');
  const qualitySlider = document.getElementById('set-quality');
  const qualityLabel = document.getElementById('quality-label');
  const oneClickCheckbox = document.getElementById('set-oneclick');
  const oneClickHint = document.getElementById('oneclick-hint');
  const presetButtons = [...document.querySelectorAll('.preset')];

  const CAPTURE_BLOCKED_PATTERN = /^(chrome|chrome-extension|edge|about|brave|vivaldi|opera):/i;
  const PRESETS = {
    balanced: {
      maxFileSizeMB: 3,
      compressionStrategy: 'auto',
      sectionMaxHeight: 4096,
      enableOCR: true,
      enableSections: true,
      quality: 0.92,
    },
    fast: {
      maxFileSizeMB: 1.5,
      compressionStrategy: 'aggressive',
      sectionMaxHeight: 3072,
      enableOCR: true,
      enableSections: true,
      quality: 0.72,
    },
    crisp: {
      maxFileSizeMB: 8,
      compressionStrategy: 'auto',
      sectionMaxHeight: 8192,
      enableOCR: true,
      enableSections: true,
      quality: 0.98,
    },
  };

  let saveTimer = null;
  let progressTimer = null;

  // ── Load saved settings ───────────────────────────────────────────────

  chrome.runtime.sendMessage({ action: 'get-settings' }, (response) => {
    if (!response?.settings) return;
    applySettings(response.settings);
  });

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    renderActiveTab(tab);
  });

  // ── Quality slider ────────────────────────────────────────────────────

  qualitySlider.addEventListener('input', () => {
    updateQualityLabel();
    updatePresetState();
    queueSettingsSave();
  });

  // ── 1-Click toggle — save immediately on change ─────────────────────

  oneClickCheckbox.addEventListener('change', () => {
    const enabled = oneClickCheckbox.checked;
    updateOneClickHint(enabled);

    // Save just the oneClickMode setting right away
    saveSettings({ quiet: true });
  });

  document.querySelectorAll('.settings-panel input, .settings-panel select').forEach((control) => {
    if (control === qualitySlider || control === oneClickCheckbox) return;
    control.addEventListener('input', () => {
      updatePresetState();
      queueSettingsSave();
    });
    control.addEventListener('change', () => {
      updatePresetState();
      queueSettingsSave();
    });
  });

  presetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const preset = PRESETS[button.dataset.preset];
      if (!preset) return;
      applySettings({ ...gatherSettings(), ...preset });
      saveSettings({ quiet: true });
      setStatus(`Preset applied: ${button.querySelector('strong')?.textContent || button.dataset.preset}`, 'success');
    });
  });

  function updateOneClickHint(enabled) {
    if (enabled) {
      oneClickHint.textContent = 'Enabled — this popup won\'t open. Click turkey icon to gobble instantly.';
      oneClickHint.style.color = '#E8A849';
    } else {
      oneClickHint.textContent = 'Click the turkey icon to instantly gobble — no popup.';
      oneClickHint.style.color = '';
    }
  }

  // ── Settings toggle ───────────────────────────────────────────────────

  settingsToggle.addEventListener('click', () => {
    toggleSettings();
  });

  settingsToggle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleSettings();
    }
  });

  // ── Capture button ────────────────────────────────────────────────────

  btnCapture.addEventListener('click', async () => {
    btnCapture.disabled = true;
    status.className = 'status';
    status.textContent = 'Gobbling page...';

    const settings = gatherSettings();

    chrome.runtime.sendMessage({ action: 'save-settings', settings }, () => {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab) {
          status.className = 'status error';
          status.textContent = 'No active tab found.';
          btnCapture.disabled = false;
          return;
        }

        if (isCaptureBlocked(tab.url)) {
          status.className = 'status error';
          status.textContent = 'Cannot capture browser/internal pages.';
          btnCapture.disabled = false;
          return;
        }

        chrome.runtime.sendMessage({ action: 'start-capture', tabId: tab.id }, (response) => {
          if (chrome.runtime.lastError || response?.ok === false) {
            status.className = 'status error';
            status.textContent = response?.error || chrome.runtime.lastError?.message || 'Could not start capture.';
            btnCapture.disabled = false;
            return;
          }

          status.className = 'status';
          status.textContent = 'Gobbling... keep this open or click away.';
          watchCaptureProgress();
        });
      });
    });
  });

  // ── Helpers ─────────────────────────────────────────────────────────

  function renderActiveTab(tab) {
    if (!tab) {
      pageCard.classList.add('blocked');
      pageTitle.textContent = 'No active tab found';
      pageUrl.textContent = 'Open a normal web page, then try again.';
      btnCapture.disabled = true;
      return;
    }

    const blocked = isCaptureBlocked(tab.url);
    pageCard.classList.toggle('blocked', blocked);
    pageTitle.textContent = blocked ? 'This page cannot be gobbled' : (tab.title || 'Ready to gobble this page');
    pageUrl.textContent = blocked ? 'Chrome blocks extension capture here.' : readableUrl(tab.url);
    btnCapture.disabled = blocked;
  }

  function readableUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    } catch (_) {
      return url || 'Active tab';
    }
  }

  function isCaptureBlocked(url = '') {
    return !url || CAPTURE_BLOCKED_PATTERN.test(url);
  }

  function toggleSettings() {
    const open = !settingsPanel.classList.contains('open');
    settingsToggle.classList.toggle('open', open);
    settingsPanel.classList.toggle('open', open);
    settingsToggle.setAttribute('aria-expanded', String(open));
  }

  function applySettings(s) {
    document.getElementById('set-max-size').value = s.maxFileSizeMB || 3;
    document.getElementById('set-compression').value = s.compressionStrategy || 'auto';
    document.getElementById('set-section-height').value = s.sectionMaxHeight || 4096;
    document.getElementById('set-ocr').checked = s.enableOCR !== false;
    document.getElementById('set-sections').checked = s.enableSections !== false;
    oneClickCheckbox.checked = s.oneClickMode === true;
    qualitySlider.value = s.quality || 0.92;
    updateQualityLabel();
    updateOneClickHint(s.oneClickMode === true);
    updatePresetState();
  }

  function updateQualityLabel() {
    qualityLabel.textContent = `${Math.round(qualitySlider.value * 100)}%`;
  }

  function queueSettingsSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveSettings({ quiet: true }), 350);
  }

  function saveSettings({ quiet = false } = {}) {
    const settings = gatherSettings();
    chrome.runtime.sendMessage({ action: 'save-settings', settings }, (response) => {
      if (chrome.runtime.lastError || !response?.settings) return;
      if (!quiet) setStatus('Settings saved.', 'success');
    });
  }

  function updatePresetState() {
    const current = gatherSettings();
    presetButtons.forEach((button) => {
      const preset = PRESETS[button.dataset.preset];
      button.classList.toggle('active', Boolean(preset && matchesPreset(current, preset)));
    });
  }

  function matchesPreset(current, preset) {
    return Number(current.maxFileSizeMB) === Number(preset.maxFileSizeMB)
      && current.compressionStrategy === preset.compressionStrategy
      && Number(current.sectionMaxHeight) === Number(preset.sectionMaxHeight)
      && current.enableOCR === preset.enableOCR
      && current.enableSections === preset.enableSections
      && Math.abs(Number(current.quality) - Number(preset.quality)) < 0.001;
  }

  function setStatus(message, type = '') {
    status.className = `status ${type}`.trim();
    status.textContent = message;
  }

  function watchCaptureProgress() {
    clearInterval(progressTimer);

    const renderProgress = (response) => {
      if (!response) return;
      const { phase, current = 0, total = 0, error } = response;

      if (error || phase === 'error') {
        setStatus(error || 'Capture failed.', 'error');
        btnCapture.disabled = false;
        clearInterval(progressTimer);
        return;
      }

      if (phase === 'measuring') {
        setStatus('Measuring page...');
        return;
      }

      if (phase === 'capturing') {
        const totalText = total > 0 ? ` of ${total}` : '';
        setStatus(`Gobbling viewport ${current}${totalText}...`);
        return;
      }

      if (phase === 'processing') {
        setStatus('Stitching and opening results...');
        return;
      }

      if (phase === 'done') {
        setStatus('Gobbled — opening results.', 'success');
        clearInterval(progressTimer);
        setTimeout(() => window.close(), 1200);
      }
    };

    const poll = () => {
      chrome.runtime.sendMessage({ action: 'get-progress' }, (response) => {
        if (chrome.runtime.lastError) {
          clearInterval(progressTimer);
          return;
        }
        renderProgress(response);
      });
    };

    poll();
    progressTimer = setInterval(poll, 350);
  }

  function gatherSettings() {
    return {
      maxFileSizeMB: clampNumber(parseFloat(document.getElementById('set-max-size').value), 1, 20, 3),
      compressionStrategy: document.getElementById('set-compression').value,
      sectionMaxHeight: clampNumber(parseInt(document.getElementById('set-section-height').value), 1024, 16384, 4096),
      enableOCR: document.getElementById('set-ocr').checked,
      enableSections: document.getElementById('set-sections').checked,
      quality: clampNumber(parseFloat(qualitySlider.value), 0.3, 1, 0.92),
      oneClickMode: oneClickCheckbox.checked,
    };
  }

  function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }
});
