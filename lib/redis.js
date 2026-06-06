// lib/redis.js — minimal Upstash Redis REST client (no SDK, zero dependencies).
// Env vars are auto-provisioned by the Vercel Marketplace Upstash integration.
const { request } = require('./http');

const REST_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function configured() { return !!(REST_URL && REST_TOKEN); }

// Run a single Redis command, e.g. command(['SET', 'k', 'v', 'NX', 'EX', '40']).
// Returns the `result` field (string | number | null). Throws on transport/Redis error.
async function command(args) {
  if (!configured()) throw new Error('Upstash env vars not set (UPSTASH_REDIS_REST_*)');
  const { status, body } = await request(REST_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
  }, args);
  if (status !== 200) throw new Error(`Redis HTTP ${status}: ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  if (json.error) throw new Error(`Redis error: ${json.error}`);
  return json.result;
}

module.exports = { command, configured };
