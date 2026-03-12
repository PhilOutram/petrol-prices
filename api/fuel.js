// api/fuel.js — Simple API test
const https = require('https');

<<<<<<< HEAD
const API_BASE  = 'https://www.fuel-finder.service.gov.uk';
const TOKEN_URL = `${API_BASE}/api/v1/oauth/generate_access_token`;
=======
const API_BASE   = 'https://www.fuel-finder.service.gov.uk';
const TOKEN_URL  = `${API_BASE}/api/v1/oauth/generate_access_token`;
>>>>>>> 514d5668de379f344bbeb4b561ead2b68731987e
const PRICES_URL = `${API_BASE}/api/v1/pfs/fuel-prices`;

function httpsRequest(urlStr, options = {}, postBody = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isJson = postBody && typeof postBody === 'object';
    const bodyStr = isJson ? JSON.stringify(postBody) : (postBody || null);
    const headers = { ...(options.headers || {}) };
    if (bodyStr) {
<<<<<<< HEAD
      headers['Content-Type'] = 'application/json';
=======
      headers['Content-Type']   = isJson ? 'application/json' : 'application/x-www-form-urlencoded';
>>>>>>> 514d5668de379f344bbeb4b561ead2b68731987e
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

<<<<<<< HEAD
async function getToken() {
  const { status, body } = await httpsRequest(TOKEN_URL, { method: 'POST' }, {
    client_id: process.env.FUEL_CLIENT_ID,
    client_secret: process.env.FUEL_CLIENT_SECRET,
=======
/* ----------------------------------------------------------------
   OAuth — POST JSON body as per portal docs
   ---------------------------------------------------------------- */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const clientId     = process.env.FUEL_CLIENT_ID;
  const clientSecret = process.env.FUEL_CLIENT_SECRET;

  console.log('[fuel] clientId present:', !!clientId, '| clientSecret present:', !!clientSecret);
  if (!clientId || !clientSecret) {
    throw new Error('FUEL_CLIENT_ID or FUEL_CLIENT_SECRET are not set in Vercel environment variables.');
  }

  const { status, body } = await httpsRequest(
    TOKEN_URL,
    {
      method: 'POST',
      headers: {
        'Accept':       'application/json',
        'Content-Type': 'application/json',
        'User-Agent':   'FuelScan/1.0',
      },
    },
    { client_id: clientId, client_secret: clientSecret }
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
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json',
      'User-Agent':    'FuelScan/1.0',
    },
>>>>>>> 514d5668de379f344bbeb4b561ead2b68731987e
  });
  if (status !== 200) throw new Error(`Token failed (${status}): ${body}`);
  const json = JSON.parse(body);
  return json.data.access_token;
}

<<<<<<< HEAD
=======
/* ----------------------------------------------------------------
   Fetch ALL stations by firing all batches in parallel.
   We probe batch 1 first to confirm access, then fire the rest
   simultaneously. Reduces total time from ~17s to ~1-2s.
   ---------------------------------------------------------------- */
async function fetchAllStations(token) {
  if (cachedStations && Date.now() - stationsCachedAt < STATIONS_TTL_MS) {
    console.log('[fuel] serving from cache');
    return cachedStations;
  }

  console.log('[fuel] fetching all batches in parallel...');
  const MAX_BATCHES = 20; // UK has ~17 batches of 500

  // Fire batches in parallel groups of 5 to respect the API's
  // rate limit of 30 RPM while still being much faster than sequential.
  const CONCURRENCY = 5;
  const allStations = [];
  let batchNum = 1;

  while (batchNum <= MAX_BATCHES) {
    const group = Array.from(
      { length: Math.min(CONCURRENCY, MAX_BATCHES - batchNum + 1) },
      (_, i) => fetchBatch(token, batchNum + i).catch(() => [])
    );
    const results = await Promise.all(group);
    const flat = results.flat();

    // If any batch in the group was empty, we've reached the end
    const hitEnd = results.some(r => r.length === 0);
    allStations.push(...flat);

    if (hitEnd) break;
    batchNum += CONCURRENCY;
  }

  console.log('[fuel] total stations fetched:', allStations.length);

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
>>>>>>> 514d5668de379f344bbeb4b561ead2b68731987e
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
