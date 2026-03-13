const fetchBtn  = document.getElementById('fetch-btn');
const batchInput = document.getElementById('batch-input');
const statusEl  = document.getElementById('status');
const statsEl   = document.getElementById('stats');
const fieldsRow = document.getElementById('fields-row');
const tableWrap = document.getElementById('table-wrap');
const rawWrap   = document.getElementById('raw-wrap');

function showStatus(msg, type = 'loading') {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}
function hideStatus() { statusEl.className = 'status hidden'; }

fetchBtn.addEventListener('click', async () => {
  const batch = batchInput.value || 1;
  fetchBtn.disabled = true;
  showStatus('⏳ Fetching batch ' + batch + '...');
  statsEl.classList.add('hidden');
  fieldsRow.classList.add('hidden');
  tableWrap.classList.add('hidden');
  rawWrap.classList.add('hidden');

  const t0 = Date.now();
  try {
    const res  = await fetch(`/api/fuel?batch=${batch}`);
    const data = await res.json();
    const ms   = Date.now() - t0;

    if (!res.ok) throw new Error(data.error || 'Unknown error');

    // Stats
    document.getElementById('s-batch').textContent  = data.batch_number;
    document.getElementById('s-count').textContent  = data.total_in_batch.toLocaleString();
    document.getElementById('s-fields').textContent = data.info_fields.length;
    document.getElementById('s-time').textContent   = (ms / 1000).toFixed(2) + 's';
    statsEl.classList.remove('hidden');

    // Fields from info endpoint
    document.getElementById('fields-list').innerHTML =
      data.info_fields.map(f => `<span class="field-tag">${f}</span>`).join('') +
      (data.location_fields.length
        ? ' &nbsp;<strong>location:</strong> ' + data.location_fields.map(f => `<span class="field-tag">${f}</span>`).join('')
        : '');
    fieldsRow.classList.remove('hidden');

    // Table
    const stations = data.first_10;
    if (stations.length) {
      const fuelLabels = {
        'E10':         '⛽ Petrol (E10)',
        'E5':          '⛽ Petrol (E5)',
        'B7_STANDARD': '🚛 Diesel',
        'B7_PREMIUM':  '🚛 Diesel Premium',
      };

      const fuelTypes = [...new Set(stations.flatMap(s =>
        (s.fuel_prices || []).map(fp => fp.fuel_type)
      ))];

      const thead = document.getElementById('table-head');
      const tbody = document.getElementById('table-body');

      thead.innerHTML = `<tr>
        <th>ID</th>
        <th>Station Name</th>
        <th>Brand</th>
        <th>Address</th>
        <th>Postcode</th>
        <th>Lat</th>
        <th>Lng</th>
        ${fuelTypes.map(ft => `<th>${fuelLabels[ft] || ft}</th>`).join('')}
      </tr>`;

      tbody.innerHTML = stations.map(s => {
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
          <td>${s.brand}</td>
          <td title="${s.address}">${s.address}</td>
          <td><strong>${s.postcode}</strong></td>
          <td class="coord-cell">${lat}</td>
          <td class="coord-cell">${lng}</td>
          ${priceCells}
        </tr>`;
      }).join('');

      tableWrap.classList.remove('hidden');
    }

    // Raw JSON — first merged station
    document.getElementById('raw-json').textContent =
      JSON.stringify(stations[0], null, 2);
    rawWrap.classList.remove('hidden');

    hideStatus();
  } catch (err) {
    showStatus('❌ Error: ' + err.message, 'error');
  } finally {
    fetchBtn.disabled = false;
  }
});
