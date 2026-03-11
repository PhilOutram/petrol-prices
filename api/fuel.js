// api/fuel.js — Vercel Serverless Function
// Handles OAuth token exchange and proxies requests to the UK Gov Fuel Finder API.
// Secrets are stored in Vercel Environment Variables — never exposed to the browser.

const https = require('https');

const TOKEN_URL_STR = 'https://api.fuel-finder.service.gov.uk/oauth/token';
const API_BASE      = 'https://api.fuel-finder.service.gov.uk/v1';

let cachedToken = null;
let tokenExpiry = 0;

/* ----------------------------------------------------------------
   Simple https.request wrapper that returns { status, body }
   ---------------------------------------------------------------- */
function httpsRequest(urlStr, options = {}, postBody = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const reqOptions = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };

    const req = https.request(reqOptions, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

/* ----------------------------------------------------------------
   OAuth token (client credentials)
   ---------------------------------------------------------------- */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const clientId     = process.env.FUEL_CLIENT_ID;
  const clientSecret = process.env.FUEL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('FUEL_CLIENT_ID or FUEL_CLIENT_SECRET environment variables are not set in Vercel.');
  }

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  }).toString();

  const { status, body: responseBody } = await httpsRequest(
    TOKEN_URL_STR,
    {
      method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body
  );

  if (status < 200 || status >= 300) {
    throw new Error(`Token request failed (${status}): ${responseBody}`);
  }

  const json = JSON.parse(responseBody);
  cachedToken = json.access_token;
  tokenExpiry = Date.now() + json.expires_in * 1000;
  return cachedToken;
}

/* ----------------------------------------------------------------
   Handler
   ---------------------------------------------------------------- */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { lat, lng, radius, fuel } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng are required' });

  try {
    const token = await getAccessToken();

    const radiusMetres = Math.round((parseFloat(radius) || 5) * 1.60934 * 1000);
    const fuelParam    = fuel === 'diesel' ? 'B7' : 'E5,E10';

    const apiUrl = new URL(`${API_BASE}/stations`);
    apiUrl.searchParams.set('latitude',  lat);
    apiUrl.searchParams.set('longitude', lng);
    apiUrl.searchParams.set('radius',    radiusMetres);
    apiUrl.searchParams.set('fuels',     fuelParam);

    const { status, body } = await httpsRequest(apiUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (status < 200 || status >= 300) {
      throw new Error(`Fuel Finder API error (${status}): ${body}`);
    }

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
    return res.status(200).send(body);

  } catch (err) {
    console.error('[fuel proxy error]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
