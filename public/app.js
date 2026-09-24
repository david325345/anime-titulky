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
// datum nad časem (jen do tabulky titulků — šetří šířku)
function fmtDateStacked(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  const den = d.toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit' });
  const cas = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  return `${den}<br><span class="cas">${cas}</span>`;
}
function dur(a, b) {
  if (!a || !b) return '—';
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Kvalita titulku (na jaký zdroj je načasovaný). 🔒 = ručně nastavená (automat ji nepřepíše).
function qualityCell(s) {
  if (!s.quality) return '<span class="muted">—</span>';
  const cls = s.quality === 'BD' ? 'q-bd' : s.quality === 'DVD' ? 'q-dvd' : 'q-web';
  const lock = s.quality_locked ? ' 🔒' : '';
  return `<span class="pill ${cls}" title="${s.quality_locked ? 'Nastaveno ručně' : 'Určeno automaticky z release'}">${esc(s.quality)}${lock}</span>`;
}

function statusCell(sub) {
  const label = { downloaded: 'staženo', new: 'čeká', not_downloaded: 'evidováno', pending_extern: 'čeká na parser', failed: 'chyba' }[sub.status] || sub.status;
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
      : `<span class="pill src-extern" title="${esc(s.extern_domain || 'extern')}">${esc(s.extern_domain || 'extern')}</span>`;
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
      ? `<button class="upload-sub" data-id="${s.sub_id}" title="Nahrát titulek ručně (.ass/.srt/.zip)">📤</button>` +
        `<button class="bulk-upload" data-hiyori="${s.hiyori_id || ''}" data-anilist="${s.anilist_id || ''}" data-id="${s.sub_id}" title="Hromadně nahrát balík titulků — díly se rozpoznají z názvů souborů">📦</button>`
      : '';
    // stáhnout právě tenhle záznam teď (jen u nestažených, ne u ručních — ty čekají na 📤)
    const dlNowBtn = (s.status !== 'downloaded' && s.kind !== 'manual')
      ? `<button class="dl-one" data-id="${s.sub_id}" title="Stáhnout tento titulek teď">⬇</button>`
      : '';
    const onR2 = s.r2_key
      ? `<span class="pill r2-yes" title="${esc(s.r2_key)}">✓</span>`
      : ''; // nestažené: stav to říká sám, „—" jen zbytečně zalamovalo buňku
    return `<tr>
      <td class="muted nowrap kdy">${fmtDateStacked(s.first_seen)}</td>
      <td class="anime">${anime}</td>
      <td class="nowrap">${s.episode ?? '—'}</td>
      <td class="nowrap">${lang}</td>
      <td class="grprel"><div class="g">${esc(s.group_name || '')}</div>${s.release ? `<div class="r">${esc(s.release)}</div>` : ''}</td>
      <td class="srcq"><div>${src}</div><div>${qualityCell(s)}</div></td>
      <td class="stav"><div class="nowrap">${statusCell(s)} ${onR2}</div>${dl ? `<div class="odkaz">${dl}</div>` : ''}</td>
      <td class="actions"><div class="act">${(s.status === 'downloaded' && s.r2_key) ? `<button class="bd-resync" data-id="${s.sub_id}" data-source="hiyori" title="Přečasovat na BD časování (BD auto)">⏱</button>` : ''}${s.machine ? `<button class="machine-toggle" data-id="${s.sub_id}" title="Zobrazit strojovou verzi (BD auto)">přečas ▸</button>` : ''}${dlNowBtn}${uploadBtn}${canDelete ? `<button class="edit-sub" data-id="${s.sub_id}" data-group="${esc(s.group_name || '')}" data-release="${esc(s.release || '')}" data-lang="${esc(s.lang || '')}" data-quality="${esc(s.quality || '')}" title="Upravit fansub / release / jazyk / kvalitu">✏️</button>` : ''}${(canDelete && s.r2_key) ? `<button class="del-r2" data-id="${s.sub_id}" title="Smazat úplně (DB i soubor na R2)">🗑</button>` : ''}${(canDelete && !s.r2_key) ? `<button class="del-db" data-id="${s.sub_id}" title="Smazat z evidence (jen DB — žádný soubor na R2)">🗑</button>` : ''}${(canDelete && s.status === 'downloaded') ? `<button class="reset-sub" data-id="${s.sub_id}" title="Smazat soubor z R2 a vrátit mezi nestažené (pak jde nahrát správný přes 📤)">♻</button>` : ''}${s.unused_variants ? `<span class="unused-flag" title="Zdroj nabízel i další verzi, která se nepoužila: ${esc(s.unused_variants)} — můžeš ji doplnit ručně přes 📤">⚠️</span>` : ''}</div></td>
    </tr>${s.machine ? `<tr class="machine-row" data-for="${s.sub_id}" hidden><td></td><td colspan="7" class="machine-cell"><span class="pill machine-pill">${esc(s.machine.release || '🤖 BD')}</span>${s.machine.quality ? ` <span class="pill ${s.machine.quality === 'BD' ? 'q-bd' : s.machine.quality === 'DVD' ? 'q-dvd' : 'q-web'}">${esc(s.machine.quality)}</span>` : ''} ${s.machine.version ? esc(s.machine.version) + ' · ' : ''}${((s.machine.file_bytes || 0) / 1024).toFixed(1)} KB · <a href="/api/file/${s.machine.sub_id}">stáhnout</a>${canDelete ? ` · <button class="del-machine" data-id="${s.machine.sub_id}" title="Smazat jen tento přečas (původní titulek zůstane)">🗑 smazat přečas</button>` : ''}</td></tr>` : ''}`;
  }).join('') || `<tr><td colspan="8" class="muted">Nic nenalezeno.</td></tr>`;
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
      <label>Kvalita
        <select id="edit-quality">
          <option value="">— automaticky z release —</option>
          ${['BD', 'DVD', 'WEB-DL'].map((q) =>
            `<option value="${q}"${(ed.dataset.quality || '') === q ? ' selected' : ''}>${q}</option>`).join('')}
        </select>
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
          quality: document.getElementById('edit-quality').value,
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
    const zdroj = [r.group || null, r.seeders != null ? `${r.seeders} seedů` : null]
      .filter(Boolean).join(' · ');
    const odkud = r.ref_source === 'torbox'
      ? `vložené titulky z BD souboru (TorBox${r.ref_kb ? `, ${r.ref_kb} kB` : ''})`
      : r.ref_source === 'tosho' ? 'Anime Tosho' : null;
    alert('✔ Přečas hotový (' + (r.kind || '🤖 BD') + ')\n' +
      (r.release ? `Reference: ${r.release}\n` : '') +
      (r.ref_track ? `Stopa: ${r.ref_track}\n` : '') +
      (odkud ? `Převzato z: ${odkud}\n` : '') +
      (zdroj ? `Release: ${zdroj}\n` : '') +
      `Díl ${r.episode ?? '—'} · formát ${r.format} · ${r.elapsed_ms} ms` +
      (r.via === 'manual-pick' ? '\n\n📌 Rip je uložený jako volba pro celé anime — další díly se přečasují podle něj.' : '') +
      (r.via === 'pin' ? '\n📌 Podle ručně zvoleného ripu.' : ''));
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
      <h3>Přečas celého anime</h3>
      <p class="bd-modal-hint" id="bulk-hint">Přečasuju všechny stažené díly bez strojové verze, jeden po druhém. Zavřením okno přerušíš.</p>
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
  const bulkPin = data && data.pin;
  if (bulkPin && overlay.isConnected) {
    const redo = targets.filter((t) => t.redo).length;
    overlay.querySelector('#bulk-hint').textContent =
      `📌 Podle ručně zvoleného ripu: ${bulkPin.label || bulkPin.infohash}. Přečasuju díly bez strojové verze` +
      (redo ? ` a ${redo} díl(ů) udělaných z jiného ripu` : '') + '. Zavřením okno přerušíš.';
  }
  if (!targets.length) {
    if (overlay.isConnected) status.textContent = 'Žádný díl k přečasu — buď už strojovou verzi mají, nebo nejsou stažené.';
    return;
  }

  let ok = 0;
  const skipped = [];   // {ep, err}
  for (let i = 0; i < targets.length; i++) {
    if (cancelled) break;
    const t = targets[i];
    if (overlay.isConnected)
      status.textContent = `Přečasovávám ${i + 1}/${targets.length} (díl ${t.episode ?? '—'})… hotovo ${ok}, nepovedlo se ${skipped.length}`;
    const base = source === 'akihabara' ? `/api/akihabara/${t.sub_id}` : `/api/sub/${t.sub_id}`;
    try {
      const r = await (await fetch(`${base}/bd-resync`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })).json();
      if (r && r.ok) ok++;
      else skipped.push({ ep: t.episode ?? t.sub_id, err: (r && r.error) || 'neznámá chyba' });
    } catch (e) { skipped.push({ ep: t.episode ?? t.sub_id, err: e.message }); }
    await new Promise((r) => setTimeout(r, 400)); // pauza mezi díly (Tosho/subsync)
  }
  bdRefresh(source);
  if (overlay.isConnected) {
    // seskup díly podle skutečného důvodu, ať souhrn nelže
    const byErr = new Map();
    for (const x of skipped) {
      if (!byErr.has(x.err)) byErr.set(x.err, []);
      byErr.get(x.err).push(x.ep);
    }
    const lines = [...byErr.entries()].map(([err, eps]) => `• díly ${eps.join(', ')}: ${err}`);
    status.innerHTML =
      `${cancelled ? '⏹ Přerušeno' : '✔ Dokončeno'} — přečasováno ${ok} z ${targets.length}` +
      (skipped.length ? `, nepovedlo se ${skipped.length}:<br>` + lines.map(esc).join('<br>') : '') +
      (skipped.length && bulkPin ? '<br><br>U těchto dílů rozhodni v okně ⏱: zkusit automatiku jen pro díl, vybrat jiný rip, nahrát ručně, nebo zrušit volbu.' : '');
    overlay.querySelector('#bulk-close').textContent = 'Zavřít';
  }
}

function openBdModal(id, source) {
  const ep = bdEndpoints(id, source);
  const base = source === 'akihabara' ? `/api/akihabara/${id}` : `/api/sub/${id}`;
  const overlay = document.createElement('div');
  overlay.className = 'edit-modal-overlay';
  overlay.innerHTML = `
    <div class="edit-modal bd-modal">
      <h3>Přečas na BD</h3>
      <div class="bd-pin" id="bd-pin" style="display:none">
        <span>📌 Přečasovávám podle: <b id="bd-pin-label"></b></span>
        <button type="button" class="bd-link" id="bd-unpin">Zrušit</button>
      </div>

      <div id="bd-main">
        <p class="bd-modal-hint" id="bd-hint">Časování se vezme z vložených titulků BD/DVD releasu na TorBoxu. Rip můžeš vybrat sám, nebo ho nechat vybrat automaticky.</p>
        <div class="bd-actions">
          <button type="button" id="bd-pick">Vybrat rip…</button>
          <button type="button" id="bd-auto">Automaticky</button>
          <button type="button" id="bd-bulk">Celé anime (auto)</button>
          <button type="button" id="bd-manual">Nahrát ručně…</button>
        </div>
      </div>

      <div id="bd-decide" style="display:none">
        <div class="bd-decide-msg" id="bd-decide-msg"></div>
        <div class="bd-actions">
          <button type="button" id="bd-once">Zkusit automaticky (jen tenhle díl)</button>
          <button type="button" id="bd-pick2">Vybrat jiný rip…</button>
          <button type="button" id="bd-manual2">Nahrát ručně…</button>
          <button type="button" class="btn-secondary" id="bd-unpin2">Zrušit ruční volbu</button>
        </div>
      </div>

      <div id="bd-list" style="display:none">
        <div class="bd-list-wrap" id="bd-list-body"></div>
        <button type="button" class="bd-link bd-back" id="bd-back">← Zpět</button>
      </div>

      <div class="bd-modal-status" id="bd-status"></div>
      <button type="button" class="bd-close" id="bd-cancel">Zavřít</button>
      <input type="file" id="bd-file" accept=".ass,.srt,.ssa,.xz" style="display:none" />
    </div>`;
  document.body.appendChild(overlay);
  const $o = (sel) => overlay.querySelector(sel);
  const modal = $o('.bd-modal');
  const status = $o('#bd-status');
  let pin = null;

  const close = () => overlay.remove();
  const say = (msg) => { status.textContent = msg || ''; };
  const busy = (on, msg) => {
    if (msg !== undefined) say(msg);
    overlay.querySelectorAll('button').forEach((b) => { if (b.id !== 'bd-cancel') b.disabled = on; });
  };
  const show = (view) => {
    for (const v of ['bd-main', 'bd-decide', 'bd-list']) $o('#' + v).style.display = v === view ? '' : 'none';
    modal.classList.toggle('bd-wide', view === 'bd-list');
  };
  const renderPin = () => {
    $o('#bd-pin').style.display = pin ? '' : 'none';
    $o('#bd-pin-label').textContent = pin ? (pin.label || pin.infohash) : '';
    $o('#bd-hint').textContent = pin
      ? 'Je zvolený rip — „Automaticky" i „Celé anime" použijí jen ten. Když u některého dílu nepůjde, ukážu proč a rozhodneš sám.'
      : 'Časování se vezme z vložených titulků BD/DVD releasu na TorBoxu. Rip můžeš vybrat sám, nebo ho nechat vybrat automaticky.';
  };
  const post = async (url, body) => (await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  })).json();
  const finish = (r) => {
    if (r && r.ok) { close(); bdReport(r); bdRefresh(source); return; }
    if (r && r.stage === 'pin') {                      // ruční volba u dílu nešla → rozhodne uživatel
      $o('#bd-decide-msg').textContent = r.error;
      show('bd-decide'); busy(false, '');
      return;
    }
    close(); bdReport(r);
  };

  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  $o('#bd-cancel').addEventListener('click', close);
  fetch(`${base}/bd-pin`).then((x) => x.json()).then((d) => { pin = (d && d.pin) || null; renderPin(); }).catch(() => {});

  const unpin = async () => {
    busy(true, 'Ruším ruční volbu…');
    try { await fetch(`${base}/bd-pin`, { method: 'DELETE' }); pin = null; renderPin(); show('bd-main'); busy(false, 'Ruční volba zrušena — dál rozhoduje automatika.'); }
    catch (e) { busy(false, 'Chyba: ' + e.message); }
  };
  $o('#bd-unpin').addEventListener('click', unpin);
  $o('#bd-unpin2').addEventListener('click', unpin);

  $o('#bd-auto').addEventListener('click', async () => {
    busy(true, pin ? 'Přečasovávám podle zvoleného ripu…' : 'Hledám BD/DVD referenci (indexer → TorBox) a přečasovávám… (může to chvíli trvat)');
    try { finish(await post(ep.auto, {})); } catch (err) { close(); alert('Chyba: ' + err.message); }
  });
  $o('#bd-once').addEventListener('click', async () => {
    busy(true, 'Zkouším automatiku jen pro tenhle díl (ruční volba zůstává)…');
    try { finish(await post(ep.auto, { ignorePin: true })); } catch (err) { close(); alert('Chyba: ' + err.message); }
  });

  $o('#bd-bulk').addEventListener('click', () => {
    const targetsUrl = source === 'akihabara' ? `/api/akihabara/${id}/bulk-bd-targets` : `/api/sub/${id}/bulk-bd-targets`;
    close();
    runBulkBd(targetsUrl, source);
  });

  const pickFile = () => $o('#bd-file').click();
  $o('#bd-manual').addEventListener('click', pickFile);
  $o('#bd-manual2').addEventListener('click', pickFile);
  $o('#bd-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    busy(true, 'Přečasovávám podle nahrané reference…');
    try {
      const buf = await file.arrayBuffer();
      const r = await (await fetch(`${ep.manual}?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
      })).json();
      close();
      if (bdReport(r)) bdRefresh(source);
    } catch (err) { close(); alert('Chyba: ' + err.message); }
  });

  // ── Vybrat rip ──
  const openList = async () => {
    show('bd-list');
    const body = $o('#bd-list-body');
    body.innerHTML = '';
    busy(true, 'Načítám releasy z indexeru (čeká na aktuální seedy, ~5 s)…');
    let d;
    try { d = await (await fetch(`${base}/bd-candidates`)).json(); }
    catch (e) { busy(false, 'Chyba: ' + e.message); return; }
    busy(false, '');
    if (!d.ok) { say(d.error || 'Nepodařilo se načíst releasy.'); return; }
    if (d.pin) { pin = d.pin; renderPin(); }
    if (!d.candidates.length) {
      const st = d.stats || {};
      say(`Indexer pro díl ${d.episode} nemá žádný použitelný BD/DVD release` +
        (st.raw ? ` (releasů ${st.raw}: WEB ${st.webDropped || 0}, bez určeného zdroje ${st.noSource || 0}).` : '.'));
      return;
    }
    const rows = d.candidates.map((c, i) => `
      <tr class="${c.cached ? '' : 'bd-off'}" data-i="${i}">
        <td>${c.pinned ? '📌' : ''}</td>
        <td><b>${esc(c.group || '—')}</b></td>
        <td class="bd-name" title="${esc(c.name)}">${esc(c.name)}<div class="bd-file">díl: ${esc(c.file || '?')}</div></td>
        <td>${c.kind === '🤖 DVD' ? 'DVD' : c.remux ? 'BD Remux' : 'BD'}</td>
        <td class="num">${c.seeders}</td>
        <td>${c.cached ? '<span class="bd-tag good">v cache</span>' : '<span class="bd-tag">není v cache</span>'}
            ${c.known ? `<div><span class="bd-tag ${/nepoužitelný/.test(c.known) ? 'bad' : 'good'}">${esc(c.known)}</span></div>` : ''}</td>
        <td class="bd-row-btns">
          <button type="button" class="btn-secondary" data-act="probe" ${c.cached ? '' : 'disabled'}>Zjistit stopy</button>
          <button type="button" data-act="use" ${c.cached ? '' : 'disabled'}>Použít</button>
        </td>
      </tr>
      <tr class="bd-probe" data-probe="${i}" style="display:none"><td></td><td colspan="6"></td></tr>`).join('');
    body.innerHTML = `
      <p class="bd-modal-hint">Díl ${d.episode} — releasy seřazené jako u automatiky (BD před DVD, remux na konec, pak seedy). „Použít" přečasuje tenhle díl a rip uloží pro celé anime.</p>
      <table class="bd-table"><thead><tr><th></th><th>Skupina</th><th>Release</th><th>Zdroj</th><th>Seedy</th><th>Stav</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    // „není v cache" tlačítka nechej zakázaná i po busy(false)
    const lockOff = () => body.querySelectorAll('tr.bd-off button').forEach((b) => (b.disabled = true));
    lockOff();

    body.onclick = async (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const i = Number(btn.closest('tr').dataset.i), c = d.candidates[i];
      if (btn.dataset.act === 'probe') {
        const pr = body.querySelector(`tr[data-probe="${i}"]`), cell = pr.lastElementChild;
        pr.style.display = ''; cell.textContent = 'Zjišťuji stopy (TorBox + index souboru)…';
        busy(true); 
        try {
          const p = await post(`${base}/bd-probe`, { infohash: c.infohash });
          const tr = (p.tracks || []).map((t) => `${esc(t.codec.replace('S_TEXT/', '').replace('S_HDMV/', ''))} ${esc(t.lang || '?')} „${esc(t.name || '')}" — ${t.events} událostí`).join('<br>');
          cell.innerHTML = (p.file ? `Soubor: ${esc(p.file)}${p.kb ? ` (${p.kb} kB přečteno)` : ''}<br>` : '') +
            (tr ? `${tr}<br>` : '') +
            (p.ok ? `<b class="ok">→ použila by se: ${esc(p.pick)}</b>` : `<b class="bad">✘ ${esc(p.error || 'nepoužitelné')}</b>`);
        } catch (e) { cell.textContent = 'Chyba: ' + e.message; }
        busy(false); lockOff();
      } else {
        busy(true, `Přečasovávám díl ${d.episode} na „${c.group || c.name}"…`);
        try {
          const r = await post(ep.auto, { infohash: c.infohash });
          if (r.ok) { close(); bdReport(r); bdRefresh(source); return; }
          busy(false, '✘ ' + (r.error || 'Přečas se nepovedl.') + ' — rip se neuložil jako volba.');
          lockOff();
        } catch (e) { busy(false, 'Chyba: ' + e.message); lockOff(); }
      }
    };
  };
  $o('#bd-pick').addEventListener('click', openList);
  $o('#bd-pick2').addEventListener('click', openList);
  $o('#bd-back').addEventListener('click', () => { show('bd-main'); say(''); });
}

$('#subsTable').addEventListener('click', async (e) => {
  // editace metadat — tužka → modal
  const ed = e.target.closest('button.edit-sub');
  if (ed) { openEditModal(ed); return; }

  // ruční nahrání titulku — otevři file dialog
  // hromadné nahrání balíku titulků — díl se pozná z názvu souboru (parser indexeru)
  const bulk = e.target.closest('button.bulk-upload');
  if (bulk) {
    openBulkUpload(bulk.dataset.hiyori, bulk.dataset.anilist, bulk.dataset.id);
    return;
  }

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

  // smazat JEN přečas (strojovou verzi) — původní titulek zůstane
  const dm = e.target.closest('button.del-machine');
  if (dm) {
    const id = dm.dataset.id;
    if (!confirm('Smazat jen tento přečas (BD strojovou verzi)?\n\nPůvodní titulek zůstane. Toto je nevratné.')) return;
    dm.disabled = true;
    try {
      const r = await (await fetch(`/api/sub/${id}?r2=1`, { method: 'DELETE' })).json();
      if (r.error) { alert('Nešlo smazat přečas: ' + r.error); dm.disabled = false; }
      else { loadSubs(); loadOverview(); }
    } catch (err) {
      alert('Chyba: ' + err.message); dm.disabled = false;
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


// ==================================================================
// HROMADNÉ NAHRÁNÍ TITULKŮ (📦)
// Soubory se páruje na už založené prázdné díly: číslo dílu přečte parser
// indexeru z názvu souboru, vše ostatní (jazyk, skupina, release) zůstává
// z hiyori. Nic se nezakládá — co nemá svůj záznam, přeskočí se.
// ==================================================================
// Release se u jednoho anime často zapíše různě („Subsplease" vs „subsplease 720p"),
// takže se sady skládají podle NORMALIZOVANÉHO tvaru — bez velikosti písmen,
// kvality a technických tagů. Jinak by se jedna sada zbytečně roztrhla na dvě.
function bulkRelKey(s) {
  return String(s || '')
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\b\d{3,4}p\b/gi, ' ')
    .replace(/\b(x?26[45]|hevc|avc|10bit|8bit|web-?dl|web-?rip|web|bd-?rip|bd|blu-?ray|dvd-?rip|dvd|remux)\b/gi, ' ')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}
function bulkSetKey(r) {
  return [(r.lang || '').toUpperCase(), (r.group_name || '').trim().toLowerCase(), bulkRelKey(r.release)].join(' ¦ ');
}
// popis sady — bere se nejčastější zápis, ostatní se vypíšou jako varianty
function bulkSetPopis(rows) {
  const cetnost = (pole) => {
    const m = new Map();
    for (const v of pole) if (v) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  };
  const lang = rows[0]?.lang || '?';
  const grp = cetnost(rows.map((r) => r.group_name))[0] || '—';
  const rels = cetnost(rows.map((r) => r.release));
  return { popis: `${lang} · ${grp} · ${rels[0] || '—'}`, varianty: rels.slice(1) };
}
function bulkSetLabel(key, rows) {
  const volnych = rows.filter((r) => !r.r2_key).length;
  const { popis, varianty } = bulkSetPopis(rows);
  const navic = varianty.length ? `  [+ ${varianty.map((v) => `„${v}"`).join(', ')}]` : '';
  return `${popis}  (${rows.length} dílů, ${volnych} bez souboru)${navic}`;
}

async function openBulkUpload(hiyoriId, anilistId, subId) {
  // 1) soubory
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.ass,.srt,.ssa,.zip';
  input.style.display = 'none';
  document.body.appendChild(input);
  const files = await new Promise((resolve) => {
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
  input.remove();
  if (!files.length) return;

  // ZIP → obsah rozbalí server (prohlížeč to neumí)
  const zipFile = (files.length === 1 && /\.zip$/i.test(files[0].name)) ? files[0] : null;
  if (files.some((f) => /\.(rar|7z)$/i.test(f.name))) {
    alert('RAR/7z zatím nejde — rozbal ho a nahraj soubory nebo ZIP.');
    return;
  }
  let zipEntries = null;
  if (zipFile) {
    try {
      const r = await (await fetch('/api/bulk-zip', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: await zipFile.arrayBuffer(),
      })).json();
      if (r.error) throw new Error(r.error);
      zipEntries = r.entries || [];
    } catch (err) { alert('Archiv se nepodařilo načíst: ' + err.message); return; }
  }

  // 2) záznamy anime + rozparsované názvy
  let subs = [], parsed = [];
  try {
    const q = hiyoriId ? `hiyori_id=${hiyoriId}` : `anilist_id=${anilistId}`;
    const a = await (await fetch(`/api/subs/by-anime?${q}`)).json();
    if (a.error) throw new Error(a.error);
    subs = a.subs || [];
    const nazvy = zipEntries ? zipEntries.map((e) => e.name) : files.map((f) => f.name);
    const b = await (await fetch('/api/parse-names', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: nazvy, anilist_id: Number(anilistId) || undefined }),
    })).json();
    if (b.error) throw new Error(b.error);
    parsed = b.results || [];
  } catch (err) {
    alert('Nepodařilo se připravit náhled: ' + err.message);
    return;
  }

  // sady (jazyk · skupina · release) — do které se bude nahrávat
  const sady = new Map();
  for (const r of subs) {
    const k = bulkSetKey(r);
    if (!sady.has(k)) sady.set(k, []);
    sady.get(k).push(r);
  }
  if (!sady.size) { alert('K tomuhle anime nejsou žádné záznamy — nejdřív ho přidej přes „Ruční titulky".'); return; }

  const epByName = new Map(parsed.map((p) => [p.name, p.episode]));
  // epBase = co přečetl parser, epManual = ruční přepis (má přednost před posunem)
  const polozky = zipEntries
    ? zipEntries.map((e) => ({ name: e.name, entry: e.entry, file: null, epBase: epByName.get(e.name) ?? null, epManual: null }))
    : files.map((f) => ({ name: f.name, entry: null, file: f, epBase: epByName.get(f.name) ?? null, epManual: null }));
  let posun = 0; // srovnání číslování (např. díly 13–24 → 1–12)
  const dilPolozky = (it) => (it.epManual != null ? it.epManual : (it.epBase != null ? it.epBase + posun : null));

  // 3) okno s náhledem
  const overlay = document.createElement('div');
  overlay.className = 'edit-modal-overlay';
  overlay.innerHTML = `
    <div class="edit-modal bulk-modal">
      <h3>Hromadné nahrání — ${polozky.length} souborů${zipFile ? ' (ze ZIPu)' : ''}</h3>
      <label>Sada, do které se nahraje
        <select id="bulk-set">
          ${[...sady.entries()].map(([k, rows], i) =>
            `<option value="${i}">${esc(bulkSetLabel(k, rows))}</option>`).join('')}
        </select>
      </label>
      <div id="bulk-offset" class="bulk-offset"></div>
      <div id="bulk-preview" class="bulk-preview"></div>
      <div class="edit-modal-actions">
        <button id="bulk-cancel">Zrušit</button>
        <button id="bulk-go" class="primary">Nahrát</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const klice = [...sady.keys()];
  const sel = overlay.querySelector('#bulk-set');
  // předvybrat sadu toho řádku, u kterého se na 📦 kliklo
  const kliknuty = subs.find((r) => String(r.sub_id) === String(subId));
  if (kliknuty) {
    const i = klice.indexOf(bulkSetKey(kliknuty));
    if (i >= 0) sel.value = String(i);
  }
  const nahled = overlay.querySelector('#bulk-preview');
  const posunBox = overlay.querySelector('#bulk-offset');
  const tlacitko = overlay.querySelector('#bulk-go');

  function prepocti() {
    const rows = sady.get(klice[Number(sel.value)]) || [];
    const podleDilu = new Map(rows.map((r) => [r.episode, r]));
    // kde který díl je, kdyby v téhle sadě nebyl (ať je vidět, že jde o jinou sadu)
    const jindeDil = new Map();
    for (const [k, rs] of sady) {
      if (k === klice[Number(sel.value)]) continue;
      for (const r of rs) if (!jindeDil.has(r.episode)) jindeDil.set(r.episode, { k, r });
    }
    let pujde = 0;
    nahled.innerHTML = polozky.map((it, i) => {
      const ep = dilPolozky(it);
      const zaznam = ep != null ? podleDilu.get(ep) : null;
      let stav, cls;
      if (ep == null) { stav = 'díl nerozpoznán — doplň číslo'; cls = 'warn'; }
      else if (!zaznam) {
        const jinde = jindeDil.get(ep);
        stav = jinde
          ? `díl ${ep} je v jiné sadě: ${bulkSetPopis(sady.get(jinde.k) || []).popis}${jinde.r.r2_key ? ' (už má soubor)' : ''}`
          : `pro díl ${ep} tu není záznam — přeskočí se`;
        cls = 'warn';
      }
      else if (zaznam.r2_key) { stav = `díl ${ep} už má soubor — přeskočí se`; cls = 'skip'; }
      else { stav = `→ doplní se do dílu ${ep}`; cls = 'ok'; pujde++; }
      it.cil = (zaznam && !zaznam.r2_key) ? zaznam.sub_id : null;
      return `<div class="bulk-row ${cls}">
        <input type="number" min="1" class="bulk-ep" data-i="${i}" value="${ep ?? ''}" placeholder="?" />
        <span class="bulk-name" title="${esc(it.name)}">${esc(it.name)}</span>
        <span class="bulk-stav">${esc(stav)}</span>
      </div>`;
    }).join('');

    // Nabídka srovnání číslování — jen když se netrefí vůbec nic
    // (např. překladatel pojmenoval 2. část jako 13–24, hiyori má 1–12).
    const cisla = polozky.map(dilPolozky).filter((x) => x != null);
    const volne = rows.filter((r) => !r.r2_key).map((r) => r.episode);
    posunBox.innerHTML = '';
    if (posun !== 0) {
      posunBox.innerHTML = `<span>Číslování posunuto o ${posun > 0 ? '+' : ''}${posun}.</span>` +
        `<button id="bulk-reset-offset" class="btn-secondary">Vrátit</button>`;
      posunBox.querySelector('#bulk-reset-offset').onclick = () => { posun = 0; prepocti(); };
    } else if (!pujde && cisla.length && volne.length) {
      const min = Math.min(...cisla), minVolny = Math.min(...volne);
      const navrh = minVolny - min;
      if (navrh !== 0) {
        posunBox.innerHTML = `<span>Čísla nesedí — nejnižší je ${min}, v sadě je volný díl ${minVolny}.</span>` +
          `<button id="bulk-align">Srovnat (${min} → ${minVolny})</button>`;
        posunBox.querySelector('#bulk-align').onclick = () => { posun = navrh; prepocti(); };
      }
    }

    tlacitko.textContent = pujde ? `Nahrát ${pujde} souborů` : 'Není co nahrát';
    tlacitko.disabled = !pujde;
    nahled.querySelectorAll('.bulk-ep').forEach((inp) => {
      inp.onchange = () => {
        const v = inp.value.trim();
        polozky[Number(inp.dataset.i)].epManual = v === '' ? null : Number(v);
        prepocti();
      };
    });
  }
  sel.onchange = prepocti;
  prepocti();

  const zavri = () => overlay.remove();
  overlay.querySelector('#bulk-cancel').onclick = zavri;
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) zavri(); });

  tlacitko.onclick = async () => {
    const kNahrani = polozky.filter((it) => it.cil);
    tlacitko.disabled = true;
    sel.disabled = true;
    let hotovo = 0, chyb = 0;

    if (zipFile) {
      tlacitko.textContent = `Nahrávám ${kNahrani.length} souborů…`;
      try {
        const zip_b64 = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result).split(',')[1]);
          fr.onerror = () => reject(new Error('Nepodařilo se načíst archiv.'));
          fr.readAsDataURL(zipFile);
        });
        const map = {};
        for (const it of kNahrani) map[it.entry] = it.cil;
        const r = await (await fetch('/api/bulk-zip-commit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ zip_b64, map }),
        })).json();
        if (r.error) throw new Error(r.error);
        hotovo = r.uploaded || 0;
        chyb = (r.errors || []).length;
        (r.errors || []).forEach((x) => console.error(x.entry, x.error));
      } catch (err) { chyb = kNahrani.length; console.error(err); }
    } else {
      for (const it of kNahrani) {
        tlacitko.textContent = `Nahrávám ${hotovo + chyb + 1}/${kNahrani.length}…`;
        try {
          const buf = await it.file.arrayBuffer();
          const r = await (await fetch(
            `/api/upload-sub?sub_id=${it.cil}&filename=${encodeURIComponent(it.name)}`,
            { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf }
          )).json();
          if (r.error) { chyb++; console.error(it.name, r.error); } else hotovo++;
        } catch (err) { chyb++; console.error(it.name, err); }
      }
    }
    zavri();
    loadSubs(); loadOverview();
    if (chyb) alert(`Nahráno ${hotovo}, chyb ${chyb}. Podrobnosti v konzoli (F12).`);
  };
}
