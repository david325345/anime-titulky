const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// role účtu — mazací tlačítka vidí jen hlavní účet (ne user2)
let canDelete = true;
async function loadRole() {
  try {
    const r = await (await fetch('/api/whoami')).json();
    canDelete = !!r.can_delete;
    // záloha DB jen pro hlavní účet (obsahuje kompletní evidenci)
    if (r.role !== 'user2') {
      const bb = $('#backupBtn'); if (bb) bb.style.display = '';
      const rb = $('#restoreBtn'); if (rb) rb.style.display = '';
    }
  } catch { canDelete = true; }
}

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
    <div class="card"><div class="k">Anime celkem</div><div class="v">${c.anime || 0}</div></div>
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
    // stáhnout právě tenhle záznam teď (jen u nestažených, ne u ručních — ty čekají na 📤)
    const dlNowBtn = (s.status !== 'downloaded' && s.kind !== 'manual')
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
      <td class="nowrap">${(s.status === 'downloaded' && s.r2_key) ? `<button class="bd-resync" data-id="${s.sub_id}" data-source="hiyori" title="Přečasovat na BD časování (BD auto)">⏱</button>` : ''}${s.machine ? `<button class="machine-toggle" data-id="${s.sub_id}" title="Zobrazit strojovou verzi (BD auto)">přečas ▸</button>` : ''}${dlNowBtn}${uploadBtn}${canDelete ? `<button class="edit-sub" data-id="${s.sub_id}" data-group="${esc(s.group_name || '')}" data-release="${esc(s.release || '')}" data-lang="${esc(s.lang || '')}" title="Upravit fansub / release / jazyk">✏️</button>` : ''}${(canDelete && s.r2_key) ? `<button class="del-r2" data-id="${s.sub_id}" title="Smazat úplně (DB i soubor na R2)">🗑</button>` : ''}${(canDelete && !s.r2_key) ? `<button class="del-db" data-id="${s.sub_id}" title="Smazat z evidence (jen DB — žádný soubor na R2)">🗑</button>` : ''}${(canDelete && s.status === 'downloaded') ? `<button class="reset-sub" data-id="${s.sub_id}" title="Smazat soubor z R2 a vrátit mezi nestažené (pak jde nahrát správný přes 📤)">♻</button>` : ''}</td>
    </tr>${s.machine ? `<tr class="machine-row" data-for="${s.sub_id}" hidden><td></td><td colspan="10" class="machine-cell"><span class="pill machine-pill">${esc(s.machine.release || '🤖 BD')}</span> ${s.machine.version ? esc(s.machine.version) + ' · ' : ''}${((s.machine.file_bytes || 0) / 1024).toFixed(1)} KB · <a href="/api/file/${s.machine.sub_id}">stáhnout</a></td></tr>` : ''}`;
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

async function loadRequests() {
  try {
    const d = await (await fetch('/api/requests?status=pending')).json();
    renderRequests(d.requests || []);
  } catch (e) { /* ignoruj */ }
}

function renderRequests(reqs) {
  const panel = document.getElementById('requestsPanel');
  const body = document.getElementById('requestsBody');
  const count = document.getElementById('reqCount');
  if (!panel || !body) return;
  if (!reqs.length) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  count.textContent = `(${reqs.length})`;
  body.innerHTML = reqs.map((r) => {
    const title = (r.title || '—').replace(/\s*-\s*Hiyori$/i, '');
    const date = (r.requested_at || '').replace('T', ' ').slice(0, 16);
    const alLink = r.anilist_id ? `<a href="https://anilist.co/anime/${r.anilist_id}" target="_blank">${r.anilist_id}</a>` : '—';
    const hLink = `<a href="https://hiyori.cz/anime/${r.hiyori_id}" target="_blank">${r.hiyori_id}</a>`;
    return `<tr>
      <td>${escapeHtml(title)}</td>
      <td>${hLink}</td>
      <td>${alLink}</td>
      <td class="muted">${date}</td>
      <td class="req-actions">
        <button class="req-approve" data-id="${r.id}" title="Přidat anime (všechny díly)">✓ Přidat</button>
        <button class="req-reject" data-id="${r.id}" title="Zamítnout požadavek">✗ Zamítnout</button>
      </td>
    </tr>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function load() { loadOverview(); loadSubs(); loadRequests(); }

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

$('#backupBtn').addEventListener('click', () => {
  // prohlížeč stáhne soubor přímo z endpointu (gzip DB)
  window.location.href = '/api/backup/download';
});

$('#restoreBtn').addEventListener('click', () => $('#restoreFile').click());
$('#restoreFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // reset, ať jde nahrát ten samý soubor znovu
  if (!confirm(
    `Obnovit databázi ze souboru "${file.name}"?\n\n` +
    `Tím se PŘEPÍŠE aktuální databáze a služba se restartuje.\n` +
    `(Aktuální stav se pro jistotu zazálohuje.)\n\nToto je nevratné.`
  )) return;

  const rb = $('#restoreBtn');
  rb.disabled = true;
  const orig = rb.textContent;
  rb.textContent = '⏳ Obnovuji…';
  try {
    const buf = await file.arrayBuffer();
    const r = await (await fetch('/api/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    })).json();
    if (r.ok) {
      alert('✅ ' + (r.message || 'DB obnovena. Služba se restartuje.'));
      // po restartu (~10 s) obnov stránku
      setTimeout(() => location.reload(), 10000);
    } else {
      alert('⚠ Obnova selhala: ' + (r.error || 'neznámá chyba'));
      rb.disabled = false;
      rb.textContent = orig;
    }
  } catch (err) {
    alert('⚠ Chyba: ' + err.message);
    rb.disabled = false;
    rb.textContent = orig;
  }
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
      `&group=${encodeURIComponent($('#mGroup').value.trim())}` +
      `&release=${encodeURIComponent($('#mRelease').value.trim())}`;
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
        const found = r.found || 0;
        const added = r.added || 0;
        const blocked = r.blocked || 0;
        const skipped = found - added - blocked; // už v DB (duplicity)
        const title = r.title || 'anime';

        if (found === 0) {
          msg.textContent = `✅ ${title} — hiyori nemá žádné titulky.`;
        } else if (added === 0 && skipped > 0) {
          // vše, co hiyori nabízí, už máme
          msg.textContent = `ℹ️ ${title} — nic nového, všech ${skipped} titulků už v databázi máme.`;
        } else {
          const dl = r.download_enabled ? 'zařazeno do fronty' : 'evidováno (stahování vypnuté)';
          let t = `✅ ${title} — nalezeno ${found}, nových ${added} (${dl})`;
          if (skipped > 0) t += `, ${skipped} už jsme měli`;
          if (blocked > 0) t += `, ${blocked} blokováno`;
          msg.textContent = t + '.';
        }
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
// modal pro editaci metadat (jeden formulář: Fansub, Release, Jazyk)
function openEditModal(ed) {
  const id = ed.dataset.id;
  // odstraň případný předchozí
  document.getElementById('editModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'editModal';
  overlay.className = 'edit-modal-overlay';
  overlay.innerHTML = `
    <div class="edit-modal">
      <h3>Upravit titulek</h3>
      <label>Fansub (skupina)
        <input type="text" id="edit-group" value="${esc(ed.dataset.group || '')}" placeholder="např. HorribelSubs" />
      </label>
      <label>Release
        <input type="text" id="edit-release" value="${esc(ed.dataset.release || '')}" placeholder="např. SubsPlease, Bluray" />
      </label>
      <label>Jazyk
        <input type="text" id="edit-lang" value="${esc(ed.dataset.lang || '')}" placeholder="CZ / SK" maxlength="4" />
      </label>
      <div class="edit-modal-actions">
        <button type="button" class="btn-secondary" id="edit-cancel">Zrušit</button>
        <button type="button" id="edit-save">Uložit</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  document.getElementById('edit-cancel').addEventListener('click', close);
  document.getElementById('edit-group').focus();

  document.getElementById('edit-save').addEventListener('click', async () => {
    const saveBtn = document.getElementById('edit-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Ukládám…';
    try {
      const r = await (await fetch(`/api/sub/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_name: document.getElementById('edit-group').value.trim(),
          release: document.getElementById('edit-release').value.trim(),
          lang: document.getElementById('edit-lang').value.trim().toUpperCase(),
        }),
      })).json();
      if (r.ok) { close(); loadSubs(); }
      else {
        alert('Úprava selhala: ' + (r.error || 'neznámá chyba'));
        saveBtn.disabled = false; saveBtn.textContent = 'Uložit';
      }
    } catch (err) {
      alert('Chyba: ' + err.message);
      saveBtn.disabled = false; saveBtn.textContent = 'Uložit';
    }
  });
}

// ── Přečas na BD: okno s volbou auto / ruční reference ──────────────────
function bdEndpoints(id, source) {
  const base = source === 'akihabara' ? `/api/akihabara/${id}` : `/api/sub/${id}`;
  return { auto: `${base}/bd-resync`, manual: `${base}/bd-resync-manual` };
}
function bdRefresh(source) {
  if (source === 'akihabara') { for (const id of akiExpanded) loadAkiDetail(id); }
  else { loadSubs(); loadOverview(); }
}
function bdReport(r) {
  if (r && r.ok) {
    alert('✔ Přečas hotový (' + (r.kind || '🤖 BD') + ')\n' +
      (r.release ? `Release: ${r.release}\n` : '') +
      `Díl ${r.episode ?? '—'} · formát ${r.format} · ${r.elapsed_ms} ms`);
    return true;
  }
  alert('✘ Přečas se nepovedl: ' + ((r && r.error) || 'neznámá chyba'));
  return false;
}
// ── Hromadný přečas celého anime (synchronně, s průběhem) ──────────────────
async function runBulkBd(targetsUrl, source) {
  const overlay = document.createElement('div');
  overlay.className = 'edit-modal-overlay';
  overlay.innerHTML = `
    <div class="edit-modal bd-modal">
      <h3>Přečas celého anime (🤖 auto)</h3>
      <p class="bd-modal-hint">Přečasuju všechny stažené díly bez strojové verze, jeden po druhém. Zavřením okno přerušíš.</p>
      <div class="bd-modal-status" id="bulk-status">Zjišťuji díly k přečasu…</div>
      <div class="edit-modal-actions">
        <button type="button" class="btn-secondary" id="bulk-close">Přerušit</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const status = overlay.querySelector('#bulk-status');
  let cancelled = false;
  const close = () => { cancelled = true; overlay.remove(); };
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  overlay.querySelector('#bulk-close').addEventListener('click', close);

  let data;
  try { data = await (await fetch(targetsUrl)).json(); }
  catch (e) { if (overlay.isConnected) status.textContent = 'Chyba: ' + e.message; return; }
  const targets = (data && data.targets) || [];
  if (!targets.length) {
    if (overlay.isConnected) status.textContent = 'Žádné díly k přečasu (vše hotové nebo nic staženého).';
    return;
  }

  let ok = 0;
  const skipped = [];
  for (let i = 0; i < targets.length; i++) {
    if (cancelled) break;
    const t = targets[i];
    if (overlay.isConnected)
      status.textContent = `Přečasovávám ${i + 1}/${targets.length} (díl ${t.episode ?? '—'})… hotovo ${ok}, přeskočeno ${skipped.length}`;
    const base = source === 'akihabara' ? `/api/akihabara/${t.sub_id}` : `/api/sub/${t.sub_id}`;
    try {
      const r = await (await fetch(`${base}/bd-resync`, { method: 'POST' })).json();
      if (r && r.ok) ok++; else skipped.push(t.episode ?? t.sub_id);
    } catch { skipped.push(t.episode ?? t.sub_id); }
    await new Promise((r) => setTimeout(r, 400)); // pauza mezi díly (Tosho/subsync)
  }
  bdRefresh(source);
  if (overlay.isConnected) {
    status.textContent =
      `✔ Hotovo ${ok} · přeskočeno ${skipped.length}` +
      (skipped.length ? ` (díly ${skipped.join(', ')} — auto nenašlo, dober ručně)` : '') +
      (cancelled ? ' · PŘERUŠENO' : '');
    overlay.querySelector('#bulk-close').textContent = 'Zavřít';
  }
}

function openBdModal(id, source) {
  const ep = bdEndpoints(id, source);
  const overlay = document.createElement('div');
  overlay.className = 'edit-modal-overlay';
  overlay.innerHTML = `
    <div class="edit-modal bd-modal">
      <h3>Přečas na BD (BD auto)</h3>
      <p class="bd-modal-hint">Automaticky najde referenci na Anime Tosho (BD, jinak DVD), nebo nahraj vlastní referenci (.ass/.srt).</p>
      <div class="bd-modal-status" id="bd-status"></div>
      <div class="edit-modal-actions">
        <button type="button" class="btn-secondary" id="bd-cancel">Zavřít</button>
        <button type="button" id="bd-manual">Nahrát ručně</button>
        <button type="button" id="bd-bulk">Celé anime (auto)</button>
        <button type="button" id="bd-auto">Automaticky (Tosho)</button>
      </div>
      <input type="file" id="bd-file" accept=".ass,.srt,.ssa,.xz" hidden />
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  const status = overlay.querySelector('#bd-status');
  const setBusy = (msg) => {
    status.textContent = msg;
    overlay.querySelectorAll('button').forEach((b) => (b.disabled = true));
  };
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  overlay.querySelector('#bd-cancel').addEventListener('click', close);

  overlay.querySelector('#bd-auto').addEventListener('click', async () => {
    setBusy('Hledám BD na Toshu a přečasovávám… (může to chvíli trvat)');
    try {
      const r = await (await fetch(ep.auto, { method: 'POST' })).json();
      close();
      if (bdReport(r)) bdRefresh(source);
    } catch (err) { close(); alert('Chyba: ' + err.message); }
  });

  overlay.querySelector('#bd-bulk').addEventListener('click', () => {
    const targetsUrl = source === 'akihabara'
      ? `/api/akihabara/${id}/bulk-bd-targets`
      : `/api/sub/${id}/bulk-bd-targets`;
    close();
    runBulkBd(targetsUrl, source);
  });

  overlay.querySelector('#bd-manual').addEventListener('click', () => {
    overlay.querySelector('#bd-file').click();
  });
  overlay.querySelector('#bd-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    setBusy('Přečasovávám podle nahrané reference…');
    try {
      const buf = await file.arrayBuffer();
      const url = `${ep.manual}?filename=${encodeURIComponent(file.name)}`;
      const r = await (await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      })).json();
      close();
      if (bdReport(r)) bdRefresh(source);
    } catch (err) { close(); alert('Chyba: ' + err.message); }
  });
}

$('#subsTable').addEventListener('click', async (e) => {
  // editace metadat — tužka → modal
  const ed = e.target.closest('button.edit-sub');
  if (ed) { openEditModal(ed); return; }

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

  // smazání jen z evidence (řádky bez souboru na R2 — např. „čeká na parser")
  const dbBtn = e.target.closest('button.del-db');
  if (dbBtn) {
    const id = dbBtn.dataset.id;
    if (!confirm('Smazat záznam z evidence?\n\n(Žádný soubor na R2 není — smaže se jen z DB.)')) return;
    dbBtn.disabled = true;
    try {
      const r = await (await fetch(`/api/sub/${id}`, { method: 'DELETE' })).json();
      if (r.error) {
        alert('Nešlo smazat: ' + r.error);
        dbBtn.disabled = false;
      } else {
        loadSubs();
        loadOverview();
      }
    } catch (err) {
      alert('Chyba: ' + err.message);
      dbBtn.disabled = false;
    }
    return;
  }

  // vrácení mezi nestažené (smaže soubor z R2, záznam zůstane)
  const rsBtn = e.target.closest('button.reset-sub');
  if (rsBtn) {
    const id = rsBtn.dataset.id;
    if (!confirm('Smazat soubor z R2 a vrátit záznam mezi nestažené?\n\nZáznam v DB zůstane, půjde k němu nahrát správný titulek přes 📤.')) return;
    rsBtn.disabled = true;
    try {
      const r = await (await fetch(`/api/sub/${id}/reset`, { method: 'POST' })).json();
      if (r.error) {
        alert('Nešlo vrátit: ' + r.error);
        rsBtn.disabled = false;
      } else {
        loadSubs();
        loadOverview();
      }
    } catch (err) {
      alert('Chyba: ' + err.message);
      rsBtn.disabled = false;
    }
    return;
  }

  // rozbalit / schovat strojovou verzi (BD auto)
  const mt = e.target.closest('button.machine-toggle');
  if (mt) {
    const id = mt.dataset.id;
    const row = document.querySelector(`tr.machine-row[data-for="${id}"]`);
    if (row) {
      const show = row.hasAttribute('hidden');
      if (show) row.removeAttribute('hidden'); else row.setAttribute('hidden', '');
      mt.textContent = show ? 'přečas ▾' : 'přečas ▸';
    }
    return;
  }

  // přečas na BD — otevři okno s volbou auto / ruční reference
  const bd = e.target.closest('button.bd-resync');
  if (bd) {
    openBdModal(bd.dataset.id, bd.dataset.source || 'hiyori');
    return;
  }
});

// Požadavky na přidání — Přidat / Zamítnout
const requestsTable = document.getElementById('requestsTable');
if (requestsTable) {
  requestsTable.addEventListener('click', async (e) => {
    const ap = e.target.closest('button.req-approve');
    if (ap) {
      const id = ap.dataset.id;
      if (!confirm('Přidat anime a stáhnout všechny díly?')) return;
      ap.disabled = true;
      ap.textContent = '⏳ Přidávám…';
      try {
        const r = await (await fetch(`/api/requests/${id}/approve`, { method: 'POST' })).json();
        if (r.error) { alert('Chyba: ' + r.error); ap.disabled = false; ap.textContent = '✓ Přidat'; }
        else { loadRequests(); loadSubs(); loadOverview(); }
      } catch (err) {
        alert('Chyba: ' + err.message); ap.disabled = false; ap.textContent = '✓ Přidat';
      }
      return;
    }
    const rj = e.target.closest('button.req-reject');
    if (rj) {
      const id = rj.dataset.id;
      if (!confirm('Zamítnout tento požadavek?')) return;
      rj.disabled = true;
      try {
        const r = await (await fetch(`/api/requests/${id}/reject`, { method: 'POST' })).json();
        if (r.error) { alert('Chyba: ' + r.error); rj.disabled = false; }
        else { loadRequests(); }
      } catch (err) {
        alert('Chyba: ' + err.message); rj.disabled = false;
      }
      return;
    }
  });
}

// ==================================================================
// AKIHABARA ARCHIV (read-only sekce)
// ==================================================================
let akiPage = 1;
let akiQuery = '';
const akiExpanded = new Set(); // anilist_id rozbalených řádků

async function loadAkihabara() {
  try {
    // souhrn do hlavičky (jen jednou stačí, ale levné)
    const st = await (await fetch('/api/akihabara/stats')).json();
    if (st.enabled) {
      $('#akiCount').textContent = `(${st.subs} titulků / ${st.anime} anime, jen ke čtení)`;
    } else {
      $('#akiCount').textContent = '(archiv nedostupný)';
    }

    const url = `/api/akihabara/list?page=${akiPage}` + (akiQuery ? `&q=${encodeURIComponent(akiQuery)}` : '');
    const d = await (await fetch(url)).json();
    renderAkihabara(d.anime || []);

    const from = d.total === 0 ? 0 : (d.page - 1) * d.per_page + 1;
    const to = Math.min(d.page * d.per_page, d.total);
    $('#akiPageInfo').textContent = `${from}–${to} z ${d.total}`;
    $('#akiPrevBtn').disabled = d.page <= 1;
    $('#akiNextBtn').disabled = d.page >= d.pages;
  } catch (e) {
    $('#akiTable tbody').innerHTML = '<tr><td colspan="5" class="muted">Archiv nedostupný.</td></tr>';
  }
}

function renderAkihabara(anime) {
  $('#akiTable tbody').innerHTML = anime.map((a) => {
    const isOpen = akiExpanded.has(a.anilist_id);
    const arrow = isOpen ? '▼' : '▶';
    const langs = a.langs.join(', ');
    const groups = a.groups.join(', ');
    const mainRow =
      `<tr class="aki-anime" data-id="${a.anilist_id}">` +
      `<td class="aki-arrow">${arrow}</td>` +
      `<td>${esc(a.anime_title)}</td>` +
      `<td>${a.episodes_count}</td>` +
      `<td>${esc(langs)}</td>` +
      `<td class="aki-groups">${esc(groups)}</td>` +
      `</tr>`;
    // rozbalený detail (díly) — placeholder, naplní se async po kliknutí
    const detailRow = isOpen
      ? `<tr class="aki-detail" data-id="${a.anilist_id}"><td></td><td colspan="4" class="aki-detail-cell">Načítám…</td></tr>`
      : '';
    return mainRow + detailRow;
  }).join('');

  // dopočítej detaily rozbalených řádků
  for (const id of akiExpanded) {
    if (anime.some((a) => a.anilist_id === id)) loadAkiDetail(id);
  }
}

async function loadAkiDetail(anilistId) {
  const cell = document.querySelector(`tr.aki-detail[data-id="${anilistId}"] .aki-detail-cell`);
  if (!cell) return;
  try {
    const d = await (await fetch(`/api/akihabara/detail?anilist=${anilistId}`)).json();
    if (!d.episodes || !d.episodes.length) {
      cell.innerHTML = '<span class="muted">Žádné díly.</span>';
      return;
    }
    cell.innerHTML =
      `<div class="aki-bulk-bar"><button class="aki-bulk-bd" data-anilist="${anilistId}">⏱ Přečasovat vše (auto)</button></div>` +
      '<div class="aki-eps">' +
      d.episodes.map((ep) => {
        const variants = ep.subs.map((s) => {
          const g = s.group ? ` [${esc(s.group)}]` : '';
          const r = s.release ? ` · ${esc(s.release)}` : '';
          const bd = s.id ? ` <button class="bd-resync" data-id="${s.id}" data-source="akihabara" title="Přečasovat na BD (BD auto)">⏱</button>` : '';
          const m = s.machine ? ` <a class="machine-dl" href="/api/file/${s.machine.sub_id}" title="${esc(s.machine.release || '🤖 BD')}${s.machine.version ? ' · ' + esc(s.machine.version) : ''}">přečas ⬇</a>` : '';
          return `${esc(s.lang)}${g}${r}${bd}${m}`;
        }).join(' · ');
        const epLabel = ep.episode != null ? `Díl ${ep.episode}` : 'Film';
        return `<div class="aki-ep"><b>${esc(epLabel)}:</b> ${variants}</div>`;
      }).join('') +
      '</div>';
  } catch {
    cell.innerHTML = '<span class="muted">Chyba načtení dílů.</span>';
  }
}

// klik na řádek anime → rozbalit/sbalit
$('#akiTable').addEventListener('click', (e) => {
  const bulk = e.target.closest('button.aki-bulk-bd');
  if (bulk) { runBulkBd(`/api/akihabara/anime/${bulk.dataset.anilist}/bulk-bd-targets`, 'akihabara'); return; }
  const bd = e.target.closest('button.bd-resync');
  if (bd) { openBdModal(bd.dataset.id, 'akihabara'); return; }
  const row = e.target.closest('tr.aki-anime');
  if (!row) return;
  const id = Number(row.dataset.id);
  if (akiExpanded.has(id)) akiExpanded.delete(id);
  else akiExpanded.add(id);
  loadAkihabara();
});

// hledání v archivu (debounce)
let akiSearchTimer;
$('#akiSearch').addEventListener('input', (e) => {
  clearTimeout(akiSearchTimer);
  akiSearchTimer = setTimeout(() => {
    akiQuery = e.target.value.trim();
    akiPage = 1;
    akiExpanded.clear();
    loadAkihabara();
  }, 300);
});

$('#akiPrevBtn').addEventListener('click', () => { if (akiPage > 1) { akiPage--; akiExpanded.clear(); loadAkihabara(); } });
$('#akiNextBtn').addEventListener('click', () => { akiPage++; akiExpanded.clear(); loadAkihabara(); });

loadRole().then(load);
loadAkihabara();
setInterval(loadOverview, 5000); // auto-refresh jen souhrn (netrhá stránkování/hledání)
