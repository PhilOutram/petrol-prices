const fetchBtn = document.getElementById('fetch-btn');
const batchInput = document.getElementById('batch-input');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const fieldsRow = document.getElementById('fields-row');
const tableWrap = document.getElementById('table-wrap');
const rawWrap = document.getElementById('raw-wrap');

function showStatus(msg, type = 'loading') {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}

function hideStatus() { statusEl.className = 'status hidden'; }

fetchBtn.addEventListener('click', async () => {
  const batch = batchInput.value || 1;
  fetchBtn.disabled = true;
  showStatus('⏳ Fetching batch ' + batch + '...');

  // Hide previous results
  statsEl.classList.add('hidden');
  fieldsRow.classList.add('hidden');
  tableWrap.classList.add('hidden');
  rawWrap.classList.add('hidden');

  const t0 = Date.now();
  try {
    const res = await fetch(`/api/fuel?batch=${batch}`);
    const data = await res.json();
    const ms = Date.now() - t0;

    if (!res.ok) throw new Error(data.error || 'Unknown error');

    // Stats
    document.getElementById('s-batch').textContent = data.batch_number;
    document.getElementById('s-count').textContent = data.total_in_batch.toLocaleString();
    document.getElementById('s-fields').textContent = data.fields.length;
    document.getElementById('s-time').textContent = (ms / 1000).toFixed(2) + 's';
    statsEl.classList.remove('hidden');

    // Fields
    document.getElementById('fields-list').innerHTML = data.fields
      .map(f => `<span class="field-tag">${f}</span>`).join('');
    fieldsRow.classList.remove('hidden');

    // Table — flatten fuel_prices into readable columns
    const stations = data.first_10;
    if (stations.length) {
      // Build column list: simple fields first, then fuel prices
      const simpleFields = data.fields.filter(f => f !== 'fuel_prices');
      const fuelTypes = [...new Set(stations.flatMap(s =>
        (s.fuel_prices || []).map(fp => fp.fuel_type || fp.type || Object.keys(fp)[0])
      ))];

      const thead = document.getElementById('table-head');
      const tbody = document.getElementById('table-body');

      thead.innerHTML = '<tr>' +
        simpleFields.map(f => `<th>${f}</th>`).join('') +
        fuelTypes.map(ft => `<th>💷 ${ft}</th>`).join('') +
        '</tr>';

      tbody.innerHTML = stations.map(s => {
        const simpleCells = simpleFields.map(f => {
          const v = s[f];
          if (v === null || v === undefined || v === '') return `<td class="null-cell">—</td>`;
          return `<td title="${String(v)}">${String(v)}</td>`;
        }).join('');

        const priceCells = fuelTypes.map(ft => {
          const fp = (s.fuel_prices || []).find(p =>
            (p.fuel_type || p.type || Object.keys(p)[0]) === ft
          );
          const price = fp ? (fp.price ?? fp.cost ?? Object.values(fp)[1]) : null;
          return price != null
            ? `<td class="price-cell">${Number(price).toFixed(1)}p</td>`
            : `<td class="null-cell">—</td>`;
        }).join('');

        return `<tr>${simpleCells}${priceCells}</tr>`;
      }).join('');

      tableWrap.classList.remove('hidden');
    }

    // Raw JSON of first station
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
