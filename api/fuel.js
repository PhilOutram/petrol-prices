// api/fuel.js — Simple API test proxy
const https = require('https');

const API_BASE   = 'https://www.fuel-finder.service.gov.uk';
const TOKEN_URL  = `${API_BASE}/api/v1/oauth/generate_access_token`;
const PRICES_URL = `${API_BASE}/api/v1/pfs/fuel-prices`;

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  console.log('[fuel] Vercel region:', process.env.VERCEL_REGION || 'unknown');

  // ── Step 1: check env vars ──────────────────────────────────────────
  const clientId     = process.env.FUEL_CLIENT_ID;
  const clientSecret = process.env.FUEL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[fuel] Missing env vars');
    return res.status(500).json({ error: 'Server misconfiguration: missing API credentials' });
  }
  console.log('[fuel] Env vars present. Client ID starts with:', clientId.slice(0, 4) + '...');

  // ── Step 2: get token ───────────────────────────────────────────────
  let token;
  try {
    const tokenPayload = { client_id: clientId, client_secret: clientSecret };
    console.log('[fuel] Requesting token from', TOKEN_URL);
    console.log('[fuel] Token payload keys:', Object.keys(tokenPayload));
    const { status, body } = await httpsRequest(TOKEN_URL, { method: 'POST' }, tokenPayload);
    console.log('[fuel] Token response status:', status);
    console.log('[fuel] Token response body (first 300):', body.slice(0, 300));
    if (status !== 200) {
      return res.status(500).json({ error: `Token request failed (HTTP ${status})`, detail: body.slice(0, 300) });
    }
    const json = JSON.parse(body);
    if (!json.data || !json.data.access_token) {
      return res.status(500).json({ error: 'Token response missing access_token', detail: json });
    }
    token = json.data.access_token;
    console.log('[fuel] Token obtained OK');
  } catch (err) {
    console.error('[fuel] Token fetch threw:', err.message);
    return res.status(500).json({ error: 'Token fetch failed', detail: err.message });
  }

  // ── Step 3: fetch batch ─────────────────────────────────────────────
  const batch = parseInt(req.query.batch) || 1;
  const url   = `${PRICES_URL}?batch-number=${batch}`;
  try {
    console.log('[fuel] Fetching batch', batch, 'from', url);
    const { status, body } = await httpsRequest(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log('[fuel] Prices response status:', status);
    console.log('[fuel] Prices response (first 200):', body.slice(0, 200));
    if (status !== 200) {
      return res.status(500).json({ error: `Prices request failed (HTTP ${status})`, detail: body.slice(0, 300) });
    }
    const stations = JSON.parse(body);
    console.log('[fuel] Stations in batch:', stations.length);
    return res.status(200).json({
      batch_number:   batch,
      total_in_batch: stations.length,
      fields:         stations.length > 0 ? Object.keys(stations[0]) : [],
      first_10:       stations.slice(0, 10),
    });
  } catch (err) {
    console.error('[fuel] Prices fetch threw:', err.message);
    return res.status(500).json({ error: 'Prices fetch failed', detail: err.message });
  }
};