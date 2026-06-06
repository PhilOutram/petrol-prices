# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FuelScan — a UK petrol price finder. A static frontend (`public/`) talks to two Vercel
serverless functions (`api/`) that proxy the official UK Government Fuel Finder Scheme API.
There is **no build step, no package.json, no tests, and no lint tooling** — the frontend is
vanilla HTML/CSS/JS served as static files, and the functions are plain CommonJS modules.

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

## Architecture

### Upstream API shape
Two endpoints, both paginated in **batches of up to 500 stations** (~15-17 batches total),
both keyed by `node_id`:
- `GET /api/v1/pfs/fuel-prices?batch-number=N` — prices per station (`fuel_prices[]`).
- `GET /api/v1/pfs?batch-number=N` — station info (brand, address, lat/lng).

Prices are in **pence per litre**. Fuel types: `E10`/`E5` (petrol), `B7_STANDARD`/`B7_PREMIUM`
(diesel). Auth is OAuth 2.0 client-credentials; the access token lives under `data.access_token`
in the token response. Rate limit: 30 req/min, 1 concurrent request per client.

### `api/fuel.js` — the production endpoint
Fetches a token, then runs in one of three **modes** based on query params, and always merges
prices + info into a flat station array (`mergeStations`) before returning:
- `?batch=N` — single batch (testing).
- `?batches=3,7,...` — **fast path**: fetch only the named batches in parallel (`Promise.all`).
- *(no params)* — **discovery**: fetch all batches in parallel groups of `GROUP_SIZE` (5), up to
  `MAX_BATCHES` (25), stopping when a batch 404s.

### `api/fuel-check.js` — diagnostic endpoint
Always does a full all-batches fetch and returns extra diagnostics (per-batch counts, discovered
field names, first 10 merged stations). Backs the `check.html` page only. Largely duplicates the
helpers in `fuel.js` (`httpsRequest`, `getToken`, `fetchBatch`) — if you change request handling
in one, mirror it in the other.

### Client fast-path optimization (`public/index.js`)
The main app avoids re-fetching all ~8,500 stations on every search using a cached **profile** in
`localStorage`:
1. First search → **discovery** mode (full fetch). From the 20 nearest stations it records which
   **batches** they live in and a **fingerprint** (the `node_id`s of the 5 cheapest nearby). This
   is `buildProfile`.
2. Subsequent searches → **fast path**: re-fetch only the profiled batches (`?batches=`), then
   `verifyFingerprint` confirms those `node_id`s still exist. If they do, render; if not (data
   shifted between batches), clear the profile and fall back to discovery.

Note `buildProfile` infers a station's batch from its index in the returned array
(`Math.floor(idx / 500) + 1`), which assumes the upstream array order mirrors batch boundaries.

Other client concerns in `index.js`: postcode→lat/lng via `api.postcodes.io`, Leaflet map with
price-coloured SVG markers (`priceColor` lerps green→orange→red by pence above cheapest),
distance via haversine, and up-to-3 pinned favourites + a saved-search favourite, all in
`localStorage` (`fuelscan_profile`, `fuelscan_favourite`, `fuelscan_pinned`).

### Pages
- `index.html` + `index.js` — the main app.
- `check.html` + `check.js` — API diagnostic/inspection page.
- `public/app.js` is an **orphaned** older diagnostic script — not referenced by any HTML.
