// api/fuel.js — API test proxy (prices + station info)
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

  const clientId = process.env.FUEL_CLIENT_ID;
  const clientSecret = process.env.FUEL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Missing API credentials' });
  }

  let token;
  try {
    token = await getToken();
    console.log('[fuel] Token OK');
  } catch (err) {
    console.error('[fuel] Token error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  const batch   = parseInt(req.query.batch) || 1;
  const authHdr = { Authorization: `Bearer ${token}` };

  // ── Fetch prices ────────────────────────────────────────────────────
  let stations = [];
  try {
    console.log('[fuel] Fetching prices batch', batch);
    const { status, body } = await httpsRequest(
      `${PRICES_URL}?batch-number=${batch}`, { headers: authHdr }
    );
    console.log('[fuel] Prices status:', status);
    if (status !== 200) throw new Error(`Prices HTTP ${status}: ${body.slice(0, 200)}`);
    stations = JSON.parse(body);
    console.log('[fuel] Prices count:', stations.length);
  } catch (err) {
    console.error('[fuel] Prices error:', err.message);
    return res.status(500).json({ error: 'Prices fetch failed', detail: err.message });
  }

  // ── Fetch station info (address/postcode) ───────────────────────────
  let infoResult = { status: null, sample: null, fields: [], error: null };
  try {
    console.log('[fuel] Fetching station info batch', batch, 'from', INFO_URL);
    const { status, body } = await httpsRequest(
      `${INFO_URL}?batch-number=${batch}`, { headers: authHdr }
    );
    console.log('[fuel] Info status:', status);
    console.log('[fuel] Info body (first 500):', body.slice(0, 500));
    if (status === 200) {
      const infoData = JSON.parse(body);
      infoResult.status = status;
      infoResult.count  = infoData.length;
      infoResult.fields = infoData.length > 0 ? Object.keys(infoData[0]) : [];
      infoResult.sample = infoData[0] || null;
    } else {
      infoResult.status = status;
      infoResult.error  = body.slice(0, 300);
    }
  } catch (err) {
    console.error('[fuel] Info error:', err.message);
    infoResult.error = err.message;
  }

  return res.status(200).json({
    batch_number:    batch,
    total_in_batch:  stations.length,
    fields:          stations.length > 0 ? Object.keys(stations[0]) : [],
    first_10:        stations.slice(0, 10),
    info_endpoint:   infoResult,   // <-- what came back from the info endpoint
  });
};