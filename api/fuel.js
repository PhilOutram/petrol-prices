// api/fuel.js — fast cache-read endpoint. Never hits the slow government API itself.
// Returns one of:
//   { status: 'fresh', ageMinutes, total_stations, stations }   cache < 15 min old
//   { status: 'stale', ageMinutes, total_stations, stations }   older, but still usable
//   { status: 'empty' }                                         nothing cached / too old
// The browser triggers /api/refresh when it sees 'stale' or 'empty'.
const { loadCache } = require('../lib/cache');

const FRESH_MS     = 15 * 60 * 1000;          // <= this old => 'fresh'
const MAX_STALE_MS = 6 * 60 * 60 * 1000;      // older than this => treat as 'empty' (force rebuild)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const cached = await loadCache();
    if (!cached || (Date.now() - cached.ts) > MAX_STALE_MS) {
      return res.status(200).json({ status: 'empty' });
    }
    const age    = Date.now() - cached.ts;
    const status = age <= FRESH_MS ? 'fresh' : 'stale';
    return res.status(200).json({
      status,
      ageMinutes:     Math.round(age / 60000),
      total_stations: cached.stations.length,
      stations:       cached.stations,
    });
  } catch (err) {
    console.error('[fuel] read error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
