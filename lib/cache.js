// lib/cache.js — shared station dataset cache + refresh lock, backed by Upstash Redis.
//
// The full UK dataset (~8,500 stations) is gzipped, base64-encoded, and split into
// fixed-size chunks so each Redis REST request stays under the free-tier ~1MB limit.
// A meta key (written last) records the timestamp and chunk count, so a reader never
// sees a half-written dataset.
const zlib = require('zlib');
const { command } = require('./redis');

const META_KEY    = 'fuel:meta';            // JSON { ts, chunks, count }
const DATA_KEY    = i => `fuel:data:${i}`;
const LOCK_KEY    = 'fuel:lock';
const CHUNK_CHARS = 700000;                 // ~700KB base64 per chunk (< 1MB request limit)
const LOCK_TTL    = 40;                      // seconds — auto-expires if a refresh crashes

// Store the merged station array. Writes chunks first, then meta (the commit point).
async function storeCache(stations) {
  const gz  = zlib.gzipSync(JSON.stringify(stations));
  const b64 = gz.toString('base64');
  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) chunks.push(b64.slice(i, i + CHUNK_CHARS));

  for (let i = 0; i < chunks.length; i++) await command(['SET', DATA_KEY(i), chunks[i]]);
  await command(['SET', META_KEY,
    JSON.stringify({ ts: Date.now(), chunks: chunks.length, count: stations.length })]);
  return { count: stations.length, chunks: chunks.length, bytes: gz.length };
}

// Load the dataset. Returns { ts, stations } or null if nothing is cached / a chunk is missing.
async function loadCache() {
  const metaRaw = await command(['GET', META_KEY]);
  if (!metaRaw) return null;
  const meta = JSON.parse(metaRaw);
  if (!meta.chunks) return null;

  const parts = [];
  for (let i = 0; i < meta.chunks; i++) {
    const part = await command(['GET', DATA_KEY(i)]);
    if (part == null) return null;          // partial/evicted dataset — treat as no cache
    parts.push(part);
  }
  const json = zlib.gunzipSync(Buffer.from(parts.join(''), 'base64')).toString();
  return { ts: meta.ts, stations: JSON.parse(json) };
}

// Atomic lock: returns true if this caller should perform the refresh.
async function acquireLock() {
  const r = await command(['SET', LOCK_KEY, '1', 'NX', 'EX', String(LOCK_TTL)]);
  return r === 'OK';
}
async function releaseLock() {
  try { await command(['DEL', LOCK_KEY]); } catch { /* lock will expire on its own */ }
}

module.exports = { storeCache, loadCache, acquireLock, releaseLock };
