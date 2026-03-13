// api/fuel.js — Prices + station info merged
const https = require('https');

const API_BASE   = 'https://www.fuel-finder.service.gov.uk';
const TOKEN_URL  = `${API_BASE}/api/v1/oauth/generate_access_token`;
const PRICES_URL = `${API_BASE}/api/v1/pfs/fuel-prices`;
const INFO_URL   = `${API_BASE}/api/v1/pfs`;

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
    console.log('[fuel] Token OK');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const batch   = parseInt(req.query.batch) || 1;
  const authHdr = { Authorization: `Bearer ${token}` };

  // Fetch both endpoints in parallel
  const [pricesRes, infoRes] = await Promise.all([
    httpsRequest(`${PRICES_URL}?batch-number=${batch}`, { headers: authHdr }),
    httpsRequest(`${INFO_URL}?batch-number=${batch}`,   { headers: authHdr }),
  ]);

  console.log('[fuel] Prices status:', pricesRes.status, '| Info status:', infoRes.status);

  if (pricesRes.status !== 200) {
    return res.status(500).json({ error: `Prices fetch failed (HTTP ${pricesRes.status})` });
  }
  if (infoRes.status !== 200) {
    return res.status(500).json({ error: `Info fetch failed (HTTP ${infoRes.status})` });
  }

  const prices  = JSON.parse(pricesRes.body);
  const info    = JSON.parse(infoRes.body);
  console.log('[fuel] Prices:', prices.length, '| Info:', info.length);

  // Log first info record so we can see all fields
  if (info.length > 0) {
    console.log('[fuel] Info fields:', Object.keys(info[0]));
    console.log('[fuel] Info sample location:', JSON.stringify(info[0].location));
  }

  // Build a lookup map from node_id → info record
  const infoMap = {};
  for (const s of info) infoMap[s.node_id] = s;

  // Merge prices + info
  const merged = prices.map(p => {
    const i = infoMap[p.node_id] || {};
    const loc = i.location || {};
    return {
      node_id:       p.node_id,
      trading_name:  p.trading_name,
      brand:         i.brand_name || '—',
      address:       [loc.address_line_1, loc.city].filter(Boolean).join(', ') || '—',
      postcode:      loc.postcode || '—',
      latitude:      loc.latitude  ?? null,
      longitude:     loc.longitude ?? null,
      phone:         p.public_phone_number || '—',
      fuel_prices:   p.fuel_prices,
    };
  });

  return res.status(200).json({
    batch_number:   batch,
    total_in_batch: merged.length,
    info_fields:    info.length > 0 ? Object.keys(info[0]) : [],
    location_fields: info.length > 0 && info[0].location ? Object.keys(info[0].location) : [],
    first_10:       merged.slice(0, 10),
  });
};
