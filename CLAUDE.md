# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FuelScan — a UK petrol price finder. A static frontend (`public/`) talks to Vercel serverless
functions (`api/`, with shared code in `lib/`) that proxy the official UK Government Fuel Finder
Scheme API and cache results in Upstash Redis. There is **no build step, no package.json, no
tests, and no lint tooling** — the frontend is vanilla HTML/CSS/JS served as static files, and
the functions are plain CommonJS modules using only Node built-ins (`https`, `zlib`).

## Commands

- **Run locally**: `vercel dev` (requires the Vercel CLI and the two env vars below). There is
  no other local server; opening `public/index.html` directly will fail because `/api/*` calls
  won't resolve.
- **Deploy**: pushing to the repo triggers a Vercel deploy. Files typically arrive via a Windows
  batch script that unzips `files.zip` from `~/Downloads` and copies into `api/` and `public/`,
  then commits and pushes (see README "Deployment" section).
- After changing env vars in the Vercel dashboard you **must manually redeploy** — Vercel does
  not auto-redeploy on env var changes.

## Critical deployment constraints

- **`vercel.json` must keep `"regions": ["lhr1"]`.** The upstream API sits behind AWS CloudFront,
  which blocks non-UK requests. Vercel's default region (`iad1`, US) gets a **403** on the token
  endpoint. London (`lhr1`) is the fix. If you see a 403 on the token endpoint, check this first.
  `vercel.json` can silently revert on redeploy — verify it after each deploy.
- **Token requests need `Content-Length` and `Accept` headers**, or CloudFront returns 403 even
  from a UK IP. `httpsRequest` in the API functions sets these.
- **Use Node's `https` module, never `fetch`**, inside the serverless functions — `fetch` can
  throw `ENOTFOUND` on some Vercel Node runtimes.
- **Functions are CommonJS** (`module.exports = async function handler(req, res)`), not ESM.

## Environment variables (set in Vercel dashboard)

- `FUEL_CLIENT_ID`, `FUEL_CLIENT_SECRET` — OAuth client-credentials for the Fuel Finder portal.
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — auto-provisioned when you add the
  Upstash Redis integration from the Vercel Marketplace. Back the shared price cache. Only
  `api/refresh.js` needs the Fuel credentials; `api/fuel.js` only reads Redis.

## Architecture

### Upstream API shape
Two endpoints, both paginated in **batches of up to 500 stations** (~15-17 batches total),
both keyed by `node_id`:
- `GET /api/v1/pfs/fuel-prices?batch-number=N` — prices per station (`fuel_prices[]`).
- `GET /api/v1/pfs?batch-number=N` — station info (brand, address, lat/lng).

Prices are in **pence per litre**. Fuel types: `E10`/`E5` (petrol), `B7_STANDARD`/`B7_PREMIUM`
(diesel). Auth is OAuth 2.0 client-credentials; the access token lives under `data.access_token`
in the token response. Rate limit: 30 req/min, 1 concurrent request per client.

### Shared price cache (the core of the current design)
The slow multi-batch fetch is done **once per ~15 minutes for all users** and cached in Upstash
Redis, instead of every browser re-fetching. Two endpoints split read from write:

- **`api/fuel.js`** — pure cache read (fast, no government API calls, no credentials needed).
  Returns `{ status, ageMinutes, stations }` where status is `fresh` (<15 min), `stale`
  (older, still served), or `empty` (nothing cached, or older than 6 h → force a rebuild).
- **`api/refresh.js`** — does the ~20 s full fetch (`lib/fuelApi.fetchAllStations`) and stores it.
  Guarded by an atomic Redis lock (`SET … NX EX 40`) so only one client refreshes per window;
  others get `{ status: 'refreshing' }`. Needs `maxDuration: 60` in `vercel.json`.

Shared helpers live in **`lib/`** (required from the functions; not routes): `http.js` (the https
wrapper), `redis.js` (Upstash REST), `cache.js` (gzip + chunked store/load + lock), `fuelApi.js`
(token + batch fetch + merge/trim). The dataset is gzipped and split into ~700 KB base64 chunks
to stay under Upstash's free-tier ~1 MB request limit; `fuel:meta` (written last) is the commit
point. Per-price timestamps are dropped in `mergeStations` since the UI never reads them.

### Client data flow (`public/index.js`)
On each search the browser calls `/api/fuel` and filters the returned dataset locally
(`filterStations` → `renderQuery`). Behaviour by cache status:
- **fresh** → render immediately.
- **stale** → render the old data at once with an age banner ("from 23 min ago"), then
  `backgroundRefresh()` calls `/api/refresh` and **re-renders with fresh data when it lands**
  (or `pollUntilFresh` if another client holds the lock). Nobody is left on silent stale data.
- **empty** → `coldBuild()` shows a "fetching (~20 s)" status and retries the refresh up to 4×.

The header ↺ button (`reset-profile-btn`) now forces an immediate refresh. The old
`localStorage` "profile"/fingerprint/batch-subset fast-path was **removed** — it caused a bug
where repeated searches found progressively fewer stations (fragile `idx/500` batch guessing +
the government API's "1 concurrent request" limit being exceeded by parallel fan-out).

### `api/fuel-check.js` — diagnostic endpoint (unchanged, bypasses the cache)
Does a direct full all-batches fetch and returns diagnostics (per-batch counts, field names,
first 10 stations). Backs `check.html` only. Self-contained — it still has its own copies of
`httpsRequest`/`getToken`/`fetchBatch` and does **not** use `lib/`, so it works as a
cache-independent way to probe the upstream API.

Other client concerns in `index.js`: postcode→lat/lng via `api.postcodes.io`, Leaflet map with
price-coloured SVG markers (`priceColor` lerps green→orange→red by pence above cheapest),
distance via haversine, and up-to-3 pinned favourites + a saved-search favourite, all in
`localStorage` (`fuelscan_profile`, `fuelscan_favourite`, `fuelscan_pinned`).

### Pages
- `index.html` + `index.js` — the main app.
- `check.html` + `check.js` — API diagnostic/inspection page.
- `public/app.js` is an **orphaned** older diagnostic script — not referenced by any HTML.
