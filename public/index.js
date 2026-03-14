// ================================================================
// FuelScan — Main App
// ================================================================
const PROFILE_KEY    = 'fuelscan_profile';
const FAV_KEY        = 'fuelscan_favourite';
const PINNED_KEY     = 'fuelscan_pinned';      // up to 3 pinned stations
const FINGERPRINT_N  = 5;
const NEARBY_COUNT   = 20;
const FILL_LITRES    = 60;
const EARTH_RADIUS_M = 6371000;

// ── DOM ──────────────────────────────────────────────────────────
const postcodeInput   = document.getElementById('postcode-input');
const searchBtn       = document.getElementById('search-btn');
const gpsBtn          = document.getElementById('gps-btn');
const favBtn          = document.getElementById('fav-btn');
const radiusSelect    = document.getElementById('radius-select');
const fuelSelect      = document.getElementById('fuel-select');
const mapToggle       = document.getElementById('map-toggle');
const statusEl        = document.getElementById('status');
const profileBar      = document.getElementById('profile-bar');
const profileText     = document.getElementById('profile-text');
const resetProfileBtn = document.getElementById('reset-profile-btn');
const summaryBar      = document.getElementById('summary-bar');
const mapWrap         = document.getElementById('map-wrap');
const resultsEl       = document.getElementById('results');
const resultsTitleEl  = document.getElementById('results-title');
const resultsMetaEl   = document.getElementById('results-meta');
const stationListEl   = document.getElementById('station-list');

// ── State ─────────────────────────────────────────────────────────
let leafletMap    = null;
let mapMarkers    = [];
let lastStations  = [];
let lastLat       = null;
let lastLng       = null;

// ── Helpers ───────────────────────────────────────────────────────
function showStatus(msg, type = 'loading') {
  statusEl.innerHTML = msg;
  statusEl.className = `status ${type}`;
}
function hideStatus() { statusEl.className = 'status hidden'; }

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
function loadProfile()  { try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null; } catch { return null; } }
function saveProfile(p) { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); }
function clearProfile() { localStorage.removeItem(PROFILE_KEY); }

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
    favBtn.title    = 'Favourite available after first search';
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
function filterStations(stations, lat, lng, radiusMiles, fuelType) {
  return stations
    .filter(s => s.latitude != null && s.longitude != null)
    .map(s => ({
      ...s,
      distanceMiles: metresToMiles(distanceMetres(lat, lng, s.latitude, s.longitude)),
      price: (s.fuel_prices || []).find(fp => fp.fuel_type === fuelType)?.price ?? null,
    }))
    .filter(s => s.distanceMiles <= radiusMiles && s.price !== null)
    .sort((a, b) => a.price - b.price);
}

// ── API fetch ─────────────────────────────────────────────────────
async function fetchFast(batches) {
  const res  = await fetch(`/api/fuel?batches=${batches.join(',')}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Fast fetch failed');
  return data;
}

async function fetchDiscovery() {
  // Stream-style: fetch with progress updates
  // We know ~15 batches; show progress as groups complete
  // We call the endpoint which handles parallelism, but show a count-up
  let done = false;
  let batchCount = 0;
  const interval = setInterval(() => {
    if (!done) {
      batchCount = Math.min(batchCount + 1, 14);
      showStatus(`🔍 Collecting petrol stations… batch ${batchCount} of 15`);
    }
  }, 320);

  try {
    const res  = await fetch('/api/fuel');
    const data = await res.json();
    done = true;
    clearInterval(interval);
    if (!res.ok) throw new Error(data.error || 'Discovery fetch failed');
    return data;
  } catch (err) {
    done = true;
    clearInterval(interval);
    throw err;
  }
}

// ── Build profile ─────────────────────────────────────────────────
function buildProfile(stations, lat, lng, fuelType) {
  const fuelLabels = {
    'E10': 'Petrol (E10)', 'E5': 'Petrol (E5)',
    'B7_STANDARD': 'Diesel', 'B7_PREMIUM': 'Diesel Premium',
  };
  const nearby = stations
    .filter(s => s.latitude != null && s.longitude != null)
    .map(s => ({ ...s, distanceMiles: metresToMiles(distanceMetres(lat, lng, s.latitude, s.longitude)) }))
    .filter(s => s.distanceMiles <= 20)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, NEARBY_COUNT);

  const batchSet = new Set();
  for (const s of nearby) {
    const idx = stations.findIndex(st => st.node_id === s.node_id);
    if (idx >= 0) batchSet.add(Math.floor(idx / 500) + 1);
  }

  const withPrice = nearby
    .filter(s => (s.fuel_prices || []).some(fp => fp.fuel_type === fuelType))
    .sort((a, b) => {
      const pa = a.fuel_prices.find(fp => fp.fuel_type === fuelType)?.price ?? 999;
      const pb = b.fuel_prices.find(fp => fp.fuel_type === fuelType)?.price ?? 999;
      return pa - pb;
    });
  const fingerprint = withPrice.slice(0, FINGERPRINT_N).map(s => s.node_id);

  return {
    lat, lng,
    batches: [...batchSet].sort((a,b) => a-b),
    fingerprint,
    fuelType,
    fuelLabel: fuelLabels[fuelType] || fuelType,
    builtAt: new Date().toISOString(),
  };
}

function verifyFingerprint(stations, fingerprint) {
  const nodeIds = new Set(stations.map(s => s.node_id));
  return fingerprint.every(id => nodeIds.has(id));
}

// ── Summary bar ───────────────────────────────────────────────────
function renderSummary(stations) {
  if (stations.length < 2) { summaryBar.classList.add('hidden'); return; }
  const cheap  = stations[0];
  const expens = stations[stations.length - 1];
  const saving = (expens.price - cheap.price) / 100 * FILL_LITRES;

  const shortName = s => s.trading_name.length > 22
    ? s.trading_name.slice(0, 22) + '…'
    : s.trading_name;

  document.getElementById('sum-cheap-name').textContent  = shortName(cheap);
  document.getElementById('sum-cheap-price').textContent = `${cheap.price.toFixed(1)}p/L`;
  document.getElementById('sum-cheap-fill').textContent  = `£${fillCost(cheap.price)} for ${FILL_LITRES}L`;

  document.getElementById('sum-exp-name').textContent    = shortName(expens);
  document.getElementById('sum-exp-price').textContent   = `${expens.price.toFixed(1)}p/L`;
  document.getElementById('sum-exp-fill').textContent    = `£${fillCost(expens.price)} for ${FILL_LITRES}L`;

  document.getElementById('sum-saving').textContent      = `£${saving.toFixed(2)}`;
  document.getElementById('sum-saving-desc').textContent = `saved on a ${FILL_LITRES}L fill`;

  summaryBar.classList.remove('hidden');
}

// ── Map ───────────────────────────────────────────────────────────
function initMap(lat, lng) {
  if (!leafletMap) {
    leafletMap = L.map('map').setView([lat, lng], 12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO',
      maxZoom: 19,
    }).addTo(leafletMap);
  } else {
    leafletMap.setView([lat, lng], 12);
  }
}

function makeMarkerIcon(price, cheapest, priciest, pinned) {
  const range = priciest - cheapest || 1;
  const pct   = (price - cheapest) / range;
  const color = pct < 0.33 ? '#059669' : pct < 0.66 ? '#d97706' : '#dc2626';
  const border = pinned ? '#2563eb' : '#fff';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="44" height="52" viewBox="0 0 44 52">
      <ellipse cx="22" cy="48" rx="8" ry="4" fill="rgba(0,0,0,0.15)"/>
      <path d="M22 2 C12 2 4 10 4 20 C4 34 22 48 22 48 C22 48 40 34 40 20 C40 10 32 2 22 2Z"
            fill="${color}" stroke="${border}" stroke-width="2.5"/>
      <text x="22" y="23" text-anchor="middle" font-size="11" font-weight="700"
            font-family="DM Mono,monospace" fill="white">${price.toFixed(1)}</text>
    </svg>`;
  return L.divIcon({
    html: svg, className: '', iconSize: [44, 52], iconAnchor: [22, 48], popupAnchor: [0, -50],
  });
}

function renderMap(stations, lat, lng, fuelType, pinned) {
  initMap(lat, lng);
  mapMarkers.forEach(m => m.remove());
  mapMarkers = [];

  const cheapest = stations[0]?.price ?? 0;
  const priciest = stations[stations.length-1]?.price ?? 0;
  const pinnedIds = new Set(pinned);

  // User location marker
  const userIcon = L.divIcon({
    html: `<div style="width:14px;height:14px;background:#2563eb;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>`,
    className: '', iconSize: [14,14], iconAnchor: [7,7],
  });
  L.marker([lat, lng], { icon: userIcon }).addTo(leafletMap)
    .bindPopup('<strong>Your location</strong>');

  stations.forEach(s => {
    const isPinned = pinnedIds.has(s.node_id);
    const icon = makeMarkerIcon(s.price, cheapest, priciest, isPinned);
    const marker = L.marker([s.latitude, s.longitude], { icon })
      .addTo(leafletMap)
      .bindPopup(`
        <div style="font-family:'DM Sans',sans-serif;min-width:160px">
          <div style="font-weight:700;font-size:13px;margin-bottom:4px">${s.trading_name}</div>
          <div style="color:#6b7280;font-size:12px;margin-bottom:6px">${s.address || s.postcode || ''}</div>
          <div style="font-size:20px;font-weight:700;color:${s.price === cheapest ? '#059669' : '#1a1a2e'}">${s.price.toFixed(1)}p</div>
          <div style="font-size:11px;color:#9ca3af">£${fillCost(s.price)} / ${FILL_LITRES}L · ${s.distanceMiles.toFixed(1)}mi</div>
        </div>`);
    mapMarkers.push(marker);
  });

  // Fit map to markers
  if (stations.length > 0) {
    const bounds = L.latLngBounds(
      [[lat, lng], ...stations.map(s => [s.latitude, s.longitude])]
    );
    leafletMap.fitBounds(bounds, { padding: [40, 40] });
  }

  // Invalidate size in case map was hidden
  setTimeout(() => leafletMap.invalidateSize(), 100);
}

// ── Station cards ─────────────────────────────────────────────────
function renderResults(stations, fuelType, elapsed, mode) {
  const fuelLabels = {
    'E10': 'Petrol E10', 'E5': 'Petrol E5',
    'B7_STANDARD': 'Diesel', 'B7_PREMIUM': 'Diesel Premium',
  };
  const pinned = loadPinned();

  resultsTitleEl.textContent = `${stations.length} station${stations.length !== 1 ? 's' : ''} nearby`;
  resultsMetaEl.textContent  = `${fuelLabels[fuelType] || fuelType} · ${elapsed}s · ${mode === 'fast' ? '⚡ fast' : '🔍 full search'}`;

  if (stations.length === 0) {
    stationListEl.innerHTML = '<p class="no-results">No stations found. Try a wider radius.</p>';
    resultsEl.classList.remove('hidden');
    return;
  }

  const cheapest = stations[0].price;
  const priciest = stations[stations.length-1].price;
  const range    = priciest - cheapest || 1;

  stationListEl.innerHTML = stations.map((s, i) => {
    const pct      = ((s.price - cheapest) / range) * 100;
    const color    = pct < 33 ? '#059669' : pct < 66 ? '#d97706' : '#dc2626';
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
          <button class="pin-btn ${isPinned ? 'pinned' : ''}"
                  data-node="${s.node_id}"
                  title="${isPinned ? 'Remove favourite' : 'Add to favourites'}">
            ${isPinned ? '★' : '☆'}
          </button>
        </div>
      </div>`;
  }).join('');

  resultsEl.classList.remove('hidden');

  // Pin button handlers
  stationListEl.querySelectorAll('.pin-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      togglePin(btn.dataset.node);
    });
  });
}

// ── Pin/unpin stations ────────────────────────────────────────────
function togglePin(nodeId) {
  let pinned = loadPinned();
  if (pinned.includes(nodeId)) {
    pinned = pinned.filter(id => id !== nodeId);
  } else {
    if (pinned.length >= 3) {
      showStatus('⚠️ You can favourite up to 3 stations. Remove one first.', 'error');
      setTimeout(hideStatus, 2500);
      return;
    }
    pinned.push(nodeId);
  }
  savePinned(pinned);

  // Re-render cards and map markers
  if (lastStations.length) {
    renderResults(lastStations, fuelSelect.value, '', lastStations._mode || 'fast');
    if (mapToggle.checked && lastLat !== null) {
      renderMap(lastStations, lastLat, lastLng, fuelSelect.value, pinned);
    }
  }
}

// ── Profile bar ───────────────────────────────────────────────────
function updateProfileBar(profile) {
  if (!profile) { profileBar.classList.add('hidden'); return; }
  const age    = Math.round((Date.now() - new Date(profile.builtAt)) / 60000);
  const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age/60)}h ago`;
  profileText.textContent =
    `⚡ Fast lookup active — batches ${profile.batches.join(', ')} · built ${ageStr}`;
  profileBar.classList.remove('hidden');
}

// ── Main search ───────────────────────────────────────────────────
async function doSearch(lat, lng, postcode) {
  const radiusMiles = parseFloat(radiusSelect.value);
  const fuelType    = fuelSelect.value;
  const fuelLabels  = {
    'E10': 'Petrol (E10)', 'E5': 'Petrol (E5)',
    'B7_STANDARD': 'Diesel', 'B7_PREMIUM': 'Diesel Premium',
  };
  const t0 = Date.now();

  lastLat = lat; lastLng = lng;
  resultsEl.classList.add('hidden');
  summaryBar.classList.add('hidden');
  stationListEl.innerHTML = '';

  const profile = loadProfile();

  // Fast path
  if (profile?.batches?.length) {
    const batchStr = profile.batches.join(', ');
    showStatus(`⚡ Fast lookup — checking batches ${batchStr}…`);
    try {
      const data = await fetchFast(profile.batches);
      const ok   = verifyFingerprint(data.stations, profile.fingerprint);
      if (ok) {
        const nearby  = filterStations(data.stations, lat, lng, radiusMiles, fuelType);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
        lastStations  = nearby;
        hideStatus();
        updateProfileBar(profile);
        renderSummary(nearby);
        renderResults(nearby, fuelType, elapsed, 'fast');
        if (mapToggle.checked) renderMap(nearby, lat, lng, fuelType, loadPinned());
        saveFavIfNew(postcode, lat, lng, fuelType, fuelLabels, radiusMiles);
        updateFavBtn();
        return;
      }
      showStatus('🔍 Data changed — doing full search…');
      clearProfile();
    } catch(err) {
      showStatus('🔍 Falling back to full search…');
    }
  }

  // Discovery path
  showStatus('🔍 Collecting petrol stations… batch 1 of 15');
  try {
    const data    = await fetchDiscovery();
    const newProf = buildProfile(data.stations, lat, lng, fuelType);
    saveProfile(newProf);

    const nearby  = filterStations(data.stations, lat, lng, radiusMiles, fuelType);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    lastStations  = nearby;
    hideStatus();
    updateProfileBar(newProf);
    renderSummary(nearby);
    renderResults(nearby, fuelType, elapsed, 'discovery');
    if (mapToggle.checked) renderMap(nearby, lat, lng, fuelType, loadPinned());
    saveFavIfNew(postcode, lat, lng, fuelType, fuelLabels, radiusMiles);
    updateFavBtn();
  } catch(err) {
    showStatus('❌ ' + err.message, 'error');
  }
}

function saveFavIfNew(postcode, lat, lng, fuelType, fuelLabels, radius) {
  // Always update favourite with latest search settings
  saveFav({
    postcode: postcode || null,
    lat, lng,
    fuelType,
    fuelLabel: fuelLabels[fuelType] || fuelType,
    radius,
  });
}

// ── Events ────────────────────────────────────────────────────────
searchBtn.addEventListener('click', async () => {
  const postcode = postcodeInput.value.trim().toUpperCase();
  if (!postcode) { showStatus('Please enter a postcode', 'error'); return; }
  showStatus('📍 Looking up postcode…');
  try {
    const { lat, lng } = await postcodeToLatLng(postcode);
    await doSearch(lat, lng, postcode);
  } catch(err) {
    showStatus('❌ ' + err.message, 'error');
  }
});

postcodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchBtn.click(); });

gpsBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { showStatus('❌ Geolocation not supported', 'error'); return; }
  showStatus('📍 Getting your location…');
  navigator.geolocation.getCurrentPosition(
    pos => doSearch(pos.coords.latitude, pos.coords.longitude, null),
    ()  => showStatus('❌ Location access denied', 'error')
  );
});

favBtn.addEventListener('click', () => {
  const fav = loadFav();
  if (!fav) return;
  radiusSelect.value = fav.radius;
  fuelSelect.value   = fav.fuelType;
  if (fav.postcode) {
    postcodeInput.value = fav.postcode;
    doSearch(fav.lat, fav.lng, fav.postcode);
  } else {
    doSearch(fav.lat, fav.lng, null);
  }
});

resetProfileBtn.addEventListener('click', () => {
  clearProfile();
  updateProfileBar(null);
  showStatus('Profile cleared — next search will do a full lookup', 'loading');
  setTimeout(hideStatus, 2500);
});

mapToggle.addEventListener('change', () => {
  if (mapToggle.checked) {
    mapWrap.classList.remove('hidden');
    if (lastStations.length && lastLat !== null) {
      renderMap(lastStations, lastLat, lastLng, fuelSelect.value, loadPinned());
    }
  } else {
    mapWrap.classList.add('hidden');
  }
});

// ── Init ──────────────────────────────────────────────────────────
updateProfileBar(loadProfile());
updateFavBtn();
