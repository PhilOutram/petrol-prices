// ================================================================
// FuelScan — Main App
// ================================================================
const APP_VERSION    = 'v1.1.11';   // shown in the header; keep sw.js CACHE name in sync
const FAV_KEY        = 'fuelscan_favourite';
const PINNED_KEY     = 'fuelscan_pinned';
const FILL_LITRES    = 60;
const EARTH_RADIUS_M = 6371000;
const STATUS_HIDE_MS = 3000;   // ms after which status bar auto-hides
const USER_MARKER_Z  = 100000; // z-offset: location dot sits above every pin (incl. selected)
const SEL_MARKER_Z   = 2000;   // z-offset: selected pin rises above other pins, below the dot

// Map marker edge colours/widths - favourite = gold, selected = blue, default = white.
const SEL_BORDER_COLOR = '#2563eb';   // selected pin edge (matches the accent blue)
const FAV_BORDER_COLOR = '#eab308';   // favourited station edge (gold)
const PIN_BORDER_COLOR = 'white';     // default station edge
const SEL_BORDER_W     = 4;           // selected pin edge width (px)
const FAV_BORDER_W     = 3;           // favourite edge width (px)
const PIN_BORDER_W     = 2;           // default edge width (px)

// Basemap - Esri World Street Map (free, no API key). Place and road names are baked into the
// tile, so unlike the grey canvas this needs no second labels layer. Real tiles reach zoom 19;
// zoom 20 returns a "Map data not yet available" image, so 19 is the cap.
const ESRI_SERVICES_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const TILE_BASE_URL     = ESRI_SERVICES_URL + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}';
const MAP_MAX_ZOOM      = 19;
const MAP_ATTRIBUTION   = 'Tiles © Esri, HERE, Garmin, USGS, © OpenStreetMap contributors';

// The blue dot is where the user actually is, kept up to date as they move so someone driving
// to a station can see themselves and the road they are on. There is no dot for the search
// centre - the shaded area already shows where the search was.
const LIVE_DOT_COLOR     = '#2563eb';
const LIVE_FIX_MAX_AGE_MS = 10 * 1000;   // reuse a fix this recent instead of awaiting a new one
const LIVE_FIX_TIMEOUT_MS = 20 * 1000;   // give up on a single fix after this long

// Everything outside the searched area is dimmed, so a gap in the pins reads as "no stations
// here" rather than "just outside the search".
const MASK_FILL_COLOR   = '#1f2937';
const MASK_FILL_OPACITY = 0.18;
const MASK_EDGE_COLOR   = '#374151';
const MASK_EDGE_WIDTH   = 1.5;
const MASK_EDGE_OPACITY = 0.5;
const MASK_RING_POINTS  = 128;   // segments approximating the radius circle
const MASK_FIT_PADDING  = 12;    // px of slack when fitting the map to the searched area
const MAP_SETTLE_MS     = 100;   // wait for the layout to settle, then re-measure and re-fit
const WORLD_RING        = [[-85, -180], [-85, 180], [85, 180], [85, -180]];

const METRES_PER_MILE  = 1609.344;
const DATASET_REUSE_MS = 5 * 60 * 1000;   // how long a loaded dataset is reused without re-reading

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
let liveMarker      = null;    // the blue "your location" dot, moved as new fixes arrive
let liveWatchId     = null;    // navigator.geolocation watch, null when not tracking
let lastLivePos     = null;    // most recent fix, replayed once the map exists
let selectedNode    = null;    // node_id of the selected station (kept in sync: list/pin/summary)
let lastStations    = [];      // filtered list currently shown (used by pin re-render)
let lastLat         = null;
let lastLng         = null;
let statusHideTimer = null;
let mapMoved        = false;   // tracks whether user has panned/zoomed
let datasetStations = [];      // full UK station list from the shared cache
let datasetStatus   = null;    // 'fresh' | 'stale' - how the cache described that list
let datasetTotal    = 0;       // station count reported with it
let datasetAt       = 0;       // when we loaded it, so a search can reuse it without re-reading
let prefetchPromise = null;    // the startup load, so a search waits rather than re-fetching
let currentQuery    = null;    // { lat, lng, radiusMiles, fuelType, postcode, saveAsFav }
let refreshing      = false;   // true while a background/foreground refresh is in flight
let searchAreaLayer = null;    // the shading outside the searched area

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
function metresToMiles(m) { return m / METRES_PER_MILE; }
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

// A search needs the whole UK dataset wherever it is centred, so the list is loaded once and
// reused. setDataset records when, so a later search knows whether it is still worth reusing.
function setDataset(stations, status, total) {
  datasetStations = stations;
  datasetStatus   = status;
  datasetTotal    = total ?? stations.length;
  datasetAt       = Date.now();
}

function datasetReady() {
  return datasetStations.length > 0 && datasetStatus === 'fresh'
      && Date.now() - datasetAt < DATASET_REUSE_MS;
}

// Load the prices while the user is still deciding where to search, so the first search is
// instant. Quiet by design: it says what it is doing in the status bar and swallows errors,
// because the search path reports anything the user is actually waiting on.
async function prefetchPrices() {
  try {
    showStatus('🔄 Loading prices in the background…');
    const cache = await getCache();
    if (cache.status === 'empty') {       // nothing cached at all - build it now, not at search
      showStatus('🔄 Fetching the latest UK fuel prices in the background (~20s)…');
      await backgroundRefresh();
      return;
    }
    setDataset(cache.stations, cache.status, cache.total_stations);
    if (cache.status === 'stale') {
      showStatus(`🔄 Updating prices from ${ageText(cache.ageMinutes)} in the background…`);
      await backgroundRefresh();
    } else {
      showStatus(`✓ Prices ready · ${datasetTotal.toLocaleString()} stations`, 'loading', true);
    }
  } catch {
    hideStatus();   // nothing to report yet; the first search will try again and say so
  }
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
    selectStation(nodeId, { fromMap: false });
    mapWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
}

// ── Map ───────────────────────────────────────────────────────────
function initMap(lat, lng) {
  if (!leafletMap) {
    leafletMap = L.map('map').setView([lat, lng], 12);
    L.tileLayer(TILE_BASE_URL, { maxZoom: MAP_MAX_ZOOM, attribution: MAP_ATTRIBUTION })
      .addTo(leafletMap);

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
  const border = isHighlighted ? SEL_BORDER_COLOR : isPinned ? FAV_BORDER_COLOR : PIN_BORDER_COLOR;
  const bw     = isHighlighted ? SEL_BORDER_W : isPinned ? FAV_BORDER_W : PIN_BORDER_W;
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

// ── Live location dot ─────────────────────────────────────────────
// Where the user actually is, following them as they move. Never started on its own: the app
// only tracks once the user has asked for their location with 📍, or has already granted the
// permission on an earlier visit, so loading the page never raises a location prompt.
function showLivePosition(pos) {
  lastLivePos = pos;
  if (!leafletMap) return;             // no map yet - renderMap replays this fix when there is
  const here = [pos.coords.latitude, pos.coords.longitude];
  if (liveMarker) { liveMarker.setLatLng(here); return; }
  const icon = L.divIcon({
    html: `<div style="width:14px;height:14px;background:${LIVE_DOT_COLOR};border:3px solid white;
                       border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>`,
    className: '', iconSize: [14,14], iconAnchor: [7,7],
  });
  // zIndexOffset keeps the location dot above every station pin — Leaflet otherwise
  // z-orders markers by latitude, which lets pins south of you bury the dot.
  liveMarker = L.marker(here, { icon, zIndexOffset: USER_MARKER_Z })
    .addTo(leafletMap)
    .bindPopup('<strong>Your location</strong>');
}

function startLiveTracking() {
  if (liveWatchId !== null || !navigator.geolocation) return;
  liveWatchId = navigator.geolocation.watchPosition(showLivePosition, () => {}, {
    enableHighAccuracy: true,
    maximumAge:         LIVE_FIX_MAX_AGE_MS,
    timeout:            LIVE_FIX_TIMEOUT_MS,
  });
}

// Ring of points approximating a circle of `radiusMiles` around (lat,lng). Flat-earth maths
// is plenty at these distances (the largest radius offered is 20 miles).
function circleRing(lat, lng, radiusMiles) {
  const latSpan = (radiusMiles * METRES_PER_MILE) / EARTH_RADIUS_M * (180 / Math.PI);
  const lngSpan = latSpan / Math.cos(lat * Math.PI / 180);
  const ring = [];
  for (let i = 0; i < MASK_RING_POINTS; i++) {
    const angle = (i / MASK_RING_POINTS) * 2 * Math.PI;
    ring.push([lat + latSpan * Math.cos(angle), lng + lngSpan * Math.sin(angle)]);
  }
  return ring;
}

// Dim everything outside the searched area: one polygon covering the world with the searched
// area punched out of it (evenodd fill). Returns the searched ring so the caller can fit to it.
function drawSearchArea(lat, lng, radiusMiles, bounds) {
  if (searchAreaLayer) searchAreaLayer.remove();
  const ring = bounds
    ? [[bounds.south, bounds.west], [bounds.south, bounds.east],
       [bounds.north, bounds.east], [bounds.north, bounds.west]]
    : circleRing(lat, lng, radiusMiles);
  searchAreaLayer = L.polygon([WORLD_RING, ring], {
    color: MASK_EDGE_COLOR, weight: MASK_EDGE_WIDTH, opacity: MASK_EDGE_OPACITY,
    fillColor: MASK_FILL_COLOR, fillOpacity: MASK_FILL_OPACITY, fillRule: 'evenodd',
    interactive: false,   // clicks still reach the pins and the map underneath
  }).addTo(leafletMap);
  return ring;
}

function renderMap(stations, lat, lng, fuelType, pinned, fitView = true) {
  mapWrap.classList.remove('hidden');
  initMap(lat, lng);
  mapMarkers.forEach(m => m.remove());
  mapMarkers = [];

  const cheapest  = stations[0]?.price ?? 0;
  const priciest  = stations[stations.length-1]?.price ?? 0;
  const pinnedIds = new Set(pinned);

  // Shading outside the searched area, drawn before the pins so it sits under them.
  const ring = drawSearchArea(lat, lng, currentQuery?.radiusMiles, currentQuery?.bounds);

  // The live dot survives re-renders; replay the latest fix in case it arrived while the map
  // was still hidden.
  if (lastLivePos) showLivePosition(lastLivePos);

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
    // Click a pin → same as clicking its row, minus the map/list movement (fromMap).
    marker.on('click', () => selectStation(s.node_id, { fromMap: true }));
    mapMarkers.push(marker);
  });

  // Fit to the whole searched area, not just the pins, or its edge is never on screen and the
  // shading has nothing to tell you. The map may have only just been un-hidden or resized, so
  // measure before fitting and again once the layout has settled.
  // animate:false - a search jumps to its area, and an animated fit that gets re-fitted
  // mid-flight leaves the previous zoom level's tiles stacked on the map.
  const fitToSearchArea = () => leafletMap.fitBounds(L.latLngBounds(ring),
                                     { padding: [MASK_FIT_PADDING, MASK_FIT_PADDING],
                                       animate: false });
  leafletMap.invalidateSize();
  if (fitView) fitToSearchArea();
  setTimeout(() => {
    leafletMap.invalidateSize();
    if (!fitView) return;
    // A map measured at zero width (rendered in a hidden or not-yet-laid-out tab) fits to
    // nothing and sticks at max zoom, so wait for it to have a size before fitting.
    if (leafletMap.getSize().x > 0) fitToSearchArea();
    else leafletMap.once('resize', fitToSearchArea);
  }, MAP_SETTLE_MS);
}

// ── Station cards ─────────────────────────────────────────────────
function renderResults(stations, fuelType, elapsed, note) {
  const fuelLabels = {
    'E10': 'Unleaded (E10)', 'E5': 'Super Unleaded (E5)',
    'B7_STANDARD': 'Diesel', 'B7_PREMIUM': 'Diesel Premium',
  };
  const pinned = loadPinned();
  selectedNode = null;   // the list is being rebuilt — clear any prior selection

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

  // Click card → select it (highlights card + pin, centres the map on the pin). Clicking
  // the already-selected row toggles the selection off.
  stationListEl.querySelectorAll('.station-card').forEach(card => {
    card.addEventListener('click', () => {
      const nodeId = card.dataset.node;
      selectStation(nodeId === selectedNode ? null : nodeId, { fromMap: false });
    });
  });
}

// Select a station from the list, a summary tile, or a map pin. The selected row and its
// pin both take the blue "selected" styling, and the pin rises above the other pins (but
// stays below the location dot). fromMap = true means the click came from the pin itself,
// so we leave the map where it is and don't scroll the list — we just mirror the highlight,
// keeping the connection clear for when the user scrolls down to that row.
function selectStation(nodeId, { fromMap = false } = {}) {
  selectedNode = nodeId;

  // Cards — blue highlight on the selected row (never scrolled into view).
  stationListEl.querySelectorAll('.station-card').forEach(card => {
    card.classList.toggle('highlighted', !!nodeId && card.dataset.node === nodeId);
  });

  // Map markers — blue border + raised z-order on the selected pin, reset on the rest.
  mapMarkers.forEach(marker => {
    const isThis = marker._nodeId === nodeId;
    const icon = makeMarkerIcon(
      marker._price, marker._cheapest, marker._priciest, marker._isPinned, isThis
    );
    marker.setIcon(icon);
    marker.setZIndexOffset(isThis ? SEL_MARKER_Z : 0);
    if (isThis && !fromMap) {          // list/summary click — bring the pin into view
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
async function doSearch(lat, lng, postcode, opts = {}) {
  const { saveAsFav = true, overrideRadius = null, keepView = false, bounds = null } = opts;
  const radiusMiles = overrideRadius !== null ? overrideRadius : parseFloat(radiusSelect.value);
  const fuelType    = fuelSelect.value;
  currentQuery = { lat, lng, radiusMiles, fuelType, postcode, saveAsFav, keepView, bounds };

  lastLat = lat; lastLng = lng;
  mapMoved = false;
  searchHereBtn.classList.add('hidden');
  // Note: existing results/summary stay on screen and are replaced in place by renderQuery,
  // so the layout never collapses and re-expands (which used to jolt the map up and down).

  const t0 = Date.now();

  // The startup prefetch may still be in flight - wait for it rather than firing a second
  // read of the very same dataset.
  if (prefetchPromise) {
    showStatus('🔍 Loading fuel prices…');
    try { await prefetchPromise; } catch { /* fall through to a read of our own */ }
  }
  if (datasetReady()) {                  // already loaded and still current - no network wait
    showStatus(`✓ ${datasetTotal.toLocaleString()} stations · prices current`, 'loading', true);
    renderQuery('live', ((Date.now() - t0) / 1000).toFixed(2));
    return;
  }

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
  setDataset(cache.stations, cache.status, cache.total_stations);
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
    'E10': 'Unleaded (E10)', 'E5': 'Super Unleaded (E5)',
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
      setDataset(data.stations, 'fresh', data.total_stations);
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
        setDataset(c.stations, c.status, c.total_stations);
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
      setDataset(data.stations, 'fresh', data.total_stations);
      renderQuery('updated just now', '');
      showStatus(currentQuery ? '✓ Prices updated — now current'
                              : `✓ Prices ready · ${datasetTotal.toLocaleString()} stations`,
                 'loading', true);
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
    doSearch(centre.lat, centre.lng, null, { saveAsFav: false, keepView: true, bounds });
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
    pos => {
      showLivePosition(pos);
      startLiveTracking();   // permission is granted now, so keep the dot following them
      doSearch(pos.coords.latitude, pos.coords.longitude, null);
    },
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
      setDataset(data.stations, 'fresh', data.total_stations);
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

// If location was already allowed on an earlier visit, start the dot now. This asks nothing:
// querying the permission never prompts, and a 'prompt' or 'denied' state is left alone.
navigator.permissions?.query({ name: 'geolocation' })
  .then(p => { if (p.state === 'granted') startLiveTracking(); })
  .catch(() => {});

// Start loading prices immediately - a search can then render straight from memory.
prefetchPromise = prefetchPrices().finally(() => { prefetchPromise = null; });

// Register the service worker so the app can be installed as a PWA.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
