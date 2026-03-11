// api/fuel-csv.js — Vercel Serverless Function
// Fetches the official UK Gov Fuel Finder CSV (updated twice daily),
// parses it in memory, filters by user location and returns results.
// Much faster than the batch API — single request, no pagination.

const https = require('https');

// ----------------------------------------------------------------
// UPDATE THIS URL once confirmed from the developer portal.
// It will be something like:
// https://www.fuel-finder.service.gov.uk/api/v1/fuel-prices.csv
// ----------------------------------------------------------------
const CSV_URL = 'https://www.fuel-finder.service.gov.uk/api/v1/fuel-prices.csv';

// In-memory cache — persists for the lifetime of the function instance
let csvCache      = null;
let csvCachedAt   = 0;
const CSV_TTL_MS  = 60 * 60 * 1000; // 1 hour (CSV updates twice daily)

/* ----------------------------------------------------------------
   https GET helper
   ---------------------------------------------------------------- */
function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers: {
        'Accept':     'text/csv,application/csv,*/*',
        'User-Agent': 'FuelScan/1.0',
      },
    };
    const req = https.request(options, res => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* ----------------------------------------------------------------
   Parse CSV into array of objects.
   Handles quoted fields and standard comma separation.
   ---------------------------------------------------------------- */
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  // Parse header row — normalise to lowercase with underscores
  const headers = lines[0].split(',').map(h =>
    h.trim().replace(/^"|"$/g, '').toLowerCase().replace(/\s+/g, '_')
  );

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV split — handles basic quoted fields
    const values = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === ',' && !inQuotes) { values.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    values.push(current.trim());

    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

/* ----------------------------------------------------------------
   Fetch and cache the CSV
   ---------------------------------------------------------------- */
async function fetchCSV() {
  if (csvCache && Date.now() - csvCachedAt < CSV_TTL_MS) {
    console.log('[fuel-csv] serving from cache, age:', Math.round((Date.now() - csvCachedAt) / 60000), 'mins');
    return csvCache;
  }

  console.log('[fuel-csv] fetching fresh CSV from', CSV_URL);
  const { status, body } = await httpsGet(CSV_URL);

  if (status < 200 || status >= 300) {
    throw new Error(`CSV fetch failed (${status}). Please check the CSV_URL in fuel-csv.js matches your portal's download link.`);
  }

  const rows = parseCSV(body);
  console.log('[fuel-csv] parsed', rows.length, 'stations');

  if (rows.length === 0) {
    throw new Error('CSV parsed but contained no rows. The CSV format may have changed — check the field names.');
  }

  // Log first row keys so we can verify field mapping
  console.log('[fuel-csv] CSV fields:', Object.keys(rows[0]).join(', '));

  csvCache    = rows;
  csvCachedAt = Date.now();
  return rows;
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
   Normalise a CSV row into our app's station format.
   Field names below are best guesses based on the API response
   structure — the log above will show the real field names on
   first run so we can correct them if needed.
   ---------------------------------------------------------------- */
function normaliseRow(row, userLat, userLng) {
  // Try multiple likely field name variations for lat/lng
  const lat = parseFloat(
    row.latitude || row.lat || row.site_latitude || row.location_latitude || ''
  );
  const lng = parseFloat(
    row.longitude || row.lng || row.long || row.site_longitude || row.location_longitude || ''
  );

  if (isNaN(lat) || isNaN(lng)) return null;

  // Price fields — try multiple likely names
  const petrolPrice = parseFloat(
    row.e5 || row.unleaded || row.petrol || row.e5_price || row.unleaded_price || ''
  ) || null;

  const dieselPrice = parseFloat(
    row.b7 || row.diesel || row.diesel_price || row.b7_price || ''
  ) || null;

  return {
    id:          row.node_id || row.site_id || row.id || String(Math.random()),
    name:        row.trading_name || row.name || row.site_name || 'Unknown Station',
    brand:       row.brand || row.operator || row.retailer || '',
    address:     [row.address, row.town || row.city, row.postcode].filter(Boolean).join(', '),
    lat,
    lng,
    petrolPrice,
    dieselPrice,
    lastUpdated: row.last_updated || row.updated_at || row.price_date || null,
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
    const rows = await fetchCSV();

    const results = rows
      .map(row => normaliseRow(row, userLat, userLng))
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

    console.log('[fuel-csv] returning', results.length, 'stations within', radiusMiles, 'miles');

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(results);

  } catch (err) {
    console.error('[fuel-csv error]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
