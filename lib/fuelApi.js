// lib/fuelApi.js — fetches the full UK dataset from the government Fuel Finder API.
// This is the slow (~20s) operation; it only runs inside /api/refresh, behind a lock.
const { request } = require('./http');

const API_BASE    = 'https://www.fuel-finder.service.gov.uk';
const TOKEN_URL   = `${API_BASE}/api/v1/oauth/generate_access_token`;
const PRICES_URL  = `${API_BASE}/api/v1/pfs/fuel-prices`;
const INFO_URL    = `${API_BASE}/api/v1/pfs`;
const MAX_BATCHES = 25;
const GROUP_SIZE  = 5;
const GOV_HEADERS = { 'User-Agent': 'FuelScan/1.0' };

async function getToken() {
  const { status, body } = await request(TOKEN_URL, { method: 'POST', headers: GOV_HEADERS }, {
    client_id:     process.env.FUEL_CLIENT_ID,
    client_secret: process.env.FUEL_CLIENT_SECRET,
  });
  if (status !== 200) throw new Error(`Token failed (HTTP ${status}): ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  if (!json.data?.access_token) throw new Error('No access_token in response');
  return json.data.access_token;
}

async function fetchBatch(url, batchNum, auth) {
  const { status, body } = await request(
    `${url}?batch-number=${batchNum}`, { headers: { ...GOV_HEADERS, ...auth } }
  );
  if (status === 404) return null;          // past the last batch
  if (status !== 200) throw new Error(`HTTP ${status} on batch ${batchNum}`);
  return JSON.parse(body);
}

async function fetchAllBatches(baseUrl, auth) {
  const all = [];
  let batch = 1;
  let reachedEnd = false;
  while (batch <= MAX_BATCHES && !reachedEnd) {
    const group = [];
    for (let i = 0; i < GROUP_SIZE && batch <= MAX_BATCHES; i++, batch++) group.push(batch);
    const results = await Promise.all(group.map(n => fetchBatch(baseUrl, n, auth)));
    for (const result of results) {
      if (result === null) reachedEnd = true;
      else all.push(...result);
    }
  }
  return all;
}

// Merge prices + info on node_id and trim to the fields the UI uses. The two per-price
// timestamps are dropped here — they are the bulk of the payload and the UI never reads them.
function mergeStations(prices, info) {
  const infoMap = {};
  for (const s of info) infoMap[s.node_id] = s;
  return prices.map(p => {
    const i   = infoMap[p.node_id] || {};
    const loc = i.location || {};
    return {
      node_id:      p.node_id,
      trading_name: p.trading_name,
      brand:        i.brand_name || null,
      address:      [loc.address_line_1, loc.city].filter(Boolean).join(', ') || null,
      postcode:     loc.postcode  || null,
      latitude:     loc.latitude  ?? null,
      longitude:    loc.longitude ?? null,
      phone:        p.public_phone_number || null,
      fuel_prices:  (p.fuel_prices || []).map(fp => ({ fuel_type: fp.fuel_type, price: fp.price })),
    };
  });
}

// Full refresh: token -> all batches of both endpoints (in parallel) -> merged array.
async function fetchAllStations() {
  const token = await getToken();
  const auth  = { Authorization: `Bearer ${token}` };
  const [prices, info] = await Promise.all([
    fetchAllBatches(PRICES_URL, auth),
    fetchAllBatches(INFO_URL,   auth),
  ]);
  return mergeStations(prices, info);
}

module.exports = { fetchAllStations };
