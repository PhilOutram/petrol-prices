/* ============================================================
   FUELSCAN — app.js
   Frontend logic. API calls go via /api/fuel (Vercel Function).
   ============================================================ */

/* ----------------------------------------------------------------
   CONFIG — update PROXY_URL if you deploy to a custom domain.
   In Vercel, /api/fuel is relative so no change needed.
   ---------------------------------------------------------------- */
const CONFIG = {
  PROXY_URL:  '/api/fuel',  // Vercel serverless function
  DEMO_MODE:  false,        // set true to use synthetic data (no credentials needed)
};

const POSTCODES_API = 'https://api.postcodes.io/postcodes/';

/* ================================================================
   STATE
   ================================================================ */
let map          = null;
let userMarker   = null;
let stationMarkers = [];
let allStations  = [];
let userLatLng   = null;
let activeCard   = null;

let filterState = {
  fuelType:    'petrol',
  radiusMiles: 5,
  sortBy:      'price',
};

/* ================================================================
   DOM
   ================================================================ */
const $ = id => document.getElementById(id);
const dom = {
  btnGps:        $('btn-gps'),
  postcodeInput: $('postcode-input'),
  btnPostcode:   $('btn-postcode'),
  radiusSelect:  $('radius-select'),
  sortSelect:    $('sort-select'),
  statusBar:     $('status-bar'),
  statusText:    $('status-text'),
  errorBar:      $('error-bar'),
  errorText:     $('error-text'),
  errorDismiss:  $('error-dismiss'),
  lastUpdated:   $('last-updated'),
  stationList:   $('station-list'),
  resultCount:   $('result-count'),
  statsRow:      $('stats-row'),
  statCheapest:  $('stat-cheapest'),
  statAvg:       $('stat-avg'),
  statExpensive: $('stat-expensive'),
  themeToggle:   $('theme-toggle'),
};

/* ================================================================
   THEME TOGGLE
   ================================================================ */
const THEME_KEY = 'fuelscan-theme';

function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  updateMapTiles(theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

/* ================================================================
   MAP INIT
   ================================================================ */
let darkTileLayer  = null;
let lightTileLayer = null;

function initMap() {
  map = L.map('map', { center: [52.5, -1.5], zoom: 7, zoomControl: true });

  darkTileLayer = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://openstreetmap.org/copyright">OSM</a>', maxZoom: 19, subdomains: 'abcd' }
  );

  lightTileLayer = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://openstreetmap.org/copyright">OSM</a>', maxZoom: 19, subdomains: 'abcd' }
  );

  const initialTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  (initialTheme === 'dark' ? darkTileLayer : lightTileLayer).addTo(map);
}

function updateMapTiles(theme) {
  if (!map) return;
  if (theme === 'dark') {
    if (map.hasLayer(lightTileLayer)) { map.removeLayer(lightTileLayer); darkTileLayer.addTo(map); }
  } else {
    if (map.hasLayer(darkTileLayer))  { map.removeLayer(darkTileLayer); lightTileLayer.addTo(map); }
  }
}

/* ================================================================
   LOCATION: GPS
   ================================================================ */
function getGpsLocation() {
  if (!navigator.geolocation) { showError('Geolocation is not supported. Please enter a postcode.'); return; }
  showStatus('Getting your GPS location...');
  navigator.geolocation.getCurrentPosition(
    pos => {
      userLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      hideStatus();
      placeUserMarker(userLatLng.lat, userLatLng.lng);
      loadStations();
    },
    err => {
      hideStatus();
      const msgs = { 1: 'Location access denied. Please enter a postcode.', 2: 'Unable to determine location. Please enter a postcode.', 3: 'Location request timed out.' };
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
  if (clean.length < 5) { showError('Please enter a valid UK postcode.'); return; }
  showStatus('Looking up postcode...');
  try {
    const res  = await fetch(`${POSTCODES_API}${encodeURIComponent(clean)}`);
    const data = await res.json();
    if (data.status !== 200) throw new Error('Postcode not found.');
    userLatLng = { lat: data.result.latitude, lng: data.result.longitude };
    hideStatus();
    placeUserMarker(userLatLng.lat, userLatLng.lng);
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
  const icon = L.divIcon({ className: '', html: '<div class="user-marker"></div>', iconSize: [14,14], iconAnchor: [7,7] });
  userMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map)
    .bindPopup('<div style="font-family:\'DM Mono\',monospace;font-size:12px">📍 Your location</div>');
  map.setView([lat, lng], 13);
}

/* ================================================================
   LOAD STATIONS
   ================================================================ */
async function loadStations() {
  if (!userLatLng) return;
  showStatus('Fetching fuel prices...');
  clearMarkers();
  showSkeletons();

  try {
    const stations = CONFIG.DEMO_MODE ? generateDemoData() : await fetchViaProxy();
    allStations = stations;
    hideStatus();
    renderAll();
    dom.lastUpdated.textContent = `Updated: ${new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })}`;
    if (CONFIG.DEMO_MODE) showConfigNotice();
  } catch (e) {
    hideStatus();
    showError(`Failed to load fuel prices: ${e.message}`);
    dom.stationList.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${escHtml(e.message)}</p></div>`;
  }
}

/* ================================================================
   FETCH via Vercel proxy
   ================================================================ */
async function fetchViaProxy() {
  const { lat, lng } = userLatLng;
  const url = new URL(CONFIG.PROXY_URL, window.location.origin);
  url.searchParams.set('lat',    lat);
  url.searchParams.set('lng',    lng);
  url.searchParams.set('radius', filterState.radiusMiles);
  url.searchParams.set('fuel',   filterState.fuelType);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Proxy error ${res.status}`);
  }
  const json = await res.json();
  return normaliseApiResponse(json);
}

/* ================================================================
   NORMALISE API RESPONSE
   Adjust field mappings once you have access to the official docs.
   ================================================================ */
function normaliseApiResponse(json) {
  const raw = Array.isArray(json) ? json : (json.stations || json.data || []);
  return raw.map(s => ({
    id:          s.id || s.site_id || String(Math.random()),
    name:        s.name || s.site_name || 'Unknown Station',
    brand:       s.brand || s.retailer_name || '',
    address:     [s.address, s.town, s.postcode].filter(Boolean).join(', '),
    lat:         parseFloat(s.latitude  || s.lat),
    lng:         parseFloat(s.longitude || s.lng),
    petrolPrice: parsePence(s.prices?.E5 || s.prices?.E10 || s.unleaded),
    dieselPrice: parsePence(s.prices?.B7 || s.diesel),
    lastUpdated: s.last_updated || s.updated_at || null,
    distance:    null,
  })).filter(s => !isNaN(s.lat) && !isNaN(s.lng));
}

function parsePence(val) {
  if (val == null || val === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/* ================================================================
   DEMO DATA
   ================================================================ */
function generateDemoData() {
  const brands   = ['BP','Shell','Esso','Texaco','Gulf','Jet','Morrisons','Tesco','Sainsbury\'s','Asda','Co-op','Total'];
  const suffixes = ['Service Station','Forecourt','Garage','Petrol Station'];
  const baseP = 142 + Math.random() * 12;
  const baseD = 148 + Math.random() * 14;
  const { lat, lng } = userLatLng;
  const out = [];
  for (let i = 0; i < 22; i++) {
    const brand   = brands[Math.floor(Math.random() * brands.length)];
    const sLat = lat + (Math.random() - 0.5) * 0.14;
    const sLng = lng + (Math.random() - 0.5) * 0.22;
    if (haversine(lat, lng, sLat, sLng) > filterState.radiusMiles + 2) continue;
    out.push({
      id: `demo-${i}`, name: `${brand} ${suffixes[i % suffixes.length]}`,
      brand, address: `${(i+1)*7} Example Road`,
      lat: sLat, lng: sLng,
      petrolPrice: parseFloat((baseP + (Math.random()-0.5)*14).toFixed(1)),
      dieselPrice: parseFloat((baseD + (Math.random()-0.5)*16).toFixed(1)),
      lastUpdated: new Date(Date.now() - Math.random()*3600000).toISOString(),
      distance: null,
    });
  }
  return out;
}

/* ================================================================
   RENDER
   ================================================================ */
function renderAll() {
  if (!userLatLng || !allStations.length) return;

  const withDist = allStations.map(s => ({ ...s, distance: haversine(userLatLng.lat, userLatLng.lng, s.lat, s.lng) }));

  const filtered = withDist.filter(s => {
    if (s.distance > filterState.radiusMiles) return false;
    const p = filterState.fuelType === 'petrol' ? s.petrolPrice : s.dieselPrice;
    return p !== null && p > 0;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (filterState.sortBy === 'distance') return a.distance - b.distance;
    const ap = filterState.fuelType === 'petrol' ? a.petrolPrice : a.dieselPrice;
    const bp = filterState.fuelType === 'petrol' ? b.petrolPrice : b.dieselPrice;
    return ap - bp;
  });

  const prices = sorted.map(s => filterState.fuelType === 'petrol' ? s.petrolPrice : s.dieselPrice);
  const minP   = Math.min(...prices);
  const maxP   = Math.max(...prices);
  const avgP   = prices.reduce((a,b) => a+b, 0) / prices.length;

  updateStats(minP, avgP, maxP);
  dom.resultCount.textContent = `${sorted.length} station${sorted.length !== 1 ? 's' : ''}`;

  clearMarkers();
  dom.stationList.innerHTML = '';

  if (!sorted.length) {
    dom.stationList.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>No ${filterState.fuelType} stations found within ${filterState.radiusMiles} miles.</p></div>`;
    dom.statsRow.classList.add('hidden');
    return;
  }

  sorted.forEach((station, idx) => {
    const price = filterState.fuelType === 'petrol' ? station.petrolPrice : station.dieselPrice;
    const tier  = getPriceTier(price, minP, maxP);
    addStationMarker(station, price, tier);
    dom.stationList.appendChild(buildCard(station, price, tier, idx));
  });

  fitMapToMarkers(sorted);
}

function getPriceTier(price, min, max) {
  const range = max - min;
  if (range < 0.1) return 'cheapest';
  const n = (price - min) / range;
  return n < 0.33 ? 'cheapest' : n < 0.66 ? 'mid' : 'pricey';
}

/* ================================================================
   STATION CARD
   ================================================================ */
function buildCard(station, price, tier, rank) {
  const card = document.createElement('div');
  card.className = 'station-card';
  card.dataset.id = station.id;

  const rankLabel = rank === 0 ? '🥇 #1 Cheapest' : rank === 1 ? '🥈 #2' : rank === 2 ? '🥉 #3' : `#${rank+1}`;
  const rankClass = rank < 3 ? `rank-${rank+1}` : '';
  const colorClass = tier === 'cheapest' ? 'green' : tier === 'mid' ? 'yellow' : 'red';
  const chipClass  = `${tier}-chip`;

  let priceBlock = `
    <div class="price-chip ${chipClass}">
      <span class="price-chip-label">${filterState.fuelType === 'petrol' ? 'Petrol' : 'Diesel'}</span>
      <span class="price-chip-value ${colorClass}">${price.toFixed(1)}</span>
      <span class="price-chip-unit">p/litre</span>
    </div>`;

  const altPrice = filterState.fuelType === 'petrol' ? station.dieselPrice : station.petrolPrice;
  const altLabel = filterState.fuelType === 'petrol' ? 'Diesel' : 'Petrol';
  if (altPrice) {
    priceBlock += `
      <div class="price-chip">
        <span class="price-chip-label">${altLabel}</span>
        <span class="price-chip-value">${altPrice.toFixed(1)}</span>
        <span class="price-chip-unit">p/litre</span>
      </div>`;
  }

  const updated = station.lastUpdated ? timeAgo(new Date(station.lastUpdated)) : '';
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
    </div>`;

  card.addEventListener('click', () => highlightStation(station.id, station));
  return card;
}

/* ================================================================
   MAP MARKERS
   ================================================================ */
function addStationMarker(station, price, tier) {
  const tc = tier === 'cheapest' ? '' : tier;
  const icon = L.divIcon({
    className: '',
    html: `<div class="custom-marker"><div class="marker-bubble ${tc}">${price.toFixed(1)}p</div><div class="marker-tail ${tc}"></div></div>`,
    iconSize: [60, 35], iconAnchor: [30, 35],
  });
  const marker = L.marker([station.lat, station.lng], { icon }).addTo(map).bindPopup(buildPopup(station));
  marker.on('click', () => highlightStation(station.id, station));
  stationMarkers.push({ id: station.id, marker });
}

function buildPopup(station) {
  return `
    <div class="popup-name">${escHtml(station.name)}</div>
    <div class="popup-brand">${escHtml(station.brand)}</div>
    <div class="popup-prices">
      ${station.petrolPrice ? `<div class="popup-price"><span class="label">Petrol</span>${station.petrolPrice.toFixed(1)}p</div>` : ''}
      ${station.dieselPrice ? `<div class="popup-price"><span class="label">Diesel</span>${station.dieselPrice.toFixed(1)}p</div>` : ''}
    </div>
    <div class="popup-address">${escHtml(station.address)}</div>`;
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
   HIGHLIGHT
   ================================================================ */
function highlightStation(id, station) {
  if (activeCard) activeCard.classList.remove('highlighted');
  const card = dom.stationList.querySelector(`[data-id="${id}"]`);
  if (card) { card.classList.add('highlighted'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); activeCard = card; }
  const mo = stationMarkers.find(m => m.id === id);
  if (mo) { mo.marker.openPopup(); map.setView([station.lat, station.lng], Math.max(map.getZoom(), 14), { animate: true }); }
}

/* ================================================================
   STATS
   ================================================================ */
function updateStats(min, avg, max) {
  dom.statsRow.classList.remove('hidden');
  dom.statCheapest.textContent  = `${min.toFixed(1)}p`;
  dom.statAvg.textContent       = `${avg.toFixed(1)}p`;
  dom.statExpensive.textContent = `${max.toFixed(1)}p`;
}

/* ================================================================
   SKELETONS / NOTICES
   ================================================================ */
function showSkeletons() {
  dom.stationList.innerHTML = Array.from({ length: 5 }, () => '<div class="skeleton skeleton-card"></div>').join('');
}

function showConfigNotice() {
  const n = document.createElement('div');
  n.className = 'config-notice';
  n.innerHTML = `<strong>⚙️ Demo Mode</strong> — showing synthetic data.<br>
    Set <code>DEMO_MODE: false</code> in app.js and add your Vercel environment variables to use live prices.`;
  dom.stationList.insertBefore(n, dom.stationList.firstChild);
}

/* ================================================================
   STATUS / ERROR
   ================================================================ */
function showStatus(msg) { dom.statusText.textContent = msg; dom.statusBar.classList.remove('hidden'); dom.errorBar.classList.add('hidden'); }
function hideStatus()    { dom.statusBar.classList.add('hidden'); }
function showError(msg)  { dom.errorText.textContent = msg; dom.errorBar.classList.remove('hidden'); dom.statusBar.classList.add('hidden'); }

/* ================================================================
   HELPERS
   ================================================================ */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8, dLat = toRad(lat2-lat1), dLng = toRad(lng2-lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function toRad(d) { return d * Math.PI / 180; }

function timeAgo(date) {
  const m = Math.floor((Date.now()-date)/60000);
  if (m < 2)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h/24)}d ago`;
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ================================================================
   EVENT LISTENERS
   ================================================================ */
dom.btnGps.addEventListener('click', () => { dom.btnGps.classList.add('active'); getGpsLocation(); });

dom.postcodeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { dom.btnGps.classList.remove('active'); getPostcodeLocation(dom.postcodeInput.value); }
});
dom.btnPostcode.addEventListener('click', () => { dom.btnGps.classList.remove('active'); getPostcodeLocation(dom.postcodeInput.value); });

dom.radiusSelect.addEventListener('change', () => {
  filterState.radiusMiles = parseInt(dom.radiusSelect.value, 10);
  if (userLatLng && allStations.length) renderAll();
});
dom.sortSelect.addEventListener('change', () => {
  filterState.sortBy = dom.sortSelect.value;
  if (userLatLng && allStations.length) renderAll();
});
document.querySelectorAll('.fuel-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fuel-toggle').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filterState.fuelType = btn.dataset.fuel;
    if (userLatLng && allStations.length) renderAll();
    else if (userLatLng) loadStations();
  });
});

dom.errorDismiss.addEventListener('click', () => dom.errorBar.classList.add('hidden'));
dom.themeToggle.addEventListener('click', toggleTheme);

/* ================================================================
   INIT
   ================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(getStoredTheme());
  initMap();
});
