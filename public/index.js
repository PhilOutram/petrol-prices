// ================================================================
// FuelScan — Main App
// ================================================================
const APP_VERSION    = 'v1.1.0';   // shown in the header; keep sw.js CACHE name in sync
const FAV_KEY        = 'fuelscan_favourite';
const PINNED_KEY     = 'fuelscan_pinned';
const FILL_LITRES    = 60;
const EARTH_RADIUS_M = 6371000;
const STATUS_HIDE_MS = 3000;   // ms after which status bar auto-hides
const USER_MARKER_Z  = 1000;   // z-offset so the location dot sits above all station pins

// ── DOM ──────────────────────────────────────────────────────────
const postcodeInput   = document.getElementById('postcode-input');
const searchBtn       = document.getElementById('search-btn');
const gpsBtn          = document.getElementById('gps-btn');
const favBtn          = document.getElementById('fav-btn');
const radiusSelect    = document.getElementById('radius-select');
const fuelSelect      = document.getElementById('fuel-select');
const statusEl        = document.getElementById('status');
const resetProfileBtn = document.getElementById('reset-profile-btn');
const summaryBar      = document.getElementById('summary-bar');
const mapWrap         = document.getElementById('map-wrap');
const searchHereBtn   = document.getElementById('search-here-btn');
const resultsEl       = document.getElementById('results');
const resultsTitleEl  = document.getElementById('results-title');
const resultsMetaEl   = document.getElementById('results-meta');
const stationListEl   = document.getElementById('station-list');

// ── State ─────────────────────────────────────────────────────────
let leafletMap      = null;
let mapMarkers      = [];
let userMarker      = null;    // the "your location" dot — tracked so it can be replaced
let lastStations    = [];      // filtered list currently shown (used by pin re-render)
let lastLat         = null;
let lastLng         = null;
let statusHideTimer = null;
let mapMoved        = false;   // tracks whether user has panned/zoomed
let datasetStations = [];      // full UK station list from the shared cache
let currentQuery    = null;    // { lat, lng, radiusMiles, fuelType, postcode, saveAsFav }
let refreshing      = false;   // true while a background/foreground refresh is in flight

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Helpers ───────────────────────────────────────────────────────
function showStatus(msg, type = 'loading', autoHide = false) {
  clearTimeout(statusHideTimer);
  statusEl.innerHTML = msg;
  statusEl.className = `status ${type}`;
  if (autoHide) {
    statusHideTimer = setTimeout(hideStatus, STATUS_HIDE_MS);
  }
}
function hideStatus() {
  statusEl.className = 'status hidden';
  clearTimeout(statusHideTimer);
}

function distanceMetres(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function metresToMiles(m) { return m / 1609.344; }
function fillCost(pricePence) { return ((pricePence / 100) * FILL_LITRES).toFixed(2); }

// ── Storage ───────────────────────────────────────────────────────
function loadFav()      { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || null; } catch { return null; } }
function saveFav(f)     { localStorage.setItem(FAV_KEY, JSON.stringify(f)); }
function loadPinned()   { try { return JSON.parse(localStorage.getItem(PINNED_KEY)) || []; } catch { return []; } }
function savePinned(p)  { localStorage.setItem(PINNED_KEY, JSON.stringify(p)); }

// ── Favourite button ──────────────────────────────────────────────
function updateFavBtn() {
  const fav = loadFav();
  if (fav) {
    favBtn.disabled = false;
    favBtn.title    = `★ ${fav.postcode || 'GPS'} · ${fav.fuelLabel} · ${fav.radius}mi`;
    favBtn.classList.add('fav-ready');
  } else {
    favBtn.disabled = true;
    favBtn.title    = 'Available after first search';
    favBtn.classList.remove('fav-ready');
  }
}

// ── Postcode → lat/lng ────────────────────────────────────────────
async function postcodeToLatLng(postcode) {
  const res  = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
  const data = await res.json();
  if (!res.ok || data.status !== 200) throw new Error('Postcode not found');
  return { lat: data.result.latitude, lng: data.result.longitude };
}

// ── Filter & sort ─────────────────────────────────────────────────
// When `bounds` is given (a "Search here"), keep every station inside the visible map
// rectangle. Otherwise keep stations within `radiusMiles` of (lat,lng). Distance is still
// computed from the centre for the per-station "X mi" label either way.
function filterStations(stations, lat, lng, radiusMiles, fuelType, bounds = null) {
  return stations
    .filter(s => s.latitude != null && s.longitude != null)
    .map(s => ({
      ...s,
      distanceMiles: metresToMiles(distanceMetres(lat, lng, s.latitude, s.longitude)),
      price: (s.fuel_prices || []).find(fp => fp.fuel_type === fuelType)?.price ?? null,
    }))
    .filter(s => {
      if (s.price === null) return false;
      if (bounds) {
        return s.latitude  >= bounds.south && s.latitude  <= bounds.north
            && s.longitude >= bounds.west  && s.longitude <= bounds.east;
      }
      return s.distanceMiles <= radiusMiles;
    })
    .sort((a, b) => a.price - b.price);
}

// ── Shared cache API ──────────────────────────────────────────────
// /api/fuel    -> { status: 'fresh'|'stale'|'empty', ageMinutes?, stations? }  (fast read)
// /api/refresh -> { status: 'fresh', stations } | { status: 'refreshing' }     (does the work)
async function getCache() {
  const res  = await fetch('/api/fuel');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load prices');
  return data;
}

async function runRefresh() {
  const res  = await fetch('/api/refresh');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Refresh failed');
  return data;
}

function ageText(min) {
  if (min < 1)  return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return `${h} hour${h !== 1 ? 's' : ''} ago`;
}

// ── Summary bar ───────────────────────────────────────────────────
// Stays visible at all times after the first search. With fewer than 2 stations there is
// nothing to compare, so it shows a message instead of the cheapest/priciest/saving columns.
function renderSummary(stations) {
  summaryBar.classList.remove('hidden');
  const msgEl = document.getElementById('summary-msg');

  if (stations.length < 2) {
    summaryBar.classList.add('empty');
    msgEl.textContent = stations.length === 0
      ? 'No stations within the search area.'
      : 'Only one station within the search area.';
    return;
  }
  summaryBar.classList.remove('empty');

  const cheap  = stations[0];
  const expens = stations[stations.length - 1];
  const saving = (expens.price - cheap.price) / 100 * FILL_LITRES;

  const shortName = s => s.trading_name.length > 18
    ? s.trading_name.slice(0, 18) + '…' : s.trading_name;

  document.getElementById('sum-cheap-name').textContent  = shortName(cheap);
  document.getElementById('sum-cheap-price').textContent = `${cheap.price.toFixed(1)}p`;
  document.getElementById('sum-cheap-fill').textContent  = `£${fillCost(cheap.price)}`;

  document.getElementById('sum-exp-name').textContent    = shortName(expens);
  document.getElementById('sum-exp-price').textContent   = `${expens.price.toFixed(1)}p`;
  document.getElementById('sum-exp-fill').textContent    = `£${fillCost(expens.price)}`;

  document.getElementById('sum-saving').textContent      = `£${saving.toFixed(2)}`;

  // Make the Cheapest / Priciest tiles jump to their pin on the map, same as a list card.
  wireSummaryJump('summary-best',  cheap.node_id);
  wireSummaryJump('summary-worst', expens.node_id);
}

// Attach a click on a summary tile that pans the map to the given station's pin.
function wireSummaryJump(className, nodeId) {
  const tile = summaryBar.querySelector('.' + className);
  if (!tile) return;
  tile.classList.add('clickable');
  tile.onclick = () => {
    highlightStation(nodeId);
    mapWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
}

// ── Map ───────────────────────────────────────────────────────────
function initMap(lat, lng) {
  if (!leafletMap) {
    leafletMap = L.map('map').setView([lat, lng], 12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO',
      maxZoom: 19,
    }).addTo(leafletMap);

    // Show "Search here" button when the user moves the map (after any search,
    // even one that found nothing — so they can always re-search a wider area).
    leafletMap.on('movestart', () => {
      if (currentQuery) {
        mapMoved = true;
        searchHereBtn.classList.remove('hidden');
      }
    });
  }
  // On later renders the view is set by renderMap (fitBounds), or left alone for a
  // "search here" re-search — so we never yank the map the user just positioned.
}

// Colour scale: green at cheapest, orange at cheapest+5p, red beyond that
// Linearly interpolated between anchor points
function priceColor(price, cheapest) {
  const MID_PENCE = 5;   // pence above cheapest where colour hits orange
  const RED_PENCE = 10;  // pence above cheapest where colour hits full red

  function lerp(a, b, t) { return Math.round(a + (b - a) * Math.max(0, Math.min(1, t))); }
  function lerpColor(c1, c2, t) {
    return `rgb(${lerp(c1[0],c2[0],t)},${lerp(c1[1],c2[1],t)},${lerp(c1[2],c2[2],t)})`;
  }

  const GREEN  = [5,  150, 105];   // #059669
  const ORANGE = [217, 119,  6];   // #d97706
  const RED    = [220,  38, 38];   // #dc2626

  const diff = price - cheapest;
  if (diff <= 0)          return lerpColor(GREEN,  ORANGE, 0);
  if (diff <= MID_PENCE)  return lerpColor(GREEN,  ORANGE, diff / MID_PENCE);
  if (diff <= RED_PENCE)  return lerpColor(ORANGE, RED,    (diff - MID_PENCE) / (RED_PENCE - MID_PENCE));
  return `rgb(${RED[0]},${RED[1]},${RED[2]})`;
}

function makeMarkerIcon(price, cheapest, priciest, isPinned, isHighlighted) {
  const color  = priceColor(price, cheapest);
  const border = isHighlighted ? '#facc15' : isPinned ? '#2563eb' : 'white';
  const bw     = isHighlighted ? 4 : isPinned ? 3 : 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="46" viewBox="0 0 52 46">
    <ellipse cx="26" cy="43" rx="9" ry="3.5" fill="rgba(0,0,0,0.15)"/>
    <path d="M26 3 C14 3 6 11 6 21 C6 33 26 43 26 43 C26 43 46 33 46 21 C46 11 38 3 26 3Z"
          fill="${color}" stroke="${border}" stroke-width="${bw}"/>
    <text x="26" y="25" text-anchor="middle" dominant-baseline="middle"
          font-size="12" font-weight="700"
          font-family="DM Mono,monospace" fill="white">${price.toFixed(1)}</text>
  </svg>`;
  return L.divIcon({
    html: svg, className: '',
    iconSize: [52, 46], iconAnchor: [26, 43], popupAnchor: [0, -45],
  });
}

function renderMap(stations, lat, lng, fuelType, pinned, fitView = true) {
  mapWrap.classList.remove('hidden');
  initMap(lat, lng);
  mapMarkers.forEach(m => m.remove());
  mapMarkers = [];

  const cheapest  = stations[0]?.price ?? 0;
  const priciest  = stations[stations.length-1]?.price ?? 0;
  const pinnedIds = new Set(pinned);

  // User dot — remove the previous one first so they don't stack up across searches.
  if (userMarker) userMarker.remove();
  const userIcon = L.divIcon({
    html: `<div style="width:14px;height:14px;background:#2563eb;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>`,
    className: '', iconSize: [14,14], iconAnchor: [7,7],
  });
  // zIndexOffset keeps the location dot above every station pin — Leaflet otherwise
  // z-orders markers by latitude, which lets pins south of you bury the dot.
  userMarker = L.marker([lat, lng], { icon: userIcon, zIndexOffset: USER_MARKER_Z })
    .addTo(leafletMap)
    .bindPopup('<strong>Your location</strong>');

  stations.forEach(s => {
    const isPinned = pinnedIds.has(s.node_id);
    const icon     = makeMarkerIcon(s.price, cheapest, priciest, isPinned, false);
    const popupColor = priceColor(s.price, cheapest);
    const marker   = L.marker([s.latitude, s.longitude], { icon })
      .addTo(leafletMap)
      .bindPopup(`
        <div style="font-family:'DM Sans',sans-serif;min-width:200px;position:relative;
                    padding-right:38px">
          <div style="font-weight:700;font-size:13px;margin-bottom:3px">${s.trading_name}</div>
          <div style="color:#6b7280;font-size:12px;margin-bottom:5px">${s.address || s.postcode || ''}</div>
          <div style="font-size:20px;font-weight:700;color:${popupColor}">${s.price.toFixed(1)}p/L</div>
          <div style="font-size:11px;color:#9ca3af">£${fillCost(s.price)} / ${FILL_LITRES}L · ${s.distanceMiles.toFixed(1)} mi</div>
          <a href="https://www.google.com/maps/dir/?api=1&destination=${s.latitude},${s.longitude}&travelmode=driving"
             target="_blank" rel="noopener" title="Driving directions"
             style="position:absolute;right:-6px;bottom:0;width:32px;height:32px;border-radius:50%;
                    background:#1a73e8;display:flex;align-items:center;justify-content:center;
                    text-decoration:none;box-shadow:0 1px 4px rgba(0,0,0,0.25)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </a>
        </div>`);
    marker._nodeId    = s.node_id;
    marker._price     = s.price;
    marker._cheapest  = cheapest;
    marker._priciest  = priciest;
    marker._isPinned  = isPinned;
    mapMarkers.push(marker);
  });

  if (fitView && stations.length > 0) {
    const bounds = L.latLngBounds([[lat, lng], ...stations.map(s => [s.latitude, s.longitude])]);
    leafletMap.fitBounds(bounds, { padding: [40, 40] });
  }
  setTimeout(() => leafletMap.invalidateSize(), 100);
}

// ── Station cards ─────────────────────────────────────────────────
function renderResults(stations, fuelType, elapsed, note) {
  const fuelLabels = {
    'E10': 'Petrol E10', 'E5': 'Petrol E5',
    'B7_STANDARD': 'Diesel', 'B7_PREMIUM': 'Diesel Premium',
  };
  const pinned = loadPinned();

  resultsTitleEl.textContent = `${stations.length} station${stations.length !== 1 ? 's' : ''} nearby`;
  const metaBits = [fuelLabels[fuelType] || fuelType];
  if (elapsed) metaBits.push(`${elapsed}s`);
  if (note)    metaBits.push(note);
  resultsMetaEl.textContent = metaBits.join(' · ');

  if (stations.length === 0) {
    const hint = currentQuery?.bounds
      ? 'No stations in the visible map area. Zoom out and tap “Search here” again.'
      : 'No stations found. Try a wider radius.';
    stationListEl.innerHTML = `<p class="no-results">${hint}</p>`;
    resultsEl.classList.remove('hidden');
    return;
  }

  const cheapest = stations[0].price;
  const priciest = stations[stations.length-1].price;
  const range    = priciest - cheapest || 1;

  stationListEl.innerHTML = stations.map((s, i) => {
    const color    = priceColor(s.price, cheapest);
    const medal    = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
    const isPinned = pinned.includes(s.node_id);
    return `
      <div class="station-card ${isPinned ? 'pinned' : ''}" data-node="${s.node_id}">
        <div class="station-rank">${medal}</div>
        <div class="station-info">
          <div class="station-name">${s.trading_name}</div>
          <div class="station-address">${s.address || s.postcode || '—'}</div>
          <div class="station-meta">${s.brand || ''} · ${s.distanceMiles.toFixed(1)} mi</div>
        </div>
        <div class="station-right">
          <div class="station-price" style="color:${color}">${s.price.toFixed(1)}p</div>
          <div class="station-fill">£${fillCost(s.price)}</div>
          <button class="pin-btn ${isPinned ? 'pinned' : ''}" data-node="${s.node_id}"
                  title="${isPinned ? 'Remove favourite' : 'Favourite this station'}">
            ${isPinned ? '★' : '☆'}
          </button>
        </div>
      </div>`;
  }).join('');

  resultsEl.classList.remove('hidden');

  stationListEl.querySelectorAll('.pin-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); togglePin(btn.dataset.node); });
  });

  // Click card → highlight card + map marker
  let highlightedNode = null;
  stationListEl.querySelectorAll('.station-card').forEach(card => {
    card.addEventListener('click', () => {
      const nodeId = card.dataset.node;
      highlightStation(nodeId === highlightedNode ? null : nodeId);
      highlightedNode = nodeId === highlightedNode ? null : nodeId;
    });
  });
}

function highlightStation(nodeId) {
  // Cards
  stationListEl.querySelectorAll('.station-card').forEach(card => {
    if (nodeId && card.dataset.node === nodeId) {
      card.classList.add('highlighted');
    } else {
      card.classList.remove('highlighted');
    }
  });

  // Map markers
  mapMarkers.forEach(marker => {
    const isThis     = marker._nodeId === nodeId;
    const isPinned   = marker._isPinned;
    const icon = makeMarkerIcon(
      marker._price, marker._cheapest, marker._priciest, isPinned, isThis
    );
    marker.setIcon(icon);
    if (isThis) {
      marker.openPopup();
      leafletMap.panTo(marker.getLatLng(), { animate: true });
    }
  });
}

// ── Pin/unpin ─────────────────────────────────────────────────────
function togglePin(nodeId) {
  let pinned = loadPinned();
  if (pinned.includes(nodeId)) {
    pinned = pinned.filter(id => id !== nodeId);
  } else {
    if (pinned.length >= 3) {
      showStatus('⚠️ You can favourite up to 3 stations. Remove one first.', 'error', true);
      return;
    }
    pinned.push(nodeId);
  }
  savePinned(pinned);
  if (lastStations.length) {
    renderResults(lastStations, fuelSelect.value, '', '');
    if (lastLat !== null) renderMap(lastStations, lastLat, lastLng, fuelSelect.value, pinned, false);
  }
}

// ── Main search ───────────────────────────────────────────────────
async function doSearch(lat, lng, postcode, saveAsFav = true, overrideRadius = null,
                                                          keepView = false, bounds = null) {
  const radiusMiles = overrideRadius !== null ? overrideRadius : parseFloat(radiusSelect.value);
  const fuelType    = fuelSelect.value;
  currentQuery = { lat, lng, radiusMiles, fuelType, postcode, saveAsFav, keepView, bounds };

  lastLat = lat; lastLng = lng;
  mapMoved = false;
  searchHereBtn.classList.add('hidden');
  // Note: existing results/summary stay on screen and are replaced in place by renderQuery,
  // so the layout never collapses and re-expands (which used to jolt the map up and down).

  const t0 = Date.now();
  showStatus('🔍 Loading fuel prices…');

  let cache;
  try {
    cache = await getCache();
  } catch(err) {
    showStatus('❌ ' + err.message, 'error');
    return;
  }

  if (cache.status === 'empty') {        // nothing usable cached — must wait for a build
    await coldBuild(t0);
    return;
  }

  // We have data (fresh or stale) — show it immediately.
  datasetStations = cache.stations;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  if (cache.status === 'fresh') {
    showStatus(`✓ ${cache.total_stations.toLocaleString()} stations · prices current`,
                                                                          'loading', true);
    renderQuery('live', elapsed);
  } else {                               // stale: show now, refresh underneath, auto-update
    const ageTxt = ageText(cache.ageMinutes);
    showStatus(`⏳ Showing prices from ${ageTxt} — fetching the latest (up to 30s)…`);
    renderQuery(`from ${ageTxt}`, elapsed);
    backgroundRefresh();
  }
}

// Filter the cached dataset for the current query and render summary + map + list.
function renderQuery(note, elapsed) {
  if (!currentQuery) return;
  const { lat, lng, radiusMiles, fuelType, postcode, saveAsFav } = currentQuery;
  const fuelLabels = {
    'E10': 'Petrol (E10)', 'E5': 'Petrol (E5)',
    'B7_STANDARD': 'Diesel', 'B7_PREMIUM': 'Diesel Premium',
  };
  const nearby = filterStations(datasetStations, lat, lng, radiusMiles, fuelType,
                                                                          currentQuery.bounds);
  lastStations = nearby;
  renderSummary(nearby);
  renderMap(nearby, lat, lng, fuelType, loadPinned(), !currentQuery.keepView);
  renderResults(nearby, fuelType, elapsed, note);
  if (saveAsFav) saveFavSettings(postcode, lat, lng, fuelType, fuelLabels, radiusMiles);
  updateFavBtn();
}

// Cold start: no usable cache. Trigger a build and wait, retrying a few times.
async function coldBuild(t0) {
  showStatus('⏳ Fetching the latest UK fuel prices (~20s)…');
  for (let tries = 1; tries <= 4; tries++) {
    let data;
    try {
      data = await runRefresh();
    } catch(err) {
      showStatus('❌ ' + err.message, 'error');
      return;
    }
    if (data.status === 'fresh') {
      datasetStations = data.stations;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
      showStatus(`✓ ${data.total_stations.toLocaleString()} stations · prices current`,
                                                                          'loading', true);
      renderQuery('live', elapsed);
      return;
    }
    // status 'refreshing' — someone else is building; wait, then re-read the cache.
    showStatus(`⏳ Fetching the latest prices… (checking again ${tries}/4)`);
    await sleep(5000);
    try {
      const c = await getCache();
      if (c.status !== 'empty') {
        datasetStations = c.stations;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
        showStatus(`✓ ${c.total_stations.toLocaleString()} stations`, 'loading', true);
        renderQuery(c.status === 'fresh' ? 'live' : `from ${ageText(c.ageMinutes)}`, elapsed);
        return;
      }
    } catch { /* keep retrying */ }
  }
  showStatus('❌ Could not load prices. Please try again in a moment.', 'error');
}

// Stale path: refresh in the background, then re-render the same query with fresh data.
async function backgroundRefresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    let data = await runRefresh();
    if (data.status === 'refreshing') data = await pollUntilFresh();
    if (data && data.status === 'fresh' && data.stations) {
      datasetStations = data.stations;
      renderQuery('updated just now', '');
      showStatus('✓ Prices updated — now current', 'loading', true);
    }
  } catch(err) {
    showStatus('⚠️ Couldn\'t fetch the latest — showing recent prices', 'error', true);
  } finally {
    refreshing = false;
  }
}

// Another client holds the refresh lock — poll the cache until it turns fresh.
async function pollUntilFresh() {
  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    try {
      const c = await getCache();
      if (c.status === 'fresh') {
        return { status: 'fresh', stations: c.stations, total_stations: c.total_stations };
      }
    } catch { /* keep polling */ }
  }
  return null;
}

function saveFavSettings(postcode, lat, lng, fuelType, fuelLabels, radius) {
  saveFav({ postcode: postcode || null, lat, lng, fuelType, fuelLabel: fuelLabels[fuelType] || fuelType, radius });
}

// ── Search here (map pan) ─────────────────────────────────────────
if (searchHereBtn) {
  searchHereBtn.addEventListener('click', () => {
    const centre = leafletMap.getCenter();
    const b      = leafletMap.getBounds();
    const bounds = {
      south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast(),
    };
    searchHereBtn.classList.add('hidden');
    mapMoved = false;
    // keepView = true, and filter by the whole visible rectangle (not a centre radius).
    doSearch(centre.lat, centre.lng, null, false, null, true, bounds);
  });
}

// ── Events ────────────────────────────────────────────────────────
searchBtn.addEventListener('click', async () => {
  const postcode = postcodeInput.value.trim().toUpperCase();
  if (!postcode) {
    showStatus('Please enter a post code or click 📍 for current location', 'error', true);
    return;
  }
  showStatus('📍 Looking up postcode…');
  try {
    const { lat, lng } = await postcodeToLatLng(postcode);
    await doSearch(lat, lng, postcode);
  } catch(err) {
    showStatus('❌ ' + err.message, 'error', true);
  }
});

postcodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchBtn.click(); });

gpsBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { showStatus('❌ Geolocation not supported', 'error', true); return; }
  showStatus('📍 Getting your location…');
  navigator.geolocation.getCurrentPosition(
    pos => doSearch(pos.coords.latitude, pos.coords.longitude, null),
    ()  => showStatus('❌ Location access denied', 'error', true)
  );
});

favBtn.addEventListener('click', () => {
  const fav = loadFav();
  if (!fav) return;
  radiusSelect.value = fav.radius;
  fuelSelect.value   = fav.fuelType;
  if (fav.postcode) postcodeInput.value = fav.postcode;
  doSearch(fav.lat, fav.lng, fav.postcode || null);
});

// Force a fresh price refresh now (bypasses the 15-min cache window).
resetProfileBtn.addEventListener('click', async () => {
  if (refreshing) { showStatus('⏳ A refresh is already running…', 'loading', true); return; }
  refreshing = true;
  showStatus('⏳ Forcing a price refresh (~20s)…');
  try {
    let data = await runRefresh();
    if (data.status === 'refreshing') data = await pollUntilFresh();
    if (data && data.status === 'fresh') {
      datasetStations = data.stations;
      showStatus(`✓ Prices refreshed · ${data.total_stations.toLocaleString()} stations`,
                                                                          'loading', true);
      if (currentQuery) renderQuery('updated just now', '');
    } else {
      showStatus('⏳ Still updating — try your search again shortly', 'loading', true);
    }
  } catch(err) {
    showStatus('❌ ' + err.message, 'error', true);
  } finally {
    refreshing = false;
  }
});

// ── Init ──────────────────────────────────────────────────────────
document.getElementById('app-version').textContent = APP_VERSION;
updateFavBtn();

// Register the service worker so the app can be installed as a PWA.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
