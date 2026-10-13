// Unit tests for the pure helpers in lib/capture-store.js (no browser needed).
//   node --test tests/unit/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const store = require('../../lib/capture-store.js');

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const policy = { keepRecent: 5, maxAgeMs: 24 * HOUR, maxCaptures: 20 };

const records = (ages) => ages.map((ageHours, i) => ({ id: `c${i}`, createdAt: NOW - ageHours * HOUR }));

test('keeps everything when there are few recent captures', () => {
  assert.deepEqual(store.selectIdsToPrune(records([0, 1, 2]), NOW, policy), []);
});

test('always keeps the newest five, even when they are old', () => {
  const ids = store.selectIdsToPrune(records([100, 200, 300, 400, 500, 600, 700]), NOW, policy);
  assert.deepEqual(ids.sort(), ['c5', 'c6']);
});

test('keeps captures younger than 24h beyond the newest five', () => {
  const ids = store.selectIdsToPrune(records([1, 2, 3, 4, 5, 6, 7, 30, 48]), NOW, policy);
  assert.deepEqual(ids.sort(), ['c7', 'c8']);
});

test('caps the total number of stored captures', () => {
  const ages = Array.from({ length: 25 }, (_, i) => i * 0.1); // all under 24h
  const ids = store.selectIdsToPrune(records(ages), NOW, policy);
  assert.equal(ids.length, 5);
  assert.deepEqual(ids.sort(), ['c20', 'c21', 'c22', 'c23', 'c24']);
});

test('input order does not matter and input is not mutated', () => {
  const input = records([500, 0, 300, 1, 700, 2, 600]);
  const copy = JSON.parse(JSON.stringify(input));
  const ids = store.selectIdsToPrune(input, NOW, policy);
  assert.deepEqual(ids.sort(), ['c4', 'c6']);
  assert.deepEqual(input, copy);
});

test('default retention policy matches the documented limits', () => {
  assert.deepEqual({ ...store.RETENTION }, { keepRecent: 5, maxAgeMs: 24 * HOUR, maxCaptures: 20 });
});

test('capture ids are unique, URL-safe and time-ordered', () => {
  const a = store.createCaptureId(NOW, () => 0.25);
  const b = store.createCaptureId(NOW + 1000, () => 0.75);
  assert.match(a, /^[0-9a-z]+-[0-9a-z]{8}$/);
  assert.notEqual(a, b);
  assert.equal(encodeURIComponent(a), a);
  const seen = new Set(Array.from({ length: 500 }, () => store.createCaptureId()));
  assert.equal(seen.size, 500);
});

const quotaError = () => Object.assign(new Error('full'), { name: 'QuotaExceededError' });

test('recognizes storage-full errors', () => {
  assert.equal(store.isQuotaError(quotaError()), true);
  assert.equal(store.isQuotaError({ code: 22 }), true);
  assert.equal(store.isQuotaError(new Error('other')), false);
  assert.equal(store.isQuotaError(null), false);
});

test('evicts old captures until a save fits', async () => {
  let room = 0;
  const evicted = [];
  const pending = ['c0', 'c1', 'c2'];
  const result = await store.retryAfterEviction(
    async () => { if (room < 2) throw quotaError(); return 'saved'; },
    async () => { const id = pending.shift(); if (!id) return false; evicted.push(id); room += 1; return true; },
  );
  assert.equal(result, 'saved');
  assert.deepEqual(evicted, ['c0', 'c1']);
});

test('gives up with the storage error when nothing is left to evict', async () => {
  const err = quotaError();
  await assert.rejects(store.retryAfterEviction(async () => { throw err; }, async () => false), (e) => e === err);
});

test('does not evict for errors other than storage full', async () => {
  let evictions = 0;
  await assert.rejects(
    store.retryAfterEviction(async () => { throw new Error('broken'); }, async () => { evictions += 1; return true; }),
    /broken/,
  );
  assert.equal(evictions, 0);
});
