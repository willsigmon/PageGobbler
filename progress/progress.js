/**
 * PageGobbler — Progress Window
 * Polls background for capture progress and displays it.
 */

const titleEl = document.querySelector('.title');
const fillEl = document.getElementById('fill');
const statusEl = document.getElementById('status');

let pollTimer = null;

async function poll() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'get-progress' });
    if (!response) return;

    const { phase, current, total, error } = response;

    if (phase === 'idle' || phase === 'done') {
      titleEl.textContent = 'Gobbled!';
      titleEl.className = 'title done';
      fillEl.style.width = '100%';
      fillEl.className = 'fill done';
      statusEl.textContent = 'Opening results...';
      clearInterval(pollTimer);

      // Auto-close after a brief moment
      setTimeout(() => window.close(), 1500);
      return;
    }

    if (error) {
      titleEl.textContent = 'Failed';
      titleEl.className = 'title error';
      statusEl.textContent = error;
      clearInterval(pollTimer);
      setTimeout(() => window.close(), 3000);
      return;
    }

    if (phase === 'measuring') {
      statusEl.textContent = 'Measuring page...';
      fillEl.style.width = '5%';
    } else if (phase === 'capturing') {
      const pct = total > 0 ? Math.round((current / total) * 80) + 10 : 10;
      fillEl.style.width = `${pct}%`;
      statusEl.textContent = `Capturing ${current} of ${total}...`;
    } else if (phase === 'processing') {
      fillEl.style.width = '90%';
      statusEl.textContent = 'Stitching & compressing...';
    }
  } catch (_) {
    // Extension context may have been invalidated
  }
}

pollTimer = setInterval(poll, 250);
poll();
