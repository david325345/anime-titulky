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
    const isHanabi = s.extern_domain === 'hanabi.fan';
    const hanabiBtn = (isHanabi && s.status !== 'downloaded')
      ? `<button class="hanabi-link" data-id="${s.sub_id}" data-ep="${s.episode ?? ''}" title="Vložit odkaz na ZIP z hanabi (img.hanabi.fan)">🔗 odkaz</button>`
      : '';
    const dl = s.status === 'downloaded'
      ? `<a href="/api/file/${s.sub_id}">stáhnout</a>`
      : (isHanabi
          ? hanabiBtn
          : (s.kind === 'extern' ? `<a href="${esc(s.url)}" target="_blank">otevřít</a>` : ''));
    // ruční nahrání titulku (jen u nestažených)
    const uploadBtn = s.status !== 'downloaded'
      ? `<button class="upload-sub" data-id="${s.sub_id}" title="Nahrát titulek ručně (.ass/.srt/.zip)">📤</button>`
      : '';
    // stáhnout právě tenhle záznam teď (jen u nestažených)
    const dlNowBtn = s.status !== 'downloaded'
      ? `<button class="dl-one" data-id="${s.sub_id}" title="Stáhnout tento titulek teď">⬇</button>`
      : '';
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
      <td class="nowrap">${dlNowBtn}${uploadBtn}<button class="del" data-id="${s.sub_id}" title="Smazat záznam z DB (na R2 zůstává)">✖</button>${s.r2_key ? `<button class="del-r2" data-id="${s.sub_id}" title="Smazat úplně (DB i soubor na R2)">🗑</button>` : ''}</td>
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

  const manual = $('#manualChk').checked;
  let query = '/api/add-anime?url=' + encodeURIComponent(url);

  if (manual) {
    const from = Number($('#epFrom').value);
    const to = Number($('#epTo').value);
    if (!from || !to || to < from) {
      msg.className = 'addmsg err';
      msg.textContent = '⚠ Zadej platný rozsah dílů (od–do).';
      return;
    }
    query += `&ep_from=${from}&ep_to=${to}` +
      `&lang=${encodeURIComponent($('#mLang').value.trim() || 'CZ')}` +
      `&group=${encodeURIComponent($('#mGroup').value.trim())}`;
  }

  $('#addBtn').disabled = true;
  msg.className = 'addmsg muted';
  msg.textContent = 'Načítám…';
  try {
    const r = await (await fetch(query)).json();
    if (r.error) {
      msg.className = 'addmsg err';
      msg.textContent = '⚠ ' + r.error;
    } else {
      msg.className = 'addmsg ok';
      if (r.manual) {
        msg.textContent = `✅ ${r.title || 'anime'} — vytvořeno ${r.added} prázdných záznamů (díly ${r.from}–${r.to}). Nahraj k nim titulky přes 📤.`;
      } else {
        const dl = r.download_enabled ? 'zařazeno do fronty' : 'evidováno (stahování vypnuté)';
        msg.textContent = `✅ ${r.title || 'anime'} — nalezeno ${r.found} titulků, nových ${r.added}, ${dl}.`;
      }
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
$('#manualChk').addEventListener('change', (e) => {
  $('#manualRow').style.display = e.target.checked ? 'flex' : 'none';
});

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
  // ruční nahrání titulku — otevři file dialog
  const up = e.target.closest('button.upload-sub');
  if (up) {
    const id = up.dataset.id;
    let input = document.getElementById('hiddenFileInput');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.id = 'hiddenFileInput';
      input.accept = '.ass,.srt,.ssa,.zip';
      input.style.display = 'none';
      document.body.appendChild(input);
    }
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      up.disabled = true;
      const orig = up.textContent;
      up.textContent = '⏳';
      try {
        const buf = await file.arrayBuffer();
        const r = await (await fetch(
          `/api/upload-sub?sub_id=${id}&filename=${encodeURIComponent(file.name)}`,
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf }
        )).json();
        if (r.error) { alert('Chyba: ' + r.error); up.disabled = false; up.textContent = orig; }
        else { loadSubs(); loadOverview(); }
      } catch (err) {
        alert('Chyba: ' + err.message);
        up.disabled = false; up.textContent = orig;
      }
      input.value = '';
    };
    input.click();
    return;
  }

  // hanabi odkaz — prompt na ZIP URL
  const hb = e.target.closest('button.hanabi-link');
  if (hb) {
    const id = hb.dataset.id;
    const ep = hb.dataset.ep;
    const url = prompt(
      `Vlož odkaz na ZIP titulku z hanabi (díl ${ep || '?'}):\n` +
      `Zkopíruj z přihlášené stránky hanabi.fan — musí být https://img.hanabi.fan/…/*.zip`
    );
    if (!url) return;
    hb.disabled = true;
    hb.textContent = 'stahuji…';
    try {
      const r = await (await fetch('/api/hanabi-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub_id: Number(id), url: url.trim() }),
      })).json();
      if (r.error) { alert('Chyba: ' + r.error); hb.disabled = false; hb.textContent = '🔗 odkaz'; }
      else { loadSubs(); loadOverview(); }
    } catch (err) {
      alert('Chyba: ' + err.message);
      hb.disabled = false; hb.textContent = '🔗 odkaz';
    }
    return;
  }

  // stáhnout tento jeden titulek teď
  const dlBtn = e.target.closest('button.dl-one');
  if (dlBtn) {
    const id = dlBtn.dataset.id;
    const orig = dlBtn.textContent;
    dlBtn.disabled = true;
    dlBtn.textContent = '⏳';
    try {
      const r = await (await fetch(`/api/download-sub/${id}`, { method: 'POST' })).json();
      if (r.ok) {
        loadSubs();
        loadOverview();
      } else {
        alert('Nestáhlo se: ' + (r.error || 'neznámá chyba'));
        dlBtn.disabled = false;
        dlBtn.textContent = orig;
      }
    } catch (err) {
      alert('Chyba: ' + err.message);
      dlBtn.disabled = false;
      dlBtn.textContent = orig;
    }
    return;
  }

  // úplné smazání (DB + R2)
  const r2Btn = e.target.closest('button.del-r2');
  if (r2Btn) {
    const id = r2Btn.dataset.id;
    if (!confirm('Smazat ÚPLNĚ — záznam z DB i soubor z R2?\n\nToto je nevratné.')) return;
    r2Btn.disabled = true;
    try {
      const r = await (await fetch(`/api/sub/${id}?r2=1`, { method: 'DELETE' })).json();
      if (r.error) {
        alert('Nešlo smazat z R2: ' + r.error);
        r2Btn.disabled = false;
      } else {
        loadSubs();
        loadOverview();
      }
    } catch (err) {
      alert('Chyba: ' + err.message);
      r2Btn.disabled = false;
    }
    return;
  }

  // mazání záznamu (jen DB)
  const btn = e.target.closest('button.del');
  if (!btn) return;
  const id = btn.dataset.id;
  if (!confirm('Smazat tento záznam z DB? (soubor na R2 zůstane)')) return;
  btn.disabled = true;
  try {
    await fetch(`/api/sub/${id}`, { method: 'DELETE' });
    loadSubs();
    loadOverview();
  } catch (e) { btn.disabled = false; }
});

load();
setInterval(loadOverview, 5000); // auto-refresh jen souhrn (netrhá stránkování/hledání)
