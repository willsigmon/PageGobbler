/**
 * PageGobbler — Popup Controller
 */

document.addEventListener('DOMContentLoaded', () => {
  const btnCapture = document.getElementById('btn-capture');
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsPanel = document.getElementById('settings-panel');
  const status = document.getElementById('status');
  const qualitySlider = document.getElementById('set-quality');
  const qualityLabel = document.getElementById('quality-label');
  const oneClickCheckbox = document.getElementById('set-oneclick');
  const oneClickHint = document.getElementById('oneclick-hint');

  // ── Load saved settings ───────────────────────────────────────────────

  chrome.runtime.sendMessage({ action: 'get-settings' }, (response) => {
    if (!response?.settings) return;
    const s = response.settings;

    document.getElementById('set-max-size').value = s.maxFileSizeMB || 3;
    document.getElementById('set-compression').value = s.compressionStrategy || 'auto';
    document.getElementById('set-section-height').value = s.sectionMaxHeight || 4096;
    document.getElementById('set-ocr').checked = s.enableOCR !== false;
    document.getElementById('set-sections').checked = s.enableSections !== false;
    oneClickCheckbox.checked = s.oneClickMode === true;
    qualitySlider.value = s.quality || 0.92;
    qualityLabel.textContent = `${Math.round((s.quality || 0.92) * 100)}%`;

    updateOneClickHint(s.oneClickMode === true);
  });

  // ── Quality slider ────────────────────────────────────────────────────

  qualitySlider.addEventListener('input', () => {
    qualityLabel.textContent = `${Math.round(qualitySlider.value * 100)}%`;
  });

  // ── 1-Click toggle — save immediately on change ─────────────────────

  oneClickCheckbox.addEventListener('change', () => {
    const enabled = oneClickCheckbox.checked;
    updateOneClickHint(enabled);

    // Save just the oneClickMode setting right away
    const settings = gatherSettings();
    chrome.runtime.sendMessage({ action: 'save-settings', settings });
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
    settingsToggle.classList.toggle('open');
    settingsPanel.classList.toggle('open');
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

        if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
          status.className = 'status error';
          status.textContent = 'Cannot capture browser internal pages.';
          btnCapture.disabled = false;
          return;
        }

        chrome.runtime.sendMessage({ action: 'start-capture', tabId: tab.id });
        status.className = 'status';
        status.textContent = 'Gobbling... results will open in a new tab.';

        setTimeout(() => window.close(), 800);
      });
    });
  });

  // ── Helpers ─────────────────────────────────────────────────────────

  function gatherSettings() {
    return {
      maxFileSizeMB: parseFloat(document.getElementById('set-max-size').value) || 3,
      compressionStrategy: document.getElementById('set-compression').value,
      sectionMaxHeight: parseInt(document.getElementById('set-section-height').value) || 4096,
      enableOCR: document.getElementById('set-ocr').checked,
      enableSections: document.getElementById('set-sections').checked,
      quality: parseFloat(qualitySlider.value) || 0.92,
      oneClickMode: oneClickCheckbox.checked,
    };
  }
});
