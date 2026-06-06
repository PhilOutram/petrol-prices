// api/refresh.js — performs the slow (~20s) full fetch and stores it in the shared cache.
// Guarded by an atomic lock so only one client per ~15-min window actually does the work.
// Returns:
//   { status: 'fresh', total_stations, stations }   this caller refreshed
//   { status: 'refreshing' }                         another caller holds the lock
const { acquireLock, releaseLock, storeCache } = require('../lib/cache');
const { fetchAllStations } = require('../lib/fuelApi');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.FUEL_CLIENT_ID || !process.env.FUEL_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Missing API credentials' });
  }

  let gotLock;
  try {
    gotLock = await acquireLock();
  } catch (err) {
    console.error('[refresh] lock error:', err.message);
    return res.status(500).json({ error: `Lock error: ${err.message}` });
  }
  if (!gotLock) return res.status(200).json({ status: 'refreshing' });

  const t0 = Date.now();
  let stations;
  try {
    stations = await fetchAllStations();
    await storeCache(stations);
  } catch (err) {
    await releaseLock();
    console.error('[refresh] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
  await releaseLock();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[refresh] stored ${stations.length} stations in ${elapsed}s`);
  return res.status(200).json({
    status:          'fresh',
    ageMinutes:      0,
    total_stations:  stations.length,
    elapsed_seconds: parseFloat(elapsed),
    stations,
  });
};
