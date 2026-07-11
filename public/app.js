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
    <div class="card"><div class="k">Externí (čeká)</div><div class="v">${c.extern_pending || 0}</div></div>
    <div class="card"><div class="k">Chyby</div><div class="v">${c.failed || 0}</div></div>`;
  $('#lastRun').innerHTML =
    `<span class="dot ${dotCls}"></span>` +
    (status.running ? 'scrapuji…' : `poslední běh: ${fmtDate(status.lastRun)}`);
  $('#runBtn').disabled = status.running;
}

function renderSubs(subs) {
  $('#subsTable tbody').innerHTML = subs.map((s) => {
    const anime = s.hiyori_id
      ? `<a href="https://hiyori.cz/anime/${s.hiyori_id}" target="_blank">${esc(s.anime_title || '#' + s.hiyori_id)}</a>`
      : esc(s.anime_title || '');
    const lang = s.lang ? `<span class="pill lang-${esc(s.lang)}">${esc(s.lang)}</span>` : '';
    const src = s.kind === 'direct'
      ? `<span class="pill src-direct">hiyori</span>`
      : `<span class="pill src-extern">${esc(s.extern_domain || 'extern')}</span>`;
    const dl = s.status === 'downloaded'
      ? `<a href="/api/file/${s.sub_id}">stáhnout</a>`
      : (s.kind === 'extern' ? `<a href="${esc(s.url)}" target="_blank">otevřít</a>` : '');
    return `<tr>
      <td class="muted">${fmtDate(s.first_seen)}</td>
      <td>${anime}</td>
      <td>${s.episode ?? '—'}</td>
      <td>${lang}</td>
      <td>${esc(s.group_name || '')}</td>
      <td class="muted">${esc(s.release || '')}</td>
      <td>${src}</td>
      <td>${statusCell(s)}</td>
      <td>${dl}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="9" class="muted">Zatím nic. Spusť scrape.</td></tr>`;
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

async function load() {
  try {
    const d = await (await fetch('/api/overview')).json();
    renderStats(d.counts, d.status);
    renderSubs(d.subs);
    renderRuns(d.runs);
  } catch (e) { /* ignoruj, zkusíme příště */ }
}

$('#runBtn').addEventListener('click', async () => {
  $('#runBtn').disabled = true;
  await fetch('/api/run', { method: 'POST' });
  setTimeout(load, 800);
});

load();
setInterval(load, 5000); // auto-refresh
