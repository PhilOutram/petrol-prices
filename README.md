# FuelScan — UK Petrol Price Finder

A web app that finds nearby fuel stations and their prices using the official UK Government Fuel Finder Scheme API.

---

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS (`public/` folder)
- **Backend**: Vercel serverless function (`api/fuel.js`)
- **Hosting**: Vercel

---

## Project Structure

```
repo-root/
├── vercel.json          ← CRITICAL: must contain lhr1 region (see below)
├── README.md
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── api/
    └── fuel.js          ← serverless proxy (never expose credentials to browser)
```

---

## Vercel Configuration

`vercel.json` must always contain **both** of these settings:

```json
{
  "outputDirectory": "public",
  "regions": ["lhr1"]
}
```

### Why `lhr1` is critical

The UK Government Fuel Finder API sits behind **AWS CloudFront**, which blocks requests originating outside the UK. Vercel's default region is `iad1` (Washington DC), which causes a **HTTP 403** from CloudFront. Setting `regions: ["lhr1"]` forces the serverless function to run in **London**.

**If you see a 403 on the token endpoint, check this first.**

To verify the region is applied after deployment:
- Vercel Dashboard → your project → Functions → `api/fuel` → Region column should show `lhr1`
- Function logs should show `[fuel] Vercel region: lhr1`

> ⚠️ `vercel.json` can silently revert during redeployment. Always verify it's present and correct after each deploy.

---

## Environment Variables

Set these in **Vercel Dashboard → Project → Settings → Environment Variables**:

| Variable | Description |
|---|---|
| `FUEL_CLIENT_ID` | OAuth client ID from the Fuel Finder developer portal |
| `FUEL_CLIENT_SECRET` | OAuth client secret from the Fuel Finder developer portal |

**After changing environment variables you must manually redeploy** — Vercel does not auto-redeploy on env var changes.

Credentials are obtained from the [UK Government Fuel Finder developer portal](https://www.fuel-finder.service.gov.uk). You need a GOV.UK One Login to access the portal.

---

## API Details

### Authentication

- **Method**: OAuth 2.0 client credentials
- **Token endpoint**: `POST https://www.fuel-finder.service.gov.uk/api/v1/oauth/generate_access_token`
- **Request body** (JSON):
  ```json
  {
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "access_token": "eyJ...",
      "expires_in": 3600,
      "refresh_token": "..."
    }
  }
  ```
- **Required headers on token request**: `Content-Type: application/json`, `Content-Length`, `Accept: application/json`, `User-Agent`

> ⚠️ Missing `Content-Length` or `Accept` headers on the token request can cause CloudFront to return 403 even from a UK IP.

---

### Endpoint 1 — Fuel Prices

```
GET https://www.fuel-finder.service.gov.uk/api/v1/pfs/fuel-prices?batch-number=1
Authorization: Bearer {access_token}
```

**Response** — array of station objects:
```json
[
  {
    "node_id": "4882e3fee979cfefa29a8777ce57ca0ecea27b4f12ba7fb538ed0855d6b0af1c",
    "public_phone_number": "+448003234040",
    "trading_name": "PONTYPOOL SUPERSTORE - PETROL FILLING STATION",
    "fuel_prices": [
      {
        "fuel_type": "E10",
        "price": 133.9,
        "price_last_updated": "2026-03-10T18:34:42.425Z",
        "price_change_effective_timestamp": "2026-03-10T18:34:18.000Z"
      },
      {
        "fuel_type": "B7_STANDARD",
        "price": 152.9,
        "price_last_updated": "2026-03-12T14:25:55.362Z",
        "price_change_effective_timestamp": "2026-03-12T14:25:42.000Z"
      }
    ]
  }
]
```

**Known fuel types**: `E10` (standard petrol), `E5` (premium petrol), `B7_STANDARD` (diesel), `B7_PREMIUM` (premium diesel)

**Prices are in pence** (e.g. `133.9` = 133.9p per litre)

---

### Endpoint 2 — Station Information (address & location)

```
GET https://www.fuel-finder.service.gov.uk/api/v1/pfs?batch-number=1
Authorization: Bearer {access_token}
```

**Response** — array of station info objects:
```json
[
  {
    "node_id": "4882e3fee979cfefa29a8777ce57ca0ecea27b4f12ba7fb538ed0855d6b0af1c",
    "trading_name": "PONTYPOOL SUPERSTORE - PETROL FILLING STATION",
    "brand_name": "TESCO",
    "public_phone_number": "+448003234040",
    "is_same_trading_and_brand_name": false,
    "temporary_closure": false,
    "permanent_closure": null,
    "permanent_closure_date": null,
    "is_motorway_service_station": false,
    "is_supermarket_service_station": false,
    "location": {
      "address_line_1": "LOWER BRIDGE STREET",
      "address_line_2": "",
      "city": "PONTYPOOL",
      "country": "WAL",
      "postcode": "...",
      "latitude": ...,
      "longitude": ...
    }
  }
]
```

---

### Batching

- Both endpoints return up to **500 stations per batch**
- There are approximately **17 batches** (~8,300–8,500 stations total)
- Use `?batch-number=1`, `?batch-number=2`, etc. to page through all stations
- **Rate limit**: 30 requests per minute, **1 concurrent request per client**

### Joining the two endpoints

`node_id` is the shared key. Build a lookup map from the info endpoint, then merge:

```js
const infoMap = {};
for (const s of info) infoMap[s.node_id] = s;

const merged = prices.map(p => ({
  ...p,
  location: infoMap[p.node_id]?.location || {},
  brand:    infoMap[p.node_id]?.brand_name || null,
}));
```

---

## Serverless Function Pattern

Always use Node's built-in `https` module (not `fetch`) in the Vercel function — `fetch` can cause `ENOTFOUND` errors in some Vercel Node runtimes.

```js
// CommonJS — NOT ES modules
module.exports = async function handler(req, res) { ... }

// Use https.request, not fetch
const https = require('https');
```

---

## Deployment (Windows batch script)

A batch script (`deploy.bat` or similar) handles:
1. Extracting `files.zip` from `%USERPROFILE%\Downloads` to a temp folder
2. Copying files to the correct subfolders in the GitHub repo
3. Running `git add`, `git commit`, `git push`

Key copy commands:
```bat
copy /y "%TMPDIR%\fuel.js"      "%DEST%\api\fuel.js"
copy /y "%TMPDIR%\index.html"   "%DEST%\public\index.html"
copy /y "%TMPDIR%\styles.css"   "%DEST%\public\styles.css"
copy /y "%TMPDIR%\app.js"       "%DEST%\public\app.js"
if exist "%TMPDIR%\vercel.json" copy /y "%TMPDIR%\vercel.json" "%DEST%\vercel.json"
```

---

## Debugging Checklist

| Symptom | Likely cause | Fix |
|---|---|---|
| 403 on token endpoint | Wrong Vercel region | Check `vercel.json` has `"regions": ["lhr1"]` and redeploy |
| 403 on token endpoint | Bad headers | Ensure `Content-Length` and `Accept` headers are set |
| 500 "missing credentials" | Env vars not set | Add to Vercel dashboard and redeploy |
| `ENOTFOUND` | Wrong hostname | Correct hostname is `www.fuel-finder.service.gov.uk` |
| Function runs in `iad1` | `vercel.json` not deployed | Check file is in repo root, not in `public/` or `api/` |
| Timeout | Too many sequential requests | Fetch batches in parallel groups using `Promise.all` |
