/**
 * PageGobbler — Capture Store
 * Persists finished captures in the extension's own IndexedDB so the viewer
 * can load them directly, even after the MV3 service worker has been stopped.
 *
 * Loaded two ways:
 *   - background.js (module service worker): `import './lib/capture-store.js'`
 *   - viewer.html (classic script tag)
 * Both read the API from `globalThis.PageGobblerCaptureStore`.
 * Node tests can `require()` it to exercise the pure helpers.
 *
 * Data never leaves the device: IndexedDB here is scoped to the extension
 * origin (chrome-extension://<id>) and is not synced.
 */

(function initCaptureStore(root) {
  const DB_NAME = 'pagegobbler';
  const DB_VERSION = 1;
  const STORE = 'captures';
  const CREATED_INDEX = 'createdAt';

  // Retention: the newest KEEP_RECENT captures are always kept; older ones
  // survive while they are younger than MAX_AGE_MS, up to MAX_CAPTURES total.
  const RETENTION = Object.freeze({
    keepRecent: 5,
    maxAgeMs: 24 * 60 * 60 * 1000,
    maxCaptures: 20,
  });

  // ── Pure helpers (no IndexedDB) ──────────────────────────────────────────

  function createCaptureId(now = Date.now(), random = Math.random) {
    const stamp = Math.max(0, Math.floor(now)).toString(36);
    const noise = Math.floor(random() * 36 ** 8).toString(36).padStart(8, '0');
    return `${stamp}-${noise}`;
  }

  /**
   * Decide which captures to delete.
   * @param {Array<{id: string, createdAt: number}>} records
   * @param {number} now
   * @param {{keepRecent: number, maxAgeMs: number, maxCaptures: number}} policy
   * @returns {string[]} ids to delete
   */
  function selectIdsToPrune(records, now = Date.now(), policy = RETENTION) {
    const newestFirst = [...(records || [])]
      .filter((r) => r && r.id != null)
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

    return newestFirst
      .filter((record, rank) => {
        if (rank < policy.keepRecent) return false;
        if (rank >= policy.maxCaptures) return true;
        const age = now - (Number(record.createdAt) || 0);
        return age > policy.maxAgeMs;
      })
      .map((record) => record.id);
  }

  function isQuotaError(err) {
    return Boolean(err) && (err.name === 'QuotaExceededError' || err.code === 22);
  }

  /**
   * Run `attempt`; while it fails because storage is full, ask `evictOldest`
   * to free a capture and try again. Gives up with the original error once
   * nothing is left to evict.
   * @param {() => Promise<T>} attempt
   * @param {() => Promise<boolean>} evictOldest resolves false when nothing was removed
   * @returns {Promise<T>}
   * @template T
   */
  async function retryAfterEviction(attempt, evictOldest) {
    for (;;) {
      try {
        return await attempt();
      } catch (err) {
        if (!isQuotaError(err) || !(await evictOldest())) throw err;
      }
    }
  }

  // ── IndexedDB plumbing ───────────────────────────────────────────────────

  let dbPromise = null;

  function getIndexedDB() {
    const idb = root.indexedDB;
    if (!idb) throw new Error('IndexedDB is not available in this context.');
    return idb;
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = getIndexedDB().open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex(CREATED_INDEX, 'createdAt');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another context upgrading the schema should not be blocked by us.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('Could not open the capture store.'));
      };
      request.onblocked = () => {
        // Resolves once the other connection closes; nothing to do here.
      };
    });
    return dbPromise;
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Capture store transaction aborted.'));
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Save a capture. If the extension's storage is full, delete the oldest
   * other captures one at a time until the new one fits, so a full store
   * never blocks the newest capture. The most recent earlier capture is
   * never evicted: if the new one cannot fit even then, the save fails
   * without emptying the store.
   */
  async function saveCapture(record) {
    if (!record || !record.id) throw new Error('A capture record needs an id.');
    const value = { ...record, createdAt: record.createdAt || Date.now() };
    const put = async () => {
      const db = await openDb();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value);
      await transactionDone(tx);
    };
    const evictOldest = async () => {
      const others = (await listCaptureSummaries()).filter((s) => s.id !== record.id);
      if (others.length < 2) return false;
      const oldest = others[0];
      await deleteCaptures([oldest.id]);
      return true;
    };
    await retryAfterEviction(put, evictOldest);
    return record.id;
  }

  async function getCapture(id) {
    if (!id) return null;
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const result = await requestToPromise(tx.objectStore(STORE).get(id));
    return result || null;
  }

  async function getLatestCapture() {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const index = tx.objectStore(STORE).index(CREATED_INDEX);
    const cursor = await requestToPromise(index.openCursor(null, 'prev'));
    return cursor ? cursor.value : null;
  }

  /** Lists {id, createdAt}, oldest first, without loading screenshot blobs. */
  async function listCaptureSummaries() {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const index = tx.objectStore(STORE).index(CREATED_INDEX);
    return new Promise((resolve, reject) => {
      const summaries = [];
      const request = index.openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(summaries);
          return;
        }
        summaries.push({ id: cursor.primaryKey, createdAt: cursor.key });
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function deleteCaptures(ids) {
    if (!ids || ids.length === 0) return 0;
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    ids.forEach((id) => store.delete(id));
    await transactionDone(tx);
    return ids.length;
  }

  async function pruneCaptures(now = Date.now(), policy = RETENTION) {
    const summaries = await listCaptureSummaries();
    const doomed = selectIdsToPrune(summaries, now, policy);
    await deleteCaptures(doomed);
    return doomed;
  }

  const api = Object.freeze({
    RETENTION,
    createCaptureId,
    selectIdsToPrune,
    isQuotaError,
    retryAfterEviction,
    saveCapture,
    getCapture,
    getLatestCapture,
    listCaptureSummaries,
    deleteCaptures,
    pruneCaptures,
  });

  root.PageGobblerCaptureStore = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(globalThis);
