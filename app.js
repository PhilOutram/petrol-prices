/* ============================================================
   FUELSCAN — app.js
   UK Government Fuel Finder API integration
   https://www.gov.uk/guidance/access-the-latest-fuel-prices-and-forecourt-data-via-api-or-email
   ============================================================ */

/* ----------------------------------------------------------------
   ⚙️  CONFIGURATION — Fill these in after registering at:
       https://www.developer.fuel-finder.service.gov.uk/access-latest-fuelprices

   IMPORTANT: For a production app, NEVER expose client credentials
   in frontend code. Use a lightweight backend proxy (Node/Python/etc.)
   that handles OAuth token exchange and forwards requests.
   For local development / prototyping, a CORS proxy is used below.
   ---------------------------------------------------------------- */
const CONFIG = {
  // --- OAuth 2.0 credentials (from Gov Fuel Finder developer portal) ---
  CLIENT_ID:     'YOUR_CLIENT_ID',
  CLIENT_SECRET: 'YOUR_CLIENT_SECRET',

  // --- API endpoints ---
  TOKEN_URL:     'https://api.fuel-finder.service.gov.uk/oauth/token',
  API_BASE:      'https://api.fuel-finder.service.gov.uk/v1',

  // --- Optional: backend proxy URL (recommended for production) ---
  // Set this to your own server endpoint that handles auth + proxying.
  // If set, CLIENT_ID/SECRET above are ignored and this URL is used instead.
  PROXY_URL:     '',   // e.g. 'https://your-server.com/api/fuel'

  // --- Demo mode: uses the public CSV snapshot when true ---
  // Set to false once you have real API credentials.
  DEMO_MODE:     true,
  DEMO_CSV_URL:  'https://api.fuel-finder.service.gov.uk/v1/fuel-prices-data.csv',
};

/* ----------------------------------------------------------------
   POSTCODES.IO — free, open, no-key-needed postcode → lat/lng
   ---------------------------------------------------------------- */
const POSTCODES_API = 'https://api.postcodes.io/postcodes/';

/* ----------------------------------------------------------------
   MILES → METRES (for filtering)
   ---------------------------------------------------------------- */
const MILES_TO_KM = 1.60934;

/* ================================================================
   STATE
   ================================================================ */
let map = null;
let userMarker = null;
let stationMarkers = [];
let allStations = [];
let userLatLng = null;
let accessToken = null;
let tokenExpiry = 0;
let activeCard = null;

/* Current filter state */
let filterState = {
  fuelType: 'petrol',   // 'petrol' | 'diesel'
  radiusMiles: 5,
  sortBy: 'price',      // 'price' | 'distance'
};

/* ================================================================
   DOM REFERENCES
   ================================================================ */
const $ = id => document.getElementById(id);

const dom = {
  btnGps:         $('btn-gps'),
  postcodeInput:  $('postcode-input'),
  btnPostcode:    $('btn-postcode'),
  radiusSelect:   $('radius-select'),
  sortSelect:     $('sort-select'),
  fuelPetrol:     $('fuel-petrol'),
  fuelDiesel:     $('fuel-diesel'),
  statusBar:      $('status-bar'),
  statusText:     $('status-text'),
  errorBar:       $('error-bar'),
  errorText:      $('error-text'),
  errorDismiss:   $('error-dismiss'),
  lastUpdated:    $('last-updated'),
  stationList:    $('station-list'),
  resultCount:    $('result-count'),
  statsRow:       $('stats-row'),
  statCheapest:   $('stat-cheapest'),
  statAvg:        $('stat-avg'),
  statExpensive:  $('stat-expensive'),
};

/* ================================================================
   MAP INITIALISATION
   ================================================================ */
function initMap() {
  map = L.map('map', {
    center: [52.5, -1.5],  // centre of England
    zoom: 7,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    subdomains: 'abcd',
  }).addTo(map);
}

/* ================================================================
   LOCATION: GPS
   ================================================================ */
function getGpsLocation() {
  if (!navigator.geolocation) {
    showError('Geolocation is not supported by your browser. Please enter a postcode.');
    return;
  }
  showStatus('Getting your GPS location...');
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude } = pos.coords;
      userLatLng = { lat: latitude, lng: longitude };
      hideStatus();
      placeUserMarker(latitude, longitude);
      loadStations();
    },
    err => {
      hideStatus();
      const msgs = {
        1: 'Location access was denied. Please allow location access or enter a postcode.',
        2: 'Unable to determine your location. Please enter a postcode.',
        3: 'Location request timed out. Please enter a postcode.',
      };
      showError(msgs[err.code] || 'GPS error. Please enter a postcode.');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/* ================================================================
   LOCATION: POSTCODE
   ================================================================ */
async function getPostcodeLocation(postcode) {
  const clean = postcode.replace(/\s/g, '').toUpperCase();
  if (!clean || clean.length < 5) {
    showError('Please enter a valid UK postcode.');
    return;
  }
  showStatus('Looking up postcode...');
  try {
    const res = await fetch(`${POSTCODES_API}${encodeURIComponent(clean)}`);
    const data = await res.json();
    if (data.status !== 200) throw new Error('Postcode not found.');
    const { latitude, longitude } = data.result;
    userLatLng = { lat: latitude, lng: longitude };
    hideStatus();
    placeUserMarker(latitude, longitude);
    loadStations();
  } catch (e) {
    hideStatus();
    showError(`Postcode lookup failed: ${e.message}`);
  }
}

/* ================================================================
   USER MARKER
   ================================================================ */
function placeUserMarker(lat, lng) {
  if (userMarker) userMarker.remove();
  const icon = L.divIcon({
    className: '',
    html: '<div class="user-marker"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  userMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 })
    .addTo(map)
    .bindPopup('<div style="font-family:var(--font-mono);font-size:12px;color:var(--text)">📍 Your location</div>');
  map.setView([lat, lng], 13);
}

/* ================================================================
   OAUTH TOKEN (only used when DEMO_MODE=false and no PROXY_URL)
   ================================================================ */
async function getAccessToken() {
  if (CONFIG.PROXY_URL) return null;  // proxy handles auth
  if (Date.now() < tokenExpiry - 60000) return accessToken;

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET,
  });

  const res = await fetch(CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const json = await res.json();
  accessToken = json.access_token;
  tokenExpiry = Date.now() + (json.expires_in * 1000);
  return accessToken;
}

/* ================================================================
   LOAD STATIONS — orchestrates API or demo data
   ================================================================ */
async function loadStations() {
  if (!userLatLng) return;
  showStatus('Fetching fuel prices...');
  clearMarkers();
  showSkeletons();

  try {
    let stations;
    if (CONFIG.DEMO_MODE) {
      stations = await fetchViaCsv();
    } else if (CONFIG.PROXY_URL) {
      stations = await fetchViaProxy();
    } else {
      stations = await fetchViaApi();
    }

    allStations = stations;
    hideStatus();
    renderAll();
    updateLastUpdated();

    if (CONFIG.DEMO_MODE) {
      showConfigNotice();
    }
  } catch (e) {
    hideStatus();
    showError(`Failed to load fuel prices: ${e.message}`);
    dom.stationList.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${e.message}</p></div>`;
  }
}

/* ================================================================
   FETCH: via official REST API (needs OAuth)
   ================================================================ */
async function fetchViaApi() {
  const token = await getAccessToken();
  const { lat, lng } = userLatLng;
  const radiusMetres = filterState.radiusMiles * MILES_TO_KM * 1000;

  const url = new URL(`${CONFIG.API_BASE}/stations`);
  url.searchParams.set('latitude',  lat);
  url.searchParams.set('longitude', lng);
  url.searchParams.set('radius',    radiusMetres);
  url.searchParams.set('fuels',     apiFullFuelParam());

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const json = await res.json();

  return normaliseApiResponse(json);
}

/* ================================================================
   FETCH: via backend proxy
   ================================================================ */
async function fetchViaProxy() {
  const { lat, lng } = userLatLng;
  const url = new URL(CONFIG.PROXY_URL);
  url.searchParams.set('lat',    lat);
  url.searchParams.set('lng',    lng);
  url.searchParams.set('radius', filterState.radiusMiles);
  url.searchParams.set('fuel',   filterState.fuelType);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Proxy error ${res.status}`);
  const json = await res.json();
  return normaliseApiResponse(json);
}

/* ================================================================
   FETCH: via public CSV (demo / fallback)
   The CSV is served by the Fuel Finder service and contains all UK
   stations. We filter client-side by radius.
   ================================================================ */
async function fetchViaCsv() {
  // The official CSV has CORS restrictions in a pure browser context.
  // In production use your own backend to forward it.
  // For demo purposes, we generate realistic synthetic data so you
  // can see the full UI without API credentials.
  return generateDemoData();
}

/* ================================================================
   NORMALISE API RESPONSE
   Adapt this to match the actual Fuel Finder API response shape
   once you have access to the developer docs.
   ================================================================ */
function normaliseApiResponse(json) {
  // The Fuel Finder API returns stations as an array.
  // Expected shape (confirm in official docs):
  // { stations: [{ id, name, brand, address, postcode, latitude, longitude,
  //                prices: { E5, E10, B7, SDV }, last_updated }, ...] }
  const raw = Array.isArray(json) ? json : (json.stations || json.data || []);

  return raw.map(s => ({
    id:          s.id || s.site_id,
    name:        s.name || s.site_name || 'Unknown Station',
    brand:       s.brand || s.retailer_name || '',
    address:     [s.address, s.town, s.postcode].filter(Boolean).join(', '),
    lat:         parseFloat(s.latitude  || s.lat),
    lng:         parseFloat(s.longitude || s.lng),
    petrolPrice: parsePence(s.prices?.E5 || s.prices?.E10 || s.unleaded),
    dieselPrice: parsePence(s.prices?.B7 || s.diesel),
    lastUpdated: s.last_updated || s.updated_at || null,
    distance:    null,  // calculated below
  })).filter(s => !isNaN(s.lat) && !isNaN(s.lng));
}

function parsePence(val) {
  if (val == null || val === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function apiFullFuelParam() {
  return filterState.fuelType === 'diesel' ? 'B7' : 'E5,E10';
}

/* ================================================================
   DEMO DATA GENERATOR
   Realistic synthetic stations around the user's location.
   Replace with real API data once credentials are set up.
   ================================================================ */
function generateDemoData() {
  const brands = ['BP','Shell','Esso','Texaco','Gulf','Jet','Morrisons','Tesco','Sainsbury\'s','Asda','Co-op','Costco','Total'];
  const suffixes = ['Service Station','Forecourt','Garage','Petrol Station','Fill-Up'];
  const baseP = 142 + Math.random() * 12;  // petrol ~142–154p
  const baseD = 148 + Math.random() * 14;  // diesel ~148–162p
  const { lat, lng } = userLatLng;
  const stations = [];

  for (let i = 0; i < 22; i++) {
    const brand = brands[Math.floor(Math.random() * brands.length)];
    const offsetLat = (Math.random() - 0.5) * 0.14;
    const offsetLng = (Math.random() - 0.5) * 0.22;
    const sLat = lat + offsetLat;
    const sLng = lng + offsetLng;
    const dist = haversine(lat, lng, sLat, sLng);
    if (dist > filterState.radiusMiles + 2) continue;

    const pVar = (Math.random() - 0.5) * 14;
    const dVar = (Math.random() - 0.5) * 16;

    stations.push({
      id:          `demo-${i}`,
      name:        `${brand} ${suffixes[Math.floor(Math.random() * suffixes.length)]}`,
      brand,
      address:     `${Math.floor(Math.random()*200)+1} Example Road`,
      lat:         sLat,
      lng:         sLng,
      petrolPrice: parseFloat((baseP + pVar).toFixed(1)),
      dieselPrice: parseFloat((baseD + dVar).toFixed(1)),
      lastUpdated: new Date(Date.now() - Math.random() * 3600000).toISOString(),
      distance:    null,
    });
  }
  return stations;
}

/* ================================================================
   RENDER ALL — filter, sort, build cards + markers
   ================================================================ */
function renderAll() {
  if (!userLatLng || allStations.length === 0) return;

  // Attach distances
  const withDist = allStations.map(s => ({
    ...s,
    distance: haversine(userLatLng.lat, userLatLng.lng, s.lat, s.lng),
  }));

  // Filter by radius & fuel availability
  const filtered = withDist.filter(s => {
    if (s.distance > filterState.radiusMiles) return false;
    const price = filterState.fuelType === 'petrol' ? s.petrolPrice : s.dieselPrice;
    return price !== null && price > 0;
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    if (filterState.sortBy === 'distance') return a.distance - b.distance;
    const ap = filterState.fuelType === 'petrol' ? a.petrolPrice : a.dieselPrice;
    const bp = filterState.fuelType === 'petrol' ? b.petrolPrice : b.dieselPrice;
    return ap - bp;
  });

  // Price range for colouring
  const prices = sorted.map(s => filterState.fuelType === 'petrol' ? s.petrolPrice : s.dieselPrice);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const avgP = prices.reduce((a, b) => a + b, 0) / prices.length;

  // Update stats
  updateStats(minP, avgP, maxP);

  // Result count
  dom.resultCount.textContent = `${sorted.length} station${sorted.length !== 1 ? 's' : ''}`;

  // Render cards
  clearMarkers();
  dom.stationList.innerHTML = '';

  if (sorted.length === 0) {
    dom.stationList.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>No stations with ${filterState.fuelType} prices found within ${filterState.radiusMiles} miles.</p></div>`;
    dom.statsRow.classList.add('hidden');
    return;
  }

  sorted.forEach((station, idx) => {
    const price = filterState.fuelType === 'petrol' ? station.petrolPrice : station.dieselPrice;
    const tier = getPriceTier(price, minP, maxP);
    addStationMarker(station, price, tier, idx);
    dom.stationList.appendChild(buildCard(station, price, tier, idx, minP, maxP));
  });

  // Fit map to all markers + user
  fitMapToMarkers(sorted);
}

/* Price tier classification */
function getPriceTier(price, min, max) {
  const range = max - min;
  if (range < 0.1) return 'cheapest';
  const normalised = (price - min) / range;
  if (normalised < 0.33) return 'cheapest';
  if (normalised < 0.66) return 'mid';
  return 'pricey';
}

/* ================================================================
   STATION CARD
   ================================================================ */
function buildCard(station, price, tier, rank, minP, maxP) {
  const card = document.createElement('div');
  card.className = 'station-card';
  card.dataset.id = station.id;

  const rankLabel = rank === 0 ? '🥇 #1 Cheapest' : rank === 1 ? '🥈 #2' : rank === 2 ? '🥉 #3' : `#${rank + 1}`;
  const rankClass = rank < 3 ? `rank-${rank + 1}` : '';

  const colorClass = tier === 'cheapest' ? 'green' : tier === 'mid' ? 'yellow' : 'red';
  const chipClass  = tier === 'cheapest' ? 'cheapest-chip' : tier === 'mid' ? 'mid-chip' : 'pricey-chip';

  const updated = station.lastUpdated ? timeAgo(new Date(station.lastUpdated)) : '';

  // Show both prices if available
  let priceBlock = `
    <div class="price-chip ${chipClass}">
      <span class="price-chip-label">${filterState.fuelType === 'petrol' ? 'Petrol' : 'Diesel'}</span>
      <span class="price-chip-value ${colorClass}">${price.toFixed(1)}</span>
      <span class="price-chip-unit">p/litre</span>
    </div>
  `;
  // Show the other fuel type if also available
  if (filterState.fuelType === 'petrol' && station.dieselPrice) {
    priceBlock += `
      <div class="price-chip">
        <span class="price-chip-label">Diesel</span>
        <span class="price-chip-value">${station.dieselPrice.toFixed(1)}</span>
        <span class="price-chip-unit">p/litre</span>
      </div>
    `;
  } else if (filterState.fuelType === 'diesel' && station.petrolPrice) {
    priceBlock += `
      <div class="price-chip">
        <span class="price-chip-label">Petrol</span>
        <span class="price-chip-value">${station.petrolPrice.toFixed(1)}</span>
        <span class="price-chip-unit">p/litre</span>
      </div>
    `;
  }

  card.innerHTML = `
    <span class="station-rank ${rankClass}">${rankLabel}</span>
    <div class="station-top">
      <div>
        <div class="station-name">${escHtml(station.name)}</div>
        <div class="station-brand">${escHtml(station.brand)}</div>
      </div>
    </div>
    <div class="station-price-block">${priceBlock}</div>
    <div class="station-footer">
      <span class="station-address" title="${escHtml(station.address)}">${escHtml(station.address)}</span>
      <span class="station-distance">${station.distance.toFixed(1)} mi</span>
      ${updated ? `<span class="station-updated">${updated}</span>` : ''}
    </div>
  `;

  card.addEventListener('click', () => highlightStation(station.id, station));
  return card;
}

/* ================================================================
   MAP MARKERS
   ================================================================ */
function addStationMarker(station, price, tier, rank) {
  const tierClass = tier === 'cheapest' ? '' : tier === 'mid' ? 'mid' : 'pricey';
  const html = `
    <div class="custom-marker">
      <div class="marker-bubble ${tierClass}">${price.toFixed(1)}p</div>
      <div class="marker-tail ${tierClass}"></div>
    </div>
  `;
  const icon = L.divIcon({
    className: '',
    html,
    iconSize: [60, 30],
    iconAnchor: [30, 35],
  });

  const marker = L.marker([station.lat, station.lng], { icon })
    .addTo(map)
    .bindPopup(buildPopup(station, price));

  marker.on('click', () => highlightStation(station.id, station));
  stationMarkers.push({ id: station.id, marker });
}

function buildPopup(station, price) {
  return `
    <div class="popup-name">${escHtml(station.name)}</div>
    <div class="popup-brand">${escHtml(station.brand)}</div>
    <div class="popup-prices">
      ${station.petrolPrice ? `<div class="popup-price"><span class="label">Petrol</span>${station.petrolPrice.toFixed(1)}p</div>` : ''}
      ${station.dieselPrice ? `<div class="popup-price"><span class="label">Diesel</span>${station.dieselPrice.toFixed(1)}p</div>` : ''}
    </div>
    <div class="popup-address">${escHtml(station.address)}</div>
  `;
}

function clearMarkers() {
  stationMarkers.forEach(({ marker }) => marker.remove());
  stationMarkers = [];
}

function fitMapToMarkers(stations) {
  if (!stations.length) return;
  const bounds = L.latLngBounds(stations.map(s => [s.lat, s.lng]));
  if (userLatLng) bounds.extend([userLatLng.lat, userLatLng.lng]);
  map.fitBounds(bounds, { padding: [40, 40] });
}

/* ================================================================
   HIGHLIGHT — sync card & marker
   ================================================================ */
function highlightStation(id, station) {
  // Deactivate previous
  if (activeCard) activeCard.classList.remove('highlighted');
  const prevMarkerObj = stationMarkers.find(m => m.id === activeCard?.dataset?.id);
  if (prevMarkerObj) prevMarkerObj.marker.closePopup();

  // Activate new
  const card = dom.stationList.querySelector(`[data-id="${id}"]`);
  if (card) {
    card.classList.add('highlighted');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    activeCard = card;
  }
  const markerObj = stationMarkers.find(m => m.id === id);
  if (markerObj) {
    markerObj.marker.openPopup();
    map.setView([station.lat, station.lng], Math.max(map.getZoom(), 14), { animate: true });
  }
}

/* ================================================================
   STATS ROW
   ================================================================ */
function updateStats(min, avg, max) {
  dom.statsRow.classList.remove('hidden');
  dom.statCheapest.textContent  = `${min.toFixed(1)}p`;
  dom.statAvg.textContent       = `${avg.toFixed(1)}p`;
  dom.statExpensive.textContent = `${max.toFixed(1)}p`;
}

/* ================================================================
   SKELETONS
   ================================================================ */
function showSkeletons() {
  dom.stationList.innerHTML = Array.from({ length: 5 }, () =>
    '<div class="skeleton skeleton-card"></div>'
  ).join('');
}

/* ================================================================
   CONFIG NOTICE (demo mode)
   ================================================================ */
function showConfigNotice() {
  const notice = document.createElement('div');
  notice.className = 'config-notice';
  notice.innerHTML = `
    <strong>⚙️ Demo Mode Active</strong><br>
    Showing synthetic data. To use live official prices:<br>
    1. Register at <a href="https://www.developer.fuel-finder.service.gov.uk/access-latest-fuelprices" target="_blank">developer.fuel-finder.service.gov.uk</a><br>
    2. Add your <code>CLIENT_ID</code> &amp; <code>CLIENT_SECRET</code> in <code>app.js → CONFIG</code><br>
    3. Set <code>DEMO_MODE: false</code>
  `;
  dom.stationList.insertBefore(notice, dom.stationList.firstChild);
}

/* ================================================================
   STATUS / ERROR UI
   ================================================================ */
function showStatus(msg) {
  dom.statusText.textContent = msg;
  dom.statusBar.classList.remove('hidden');
  dom.errorBar.classList.add('hidden');
}
function hideStatus() {
  dom.statusBar.classList.add('hidden');
}
function showError(msg) {
  dom.errorText.textContent = msg;
  dom.errorBar.classList.remove('hidden');
  dom.statusBar.classList.add('hidden');
}
function updateLastUpdated() {
  dom.lastUpdated.textContent = `Updated: ${new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })}`;
}

/* ================================================================
   HELPERS
   ================================================================ */

/** Haversine distance in miles */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;  // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(deg) { return deg * Math.PI / 180; }

/** Time-ago string */
function timeAgo(date) {
  const mins = Math.floor((Date.now() - date) / 60000);
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs/24)}d ago`;
}

/** Escape HTML */
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ================================================================
   EVENT LISTENERS
   ================================================================ */

// GPS button
dom.btnGps.addEventListener('click', () => {
  dom.btnGps.classList.add('active');
  getGpsLocation();
});

// Postcode enter key
dom.postcodeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') getPostcodeLocation(dom.postcodeInput.value);
});

// Postcode search button
dom.btnPostcode.addEventListener('click', () => {
  dom.btnGps.classList.remove('active');
  getPostcodeLocation(dom.postcodeInput.value);
});

// Radius change
dom.radiusSelect.addEventListener('change', () => {
  filterState.radiusMiles = parseInt(dom.radiusSelect.value, 10);
  if (userLatLng && allStations.length) renderAll();
});

// Sort change
dom.sortSelect.addEventListener('change', () => {
  filterState.sortBy = dom.sortSelect.value;
  if (userLatLng && allStations.length) renderAll();
});

// Fuel type toggle
document.querySelectorAll('.fuel-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fuel-toggle').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filterState.fuelType = btn.dataset.fuel;
    if (userLatLng && allStations.length) renderAll();
    else if (userLatLng) loadStations();
  });
});

// Error dismiss
dom.errorDismiss.addEventListener('click', () => dom.errorBar.classList.add('hidden'));

/* ================================================================
   INIT
   ================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initMap();
});
