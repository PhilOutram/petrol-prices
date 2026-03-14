const fetchAllBtn = document.getElementById('fetch-all-btn');
const fetchOneBtn = document.getElementById('fetch-one-btn');
const batchInput  = document.getElementById('batch-input');
const statusEl    = document.getElementById('status');
const statsEl     = document.getElementById('stats');
const fieldsRow   = document.getElementById('fields-row');
const batchBreak  = document.getElementById('batch-breakdown');
const tableWrap   = document.getElementById('table-wrap');
const rawWrap     = document.getElementById('raw-wrap');

function showStatus(msg, type = 'loading') {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}
function hideStatus() { statusEl.className = 'status hidden'; }

function setButtons(disabled) {
  fetchAllBtn.disabled = disabled;
  fetchOneBtn.disabled = disabled;
}

function renderTable(stations) {
  const fuelLabels = {
    'E10':         '⛽ Petrol (E10)',
    'E5':          '⛽ Petrol (E5)',
    'B7_STANDARD': '🚛 Diesel',
    'B7_PREMIUM':  '🚛 Diesel Premium',
  };
  const fuelTypes = [...new Set(stations.flatMap(s =>
    (s.fuel_prices || []).map(fp => fp.fuel_type)
  ))];

  document.getElementById('table-head').innerHTML = `<tr>
    <th>ID</th><th>Station Name</th><th>Brand</th>
    <th>Address</th><th>Postcode</th><th>Lat</th><th>Lng</th>
    ${fuelTypes.map(ft => `<th>${fuelLabels[ft] || ft}</th>`).join('')}
  </tr>`;

  document.getElementById('table-body').innerHTML = stations.map(s => {
    const priceCells = fuelTypes.map(ft => {
      const fp = (s.fuel_prices || []).find(p => p.fuel_type === ft);
      return fp
        ? `<td class="price-cell">${Number(fp.price).toFixed(1)}p</td>`
        : `<td class="null-cell">—</td>`;
    }).join('');
    const lat = s.latitude  != null ? s.latitude.toFixed(4)  : '<span class="null-cell">—</span>';
    const lng = s.longitude != null ? s.longitude.toFixed(4) : '<span class="null-cell">—</span>';
    return `<tr>
      <td><span class="node-id" title="${s.node_id}">${s.node_id.slice(0,8)}…</span></td>
      <td title="${s.trading_name}">${s.trading_name}</td>
      <td>${s.brand || '—'}</td>
      <td title="${s.address}">${s.address || '—'}</td>
      <td><strong>${s.postcode || '—'}</strong></td>
      <td class="coord-cell">${lat}</td>
      <td class="coord-cell">${lng}</td>
      ${priceCells}
    </tr>`;
  }).join('');

  tableWrap.classList.remove('hidden');
}

async function doFetch(url, isFullFetch) {
  setButtons(true);
  [statsEl, fieldsRow, batchBreak, tableWrap, rawWrap].forEach(el => el.classList.add('hidden'));

  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    const stations = data.first_10 || data.stations?.slice(0, 10) || [];

    // Stats
    document.getElementById('s-count').textContent   = (data.total_stations || stations.length).toLocaleString();
    document.getElementById('s-batches').textContent = data.batches_fetched || '1';
    document.getElementById('s-fields').textContent  = (data.info_fields || []).length;
    document.getElementById('s-time').textContent    = (data.elapsed_seconds || 0).toFixed(2) + 's';
    statsEl.classList.remove('hidden');

    // Batch breakdown (full fetch only)
    if (data.batch_counts) {
      document.getElementById('batch-list').innerHTML = data.batch_counts
        .map(b => `<span class="field-tag">Batch ${b.batch}: ${b.count}</span>`).join('');
      batchBreak.classList.remove('hidden');
    }

    // Fields
    if (data.info_fields?.length) {
      document.getElementById('fields-list').innerHTML =
        data.info_fields.map(f => `<span class="field-tag">${f}</span>`).join('') +
        (data.location_fields?.length
          ? ' &nbsp;<strong>location:</strong> ' +
            data.location_fields.map(f => `<span class="field-tag">${f}</span>`).join('')
          : '');
      fieldsRow.classList.remove('hidden');
    }

    if (stations.length) {
      renderTable(stations);
      document.getElementById('raw-json').textContent = JSON.stringify(stations[0], null, 2);
      rawWrap.classList.remove('hidden');
    }

    hideStatus();
  } catch (err) {
    showStatus('❌ Error: ' + err.message, 'error');
  } finally {
    setButtons(false);
  }
}

fetchAllBtn.addEventListener('click', () => {
  showStatus('⏳ Fetching all batches — this may take a few seconds...');
  doFetch('/api/fuel-check', true);
});

fetchOneBtn.addEventListener('click', () => {
  const batch = batchInput.value || 1;
  showStatus(`⏳ Fetching batch ${batch}...`);
  doFetch(`/api/fuel-check?batch=${batch}`, false);
});
