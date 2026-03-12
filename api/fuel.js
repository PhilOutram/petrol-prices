// api/fuel.js — Simple API test
const https = require('https');

const API_BASE  = 'https://www.fuel-finder.service.gov.uk';
const TOKEN_URL = `${API_BASE}/api/v1/oauth/generate_access_token`;
const PRICES_URL = `${API_BASE}/api/v1/pfs/fuel-prices`;

function httpsRequest(urlStr, options = {}, postBody = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isJson = postBody && typeof postBody === 'object';
    const bodyStr = isJson ? JSON.stringify(postBody) : (postBody || null);
    const headers = { ...(options.headers || {}) };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
    }
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: options.method || 'GET',
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
    client_id: process.env.FUEL_CLIENT_ID,
    client_secret: process.env.FUEL_CLIENT_SECRET,
  });
  if (status !== 200) throw new Error(`Token failed (${status}): ${body}`);
  const json = JSON.parse(body);
  return json.data.access_token;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = await getToken();
    const batch = req.query.batch || 1;
    const { status, body } = await httpsRequest(
      `${PRICES_URL}?batch-number=${batch}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'FuelScan/1.0' } }
    );
    if (status !== 200) throw new Error(`API failed (${status}): ${body}`);
    const stations = JSON.parse(body);
    return res.status(200).json({
      batch_number: parseInt(batch),
      total_in_batch: stations.length,
      fields: stations.length > 0 ? Object.keys(stations[0]) : [],
      first_10: stations.slice(0, 10),
    });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message });
  }
};
