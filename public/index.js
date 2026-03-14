// ================================================================
// FuelScan — Main App
// ================================================================
// Location profile strategy:
//   1. First run (no profile) → full discovery fetch → find nearest
//      stations → save profile (batches + fingerprint node_ids)
//   2. Subsequent runs → fast fetch (saved batches only) → verify
//      fingerprint node_ids still present → show results
//   3. If fingerprint check fails → full rediscovery
// ================================================================

const PROFILE_KEY    = 'fuelscan_profile';   // localStorage key
const FINGERPRINT_N  = 5;                    // node_ids to verify
const NEARBY_COUNT   = 20;                   // stations to show
const EARTH_RADIUS_M = 6371000;

// ── DOM refs ─────────────────────────────────────────────────────
const postcodeInput   = document.getElementById('postcode-input');
const searchBtn       = document.getElementById('search-btn');
const gpsBtn          = document.getElementById('gps-btn');
const radiusSelect    = document.getElementById('radius-select');
const fuelSelect      = document.getElementById('fuel-select');
const statusEl        = document.getElementById('status');
const profileBar      = document.getElementById('profile-bar');
const profileText     = document.getElementById('profile-text');
const resetProfileBtn = document.getElementById('reset-profile-btn');
const resultsEl       = document.getElementById('results');
const resultsTitleEl  = document.getElementById('results-title');
const resultsMetaEl   = document.getElementById('results-meta');
const stationListEl   = document.getElementById('station-list');

// ── Status helpers ───────────────────────────────────────────────
function showStatus(msg, type = 'loading') {
  statusEl.innerHTML = msg;
  statusEl.className = `status ${type}`;
}
function hideStatus() { statusEl.className = 'status hidden'; }

// ── Distance (Haversine) ─────────────────────────────────────────
function distanceMetres(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function metresToMiles(m) { return m / 1609.344; }

// ── Profile (localStorage) ───────────────────────────────────────
function loadProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null; }
  catch { return null; }
}
function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}
function clearProfile() {
  localStorage.removeItem(PROFILE_KEY);
}

// ── Postcode → lat/lng ───────────────────────────────────────────
async function postcodeToLatLng(postcode) {
  const res  = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
  const data = await res.json();
  if (!res.ok || data.status !== 200) throw new Error('Postcode not found');
  return { lat: data.result.latitude, lng: data.result.longitude };
}

// ── Filter & sort stations ───────────────────────────────────────
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

// ── API fetch helpers ────────────────────────────────────────────
async function fetchFast(batches) {
  const res  = await fetch(`/api/fuel?batches=${batches.join(',')}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Fast fetch failed');
  return data;
}

async function fetchDiscovery() {
  const res  = await fetch('/api/fuel');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Discovery fetch failed');
  return data;
}

// ── Build profile from full dataset ─────────────────────────────
function buildProfile(stations, lat, lng, radiusMiles, fuelType) {
  // Find nearest NEARBY_COUNT stations with any fuel price
  const nearby = stations
    .filter(s => s.latitude != null && s.longitude != null)
    .map(s => ({
      ...s,
      distanceMiles: metresToMiles(distanceMetres(lat, lng, s.latitude, s.longitude)),
    }))
    .filter(s => s.distanceMiles <= 20)  // generous radius for profile building
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, NEARBY_COUNT);

  // Which batches do these stations come from?
  // We don't have batch info per-station from the merged response,
  // so we derive it from position in the original array (500 per batch)
  const batchSet = new Set();
  for (const s of nearby) {
    const idx = stations.findIndex(st => st.node_id === s.node_id);
    if (idx >= 0) batchSet.add(Math.floor(idx / 500) + 1);
  }

  // Fingerprint: node_ids of the FINGERPRINT_N cheapest nearby stations
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
    batches:     [...batchSet].sort((a,b) => a-b),
    fingerprint,
    fuelType,
    builtAt:     new Date().toISOString(),
  };
}

// ── Verify fingerprint ───────────────────────────────────────────
function verifyFingerprint(stations, fingerprint) {
  const nodeIds = new Set(stations.map(s => s.node_id));
  return fingerprint.every(id => nodeIds.has(id));
}

// ── Render results ───────────────────────────────────────────────
function renderResults(stations, fuelType, elapsed, mode) {
  const fuelLabels = {
    'E10':         'Petrol E10',
    'E5':          'Petrol E5',
    'B7_STANDARD': 'Diesel',
    'B7_PREMIUM':  'Diesel Premium',
  };

  resultsTitleEl.textContent = `${stations.length} station${stations.length !== 1 ? 's' : ''} nearby`;
  resultsMetaEl.textContent  = `${fuelLabels[fuelType] || fuelType} · ${elapsed}s · ${mode === 'fast' ? '⚡ fast lookup' : '🔍 full search'}`;

  if (stations.length === 0) {
    stationListEl.innerHTML = '<p class="no-results">No stations found in this area for the selected fuel type. Try increasing the radius.</p>';
    resultsEl.classList.remove('hidden');
    return;
  }

  const cheapest = stations[0].price;
  const priciest = stations[stations.length - 1].price;
  const range    = priciest - cheapest || 1;

  stationListEl.innerHTML = stations.map((s, i) => {
    const pct   = ((s.price - cheapest) / range) * 100;
    const color = pct < 33 ? '#059669' : pct < 66 ? '#d97706' : '#dc2626';
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
    return `
      <div class="station-card">
        <div class="station-rank">${medal}</div>
        <div class="station-info">
          <div class="station-name">${s.trading_name}</div>
          <div class="station-address">${s.address || s.postcode || '—'}</div>
          <div class="station-brand">${s.brand || ''}</div>
        </div>
        <div class="station-right">
          <div class="station-price" style="color:${color}">${s.price.toFixed(1)}p</div>
          <div class="station-distance">${s.distanceMiles.toFixed(1)} mi</div>
        </div>
      </div>`;
  }).join('');

  resultsEl.classList.remove('hidden');
}

// ── Update profile bar ───────────────────────────────────────────
function updateProfileBar(profile) {
  if (!profile) {
    profileBar.classList.add('hidden');
    return;
  }
  const age     = Math.round((Date.now() - new Date(profile.builtAt)) / 60000);
  const ageStr  = age < 60 ? `${age}m ago` : `${Math.round(age/60)}h ago`;
  profileText.textContent =
    `⚡ Fast lookup active — batches ${profile.batches.join(', ')} · built ${ageStr}`;
  profileBar.classList.remove('hidden');
}

// ── Main search ──────────────────────────────────────────────────
async function doSearch(lat, lng) {
  const radiusMiles = parseFloat(radiusSelect.value);
  const fuelType    = fuelSelect.value;
  const t0          = Date.now();

  resultsEl.classList.add('hidden');
  stationListEl.innerHTML = '';

  const profile = loadProfile();

  // ── Fast path ────────────────────────────────────────────────
  if (profile && profile.batches.length > 0) {
    showStatus(`⚡ Fast lookup — checking batches ${profile.batches.join(', ')}...`);
    try {
      const data = await fetchFast(profile.batches);
      const ok   = verifyFingerprint(data.stations, profile.fingerprint);

      if (ok) {
        const nearby  = filterStations(data.stations, lat, lng, radiusMiles, fuelType);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
        hideStatus();
        updateProfileBar(profile);
        renderResults(nearby, fuelType, elapsed, 'fast');
        return;
      } else {
        console.log('[app] Fingerprint check failed — falling back to full discovery');
        showStatus('🔍 Data changed — doing full search...');
        clearProfile();
      }
    } catch (err) {
      console.warn('[app] Fast fetch failed, falling back:', err.message);
      showStatus('🔍 Falling back to full search...');
    }
  }

  // ── Discovery path ───────────────────────────────────────────
  showStatus('🔍 Full search — fetching all stations...');
  try {
    const data    = await fetchDiscovery();
    const profile = buildProfile(data.stations, lat, lng, radiusMiles, fuelType);
    saveProfile(profile);
    console.log('[app] Profile saved — batches:', profile.batches, '| fingerprint:', profile.fingerprint);

    const nearby  = filterStations(data.stations, lat, lng, radiusMiles, fuelType);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    hideStatus();
    updateProfileBar(profile);
    renderResults(nearby, fuelType, elapsed, 'discovery');
  } catch (err) {
    showStatus('❌ Error: ' + err.message, 'error');
  }
}

// ── Event listeners ──────────────────────────────────────────────
searchBtn.addEventListener('click', async () => {
  const postcode = postcodeInput.value.trim();
  if (!postcode) { showStatus('Please enter a postcode', 'error'); return; }
  showStatus('📍 Looking up postcode...');
  try {
    const { lat, lng } = await postcodeToLatLng(postcode);
    await doSearch(lat, lng);
  } catch (err) {
    showStatus('❌ ' + err.message, 'error');
  }
});

postcodeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') searchBtn.click();
});

gpsBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    showStatus('❌ Geolocation not supported by your browser', 'error');
    return;
  }
  showStatus('📍 Getting your location...');
  navigator.geolocation.getCurrentPosition(
    pos => doSearch(pos.coords.latitude, pos.coords.longitude),
    ()  => showStatus('❌ Location access denied', 'error')
  );
});

resetProfileBtn.addEventListener('click', () => {
  clearProfile();
  updateProfileBar(null);
  showStatus('Profile cleared — next search will do a full lookup', 'loading');
  setTimeout(hideStatus, 2000);
});

// Show profile bar on load if profile exists
updateProfileBar(loadProfile());
