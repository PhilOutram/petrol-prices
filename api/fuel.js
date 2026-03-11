// api/fuel.js — Vercel Serverless Function
// UK Gov Fuel Finder API — correct endpoints from developer portal docs.
// Secrets stored in Vercel Environment Variables, never exposed to browser.

const https = require('https');

const API_BASE   = 'https://api.fuelfinder.service.gov.uk';
const TOKEN_URL  = `${API_BASE}/api/v1/oauth/generate_access_token`;
const PRICES_URL = `${API_BASE}/api/v1/pfs/fuel-prices`;

// In-memory cache for token and station data
let cachedToken      = null;
let tokenExpiry      = 0;
let cachedStations   = null;
let stationsCachedAt = 0;
const STATIONS_TTL_MS = 5 * 60 * 1000; // cache all stations for 5 minutes

/* ----------------------------------------------------------------
   https request helper — returns { status, body }
   Sends JSON body when postBody is an object, raw string otherwise.
   ---------------------------------------------------------------- */
function httpsRequest(urlStr, options = {}, postBody = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isJson = postBody && typeof postBody === 'object';
    const bodyStr = isJson ? JSON.stringify(postBody) : (postBody || null);

    const headers = { ...(options.headers || {}) };
    if (bodyStr) {
      headers['Content-Type']   = isJson ? 'application/json' : 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const reqOptions = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   options.method || 'GET',
      headers,
    };

    const req = https.request(reqOptions, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/* ----------------------------------------------------------------
   OAuth — POST JSON body as per portal docs
   ---------------------------------------------------------------- */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const clientId     = process.env.FUEL_CLIENT_ID;
  const clientSecret = process.env.FUEL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('FUEL_CLIENT_ID or FUEL_CLIENT_SECRET are not set in Vercel environment variables.');
  }

  const { status, body } = await httpsRequest(
    TOKEN_URL,
    { method: 'POST' },
    { client_id: clientId, client_secret: clientSecret }  // JSON body
  );

  if (status < 200 || status >= 300) {
    throw new Error(`Token request failed (${status}): ${body}`);
  }

  const json = JSON.parse(body);
  // Response shape: { success, data: { access_token, expires_in, ... }, message }
  const tokenData = json.data || json;
  cachedToken = tokenData.access_token;
  tokenExpiry = Date.now() + (tokenData.expires_in || 3600) * 1000;
  return cachedToken;
}

/* ----------------------------------------------------------------
   Fetch one batch of stations from the API
   ---------------------------------------------------------------- */
async function fetchBatch(token, batchNumber) {
  const url = `${PRICES_URL}?batch-number=${batchNumber}`;
  const { status, body } = await httpsRequest(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (status === 404 || status === 204) return [];  // no more batches
  if (status < 200 || status >= 300) {
    throw new Error(`Prices API error (${status}): ${body}`);
  }

  const json = JSON.parse(body);
  return Array.isArray(json) ? json : (json.data || []);
}

/* ----------------------------------------------------------------
   Fetch ALL stations by paginating through batches.
   Stops when a batch returns an empty array.
   ---------------------------------------------------------------- */
async function fetchAllStations(token) {
  if (cachedStations && Date.now() - stationsCachedAt < STATIONS_TTL_MS) {
    return cachedStations;
  }

  const allStations = [];
  let batchNumber = 1;
  const MAX_BATCHES = 50; // safety cap

  while (batchNumber <= MAX_BATCHES) {
    const batch = await fetchBatch(token, batchNumber);
    if (!batch.length) break;
    allStations.push(...batch);
    batchNumber++;
  }

  cachedStations   = allStations;
  stationsCachedAt = Date.now();
  return allStations;
}

/* ----------------------------------------------------------------
   Haversine distance in miles
   ---------------------------------------------------------------- */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ----------------------------------------------------------------
   Normalise a raw station object into our app format.
   Field names based on portal sample response.
   ---------------------------------------------------------------- */
function normalise(raw, userLat, userLng) {
  const lat = parseFloat(raw.latitude  || raw.lat);
  const lng = parseFloat(raw.longitude || raw.lng);
  if (isNaN(lat) || isNaN(lng)) return null;

  // Extract fuel prices from the fuel_prices array
  // Each entry: { fuel_type: 'E5'|'E10'|'B7'|..., price: 142.9 }
  const prices = {};
  if (Array.isArray(raw.fuel_prices)) {
    raw.fuel_prices.forEach(fp => {
      const type  = (fp.fuel_type || fp.type || '').toUpperCase();
      const price = parseFloat(fp.price || fp.retail_price);
      if (type && !isNaN(price)) prices[type] = price;
    });
  }

  const petrolPrice = prices['E5'] || prices['E10'] || null;
  const dieselPrice = prices['B7'] || prices['DIESEL'] || null;

  return {
    id:          raw.node_id || raw.id || String(Math.random()),
    name:        raw.trading_name || raw.name || 'Unknown Station',
    brand:       raw.brand || raw.operator || '',
    address:     [raw.address, raw.town, raw.postcode].filter(Boolean).join(', '),
    lat,
    lng,
    petrolPrice,
    dieselPrice,
    lastUpdated: raw.last_updated || raw.updated_at || null,
    distance:    haversine(userLat, userLng, lat, lng),
  };
}

/* ----------------------------------------------------------------
   Main handler
   ---------------------------------------------------------------- */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { lat, lng, radius, fuel } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng are required' });

  const userLat     = parseFloat(lat);
  const userLng     = parseFloat(lng);
  const radiusMiles = parseFloat(radius) || 5;

  try {
    const token      = await getAccessToken();
    const rawStations = await fetchAllStations(token);

    // Normalise, filter by distance and fuel availability
    const results = rawStations
      .map(s => normalise(s, userLat, userLng))
      .filter(s => {
        if (!s) return false;
        if (s.distance > radiusMiles) return false;
        const price = fuel === 'diesel' ? s.dieselPrice : s.petrolPrice;
        return price !== null && price > 0;
      })
      .sort((a, b) => {
        const ap = fuel === 'diesel' ? a.dieselPrice : a.petrolPrice;
        const bp = fuel === 'diesel' ? b.dieselPrice : b.petrolPrice;
        return ap - bp;
      });

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
    return res.status(200).json(results);

  } catch (err) {
    console.error('[fuel proxy error]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
