// api/fuel.js — Vercel Serverless Function
// Handles OAuth token exchange and proxies requests to the UK Gov Fuel Finder API.
// Secrets are stored in Vercel Environment Variables — never exposed to the browser.

const TOKEN_URL = 'https://api.fuel-finder.service.gov.uk/oauth/token';
const API_BASE  = 'https://api.fuel-finder.service.gov.uk/v1';

let cachedToken   = null;
let tokenExpiry   = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     process.env.FUEL_CLIENT_ID,
    client_secret: process.env.FUEL_CLIENT_SECRET,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  cachedToken = json.access_token;
  tokenExpiry = Date.now() + json.expires_in * 1000;
  return cachedToken;
}

export default async function handler(req, res) {
  // CORS — allow your Vercel frontend domain (update if using custom domain)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { lat, lng, radius, fuel } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'lat and lng query params are required' });
  }

  try {
    const token = await getAccessToken();

    const MILES_TO_KM = 1.60934;
    const radiusMiles = parseFloat(radius) || 5;
    const radiusMetres = Math.round(radiusMiles * MILES_TO_KM * 1000);

    const fuelParam = fuel === 'diesel' ? 'B7' : 'E5,E10';

    const url = new URL(`${API_BASE}/stations`);
    url.searchParams.set('latitude',  lat);
    url.searchParams.set('longitude', lng);
    url.searchParams.set('radius',    radiusMetres);
    url.searchParams.set('fuels',     fuelParam);

    const apiRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!apiRes.ok) {
      const text = await apiRes.text();
      throw new Error(`Fuel Finder API error (${apiRes.status}): ${text}`);
    }

    const data = await apiRes.json();

    // Cache response for 2 minutes (prices update every 30 mins max)
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
    return res.status(200).json(data);

  } catch (err) {
    console.error('[fuel proxy error]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
