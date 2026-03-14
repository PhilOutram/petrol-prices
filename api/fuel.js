// api/fuel.js — Fast production endpoint
// Supports:
//   ?batches=3,7        fetch specific batches only (fast path)
//   ?batch=1            fetch a single batch (testing)
//   (no params)         fetch all batches (first-run discovery)
const https = require('https');

const API_BASE   = 'https://www.fuel-finder.service.gov.uk';
const TOKEN_URL  = `${API_BASE}/api/v1/oauth/generate_access_token`;
const PRICES_URL = `${API_BASE}/api/v1/pfs/fuel-prices`;
const INFO_URL   = `${API_BASE}/api/v1/pfs`;
const MAX_BATCHES = 25;
const GROUP_SIZE  = 5;

function httpsRequest(urlStr, options = {}, postBody = null) {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const bodyStr = postBody ? JSON.stringify(postBody) : null;
    const headers = {
      'Accept':     'application/json',
      'User-Agent': 'FuelScan/1.0',
      ...(options.headers || {}),
    };
    if (bodyStr) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   options.method || 'GET',
      headers,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getToken() {
  const { status, body } = await httpsRequest(TOKEN_URL, { method: 'POST' }, {
    client_id:     process.env.FUEL_CLIENT_ID,
    client_secret: process.env.FUEL_CLIENT_SECRET,
  });
  if (status !== 200) throw new Error(`Token failed (HTTP ${status}): ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  if (!json.data?.access_token) throw new Error('No access_token in response');
  return json.data.access_token;
}

async function fetchBatch(url, batchNum, authHdr) {
  const { status, body } = await httpsRequest(
    `${url}?batch-number=${batchNum}`, { headers: authHdr }
  );
  if (status === 404) return null;
  if (status !== 200) throw new Error(`HTTP ${status} on batch ${batchNum}`);
  return JSON.parse(body);
}

async function fetchSpecificBatches(baseUrl, batchNums, authHdr) {
  console.log(`[fuel] Fetching specific batches from ${baseUrl.split('/').pop()}:`, batchNums);
  const results = await Promise.all(
    batchNums.map(n => fetchBatch(baseUrl, n, authHdr))
  );
  return results.filter(r => r !== null).flat();
}

async function fetchAllBatches(baseUrl, authHdr) {
  const all = [];
  let batch = 1;
  let reachedEnd = false;
  while (batch <= MAX_BATCHES && !reachedEnd) {
    const group = [];
    for (let i = 0; i < GROUP_SIZE && batch <= MAX_BATCHES; i++, batch++) {
      group.push(batch);
    }
    console.log(`[fuel] Fetching all — ${baseUrl.split('/').pop()} batches:`, group);
    const results = await Promise.all(
      group.map(n => fetchBatch(baseUrl, n, authHdr))
    );
    for (const result of results) {
      if (result === null) reachedEnd = true;
      else all.push(...result);
    }
  }
  return all;
}

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
      fuel_prices:  p.fuel_prices,
    };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  console.log('[fuel] Region:', process.env.VERCEL_REGION || 'unknown');

  if (!process.env.FUEL_CLIENT_ID || !process.env.FUEL_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Missing API credentials' });
  }

  let token;
  try {
    token = await getToken();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const authHdr = { Authorization: `Bearer ${token}` };
  const t0 = Date.now();

  // Parse request mode
  const singleBatch  = req.query.batch   ? parseInt(req.query.batch) : null;
  const batchList    = req.query.batches
    ? req.query.batches.split(',').map(Number).filter(n => n > 0)
    : null;

  let prices, info, mode;
  try {
    if (singleBatch) {
      mode = 'single';
      console.log('[fuel] Mode: single batch', singleBatch);
      [prices, info] = await Promise.all([
        fetchBatch(PRICES_URL, singleBatch, authHdr).then(r => r || []),
        fetchBatch(INFO_URL,   singleBatch, authHdr).then(r => r || []),
      ]);
    } else if (batchList) {
      mode = 'fast';
      console.log('[fuel] Mode: fast path, batches:', batchList);
      [prices, info] = await Promise.all([
        fetchSpecificBatches(PRICES_URL, batchList, authHdr),
        fetchSpecificBatches(INFO_URL,   batchList, authHdr),
      ]);
    } else {
      mode = 'discovery';
      console.log('[fuel] Mode: full discovery');
      [prices, info] = await Promise.all([
        fetchAllBatches(PRICES_URL, authHdr),
        fetchAllBatches(INFO_URL,   authHdr),
      ]);
    }
  } catch (err) {
    console.error('[fuel] Fetch error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  const elapsed  = ((Date.now() - t0) / 1000).toFixed(2);
  const stations = mergeStations(prices, info);
  console.log(`[fuel] Mode: ${mode} | stations: ${stations.length} | time: ${elapsed}s`);

  return res.status(200).json({
    mode,
    total_stations:  stations.length,
    elapsed_seconds: parseFloat(elapsed),
    stations,        // full array for main app to filter client-side
  });
};
