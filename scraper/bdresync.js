// scraper/bdresync.js — „přečas na BD" (BD/DVD auto).
// Řetěz (AUTO): CZ titulek → indexer /search?anilist&episode (kandidátní BD/DVD
// releasy, sezóny/specialy řeší indexer; dvoufázově kvůli seedům; fallback feed
// ?aid=) → pro vybraný release stáhni dialogovou titulkovou stopu z Anime Tosho
// (feed ?show=torrent&id=at_id → attachment .xz) → subsync (alass) → strojová
// verze na R2+DB. Bitmapové (PGS)/neparsovatelné se přeskakují, zkouší se další.
// Strojovka: group='🤖 <grupa BD ripu>', release=kind (BD/DVD auto),
// version=název souboru; svázaná machine_of.
// RUČNÍ: reference nahraná uživatelem (přeskočí indexer/Tosho), group=originál.
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
const DVD_RE = /\b(dvd|dvdrip)\b/i;
function groupFromTitle(title) {
  const m = (title || '').match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

// číslo dílu z názvu souboru/releasu (opatrně — radši null než špatně)
// special/OVA/S00/NCED… = NENÍ řadový díl sezóny → při párování řadového dílu vynech.
const SPECIAL_RE = /\bS00\b|\bspecials?\b|\bOVA\b|\bOAD\b|\bOAV\b|\bNC(ED|OP)\b|picture drama|creditless|\bmenus?\b/i;
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
function detectKind(name, videoSource) {
  const n = name || '';
  const vs = (videoSource || '').toLowerCase();
  if ((DVD_RE.test(n) || vs.includes('dvd')) && !BD_LOOSE.test(n)) return 'DVD auto';
  return 'BD auto';
}

// Řazení releasů: BD před DVD → 'PGS' v názvu dozadu → víc seedů → žebříček skupin.
function rankReleases(rels) {
  const rank = (g) => {
    const i = CONFIG.bdGroupRanking.findIndex((x) => x.toLowerCase() === (g || '').toLowerCase());
    return i === -1 ? 999 : i;
  };
  const isPgs = (n) => /pgs/i.test(n || '');
  return [...rels].sort(
    (a, b) =>
      (a.kind === 'BD auto' ? 0 : 1) - (b.kind === 'BD auto' ? 0 : 1) ||
      (isPgs(a.name) ? 1 : 0) - (isPgs(b.name) ? 1 : 0) ||
      b.seeders - a.seeders ||
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
  const path = `/search?${idParam}&episode=${sub.episode}`;
  const r1 = await indexerRequest(path).catch(() => null);
  const tr1 = (r1 && r1.json && r1.json.tosho_results) || [];
  if (!tr1.length) return []; // bez Tosho dat → hned fallback (žádné čekání)
  await new Promise((r) => setTimeout(r, 3000)); // seedy se načtou líně po 1. dotazu
  const r2 = await indexerRequest(path).catch(() => null);
  const tr = (r2 && r2.json && r2.json.tosho_results) || tr1;
  return rankReleases(
    tr.map((t) => ({
      at_id: t.at_id,
      group: t.group_name || '',
      name: t.name || '',
      seeders: Number(t.seeders) || 0,
      kind: detectKind(t.name, t.video_source),
    }))
  );
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
    }));
  return rankReleases(rels);
}

// Pro daný release (at_id) najdi soubor dílu (přeskoč specialy) a jeho dialogové
// titulkové stopy (ne Signs/Songs; Full/Dialogue napřed). Vrací {fileName, attIds}.
async function episodeAttachments(atId, episode) {
  let data;
  try { data = await toshoJson(`show=torrent&id=${atId}`); } catch { return null; }
  const files = Array.isArray(data) ? data : data.files || [];
  let file = null;
  if (files.length === 1 && !isSpecial(files[0].filename)) {
    file = files[0]; // jednosouborový release = ten díl
  } else {
    for (const f of files) {
      if (isSpecial(f.filename)) continue;
      if (episodeFromName(f.filename) === episode) { file = f; break; }
    }
  }
  if (!file) return null;
  const attIds = (file.attachments || [])
    .filter((a) => a.type === 'subtitle')
    .map((a) => ({ id: a.id, nm: (a.info?.name || '').toLowerCase() }))
    .filter((x) => !/sign|song/.test(x.nm)) // Signs/Songs vynech
    .sort((x, y) => (/(full|dialog)/.test(y.nm) ? 1 : 0) - (/(full|dialog)/.test(x.nm) ? 1 : 0))
    .map((x) => x.id);
  return { fileName: file.filename, attIds };
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

async function saveMachine(sub, outputText, releaseTitle, source, kind = 'BD auto', groupName = null) {
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
    group_name: groupName ?? sub.group_name ?? null, // AUTO: 🤖 grupa BD ripu; RUČNÍ: originál
    release: kind,                      // 'BD auto' / 'DVD auto' → addon ukazuje tohle
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
async function resyncAndSave(sub, refBuf, refName, releaseTitle, source, kind = 'BD auto') {
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
export async function bdResync(sub, source = 'hiyori') {
  if (sub.episode == null) {
    return { ok: false, stage: 'input', error: 'Auto přečas potřebuje číslo dílu (u filmu použij ruční referenci).' };
  }

  // releasy: primárně indexer, fallback starý ?aid=
  let via = 'indexer';
  let releases = await indexerReleases(sub);
  if (!releases.length) { via = 'aid-fallback'; releases = await fallbackReleases(sub); }
  if (!releases.length) {
    return { ok: false, stage: 'reference', via, error: 'Na Toshu (ani přes indexer) není BD/DVD release.' };
  }

  const cz = await loadCz(sub);
  if (!cz) return { ok: false, stage: 'cz', via, error: 'CZ titulek se nepodařilo stáhnout z R2.' };

  // zkoušej releasy v pořadí; v každém dialogové stopy; PGS/neparsovatelné přeskakuj
  let tried = 0;
  let skipped = 0;
  let lastDetail = null;
  for (const rel of releases) {
    if (tried >= 8) break; // strop na počet pokusů (Tosho + čas)
    const ea = await episodeAttachments(rel.at_id, sub.episode);
    if (!ea || !ea.attIds.length) continue;
    for (const attId of ea.attIds) {
      if (tried >= 8) break;
      tried++;
      let refXz;
      try { refXz = await downloadAttachXz(attId); } catch { continue; }
      const sync = await callSubsync(refXz, 'ref.xz', cz.czBuf, cz.czName);
      if (sync.ok && sync.output) {
        const groupName = `🤖 ${rel.group}`.trim(); // grupa BD ripu (i ve Stremiu)
        const saved = await saveMachine(sub, sync.output, ea.fileName, source, rel.kind, groupName);
        return {
          ok: true, via, kind: rel.kind, release: ea.fileName, group: groupName,
          seeders: rel.seeders, episode: sub.episode, format: sync.format, elapsed_ms: sync.elapsed_ms,
          machine_sub_id: saved.machineId, file_bytes: saved.bytes, tried,
        };
      }
      if (sync.non_text) skipped++;
      lastDetail = sync;
    }
  }
  return {
    ok: false, stage: 'reference', via, tried, skipped,
    error: 'Nenašel jsem použitelnou textovou referenci — releasy jsou nejspíš bitmapové (PGS). Použij ruční referenci (.ass/.srt).',
    detail: lastDetail,
  };
}

// ── orchestrátor: RUČNÍ (reference nahraná uživatelem) ──────────────────────
export async function bdResyncManual(sub, refBuf, refName, source = 'hiyori') {
  if (!refBuf || !refBuf.length) return { ok: false, stage: 'input', error: 'Prázdná reference.' };
  // reference posíláme pod jejím jménem; .xz i plain .ass/.srt zvládne wrapper
  return resyncAndSave(sub, refBuf, refName || 'ref.ass', `ruční reference: ${refName || '?'}`, source);
}
