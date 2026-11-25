(function () {
  const { t, getAdminPassword, isAdmin, updateOnlineBadge, formatDateTime } = window.CompostCommon;

  const state = {
    page: 1,
    limit: 25,
    totalPages: 1,
    from: '',
    to: '',
  };

  function buildFilterQuery(includePaging = true) {
    const params = new URLSearchParams();
    if (state.from) params.set('from', new Date(state.from).toISOString());
    if (state.to) params.set('to', new Date(state.to).toISOString());
    if (includePaging) {
      params.set('page', String(state.page));
      params.set('limit', String(state.limit));
    }
    return params.toString();
  }

  function updateExportLinks() {
    const qs = buildFilterQuery(false);
    const suffix = qs ? `?${qs}` : '';
    const csvLink = document.getElementById('exportCsvBtn');
    const xlsxLink = document.getElementById('exportXlsxBtn');
    if (csvLink) csvLink.href = `/api/export.csv${suffix}`;
    if (xlsxLink) xlsxLink.href = `/api/export.xlsx${suffix}`;
  }

  async function refreshOnlineStatus() {
    try {
      const res = await fetch('/api/latest');
      if (!res.ok) return;
      const snap = await res.json();
      updateOnlineBadge(snap.latest ? snap.latest.created_at : null);
    } catch {
      updateOnlineBadge(null);
    }
  }

  function renderTable(rows) {
    const tbody = document.getElementById('readingsTableBody');
    if (!tbody) return;

    if (!rows || rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:1.5rem;">${t('emptyTable')}</td></tr>`;
      return;
    }

    tbody.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      const sourceLabel = row.source === 'manual' ? t('sourceManual') : t('sourceSensor');
      const sourceCls = row.source === 'manual' ? 'source-manual' : 'source-sensor';

      tr.innerHTML = `
        <td>${row.id}</td>
        <td>${escapeHtml(row.device_id)}</td>
        <td>${row.temperature != null ? Number(row.temperature).toFixed(2) : '—'}</td>
        <td>${row.soil_moisture != null ? Number(row.soil_moisture).toFixed(2) : '—'}</td>
        <td>${row.oxygen != null ? Number(row.oxygen).toFixed(2) : '—'}</td>
        <td>${row.ph != null ? Number(row.ph).toFixed(2) : '—'}</td>
        <td>${row.note ? escapeHtml(row.note) : '—'}</td>
        <td><span class="source-badge ${sourceCls}">${sourceLabel}</span></td>
        <td>${formatDateTime(row.created_at)}</td>
        <td class="admin-only-cell">
          <button type="button" class="btn btn-danger btn-sm delete-row-btn" data-id="${row.id}">
            ${t('deleteBtn')}
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('.delete-row-btn').forEach((btn) => {
      btn.addEventListener('click', () => handleDeleteRow(btn.dataset.id));
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadTable() {
    updateExportLinks();
    const qs = buildFilterQuery(true);
    try {
      const res = await fetch(`/api/readings?${qs}`);
      const json = await res.json();
      if (!res.ok) {
        showTableAlert(json.error || 'Error loading data', true);
        return;
      }

      renderTable(json.data || []);

      const p = json.pagination || { page: 1, totalPages: 1, total: 0 };
      state.page = p.page;
      state.totalPages = p.totalPages;

      const info = document.getElementById('paginationInfo');
      if (info) {
        info.textContent = t('pageInfo', {
          page: p.page,
          totalPages: p.totalPages,
          total: p.total,
        });
      }

      const prevBtn = document.getElementById('prevPageBtn');
      const nextBtn = document.getElementById('nextPageBtn');
      if (prevBtn) prevBtn.disabled = p.page <= 1;
      if (nextBtn) nextBtn.disabled = p.page >= p.totalPages;
    } catch (err) {
      showTableAlert(err.message, true);
    }
  }

  function showTableAlert(msg, isError = false) {
    const box = document.getElementById('tableFeedback');
    if (!box) return;
    box.className = isError ? 'alert alert-error' : 'alert alert-success';
    box.textContent = msg;
    box.style.display = 'block';
    setTimeout(() => {
      box.style.display = 'none';
    }, 5000);
  }

  async function handleDeleteRow(id) {
    if (!isAdmin()) return;
    if (!window.confirm(t('confirmDeleteRow'))) return;

    try {
      const res = await fetch(`/api/readings/${id}`, {
        method: 'DELETE',
        headers: { 'x-admin-password': getAdminPassword() },
      });
      const json = await res.json();
      if (!res.ok) {
        showTableAlert(json.error || 'Delete failed', true);
        return;
      }
      loadTable();
    } catch (err) {
      showTableAlert(err.message, true);
    }
  }

  async function handleDeleteRange() {
    if (!isAdmin()) return;
    if (!state.from && !state.to) {
      showTableAlert(t('needDateForRangeDelete'), true);
      return;
    }
    if (!window.confirm(t('confirmDeleteRange'))) return;

    const qs = buildFilterQuery(false);
    try {
      const res = await fetch(`/api/readings?${qs}`, {
        method: 'DELETE',
        headers: { 'x-admin-password': getAdminPassword() },
      });
      const json = await res.json();
      if (!res.ok) {
        showTableAlert(json.error || 'Delete failed', true);
        return;
      }
      state.page = 1;
      loadTable();
    } catch (err) {
      showTableAlert(err.message, true);
    }
  }

  function setupDeleteAllModal() {
    const openBtn = document.getElementById('deleteAllBtn');
    const modal = document.getElementById('deleteAllModal');
    const closeBtn = document.getElementById('deleteAllClose');
    const cancelBtn = document.getElementById('deleteAllCancel');
    const check = document.getElementById('deleteAllConfirmCheck');
    const confirmBtn = document.getElementById('deleteAllConfirmBtn');

    if (!openBtn || !modal) return;

    openBtn.addEventListener('click', () => {
      check.checked = false;
      confirmBtn.disabled = true;
      modal.classList.add('open');
    });

    const closeModal = () => modal.classList.remove('open');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    check.addEventListener('change', () => {
      confirmBtn.disabled = !check.checked;
    });

    confirmBtn.addEventListener('click', async () => {
      if (!check.checked || !isAdmin()) return;
      try {
        const res = await fetch('/api/readings/all', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-password': getAdminPassword(),
          },
          body: JSON.stringify({ confirm: true }),
        });
        const json = await res.json();
        closeModal();
        if (!res.ok) {
          showTableAlert(json.error || 'Delete failed', true);
          return;
        }
        state.page = 1;
        loadTable();
        refreshOnlineStatus();
      } catch (err) {
        closeModal();
        showTableAlert(err.message, true);
      }
    });
  }

  function setupManualPhForm() {
    const form = document.getElementById('dataPhForm');
    if (!form) return;

    const feedback = document.getElementById('dataPhFeedback');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      feedback.style.display = 'none';

      const value = Number(document.getElementById('dataPhValue').value);
      const note = document.getElementById('dataPhNote').value.trim();
      const timeVal = document.getElementById('dataPhTime').value;

      const payload = {
        value,
        note: note || undefined,
        timestamp: timeVal ? new Date(timeVal).toISOString() : undefined,
      };

      try {
        const res = await fetch('/api/ph', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-password': getAdminPassword(),
          },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          feedback.className = 'alert alert-error';
          feedback.textContent = data.error || 'Error saving pH';
          feedback.style.display = 'block';
          return;
        }
        form.reset();
        feedback.className = 'alert alert-success';
        feedback.textContent = t('phSavedMsg');
        feedback.style.display = 'block';
        state.page = 1;
        loadTable();
      } catch (err) {
        feedback.className = 'alert alert-error';
        feedback.textContent = err.message;
        feedback.style.display = 'block';
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const fromInput = document.getElementById('filterFrom');
    const toInput = document.getElementById('filterTo');
    const limitSelect = document.getElementById('filterLimit');

    document.getElementById('applyFilterBtn').addEventListener('click', () => {
      state.from = fromInput.value;
      state.to = toInput.value;
      state.limit = Number(limitSelect.value) || 25;
      state.page = 1;
      loadTable();
    });

    document.getElementById('resetFilterBtn').addEventListener('click', () => {
      fromInput.value = '';
      toInput.value = '';
      state.from = '';
      state.to = '';
      state.page = 1;
      loadTable();
    });

    document.getElementById('prevPageBtn').addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        loadTable();
      }
    });

    document.getElementById('nextPageBtn').addEventListener('click', () => {
      if (state.page < state.totalPages) {
        state.page += 1;
        loadTable();
      }
    });

    const deleteRangeBtn = document.getElementById('deleteRangeBtn');
    if (deleteRangeBtn) {
      deleteRangeBtn.addEventListener('click', handleDeleteRange);
    }

    setupDeleteAllModal();
    setupManualPhForm();

    loadTable();
    refreshOnlineStatus();
    setInterval(refreshOnlineStatus, 5000);

    window.addEventListener('langChanged', loadTable);
    window.addEventListener('adminAuthChanged', loadTable);
  });
})();
