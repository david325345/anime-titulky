// scraper/bdresync.js — „přečas na BD" (BD/DVD auto).
// Řetěz (AUTO): CZ titulek → indexer /search?anilist&episode (kandidátní BD/DVD
// releasy, sezóny/specialy řeší indexer; dvoufázově kvůli seedům; fallback feed
// ?aid=) → pro vybraný release stáhni dialogovou titulkovou stopu z Anime Tosho
// (feed ?show=torrent&id=at_id → attachment .xz) → subsync (alass) → strojová
// verze na R2+DB. Bitmapové (PGS)/neparsovatelné se přeskakují, zkouší se další.
// Strojovka: group=grupa BD ripu (čistá), release='🤖 BD'/'🤖 DVD' (robot místo
// „BD auto"), version=název souboru; svázaná machine_of.
// RUČNÍ: reference nahraná uživatelem (přeskočí indexer/Tosho), group=originál.
//
// Zdroj (source): 'hiyori' = hlavní tabulka, 'akihabara' = archiv (jiné ID pásmo).
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { CONFIG } from '../config.js';
import { r2Enabled, r2Put, r2Get, r2PublicUrl } from '../r2.js';
import { saveMachineSub, machineIdFor, getBdPref, setBdPref } from '../db.js';
import { cachedHashes, episodeLink, readTimeline, pickDialogueTrack, timelineToSrt } from './torboxref.js';

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

  // http:// (interní alias indexer:3003) i https:// (veřejná) — vyber knihovnu
  // dle protokolu; self-signed agent má smysl jen u https.
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const reqOpts = { method, headers, timeout: 20000 };
  if (isHttps) reqOpts.agent = insecureAgent;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      reqOpts,
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
const DVD_RE = /\b(dvd|dvdrip)\b/i;
function groupFromTitle(title) {
  const m = (title || '').match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

// Obsah [závorky], co je TECH SPEC (ne grupa): rozlišení/kodek/BluRay/audio…
const TECHSPEC_RE = /\b(1080p|720p|480p|540p|2160p|4k|x264|x265|hevc|avc|h\.?26[45]|blu-?ray|bdrip|\bbd\b|dvd|web-?dl|dual[- ]?audio|\baudio\b|flac|aac|opus|ac3|eac3|ddp?|10-?bit|8-?bit|hi10p?|av1|remux|hdr|ma10p|multi)\b/i;

// Grupa z názvu torrentu: první [..], co NEvypadá jako tech spec.
function groupFromName(name) {
  const brackets = (name || '').match(/\[([^\]]+)\]/g) || [];
  for (const b of brackets) {
    const inner = b.slice(1, -1).trim();
    if (inner && !TECHSPEC_RE.test(inner)) return inner;
  }
  return null;
}

// číslo dílu z názvu souboru/releasu (opatrně — radši null než špatně)
// special/OVA/S00/NCED… = NENÍ řadový díl sezóny → při párování řadového dílu vynech.
const SPECIAL_RE = /\bS00\b|\bspecials?\b|\bOVAs?\b|\bOADs?\b|\bOAVs?\b|\bONAs?\b|\bNC(ED|OP)\b|picture drama|creditless|\bmenus?\b/i;
const isSpecial = (name) => SPECIAL_RE.test(name || '');

function episodeFromName(name) {
  const s = name || '';
  // SxxEyy — respektuj SEZÓNU: S00 (special) není řadový díl → null
  const se = s.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  if (se) return Number(se[1]) === 0 ? null : Number(se[2]);
  const pats = [
    /\s-\s(\d{1,3})(?:v\d)?\s(?:-|\[|\()/, //  " - 01 - " / " - 01 [" / " - 01 ("
    /\bEP?\.?\s?(\d{1,3})\b/i, //  E01 / EP01 / EP 1
    /\s(\d{1,3})(?:v\d)?\s(?:-|\[|\()/, //  " 01 [" / " 01 ("
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

// BD/DVD rozlišení kandidáta (název + video_source z indexeru). Default BD —
// tosho_results jsou BD-heavy a „?" (např. „BD720p" slitě) je skoro vždy BD.
const BD_LOOSE = /blu-?ray|bdrip|\bbd\b|\bbd\d/i;
// WEB zdroje — pro BD přečas NEPOUŽITELNÉ (mají stejné časování jako náš CZ titulek).
const WEB_RE = /\bweb(-?dl|-?rip)?\b|\bamzn\b|\bcr\b|\bnf\b|\bhulu\b|\bdsnp\b/i;

// Smí být reference? Indexer už plní video_source (BD / BD Remux / BDRip / WEB /
// WEB-DL / WEBRip), takže rozhoduje primárně on; název jen když je prázdné.
function isBdOrDvd(name, videoSource) {
  const vs = (videoSource || '').trim();
  if (vs) {
    if (BD_RE.test(vs) || DVD_RE.test(vs)) return true;   // „BD", „BD Remux", „BDRip", „DVD"
    if (WEB_RE.test(vs)) return false;                    // „WEB", „WEB-DL", „WEBRip"
  }
  const n = name || '';
  if (BD_RE.test(n) || DVD_RE.test(n)) return true;
  return false; // bez jasného BD/DVD markeru radši ven (nechceme WEB referenci)
}

function detectKind(name, videoSource) {
  const n = name || '';
  const vs = (videoSource || '').toLowerCase();
  if ((DVD_RE.test(n) || vs.includes('dvd')) && !BD_LOOSE.test(n)) return '🤖 DVD';
  return '🤖 BD';
}

// Řazení releasů: BD před DVD → 'PGS' v názvu dozadu → víc seedů → žebříček skupin.
function rankReleases(rels, prefAtId = null) {
  const rank = (g) => {
    const i = CONFIG.bdGroupRanking.findIndex((x) => x.toLowerCase() === (g || '').toLowerCase());
    return i === -1 ? 999 : i;
  };
  return [...rels].sort(
    (a, b) =>
      (a.kind === '🤖 BD' ? 0 : 1) - (b.kind === '🤖 BD' ? 0 : 1) ||   // BD před DVD (DVD = záloha)
      (a.remux ? 1 : 0) - (b.remux ? 1 : 0) ||                         // remux až nakonec (bývá jen PGS)
      b.seeders - a.seeders ||                                         // ROZHODUJE: víc seedů
      (Number(b.at_id) === Number(prefAtId) ? 1 : 0) -                 // při shodě: osvědčený
        (Number(a.at_id) === Number(prefAtId) ? 1 : 0) ||
      rank(a.group) - rank(b.group)
  );
}


// PRIMÁRNÍ zdroj releasů: indexer /search?anilist&episode (sezónu pinuje anilist,
// specialy/díly řeší indexer). Dvoufázově kvůli líným seedům: 1) zahřát →
// 2) počkat ~3 s → 3) reálné seedy. Když indexer Tosho data nemá → prázdné (fallback).
async function indexerReleases(sub) {
  const idParam = sub.anilist_id
    ? `anilist=${sub.anilist_id}`
    : sub.mal_id
    ? `mal=${sub.mal_id}`
    : null;
  if (!idParam) return [];

  // Sezóna z indexeru. Když ji nevrátí (season=null), jde nejspíš o SPECIAL/OVA
  // s vlastním AniList ID → zkus sezónu 0. Bez správné sezóny by indexer bral
  // číslo dílu jako absolutní a namapoval ho na 1. díl hlavní série.
  let ids = null;
  const r0 = await indexerRequest(`/api/resolve-ids?${idParam}&episode=${sub.episode}`).catch(() => null);
  if (r0 && r0.json) ids = r0.json;
  let season = ids && Number.isFinite(Number(ids.season)) ? Number(ids.season) : null;
  if (season == null) {
    const rs = await indexerRequest(`/api/resolve-ids?${idParam}&season=0&episode=${sub.episode}`).catch(() => null);
    if (rs && rs.json && Number(rs.json.season) === 0 && rs.json.anidb_eid) { ids = rs.json; season = 0; }
  }
  const seasonQ = season != null ? `&season=${season}` : '';

  // /search primárně přes anilist/mal; u specialů bývá prázdné → zkus anidb
  const fetchTosho = async (path) => {
    const r1 = await indexerRequest(path).catch(() => null);
    const t1 = (r1 && r1.json && r1.json.tosho_results) || [];
    if (!t1.length) return [];
    await new Promise((r) => setTimeout(r, 3000)); // seedy se načtou líně po 1. dotazu
    const r2 = await indexerRequest(path).catch(() => null);
    return (r2 && r2.json && r2.json.tosho_results) || t1;
  };
  let queriedBy = idParam.split('=')[0];   // 'anilist' | 'mal'
  let tr = await fetchTosho(`/search?${idParam}${seasonQ}&episode=${sub.episode}`);
  if (!tr.length && ids && ids.anidb_id) {
    queriedBy = 'anidb';
    tr = await fetchTosho(`/search?anidb=${ids.anidb_id}${seasonQ}&episode=${sub.episode}`);
  }
  if (!tr.length) {
    const empty = [];
    empty.stats = { raw: 0, season, queriedBy: null, anidb: (ids && ids.anidb_id) || null, noResults: true };
    return empty;
  }

  const stats = { raw: tr.length, season, queriedBy, anidb: (ids && ids.anidb_id) || null };

  // ÚPLNĚ věříme indexeru: sezónu/díl/specialy už vyřešil dotaz (season=…&episode=…),
  // zdroj videa bereme jen z jeho video_source. Co by se muselo luštit z NÁZVU, přeskočíme.
  let webDropped = 0, noSource = 0, noFileInfo = 0;
  const cands = [];
  for (const t of tr) {
    const vs = String(t.video_source || '').trim();
    if (!vs) { noSource++; continue; }                     // indexer zdroj neurčil → neluštíme z názvu
    if (!(BD_RE.test(vs) || DVD_RE.test(vs))) { webDropped++; continue; } // WEB/TV → stejné časování jako CZ

    // soubor dílu: jen z indexeru (file_index do file_list), jinak jen jednosouborový release
    let fl = [];
    try { fl = JSON.parse(t.file_list || '[]'); } catch {}
    const fi = t.file_index ?? t.fileIdx;
    let tf = fi != null ? fl[fi] : null;
    if (!tf && fl.length === 1) tf = fl[0];
    if (!tf || (!tf.filename && !(tf.filesize ?? tf.size))) { noFileInfo++; continue; }

    cands.push({
      at_id: t.at_id,
      group: t.group_name || groupFromName(t.name) || '',     // jen popisek, nic nerozhoduje
      name: t.name || '',
      seeders: Number(t.seeders) || 0,
      kind: DVD_RE.test(vs) && !BD_RE.test(vs) ? '🤖 DVD' : '🤖 BD',
      remux: /remux/i.test(vs),                           // disk-remux = obvykle jen PGS
      targetCrc32: tf.crc32 ? String(tf.crc32).toLowerCase() : null,
      targetFilename: tf.filename || null,
      targetFilesize: (tf.filesize ?? tf.size) || null,
      singleFile: fl.length <= 1,
      infohash: String(t.infohash || '').toLowerCase() || null,
    });
  }
  stats.webDropped = webDropped;
  stats.noSource = noSource;
  stats.noFileInfo = noFileInfo;
  stats.bdCount = cands.length;

  // Seedy jen řadí (dostupnost rozhodne cache TorBoxu, 0-seed v cache jde přehrát).
  const pref = sub.anilist_id ? getBdPref(sub.anilist_id) : null;
  const releases = rankReleases(cands, pref && pref.at_id);
  releases.stats = stats;
  return releases;
}

// FALLBACK: starý postup feed ?aid= (když indexer tosho_results nemá, např. Sekirei).
async function fallbackReleases(sub) {
  let anidb;
  try { anidb = await resolveAnidbId(sub); } catch { return []; }
  let feed;
  try { feed = await toshoJson(`aid=${anidb}`); } catch { return []; }
  const arr = Array.isArray(feed) ? feed : [];
  const rels = arr
    .filter((x) => x.status === 'complete' && !isSpecial(x.title || ''))
    .filter((x) => BD_RE.test(x.title || '') || DVD_RE.test(x.title || ''))
    .map((x) => ({
      at_id: x.id,
      group: groupFromTitle(x.title) || '',
      name: x.title || '',
      seeders: 0, // feed seedy nedává → řazení pak dle žebříčku
      kind: detectKind(x.title, ''),
      targetCrc32: null,
      targetFilename: null,
    }));
  return rankReleases(rels);
}

// Pro daný release (at_id) najdi soubor dílu (přeskoč specialy) a jeho dialogové
// titulkové stopy (ne Signs/Songs; Full/Dialogue napřed). Vrací {fileName, attIds}.
async function episodeAttachments(atId, episode, target = null) {
  let data;
  try { data = await toshoJson(`show=torrent&id=${atId}`); } catch { return { reason: 'feed-error' }; }
  const files = Array.isArray(data) ? data : data.files || [];
  // Tosho release nezpracovalo (status 'skipped' apod.) → nemá rozepsané soubory
  if (!files.length) return { reason: 'not-processed', status: (data && data.status) || null };

  const base = (p) => String(p || '').split('/').pop();
  let file = null;

  // 1) přesně podle toho, co řekl indexer (crc32, jinak jméno souboru)
  if (target && target.crc32) {
    file = files.find((f) => String(f.crc32 || '').toLowerCase() === target.crc32) || null;
  }
  if (!file && target && target.filename) {
    const want = base(target.filename).toLowerCase();
    file = files.find((f) => base(f.filename).toLowerCase() === want) || null;
  }

  // 2) záloha: jednosouborový release / párování dílu z názvu (specialy ven)
  if (!file) {
    if (files.length === 1 && !isSpecial(files[0].filename)) {
      file = files[0];
    } else {
      for (const f of files) {
        if (isSpecial(f.filename)) continue;
        if (episodeFromName(f.filename) === episode) { file = f; break; }
      }
    }
  }
  if (!file) return { reason: 'no-file' };

  const all = (file.attachments || []).filter((a) => a.type === 'subtitle');
  const named = all.map((a) => ({ id: a.id, nm: (a.info?.name || '').toLowerCase() }));
  const signs = named.filter((x) => /sign|song/.test(x.nm)).length;
  const bitmap = named.filter((x) => !/sign|song/.test(x.nm) && /pgs|\bsup\b/.test(x.nm)).length;
  const attIds = named
    .filter((x) => !/sign|song/.test(x.nm))
    .filter((x) => !/pgs|\bsup\b/.test(x.nm))
    .sort((x, y) => (/(full|dialog)/.test(y.nm) ? 1 : 0) - (/(full|dialog)/.test(x.nm) ? 1 : 0))
    .map((x) => x.id);
  if (!attIds.length) {
    return { reason: all.length ? (bitmap ? 'only-bitmap' : 'only-signs') : 'no-tracks',
             fileName: file.filename, signs, bitmap };
  }
  return { fileName: file.filename, attIds, signs, bitmap };
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

async function saveMachine(sub, outputText, releaseTitle, source, kind = '🤖 BD', refGroup = null) {
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
    group_name: sub.group_name ?? null, // ve Stremiu zůstává PŮVODNÍ CZ grupa
    release: refGroup ? `${kind} · ${refGroup}` : kind, // „🤖 BD · Breeze" (subRelease v db.js s tím počítá)
    version: releaseTitle,              // název ripu / ruční ref → jen pro web (addon version neukazuje)
    filename: outName,
    file_bytes: outBuf.length,
    r2_key,
    machine_of: sub.sub_id,
    machine_source: source,
  });
  return { machineId, r2_key, r2_url: r2PublicUrl(r2_key), bytes: outBuf.length };
}

// stáhni CZ titulek z R2 a připrav pro subsync (gzip→gunzip; plain→beze změny)
async function loadCz(sub) {
  const czRaw = await r2Get(sub.r2_key);
  if (!czRaw || !czRaw.length) return null;
  let czBuf = czRaw;
  if (czRaw[0] === 0x1f && czRaw[1] === 0x8b) {
    try { czBuf = zlib.gunzipSync(czRaw); } catch { czBuf = czRaw; }
  }
  return { czBuf, czName: baseNameOf(sub) };
}

// společný konec pro RUČNÍ referenci: CZ z R2 → subsync → ulož strojovou verzi
async function resyncAndSave(sub, refBuf, refName, releaseTitle, source, kind = '🤖 BD') {
  const cz = await loadCz(sub);
  if (!cz) return { ok: false, stage: 'cz', error: 'CZ titulek se nepodařilo stáhnout z R2.' };
  const sync = await callSubsync(refBuf, refName, cz.czBuf, cz.czName);
  if (!sync.ok || !sync.output) {
    return { ok: false, stage: 'subsync', error: sync.message || 'Přečas selhal.', detail: sync };
  }
  const saved = await saveMachine(sub, sync.output, releaseTitle, source, kind);
  return {
    ok: true, kind, release: releaseTitle, episode: sub.episode,
    format: sync.format, elapsed_ms: sync.elapsed_ms,
    machine_sub_id: saved.machineId, file_bytes: saved.bytes,
  };
}

// ── orchestrátor: AUTO ──────────────────────────────────────────────────────
// Zdroj releasů = indexer /search (zná sezóny/díly/specialy; dvoufázově kvůli
// seedům), fallback feed ?aid=. Kandidáty řadí BD→ne-PGS→seedy→žebříček a
// v pořadí zkouší: stáhni titulkovou stopu → subsync → bitmapové (PGS) /
// neparsovatelné PŘESKOČ. Uloží první, co projde. Grupa strojovky = 🤖 grupa BD ripu.
// Paměť prozkoumaných releasů per anime (6 h): u dalších dílů série se release,
// kde byla anglická ASS, zkusí PRVNÍ, a releasy s jen bitmapami/Signs/zipem až
// nakonec → hromadný přečas neprochází znovu stejné releasy (šetří TorBox).
const releaseMemo = new Map();   // `${anilist}:${at_id}` → { tier, bad, t }
const MEMO_TTL = 6 * 3600e3;
const memoGet = (al, at) => { const m = releaseMemo.get(`${al}:${at}`); return m && Date.now() - m.t < MEMO_TTL ? m : null; };
const memoSet = (al, at, v) => { if (al) releaseMemo.set(`${al}:${at}`, { ...v, t: Date.now() }); };

export async function bdResync(sub, source = 'hiyori') {
  if (sub.episode == null) {
    return { ok: false, stage: 'input', error: 'Auto přečas potřebuje číslo dílu (u filmu použij ruční referenci).' };
  }
  const useTorbox = !!CONFIG.torbox.key;
  const useTosho = !!CONFIG.tosho.enabled;
  if (!useTorbox && !useTosho) {
    return { ok: false, stage: 'config',
      error: 'Není nastavený žádný zdroj reference — chybí TORBOX_API_KEY (a Anime Tosho je vypnuté). Použij ruční referenci.' };
  }

  // Kandidáti: jen z indexeru (sezóna/díl/specialy/zdroj/soubor dílu určil on).
  let via = 'indexer';
  let releases = await indexerReleases(sub);
  const st = releases.stats || {};
  if (!releases.length && useTosho) { via = 'aid-fallback'; releases = await fallbackReleases(sub); }

  if (!releases.length) {
    let error;
    if (st.noResults || !st.raw) {
      error = st.anidb
        ? `Indexer pro tohle anime nemá žádný release (hledáno přes anidb ${st.anidb}${st.season != null ? `, sezóna ${st.season}` : ''}). Použij ruční referenci (.ass/.srt).`
        : 'Indexer pro tohle anime nemá žádné releasy — nejspíš chybí mapování na AniDB. Použij ruční referenci (.ass/.srt).';
    } else {
      const bits = [];
      if (st.webDropped) bits.push(`WEB ${st.webDropped}`);
      if (st.noSource) bits.push(`bez určeného zdroje ${st.noSource}`);
      if (st.noFileInfo) bits.push(`bez údaje o souboru dílu ${st.noFileInfo}`);
      error = `Indexer má ${st.raw} releasů, ale žádný použitelný BD/DVD${bits.length ? ` (${bits.join(', ')})` : ''}. Použij ruční referenci (.ass/.srt).`;
    }
    return { ok: false, stage: 'reference', via, stats: st, error };
  }

  const cz = await loadCz(sub);
  if (!cz) return { ok: false, stage: 'cz', via, error: 'CZ titulek se nepodařilo stáhnout z R2.' };

  let tried = 0;
  const why = { noHash: 0, notCached: 0, zip: 0, noFile: 0, noCues: 0, onlyBitmap: 0, onlySigns: 0,
                noTracks: 0, notProcessed: 0, syncFail: 0, sourceError: 0 };
  let lastDetail = null, lastErr = null;
  const czBroken = (sync) => ({
    ok: false, stage: 'cz', via, tried, detail: sync,
    error: 'CZ titulek má vadný formát, který alass nepřečte (ani po narovnání). Oprav zdrojový titulek nebo použij ruční referenci.',
  });

  // ── A) TorBox: vložené titulky v BD souboru ─────────────────────────────
  if (useTorbox) {
    let cached = new Set();
    try { cached = await cachedHashes(releases.map((r) => r.infohash)); }
    catch (e) { why.sourceError++; lastErr = e.message; }
    for (const r of releases) {
      if (!r.infohash) why.noHash++;
      else if (!cached.has(r.infohash)) why.notCached++;
    }
    const inCache = releases.filter((r) => r.infohash && cached.has(r.infohash)); // pořadí = seedy

    // přečti časovou osu + vyber stopu; torrent hned uklidí (data máme v paměti)
    const probe = async (rel) => {
      let L;
      try {
        L = await episodeLink(
          { infohash: rel.infohash, filename: rel.targetFilename, filesize: rel.targetFilesize, singleFile: rel.singleFile },
          { assumeCached: true });
      } catch (e) { why.sourceError++; lastErr = e.message; return null; }
      if (!L.url) {
        if (L.reason === 'uncached') why.notCached++;
        else if (L.reason === 'zip') { why.zip++; memoSet(sub.anilist_id, rel.at_id, { bad: true }); }
        else why.noFile++;
        return null;
      }
      try {
        const tl = await readTimeline(L.url, { refresh: L.refresh });
        if (tl.noCues) { why.noCues++; return null; }
        const pk = pickDialogueTrack(tl.tracks);
        if (!pk.track) {
          if (pk.reason === 'only-bitmap') why.onlyBitmap++;
          else if (pk.reason === 'only-signs') why.onlySigns++;
          else if (pk.reason === 'no-cues-for-subs') why.noCues++;
          else why.noTracks++;
          memoSet(sub.anilist_id, rel.at_id, { bad: true });   // stopy jsou napříč batchem stejné
          return null;
        }
        memoSet(sub.anilist_id, rel.at_id, { tier: pk.tier });
        return { rel, file: L.file, pk, tl };
      } catch (e) { why.sourceError++; lastErr = e.message; return null; }
      finally { await L.cleanup(); }
    };
    const attempt = async (p, probed) => {
      tried++;
      const sync = await callSubsync(timelineToSrt(p.pk.track, p.tl.scale), 'ref.srt', cz.czBuf, cz.czName);
      if (sync.ok && sync.output) {
        const saved = await saveMachine(sub, sync.output, p.file, source, p.rel.kind, p.rel.group || null);
        if (sub.anilist_id && via === 'indexer') setBdPref(sub.anilist_id, p.rel.at_id);
        return { done: {
          ok: true, via, kind: p.rel.kind, release: p.file, group: p.rel.group, seeders: p.rel.seeders,
          episode: sub.episode, format: sync.format, elapsed_ms: sync.elapsed_ms,
          machine_sub_id: saved.machineId, file_bytes: saved.bytes, tried,
          ref_source: 'torbox', ref_track: p.pk.why, ref_kb: Math.round(p.tl.bytes / 1024), probed,
        } };
      }
      if (sync.bad_input === 'subtitle') return { done: czBroken(sync) };
      if (sync.non_text) why.onlyBitmap++; else why.syncFail++;
      lastDetail = sync;
      return null;
    };

    // BD napřed; DVD jen jako záloha, když žádný BD nevyjde
    const groups = [inCache.filter((r) => r.kind !== '🤖 DVD'), inCache.filter((r) => r.kind === '🤖 DVD')];
    for (const g0 of groups) {
      if (!g0.length) continue;
      const rankOf = (r) => { const m = memoGet(sub.anilist_id, r.at_id); return m ? (m.tier === 1 ? 0 : m.bad ? 2 : 1) : 1; };
      const group = g0.map((r, i) => ({ r, i })).sort((a, b) => rankOf(a.r) - rankOf(b.r) || a.i - b.i).map((x) => x.r);
      // 1) prozkoumej nejvýš probeMax (6) cached releasů; anglická ASS (úroveň 1) ukončí hledání
      const probes = [];
      let idx = 0;
      while (idx < group.length && probes.length < (CONFIG.torbox.probeMax || 6)) {
        const p = await probe(group[idx++]);
        if (p) { probes.push(p); if (p.pk.tier === 1) break; }
      }
      // 2) pořadí pokusů: anglická ASS, jinak release s nejvíc seedy (probes jsou v pořadí seedů)
      const order = [...probes].sort((a, b) => (a.pk.tier === 1 ? 0 : 1) - (b.pk.tier === 1 ? 0 : 1));
      for (const p of order) {
        if (tried >= 8) break;
        const r = await attempt(p, probes.length);
        if (r) return r.done;
      }
      // 3) zbylé releasy této skupiny jeden po druhém
      while (idx < group.length && tried < 8) {
        const p = await probe(group[idx++]);
        if (!p) continue;
        const r = await attempt(p, probes.length + 1);
        if (r) return r.done;
      }
    }
  }

  // ── B) Anime Tosho (USPÁNO — jen při TOSHO_ENABLED) ─────────────────────
  if (useTosho) {
    for (const rel of releases) {
      if (tried >= 8) break;
      const ea = await episodeAttachments(rel.at_id, sub.episode, { crc32: rel.targetCrc32, filename: rel.targetFilename });
      if (!ea || !ea.attIds || !ea.attIds.length) {
        const r = (ea && ea.reason) || 'no-file';
        if (r === 'not-processed') why.notProcessed++;
        else if (r === 'feed-error') why.sourceError++;
        else if (r === 'only-bitmap') why.onlyBitmap++;
        else if (r === 'only-signs') why.onlySigns++;
        else if (r === 'no-tracks') why.noTracks++;
        else why.noFile++;
        continue;
      }
      for (const attId of ea.attIds) {
        if (tried >= 8) break;
        tried++;
        let refXz;
        try { refXz = await downloadAttachXz(attId); } catch { continue; }
        const sync = await callSubsync(refXz, 'ref.xz', cz.czBuf, cz.czName);
        if (sync.ok && sync.output) {
          const saved = await saveMachine(sub, sync.output, ea.fileName, source, rel.kind, rel.group || null);
          if (sub.anilist_id && via === 'indexer') setBdPref(sub.anilist_id, rel.at_id);
          return {
            ok: true, via, kind: rel.kind, release: ea.fileName, group: rel.group, seeders: rel.seeders,
            episode: sub.episode, format: sync.format, elapsed_ms: sync.elapsed_ms,
            machine_sub_id: saved.machineId, file_bytes: saved.bytes, tried, ref_source: 'tosho',
          };
        }
        if (sync.bad_input === 'subtitle') return czBroken(sync);
        if (sync.non_text) why.onlyBitmap++; else why.syncFail++;
        lastDetail = sync;
      }
    }
  }

  // Slož hlášku z toho, co se REÁLNĚ stalo.
  const parts = [];
  if (why.notCached) parts.push(`${why.notCached}× release není v cache TorBoxu`);
  if (why.zip) parts.push(`${why.zip}× TorBox drží release jako .zip (nejde číst po částech)`);
  if (why.noFile) parts.push(`${why.noFile}× soubor dílu (podle indexeru) se v releasu nenašel`);
  if (why.noCues) parts.push(`${why.noCues}× soubor nemá index titulků (Cues)`);
  if (why.onlyBitmap) parts.push(`${why.onlyBitmap}× jen bitmapové titulky (PGS)`);
  if (why.onlySigns) parts.push(`${why.onlySigns}× jen Signs & Songs`);
  if (why.noTracks) parts.push(`${why.noTracks}× soubor nemá textové titulky`);
  if (why.notProcessed) parts.push(`${why.notProcessed}× Anime Tosho release nezpracovalo`);
  if (why.noHash) parts.push(`${why.noHash}× release nemá infohash`);
  if (why.syncFail) parts.push(`${why.syncFail}× přečas selhal`);
  if (why.sourceError) parts.push(`${why.sourceError}× chyba zdroje${lastErr ? ` (${lastErr})` : ''}`);
  const detail = parts.length ? parts.join(', ') : 'žádný kandidát nešel použít';
  return {
    ok: false, stage: 'reference', via, tried, stats: st, why,
    error: `Nenašel jsem použitelnou referenci z ${releases.length} BD/DVD releasů: ${detail}. Použij ruční referenci (.ass/.srt).`,
    detail: lastDetail,
  };
}

// ── orchestrátor: RUČNÍ (reference nahraná uživatelem) ──────────────────────
export async function bdResyncManual(sub, refBuf, refName, source = 'hiyori') {
  if (!refBuf || !refBuf.length) return { ok: false, stage: 'input', error: 'Prázdná reference.' };
  // reference posíláme pod jejím jménem; .xz i plain .ass/.srt zvládne wrapper
  return resyncAndSave(sub, refBuf, refName || 'ref.ass', `ruční reference: ${refName || '?'}`, source);
}
