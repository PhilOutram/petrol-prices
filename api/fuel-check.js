// api/fuel-check.js — Full 15-batch fetch for diagnostic/check page only
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

async function fetchAllBatches(baseUrl, authHdr) {
  const all = [];
  const batchCounts = [];
  let batch = 1;
  let reachedEnd = false;

  while (batch <= MAX_BATCHES && !reachedEnd) {
    const group = [];
    for (let i = 0; i < GROUP_SIZE && batch <= MAX_BATCHES; i++, batch++) {
      group.push(batch);
    }
    console.log(`[check] Fetching ${baseUrl.split('/').pop()} batches:`, group);
    const results = await Promise.all(
      group.map(n => fetchBatch(baseUrl, n, authHdr))
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result === null) {
        reachedEnd = true;
      } else {
        all.push(...result);
        batchCounts.push({ batch: group[i], count: result.length });
      }
    }
  }
  return { all, batchCounts };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  console.log('[check] Region:', process.env.VERCEL_REGION || 'unknown');

  if (!process.env.FUEL_CLIENT_ID || !process.env.FUEL_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Missing API credentials' });
  }

  let token;
  try {
    token = await getToken();
    console.log('[check] Token OK');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const authHdr = { Authorization: `Bearer ${token}` };
  const t0 = Date.now();

  let pricesData, infoData;
  try {
    [pricesData, infoData] = await Promise.all([
      fetchAllBatches(PRICES_URL, authHdr),
      fetchAllBatches(INFO_URL,   authHdr),
    ]);
  } catch (err) {
    console.error('[check] Fetch error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const { all: prices, batchCounts } = pricesData;
  const { all: info } = infoData;

  console.log(`[check] Done — prices: ${prices.length}, info: ${info.length}, time: ${elapsed}s`);

  // Merge
  const infoMap = {};
  for (const s of info) infoMap[s.node_id] = s;

  const merged = prices.map(p => {
    const i   = infoMap[p.node_id] || {};
    const loc = i.location || {};
    return {
      node_id:      p.node_id,
      trading_name: p.trading_name,
      brand:        i.brand_name || '—',
      address:      [loc.address_line_1, loc.city].filter(Boolean).join(', ') || '—',
      postcode:     loc.postcode  || '—',
      latitude:     loc.latitude  ?? null,
      longitude:    loc.longitude ?? null,
      phone:        p.public_phone_number || '—',
      fuel_prices:  p.fuel_prices,
    };
  });

  return res.status(200).json({
    total_stations:  merged.length,
    batches_fetched: batchCounts.length,
    batch_counts:    batchCounts,
    elapsed_seconds: parseFloat(elapsed),
    info_fields:     info.length > 0 ? Object.keys(info[0]) : [],
    location_fields: info.length > 0 && info[0].location ? Object.keys(info[0].location) : [],
    first_10:        merged.slice(0, 10),
  });
};
