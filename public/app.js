const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  return d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function dur(a, b) {
  if (!a || !b) return '—';
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function statusCell(sub) {
  const label = { downloaded: 'staženo', new: 'čeká', not_downloaded: 'evidováno', pending_extern: 'extern (čeká na parser)', failed: 'chyba' }[sub.status] || sub.status;
  const t = sub.error ? ` title="${esc(sub.error)}"` : '';
  return `<span class="st-${sub.status}"${t}>${esc(label)}</span>`;
}

function renderStats(c, status) {
  const dotCls = status.running ? 'run' : 'ok';
  $('#stats').innerHTML = `
    <div class="card"><div class="k">Titulků celkem</div><div class="v">${c.total || 0}</div></div>
    <div class="card"><div class="k">Staženo</div><div class="v">${c.downloaded || 0}</div></div>
    <div class="card"><div class="k">Na R2</div><div class="v">${c.on_r2 || 0}</div></div>
    <div class="card"><div class="k">Externí (čeká)</div><div class="v">${c.extern_pending || 0}</div></div>
    <div class="card"><div class="k">Chyby</div><div class="v">${c.failed || 0}</div></div>`;
  $('#lastRun').innerHTML =
    `<span class="dot ${dotCls}"></span>` +
    (status.running ? 'scrapuji…' : `poslední běh: ${fmtDate(status.lastRun)}`);
  $('#runBtn').disabled = status.running;
  $('#dlBtn').disabled = status.running;
}

function renderSubs(subs) {
  $('#subsTable tbody').innerHTML = subs.map((s) => {
    const cleanTitle = (s.anime_title || '#' + s.hiyori_id).replace(/\s*[-–]\s*Hiyori\s*$/i, '');
    const anime = s.hiyori_id
      ? `<a href="https://hiyori.cz/anime/${s.hiyori_id}" target="_blank" title="${esc(cleanTitle)}">${esc(cleanTitle)}</a>`
      : esc(cleanTitle);
    const lang = s.lang ? `<span class="pill lang-${esc(s.lang)}">${esc(s.lang)}</span>` : '';
    const src = s.kind === 'direct'
      ? `<span class="pill src-direct">hiyori</span>`
      : `<span class="pill src-extern">${esc(s.extern_domain || 'extern')}</span>`;
    const dl = s.status === 'downloaded'
      ? `<a href="/api/file/${s.sub_id}">stáhnout</a>`
      : (s.kind === 'extern' ? `<a href="${esc(s.url)}" target="_blank">otevřít</a>` : '');
    const onR2 = s.r2_key
      ? `<span class="pill r2-yes" title="${esc(s.r2_key)}">✓</span>`
      : `<span class="r2-no">—</span>`;
    return `<tr>
      <td class="muted nowrap">${fmtDate(s.first_seen)}</td>
      <td class="anime">${anime}</td>
      <td class="nowrap">${s.episode ?? '—'}</td>
      <td class="nowrap">${lang}</td>
      <td class="group">${esc(s.group_name || '')}</td>
      <td class="release">${esc(s.release || '')}</td>
      <td class="nowrap">${src}</td>
      <td class="nowrap">${statusCell(s)}</td>
      <td class="nowrap">${onR2}</td>
      <td class="nowrap">${dl}</td>
      <td class="nowrap"><button class="del" data-id="${s.sub_id}" title="Smazat záznam (na R2 zůstává)">✕</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="11" class="muted">Nic nenalezeno.</td></tr>`;
}

function renderRuns(runs) {
  $('#runsTable tbody').innerHTML = runs.map((r) => `
    <tr>
      <td class="muted">${fmtDate(r.started_at)}</td>
      <td>${dur(r.started_at, r.finished_at)}</td>
      <td>${r.feed_cards ?? '—'}</td>
      <td>${r.anime_checked ?? '—'}</td>
      <td>${r.new_subs ?? '—'}</td>
      <td>${r.downloaded ?? '—'}</td>
      <td>${r.extern_pending ?? '—'}</td>
      <td>${r.failed ?? '—'}</td>
      <td>${r.finished_at ? (r.ok ? '<span class="dot ok"></span>ok' : `<span class="dot bad"></span>${esc(r.error || 'chyba')}`) : '<span class="dot run"></span>běží'}</td>
    </tr>`).join('') || `<tr><td colspan="9" class="muted">—</td></tr>`;
}

let curPage = 1;
let curQuery = '';

async function loadOverview() {
  try {
    const d = await (await fetch('/api/overview')).json();
    renderStats(d.counts, d.status);
    renderRuns(d.runs);
  } catch (e) { /* ignoruj */ }
}

async function loadSubs() {
  try {
    const url = `/api/subs-list?page=${curPage}` + (curQuery ? `&q=${encodeURIComponent(curQuery)}` : '');
    const d = await (await fetch(url)).json();
    renderSubs(d.subs);
    renderPager(d);
  } catch (e) { /* ignoruj */ }
}

function renderPager(d) {
  const from = d.total === 0 ? 0 : (d.page - 1) * d.per_page + 1;
  const to = Math.min(d.page * d.per_page, d.total);
  $('#pageInfo').textContent = `${from}–${to} z ${d.total}`;
  $('#prevBtn').disabled = d.page <= 1;
  $('#nextBtn').disabled = d.page >= d.pages;
}

function load() { loadOverview(); loadSubs(); }

$('#runBtn').addEventListener('click', async () => {
  $('#runBtn').disabled = true;
  await fetch('/api/run', { method: 'POST' });
  setTimeout(load, 800);
});

$('#dlBtn').addEventListener('click', async () => {
  $('#dlBtn').disabled = true;
  await fetch('/api/download-only', { method: 'POST' });
  setTimeout(load, 800);
});

async function addAnime() {
  const url = $('#addUrl').value.trim();
  const msg = $('#addMsg');
  if (!url) { msg.textContent = 'Vlož odkaz na anime z hiyori.'; return; }
  $('#addBtn').disabled = true;
  msg.className = 'addmsg muted';
  msg.textContent = 'Načítám…';
  try {
    const r = await (await fetch('/api/add-anime?url=' + encodeURIComponent(url))).json();
    if (r.error) {
      msg.className = 'addmsg err';
      msg.textContent = '⚠ ' + r.error;
    } else {
      msg.className = 'addmsg ok';
      const dl = r.download_enabled ? 'zařazeno do fronty' : 'evidováno (stahování vypnuté)';
      msg.textContent = `✅ ${r.title || 'anime'} — nalezeno ${r.found} titulků, nových ${r.added}, ${dl}.`;
      $('#addUrl').value = '';
      load();
    }
  } catch (e) {
    msg.className = 'addmsg err';
    msg.textContent = '⚠ Chyba: ' + e.message;
  } finally {
    $('#addBtn').disabled = false;
  }
}
$('#addBtn').addEventListener('click', addAnime);
$('#addUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') addAnime(); });

// stránkování
$('#prevBtn').addEventListener('click', () => { if (curPage > 1) { curPage--; loadSubs(); } });
$('#nextBtn').addEventListener('click', () => { curPage++; loadSubs(); });

// hledání podle názvu (debounce)
let searchTimer = null;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    curQuery = e.target.value.trim();
    curPage = 1;
    loadSubs();
  }, 350);
});

// mazání (delegace na tabulce)
$('#subsTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button.del');
  if (!btn) return;
  const id = btn.dataset.id;
  if (!confirm('Smazat tento záznam? (soubor na R2 zůstane)')) return;
  btn.disabled = true;
  try {
    await fetch(`/api/sub/${id}`, { method: 'DELETE' });
    loadSubs();
    loadOverview();
  } catch (e) { btn.disabled = false; }
});

load();
setInterval(loadOverview, 5000); // auto-refresh jen souhrn (netrhá stránkování/hledání)
