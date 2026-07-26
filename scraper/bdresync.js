// scraper/bdresync.js — „přečas na BD" (BD auto).
// Řetěz (AUTO): původní CZ titulek → anidb_id (z archivu přímo, jinak indexer)
// → Anime Tosho → BD release se softsuby → EN dialogová stopa (reference) →
// subsync (alass) → strojová verze (group „BD auto", svázaná machine_of) na R2+DB.
// RUČNÍ: reference nedáváme z Toshu, ale nahranou uživatelem; zbytek stejný.
//
// Zdroj (source): 'hiyori' = hlavní tabulka, 'akihabara' = archiv (jiné ID pásmo).
import https from 'node:https';
import zlib from 'node:zlib';
import { CONFIG } from '../config.js';
import { r2Enabled, r2Put, r2Get, r2PublicUrl } from '../r2.js';
import { saveMachineSub, machineIdFor } from '../db.js';

// ── Indexer (self-signed cert → jen na tenhle host vypneme verifikaci) ──────
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function indexerRequest(pathAndQuery, { method = 'GET', body = null, token = null } = {}) {
  const url = new URL(CONFIG.indexer.url + pathAndQuery);
  const payload = body ? JSON.stringify(body) : null;
  const headers = { Accept: 'application/json' };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method, headers, agent: insecureAgent, timeout: 20000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, json, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('indexer timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

// token cache (24h TTL; při restartu indexeru umře → relogin na 401)
let _tok = null;
let _tokExp = 0;
async function indexerToken() {
  if (!CONFIG.indexer.user || !CONFIG.indexer.pass) return null; // veřejné endpointy
  if (_tok && Date.now() < _tokExp) return _tok;
  const r = await indexerRequest('/api/login', {
    method: 'POST',
    body: { username: CONFIG.indexer.user, password: CONFIG.indexer.pass },
  });
  const t = r.json && (r.json.token || r.json.access_token || r.json.jwt);
  if (!t) throw new Error(`indexer login selhal (HTTP ${r.status}): ${r.raw.slice(0, 200)}`);
  _tok = t;
  _tokExp = Date.now() + 23 * 60 * 60 * 1000;
  return _tok;
}

// rekurzivně najdi anidb ID v libovolném tvaru odpovědi
function deepFindAnidb(obj, depth = 0) {
  if (obj == null || depth > 6) return null;
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = deepFindAnidb(v, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (/^anidb(_?id)?$/i.test(k) || /anidbId/i.test(k)) {
        const n = Number(typeof v === 'object' && v ? (v.id ?? v.value) : v);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    for (const v of Object.values(obj)) { const r = deepFindAnidb(v, depth + 1); if (r) return r; }
  }
  return null;
}

async function resolveAnidbId(sub) {
  // Archivní záznamy (akihabara.db) mají anidb_id rovnou z importu → indexer se
  // přeskočí, když je vyplněné.
  if (sub.anidb_id && Number(sub.anidb_id) > 0) return Number(sub.anidb_id);

  const token = await indexerToken().catch(() => null);
  const tries = [];
  if (sub.anilist_id) tries.push(`/api/resolve-ids?anilist=${sub.anilist_id}`);
  if (sub.mal_id) tries.push(`/api/resolve-ids?mal=${sub.mal_id}`);
  if (!tries.length) throw new Error('Záznam nemá anilist ani mal ID.');

  let lastRaw = '';
  for (const p of tries) {
    const r = await indexerRequest(p, { token });
    lastRaw = `HTTP ${r.status}: ${r.raw.slice(0, 200)}`;
    if (r.status === 401 && token) {
      _tok = null; // vynutit relogin a zkusit znovu
      const t2 = await indexerToken().catch(() => null);
      const r2 = await indexerRequest(p, { token: t2 });
      const a2 = deepFindAnidb(r2.json);
      if (a2) return a2;
      lastRaw = `HTTP ${r2.status}: ${r2.raw.slice(0, 200)}`;
      continue;
    }
    const a = deepFindAnidb(r.json);
    if (a) return a;
  }
  throw new Error(`Indexer nevrátil anidb_id (${lastRaw}).`);
}

// ── Anime Tosho ─────────────────────────────────────────────────────────────
async function toshoJson(qs) {
  const res = await fetch(`${CONFIG.tosho.feed}/json?${qs}`, {
    headers: { 'User-Agent': 'NimeToDex-BDResync/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Tosho HTTP ${res.status}`);
  return res.json();
}

const BD_RE = /\b(bd|bdrip|blu-?ray)\b/i;
function groupFromTitle(title) {
  const m = (title || '').match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

// číslo dílu z názvu souboru/releasu (opatrně — radši null než špatně)
function episodeFromName(name) {
  const s = name || '';
  const pats = [
    /\s-\s(\d{1,3})(?:v\d)?\s(?:-|\[|\()/, //  " - 01 - " / " - 01 [" / " - 01 ("
    /\bS\d{1,2}E(\d{1,3})\b/i, //  S01E01
    /\bEP?\.?\s?(\d{1,3})\b/i, //  E01 / EP01 / EP 1
    /\s(\d{1,3})(?:v\d)?\s(?:-|\[|\()/, //  " 01 [" / " 01 ("
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

// z titulkových příloh vyber PLNOU DIALOGOVOU stopu (ne Signs/Songs; NE podle
// jazyka — plná stopa bývá tagovaná i jako 'jpn'). Radši null než hádat.
function pickDialogue(atts) {
  const subs = (atts || []).filter((a) => a.type === 'subtitle');
  if (!subs.length) return null;
  const nameOf = (a) => (a.info?.name || '').toLowerCase();
  const isSigns = (a) => /sign|song/.test(nameOf(a));
  const isFull = (a) => /full|dialog/.test(nameOf(a));
  return (
    subs.find((a) => isFull(a) && !isSigns(a)) ||
    subs.find((a) => !isSigns(a) && nameOf(a)) ||
    (subs.length === 1 ? subs[0] : null)
  );
}

async function pickReference(releases, episode) {
  const rank = (g) => {
    const i = CONFIG.bdGroupRanking.findIndex(
      (x) => x.toLowerCase() === (g || '').toLowerCase()
    );
    return i === -1 ? 999 : i;
  };
  const sorted = [...releases].sort((a, b) => rank(a.group) - rank(b.group));

  const probed = sorted.slice(0, 8); // strop na hammrování Tosho
  for (const rel of probed) {
    let data;
    try { data = await toshoJson(`show=torrent&id=${rel.id}`); } catch { continue; }
    const files = Array.isArray(data) ? data : data.files || [];
    for (const f of files) {
      let ep = episodeFromName(f.filename);
      if (ep == null && files.length === 1) ep = episodeFromName(rel.title);
      if (ep !== episode) continue;
      const att = pickDialogue(f.attachments);
      if (att) return { attachId: att.id, releaseTitle: rel.title, group: rel.group };
    }
  }
  return null;
}

async function downloadAttachXz(attachId) {
  const hex = Number(attachId).toString(16).padStart(8, '0');
  const url = `${CONFIG.tosho.storage}/storage/attach/${hex}/${attachId}.xz`;
  const res = await fetch(url, {
    redirect: 'follow', // storage/attach dělá redirect — fetch ho následuje sám
    headers: { 'User-Agent': 'NimeToDex-BDResync/1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Tosho attach HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer()); // syrové .xz (rozbalí subsync)
}

// ── subsync (alass přečas přes interní HTTP službu) ─────────────────────────
// reference smí být .xz (Tosho) i plain .ass/.srt (ruční) — wrapper si .xz
// rozbalí sám podle magic bajtů.
async function callSubsync(refBuf, refName, czBuf, czName) {
  const fd = new FormData();
  fd.append('reference', new Blob([refBuf]), refName || 'ref.xz');
  fd.append('subtitle', new Blob([czBuf]), czName || 'sub.ass');
  fd.append('tool', 'alass');
  const res = await fetch(`${CONFIG.subsync.url}/sync`, {
    method: 'POST',
    body: fd,
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`subsync vrátil neplatnou odpověď (HTTP ${res.status})`);
  return json;
}

// ── uložení strojové verze ──────────────────────────────────────────────────
function baseNameOf(sub) {
  return (sub.filename || `sub-${sub.sub_id}.ass`)
    .replace(/\.gz$/i, '')
    .replace(/^\d+__/, ''); // odsekni prefix ID z původního jména
}

async function saveMachine(sub, outputText, releaseTitle, source) {
  if (!r2Enabled()) throw new Error('R2 není nastaveno — strojovou verzi není kam uložit.');
  const machineId = machineIdFor(sub.sub_id, source);
  const outBuf = Buffer.from(outputText, 'utf8');
  const gz = zlib.gzipSync(outBuf);

  const epKey = sub.episode != null ? `E${sub.episode}` : 'E_';
  const animeSeg = sub.anilist_id
    ? `al/${sub.anilist_id}`
    : sub.mal_id
    ? `mal/${sub.mal_id}`
    : `x/${sub.sub_id}`;
  const outName = `${machineId}__${baseNameOf(sub)}`;
  const r2_key = `machine/${animeSeg}/${epKey}/${outName}.gz`;

  await r2Put(r2_key, gz, 'application/gzip');
  saveMachineSub({
    sub_id: machineId,
    hiyori_id: sub.hiyori_id ?? null,
    anilist_id: sub.anilist_id ?? null,
    mal_id: sub.mal_id ?? null,
    anime_title: sub.anime_title ?? null,
    episode: sub.episode ?? null,
    lang: sub.lang ?? null,
    release: releaseTitle,
    filename: outName,
    file_bytes: outBuf.length,
    r2_key,
    machine_of: sub.sub_id,
    machine_source: source,
  });
  return { machineId, r2_key, r2_url: r2PublicUrl(r2_key), bytes: outBuf.length };
}

// společný konec: stáhni CZ z R2 → subsync → ulož strojovou verzi
async function resyncAndSave(sub, refBuf, refName, releaseTitle, source) {
  const czRaw = await r2Get(sub.r2_key);
  if (!czRaw || !czRaw.length) {
    return { ok: false, stage: 'cz', error: 'CZ titulek se nepodařilo stáhnout z R2.' };
  }
  // Soubor na R2 může být gzip (hiyori + většina archivu) i plain .ass/.srt
  // (část archivu se ukládala nezabalená). Rozbal jen když je to fakticky gzip.
  let czBuf = czRaw;
  if (czRaw[0] === 0x1f && czRaw[1] === 0x8b) {
    try { czBuf = zlib.gunzipSync(czRaw); } catch { czBuf = czRaw; }
  }
  const czName = baseNameOf(sub);

  const sync = await callSubsync(refBuf, refName, czBuf, czName);
  if (!sync.ok || !sync.output) {
    return { ok: false, stage: 'subsync', error: sync.message || 'Přečas selhal.', detail: sync };
  }
  const saved = await saveMachine(sub, sync.output, releaseTitle, source);
  return {
    ok: true,
    release: releaseTitle,
    episode: sub.episode,
    format: sync.format,
    elapsed_ms: sync.elapsed_ms,
    machine_sub_id: saved.machineId,
    file_bytes: saved.bytes,
  };
}

// ── orchestrátor: AUTO (reference z Toshu) ──────────────────────────────────
export async function bdResync(sub, source = 'hiyori') {
  if (sub.episode == null) {
    return { ok: false, stage: 'input', error: 'Auto přečas potřebuje číslo dílu (u filmu použij ruční referenci).' };
  }
  // 1) anidb ID
  const anidb = await resolveAnidbId(sub);

  // 2) BD releasy na Toshu
  const feed = await toshoJson(`aid=${anidb}`);
  const arr = Array.isArray(feed) ? feed : [];
  const releases = arr
    .filter((x) => x.status === 'complete' && BD_RE.test(x.title || ''))
    .map((x) => ({ id: x.id, title: x.title, group: groupFromTitle(x.title), num_files: x.num_files }));
  if (!releases.length) return { ok: false, stage: 'tosho', anidb, error: 'Na Toshu není BD release.' };

  // 3) reference = plná dialogová stopa daného dílu
  const ref = await pickReference(releases, sub.episode);
  if (!ref) {
    return { ok: false, stage: 'reference', anidb, bd_releases: releases.length,
      error: `V BD releasech nenalezena dialogová stopa pro díl ${sub.episode}.` };
  }

  // 4) stáhni EN referenci (.xz) → 5+6) přečas + uložení
  const refXz = await downloadAttachXz(ref.attachId);
  const r = await resyncAndSave(sub, refXz, 'ref.xz', ref.releaseTitle, source);
  if (r.ok) { r.anidb = anidb; r.group = ref.group; }
  return r;
}

// ── orchestrátor: RUČNÍ (reference nahraná uživatelem) ──────────────────────
export async function bdResyncManual(sub, refBuf, refName, source = 'hiyori') {
  if (!refBuf || !refBuf.length) return { ok: false, stage: 'input', error: 'Prázdná reference.' };
  // reference posíláme pod jejím jménem; .xz i plain .ass/.srt zvládne wrapper
  return resyncAndSave(sub, refBuf, refName || 'ref.ass', `ruční reference: ${refName || '?'}`, source);
}
