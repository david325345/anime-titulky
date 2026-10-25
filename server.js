// server.js — web dashboard + API + hodinový scrape interval.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { runOnce, downloadOnce, downloadSingle, isRunning, ingestAnime, addManualEpisodes, addManualNoHiyori } from './scraper/run.js';
import {
  overviewCounts, recentSubs, recentRuns, getMeta, getSub, findSubs, subsAvailability,
  listSubs, deleteSub, recentlyAdded, markDownloaded, allSubs, updateSubMeta,
  listAkihabaraAnime, akihabaraAnimeDetail, akihabaraStats, resetSubDownload,
  machineVersionsFor, getAkiSub, bulkBdTargetsHiyori, bulkBdTargetsAki, getBdPin, clearBdPin,
  insertRequest, listRequests, getRequest, setRequestStatus, requestStatusForAnilist,
  upsertAddonRequest, listAddonRequests, getAddonRequest, setAddonRequestStatus,
  subsByAnime,
  backfillQuality, migrateMachineIds, subSetSiblings, updateSubMetaMany,
  getSubFonts, fontsBrief, subFontsOverview,
} from './db.js';
import { classifyQuality, releaseGroups } from './scraper/quality.js';
import * as hanabi from './scraper/sources/hanabi.js';
import { startKeepAlive as startAtKeepAlive } from './scraper/sources/animetitulky-http.js';
import { saveSubFile } from './scraper/download.js';
import { bdResync, bdResyncManual, bdCandidates, bdProbe } from './scraper/bdresync.js';
import AdmZip from 'adm-zip';
import { r2PublicUrl, r2Get, r2Delete, r2Enabled } from './r2.js';
import { loadLibrary, library, readFontFaces, FONT_EXT } from './fonts.js';
import { ensureFonts, ensureFontsFor, servedFonts, fontsEnabled, isAssKey } from './fontjobs.js';
import { liveDbGzip, backupDbToR2, startDbBackup, restoreDbFromBuffer } from './backup.js';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { beginSubsBatch, endSubsBatch, asManualUpload, manualKeyOf } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// --- Basic Auth (dashboard + admin). Když AUTH_USER/AUTH_PASS chybí, nechrání se. ---
// Volitelný druhý účet: AUTH_USER2/AUTH_PASS2 (stejná práva KROMĚ mazání).
// Ukládá req.authRole: 'user1' (hlavní účet), 'user2' (druhý), nebo 'open' (bez auth).
function basicAuth(req, res, next) {
  const { user, pass, user2, pass2 } = CONFIG.auth;
  if (!user || !pass) { req.authRole = 'open'; return next(); }
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/i);
  if (m) {
    const [u, p] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    if (u === user && p === pass) { req.authRole = 'user1'; return next(); }
    if (user2 && pass2 && u === user2 && p === pass2) { req.authRole = 'user2'; return next(); }
  }
  res.set('WWW-Authenticate', 'Basic realm="NimeToDex Titulky"');
  return res.status(401).send('Přihlášení vyžadováno.');
}

// Jen hlavní účet (user1). Když je auth vypnutá ('open'), pustí — jinak by
// nešlo nic mazat bez nastavených účtů. Druhý účet (user2) dostane 403.
function requireUser1(req, res, next) {
  if (req.authRole === 'user2') {
    return res.status(403).json({ error: 'Mazání je povolené jen hlavnímu účtu.' });
  }
  next();
}

// ==================================================================
// VEŘEJNÉ endpointy pro addon (registrované PŘED auth → nechráněné)
// ==================================================================

// GET /api/subs?anilist=154587&mal=52991&episode=5[&lang=CZ]
// Vrací stažené titulky (na R2) — přednost anilist, fallback mal.
app.get('/api/subs', async (req, res) => {
  const anilist = Number(req.query.anilist) || null;
  const mal = Number(req.query.mal) || null;
  const episode = req.query.episode != null && req.query.episode !== ''
    ? Number(req.query.episode)
    : null;
  const lang = req.query.lang ? String(req.query.lang) : null;

  if (!anilist && !mal) {
    return res.status(400).json({ error: 'Zadej anilist a/nebo mal.' });
  }

  const { matchedBy, rows } = findSubs({ anilist, mal, episode, lang });

  // Fonty: titulky dílu, který si addon právě vyžádal, se při prvním dotazu zpracují
  // (vloží se chybějící fonty). Čeká se nejvýš FONTS_BUDGET_MS, zbytek doběhne na
  // pozadí. Dotaz na celé anime bez dílu se zpracuje jen když je titulků málo (film),
  // jinak se jen vrátí, co už zpracované je.
  if (episode != null || rows.length <= 6) {
    try { await ensureFontsFor(rows, CONFIG.fonts.budgetMs); } catch (e) { console.warn('[fonty] /api/subs:', e.message); }
  }
  const served = servedFonts(rows);

  const subs = rows.map((r) => {
    const f = served.get(r);          // verze s vloženými fonty (když je)
    const key = f ? f.key : r.r2_key;
    return {
      sub_id: r.sub_id,
      lang: r.lang,
      group: r.group_name,
      release: r.release,
      version: r.version,
      // na jaký zdroj je titulek načasovaný + video skupiny (kanonicky dle indexeru)
      quality: r.quality || classifyQuality(r.release),
      release_groups: releaseGroups(r.release),
      episode: r.episode,
      kind: r.kind,
      source: r.extern_domain || 'hiyori',
      filename: r.filename ? r.filename.replace(/\.gz$/i, '') : null,
      file_bytes: f ? f.bytes : r.file_bytes,
      r2_key: key,
      gz_url: r2PublicUrl(key), // veřejný odkaz na .gz (addon si rozbalí)
      fonts: !!f,               // true = soubor má vložené fonty ([Fonts])
    };
  });

  res.json({ matched_by: matchedBy, count: subs.length, subs });
});

// GET /api/subs/available?anilist=154587&mal=52991[&episode=5]
// Rychlá odpověď, zda pro anime/díl máme titulky na R2 (bez plných dat).
// Povolené originy pro veřejné read/request endpointy (extension na těchto webech).
const CORS_ALLOWED_ORIGINS = ['https://hiyori.cz', 'https://myanimelist.net', 'https://anilist.co'];
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

app.get('/api/subs/available', (req, res) => {
  applyCors(req, res); // povol čtení z whitelistovaných extension originů
  const anilist = Number(req.query.anilist) || null;
  const mal = Number(req.query.mal) || null;
  const episode = req.query.episode != null && req.query.episode !== ''
    ? Number(req.query.episode)
    : null;
  if (!anilist && !mal) {
    return res.status(400).json({ error: 'Zadej anilist a/nebo mal.' });
  }
  const a = subsAvailability({ anilist, mal, episode });
  res.json({
    available: a.subs_total > 0,
    matched_by: a.matchedBy,
    anime_title: a.anime_title,
    episode, // který díl se ptal (null = celé anime)
    episodes_count: a.episodes_count, // kolik různých dílů
    subs_total: a.subs_total,         // kolik titulků celkem (vč. variant)
    langs: a.langs,                   // souhrn jazyků
    episodes: a.episodes,             // [{episode, subs:[{lang,group,release}]}]
    request_status: requestStatusForAnilist(anilist), // 'pending'|'done'|null — pro tlačítko v extension
  });
});

// --- Požadavky na přidání anime z extension (veřejné, PŘED basicAuth) ---

// CORS preflight pro POST /api/request-anime
app.options('/api/request-anime', (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// Jednoduchý paměťový rate-limit na IP (20 requestů / hodinu). Resetuje se při
// restartu — pro anti-spam veřejného endpointu bohatě stačí.
const reqAnimeHits = new Map(); // ip -> [timestamp, ...]
function rateOk(ip, maxPerHour = 20) {
  const now = Date.now();
  const hourAgo = now - 3600000;
  const hits = (reqAnimeHits.get(ip) || []).filter((t) => t > hourAgo);
  if (hits.length >= maxPerHour) { reqAnimeHits.set(ip, hits); return false; }
  hits.push(now);
  reqAnimeHits.set(ip, hits);
  return true;
}

// POST /api/request-anime — extension pošle hiyori_id (+ volitelně anilist_id, title).
app.post('/api/request-anime', express.json(), (req, res) => {
  applyCors(req, res);
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  if (!rateOk(ip)) {
    return res.status(429).json({ error: 'Příliš mnoho požadavků, zkus to za chvíli.' });
  }
  const hiyoriId = Number(req.body?.hiyori_id) || null;
  if (!hiyoriId || hiyoriId <= 0) {
    return res.status(400).json({ error: 'Chybí platné hiyori_id.' });
  }
  const anilistId = Number(req.body?.anilist_id) || null;
  const title = req.body?.title ? String(req.body.title).slice(0, 300) : null;
  const r = insertRequest({ hiyori_id: hiyoriId, anilist_id: anilistId, title, ip });
  res.json(r); // { status: 'ok' } nebo { status: 'already_requested' }
});

// POST /api/requests — žádost o titulky z ADDONU (uživatel ve Stremiu/Nuviu klikl ⏳).
// Chráněno hlavičkou X-Notify-Token = NOTIFY_TOKEN (stejný token, jaký služba posílá
// addonu). Addon kontroluje jen HTTP stav (2xx = převzato); tělo je pro log/ladění.
// GET /api/requests (seznam žádostí z extension) zůstává za přihlášením níž.
const tokenOk = (got) => {
  const want = String(process.env.NOTIFY_TOKEN || '');
  const a = Buffer.from(String(got || '')), b = Buffer.from(want);
  return want.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};
app.post('/api/requests', express.json(), (req, res) => {
  if (!process.env.NOTIFY_TOKEN) return res.status(503).json({ ok: false, error: 'NOTIFY_TOKEN není nastaven.' });
  if (!tokenOk(req.headers['x-notify-token'])) return res.status(401).json({ ok: false, error: 'Neplatný token.' });
  const b = req.body || {};
  const int = (v) => (v == null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);
  const anilist_id = int(b.anilist_id);
  const scope = String(b.scope || '');
  const episode = int(b.episode);
  if (!(anilist_id > 0)) return res.status(400).json({ ok: false, error: 'Chybí platné anilist_id.' });
  if (!['anime', 'episode'].includes(scope)) return res.status(400).json({ ok: false, error: 'scope musí být "anime" nebo "episode".' });
  // pozor: v JS platí null >= 0 → číslo dílu ověřit přes Number.isInteger
  if (scope === 'episode' && !(Number.isInteger(episode) && episode >= 0)) return res.status(400).json({ ok: false, error: 'U scope "episode" chybí číslo dílu.' });
  const row = {
    anilist_id,
    mal_id: int(b.mal_id) > 0 ? int(b.mal_id) : null,
    scope,
    episode: scope === 'episode' ? episode : null,
    imdb_id: /^tt\d+$/.test(String(b.imdb_id || '')) ? String(b.imdb_id) : null,
    imdb_season: int(b.imdb_season) >= 0 ? int(b.imdb_season) : null,
    imdb_episode: int(b.imdb_episode) >= 0 ? int(b.imdb_episode) : null,
    title: b.title ? String(b.title).slice(0, 300) : null,
    requesters: int(b.requesters) > 0 ? int(b.requesters) : 1,
    requested_at: !isNaN(Date.parse(b.requested_at)) ? new Date(b.requested_at).toISOString() : null,
  };
  // titulky už máme (díl, u celého anime jakékoli) → nic neukládat
  const have = findSubs({ anilist: row.anilist_id, mal: row.mal_id, episode: row.episode });
  if (have.rows.length) return res.json({ ok: true, status: 'available', subs: have.rows.length });
  const r = upsertAddonRequest(row);
  console.log(`[addon-request] ${r.status} #${r.id} AL${row.anilist_id}${row.episode != null ? ` E${row.episode}` : ' (celé anime)'} ` +
    `„${row.title || r.title || '?'}" — žadatelů ${r.requesters}${r.status === 'existing' ? `, stav ${r.state}` : ''}`);
  res.json({ ok: true, id: r.id, status: r.status, requesters: r.requesters });
});

// GET /api/recent[?days=N] — dnes přidané stažené titulky (na R2), seskupené.
// Bez days = dnešní den od půlnoci. Veřejné (pro addon).
app.get('/api/recent', (req, res) => {
  // ?days=0 → bez časového omezení (všechna anime), ?days=N → posledních N dní,
  // bez parametru → dnešní den od půlnoci. ?limit=N → nejvýš N anime (jinak vše).
  const rawDays = req.query.days;
  const hasDays = rawDays != null && rawDays !== '';
  const nDays = hasDays ? Number(rawDays) : NaN;
  const days = Number.isFinite(nDays) && nDays >= 0 ? Math.floor(nDays) : null;

  const nLimit = Number(req.query.limit);
  const limit = Number.isFinite(nLimit) && nLimit > 0 ? Math.floor(nLimit) : null;

  let since = null;
  if (days === 0) {
    since = null;                                   // vše
  } else if (days) {
    since = new Date(Date.now() - days * 86400000); // posledních N dní
  } else {
    since = new Date();
    since.setHours(0, 0, 0, 0);                     // dnešek od půlnoci (lokální čas serveru)
  }
  const sinceIso = since ? since.toISOString() : null;
  const items = recentlyAdded(sinceIso, limit);
  res.json({ since: sinceIso, days, limit, count: items.length, items });
});

// GET /api/all — kompletní výpis všeho staženého na R2, seskupené po anime.
// Bez stránkování. Pro zálohu / import do jiného nástroje / přehled.
app.get('/api/all', (req, res) => {
  const { items, subsTotal } = allSubs();
  const served = servedFonts();        // verze s vloženými fonty (jen u vyžádaných titulků)
  // dopočítej veřejný R2 odkaz, r2_key ven neposíláme (duplikoval by gz_url)
  for (const a of items) {
    for (const ep of a.episodes) {
      for (const s of ep.subs) {
        const f = served.get(s);
        s.gz_url = r2PublicUrl(f ? f.key : s.r2_key);
        delete s.r2_key;
        delete s.src;
      }
    }
  }
  res.json({ count: items.length, subs_total: subsTotal, items });
});

// ==================================================================
// Od tohoto bodu je vše CHRÁNĚNO Basic Auth (dashboard + admin)
// ==================================================================
app.use(basicAuth);

// --- Hromadné nahrání titulků: parsing názvů + seznam záznamů anime ---

// GET /api/subs/by-anime?hiyori_id=NNN — záznamy jednoho anime (pro párování
// nahrávaných souborů na už založené díly).
app.get('/api/subs/by-anime', (req, res) => {
  const hiyori_id = Number(req.query.hiyori_id) || null;
  const anilist_id = Number(req.query.anilist_id) || null;
  const mal_id = Number(req.query.mal_id) || null;
  if (!hiyori_id && !anilist_id && !mal_id) return res.status(400).json({ error: 'Zadej hiyori_id, anilist_id nebo mal_id.' });
  res.json({ subs: subsByAnime({ hiyori_id, anilist_id, mal_id }) });
});

// POST /api/parse-names — přeposílá názvy souborů parseru indexeru (prohlížeč
// na indexer nedosáhne). Vrací jeho odpověď beze změny. Používá se jen ke
// zjištění čísla dílu; jazyk/skupinu/release bereme z hiyori.
app.post('/api/parse-names', express.json({ limit: '2mb' }), async (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names : null;
  if (!names || !names.length) return res.status(400).json({ error: 'Chybí názvy souborů.' });
  if (names.length > 500) return res.status(400).json({ error: 'Najednou nejvýš 500 souborů.' });
  try {
    const r = await fetch(`${CONFIG.indexer.url}/api/parse-names`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ names, anilist_id: Number(req.body?.anilist_id) || undefined }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j?.error || `Indexer vrátil ${r.status}.` });
    res.json(j);
  } catch (e) {
    res.status(502).json({ error: 'Indexer nedostupný: ' + e.message });
  }
});

// --- Požadavky na přidání anime — admin (za basicAuth) ---

// GET /api/requests?status=pending — seznam požadavků pro dashboard.
app.get('/api/requests', (req, res) => {
  const status = String(req.query.status || 'pending');
  res.json({ requests: listRequests(status) });
});

// POST /api/requests/:id/approve — přidá anime (všechny díly) a označí done.
app.post('/api/requests/:id/approve', requireUser1, async (req, res) => {
  const reqRow = getRequest(req.params.id);
  if (!reqRow) return res.status(404).json({ error: 'Požadavek nenalezen.' });
  try {
    const r = await ingestAnime(reqRow.hiyori_id, {}, { manualAdd: true });
    setRequestStatus(reqRow.id, 'done');
    res.json({
      ok: true,
      hiyori_id: reqRow.hiyori_id,
      title: (r.title || '').replace(/\s*-\s*Hiyori$/i, ''),
      anilist_id: r.anilistId,
      found: r.found,
      added: r.added,
      blocked: r.blocked,
    });
  } catch (e) {
    res.status(500).json({ error: 'Nepodařilo se přidat anime: ' + e.message });
  }
});

// POST /api/requests/:id/reject — zamítne požadavek.
app.post('/api/requests/:id/reject', requireUser1, (req, res) => {
  const n = setRequestStatus(req.params.id, 'rejected');
  if (!n) return res.status(404).json({ error: 'Požadavek nenalezen.' });
  res.json({ ok: true });
});

// --- Žádosti o titulky z addonu — admin (za basicAuth) ---

// GET /api/addon-requests?status=open|new|accepted|done|rejected|all
app.get('/api/addon-requests', (req, res) => {
  res.json({ requests: listAddonRequests(String(req.query.status || 'open')) });
});

// POST /api/addon-requests/:id/status { status: accepted|done|rejected|new, note? }
// Změna stavu → addon dostane zprávu (notify.js notifyRequestStatus).
app.post('/api/addon-requests/:id/status', requireUser1, express.json(), (req, res) => {
  const status = String(req.body?.status || '');
  if (!['new', 'accepted', 'done', 'rejected'].includes(status)) return res.status(400).json({ error: 'Neplatný stav.' });
  const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
  const row = setAddonRequestStatus(req.params.id, status, note);
  if (!row) return res.status(404).json({ error: 'Žádost nenalezena.' });
  res.json({ ok: true, request: row });
});

// POST /api/addon-requests/:id/add-hiyori { url } — přidá anime z hiyori (jako
// „Přidat anime z hiyori") a žádost označí jako přijatou.
app.post('/api/addon-requests/:id/add-hiyori', requireUser1, express.json(), async (req, res) => {
  const reqRow = getAddonRequest(req.params.id);
  if (!reqRow) return res.status(404).json({ error: 'Žádost nenalezena.' });
  const input = String(req.body?.url || '').trim();
  const m = input.match(/\/anime\/(\d+)/) || input.match(/^(\d+)$/);
  const hiyoriId = m ? Number(m[1]) : null;
  if (!hiyoriId) return res.status(400).json({ error: 'Zadej odkaz na anime z hiyori (např. https://hiyori.cz/anime/21389) nebo číslo.' });
  try {
    const r = await ingestAnime(hiyoriId, {}, { manualAdd: true });
    if (r.anilistId && Number(r.anilistId) !== Number(reqRow.anilist_id)) {
      console.warn(`[addon-request] #${reqRow.id}: hiyori ${hiyoriId} má AniList ${r.anilistId}, žádost ${reqRow.anilist_id}`);
    }
    const row = getAddonRequest(reqRow.id);          // mohla se mezitím sama vyřídit (titulek se stáhl)
    const upd = row.status === 'done' ? row : setAddonRequestStatus(reqRow.id, 'accepted');
    res.json({
      ok: true, request: upd, hiyori_id: hiyoriId,
      title: (r.title || '').replace(/\s*-\s*Hiyori$/i, ''),
      anilist_id: r.anilistId, found: r.found, added: r.added, blocked: r.blocked,
    });
  } catch (e) {
    res.status(500).json({ error: 'Nepodařilo se přidat anime: ' + e.message });
  }
});

// role přihlášeného účtu — frontend podle toho skryje mazací tlačítka user2
app.get('/api/whoami', (req, res) => {
  res.json({ role: req.authRole, can_delete: req.authRole !== 'user2' });
});

// stažení aktuální živé DB (gzip). Jen user1 — obsahuje kompletní evidenci.
app.get('/api/backup/download', requireUser1, async (req, res) => {
  try {
    const { buffer } = await liveDbGzip();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="hiyori-${stamp}.db.gz"`);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: 'Záloha selhala: ' + e.message });
  }
});

// ruční spuštění zálohy na R2 (jinak běží automaticky 1× denně). Jen user1.
app.post('/api/backup/run', requireUser1, async (req, res) => {
  try {
    const r = await backupDbToR2();
    res.json({ ok: true, key: r.key, bytes: r.bytes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// obnova DB ze zálohy (.db nebo .db.gz). Hlavně pro případ KORUPCE DB.
// Ověří platnost, udělá safety kopii, přepíše /data/hiyori.db a RESTARTUJE
// službu (Coolify ji nahodí zpět s čistou DB). Jen user1.
app.post('/api/backup/restore',
  requireUser1,
  express.raw({ type: '*/*', limit: '50mb' }),
  async (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ ok: false, error: 'Prázdný soubor.' });
    }
    // Neobnovovat, když běží scrape — zapisoval by do DB, kterou přepisujeme
    // (dva zápisy naráz = riziko poškození). Ať uživatel počká / zastaví běh.
    if (isRunning()) {
      return res.status(409).json({
        ok: false,
        error: 'Právě běží stahování — počkej, až doběhne, a zkus to znovu.',
      });
    }
    try {
      const r = await restoreDbFromBuffer(req.body);
      // odpověz PŘED restartem (klient uvidí úspěch), pak se ukonči
      res.json({
        ok: true,
        raw_bytes: r.raw_bytes,
        restarting: true,
        message: 'DB obnovena. Služba se restartuje (~10 s).',
      });
      console.log('[restore] DB obnovena ze zálohy — restartuji službu.');
      setTimeout(() => process.exit(0), 500); // Coolify nahodí zpět
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  }
);

app.use(express.static(path.join(__dirname, 'public')));

// souhrn pro dashboard
app.get('/api/overview', (req, res) => {
  res.json({
    status: {
      running: isRunning(),
      lastRun: getMeta('last_run_iso'),
      intervalMin: CONFIG.intervalMin,
    },
    counts: overviewCounts(),
    runs: recentRuns(12),
  });
});

// stránkovaný výpis titulků s hledáním: /api/subs-list?page=1&q=frieren
app.get('/api/subs-list', (req, res) => {
  const perPage = 100;
  const page = Math.max(1, Number(req.query.page) || 1);
  const q = req.query.q ? String(req.query.q).trim() : null;
  const { rows, total } = listSubs({ limit: perPage, offset: (page - 1) * perPage, q });

  // ke každému řádku připoj info o strojové verzi (BD auto), pokud existuje —
  // web podle toho vykreslí rozbalovací „přečas ▸".
  const machines = machineVersionsFor(rows.map((r) => r.sub_id));
  const subs = rows.map((r) => {
    const m = machines[r.sub_id];
    return {
      ...r,
      fonts: r.status === 'downloaded' ? fontsBrief(getSubFonts('hiyori', r.sub_id), r.r2_key) : null,
      ass: isAssKey(r.r2_key),
      machine: m
        ? {
            sub_id: m.sub_id,
            release: m.release,
            version: m.version,
            quality: m.quality || classifyQuality(m.release),
            file_bytes: m.file_bytes,
            downloaded_at: m.downloaded_at,
          }
        : null,
    };
  });

  res.json({
    page,
    per_page: perPage,
    total,
    pages: Math.max(1, Math.ceil(total / perPage)),
    subs,
  });
});

// ==================================================================
// AKIHABARA ARCHIV (read-only) — seznam anime + detail dílů
// ==================================================================

// souhrn archivu (pro hlavičku sekce): počet titulků + anime
app.get('/api/akihabara/stats', (req, res) => {
  res.json(akihabaraStats());
});

// stránkovaný seznam anime v archivu, s hledáním:
// /api/akihabara/list?page=1&q=fairy
app.get('/api/akihabara/list', (req, res) => {
  const perPage = 100;
  const page = Math.max(1, Number(req.query.page) || 1);
  const q = req.query.q ? String(req.query.q).trim() : null;
  const { rows, total } = listAkihabaraAnime({ limit: perPage, offset: (page - 1) * perPage, q });
  res.json({
    page,
    per_page: perPage,
    total,
    pages: Math.max(1, Math.ceil(total / perPage)),
    anime: rows,
  });
});

// detail jednoho anime — díly + titulky (pro rozbalení řádku)
// /api/akihabara/detail?anilist=6702
app.get('/api/akihabara/detail', (req, res) => {
  const anilist = Number(req.query.anilist) || null;
  if (!anilist) return res.status(400).json({ error: 'Zadej anilist.' });
  res.json(akihabaraAnimeDetail(anilist));
});

// ==================================================================
// FONTY TITULKŮ — knihovna fontů + vkládání do .ass (fonts.js, fontjobs.js)
// ==================================================================

// přehled: knihovna, počty zpracovaných titulků, chybějící fonty (seřazené podle počtu titulků)
app.get('/api/fonts/status', (req, res) => {
  const lib = library();
  const { counts, missingRows } = subFontsOverview();
  const agg = new Map();
  for (const r of missingRows) {
    let list = [];
    try { list = JSON.parse(r.missing || '[]') || []; } catch {}
    for (const m of list) {
      const k = String(m.font || '').toLowerCase();
      if (!k) continue;
      if (!agg.has(k)) agg.set(k, { font: m.font, subs: 0, lines: 0, error: null });
      const a = agg.get(k);
      a.subs++;
      a.lines += m.lines || 0;
      if (m.error) a.error = m.error;
    }
  }
  res.json({
    enabled: fontsEnabled(),
    r2: r2Enabled(),
    dir: lib.dir,
    faces: lib.faces.length,
    files: lib.files,
    bad: lib.bad || 0,
    bytes: lib.bytes,
    version: lib.version,
    loaded_at: lib.loadedAt,
    counts,
    missing_subs: missingRows.length,
    // titulky s chybějícími fonty, které se po změně knihovny ještě nezkusily znovu
    retry_pending: missingRows.filter((r) => r.lib_version !== lib.version).length,
    missing: [...agg.values()].sort((a, b) => b.subs - a.subs || b.lines - a.lines),
  });
});

// nahrání fontů do knihovny: jeden font (.ttf/.otf/.ttc/.otc) nebo ZIP s fonty
// (podsložky ZIPu se zachovají). Stejný soubor se nepřepisuje.
app.post('/api/fonts/upload', express.raw({ type: '*/*', limit: '300mb' }), (req, res) => {
  const rawName = String(req.query.filename || '').trim();
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Prázdný soubor.' });
  const lib = library();
  const root = path.resolve(lib.dir);
  const added = [];
  const replaced = [];
  const skipped = [];
  const save = (rel, buf) => {
    const parts = String(rel).split(/[\\/]+/)
      .filter((p) => p && p !== '.' && p !== '..' && !p.startsWith('.'))
      .map((p) => p.replace(/[<>:"|?*\x00-\x1f]/g, '_'));
    if (!parts.length || !FONT_EXT.test(parts[parts.length - 1])) { skipped.push(`${rel} (není font)`); return; }
    try { readFontFaces(buf); } catch (e) { skipped.push(`${rel} (${e.message})`); return; }
    const dest = path.resolve(root, ...parts);
    if (!dest.startsWith(root + path.sep)) { skipped.push(`${rel} (cesta)`); return; }
    const exists = fs.existsSync(dest);
    if (exists && fs.statSync(dest).size === buf.length && fs.readFileSync(dest).equals(buf)) {
      skipped.push(`${rel} (už je v knihovně)`);
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    (exists ? replaced : added).push(parts.join('/'));
  };
  try {
    if (/\.zip$/i.test(rawName)) {
      const zip = new AdmZip(req.body);
      for (const e of zip.getEntries()) {
        if (e.isDirectory || /(^|\/)__MACOSX\//.test(e.entryName) || !FONT_EXT.test(e.entryName)) continue;
        save(e.entryName, e.getData());
      }
    } else if (FONT_EXT.test(rawName)) {
      save(path.basename(rawName), req.body);
    } else {
      return res.status(400).json({ error: 'Povolené: .ttf, .otf, .ttc, .otc nebo .zip s fonty.' });
    }
    const before = lib.version;
    const now = loadLibrary();
    console.log(`[fonty] nahráno: +${added.length} nových, ${replaced.length} nahrazených, ${skipped.length} přeskočeno → ${now.faces.length} řezů`);
    res.json({
      ok: true,
      added: added.length,
      replaced: replaced.length,
      skipped: skipped.length,
      skipped_list: skipped.slice(0, 30),
      faces: now.faces.length,
      files: now.files,
      changed: before !== now.version,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// titulky, kterým chyběly fonty, zpracovat znovu hned (jinak až při dalším vyžádání)
app.post('/api/fonts/retry-missing', (req, res) => {
  if (!fontsEnabled()) return res.status(400).json({ error: 'Knihovna fontů je prázdná nebo chybí R2.' });
  const { missingRows } = subFontsOverview();
  for (const r of missingRows) ensureFonts(r.src, r.sub_id, { force: true }).catch(() => {});
  res.json({ ok: true, queued: missingRows.length });
});

// 🔤 vložit fonty do jednoho titulku teď (src = hiyori | aki)
app.post('/api/fonts/process/:src/:id', async (req, res) => {
  const src = { hiyori: 'hiyori', aki: 'aki', akihabara: 'aki' }[req.params.src];
  const id = Number(req.params.id);
  if (!src || !id) return res.status(400).json({ error: 'Špatný titulek.' });
  if (!fontsEnabled()) return res.status(400).json({ error: 'Knihovna fontů je prázdná nebo chybí R2.' });
  try {
    const r = await ensureFonts(src, id, { force: true });
    if (r.state === 'gone') return res.status(404).json({ error: 'Titulek nemá soubor na R2.' });
    res.json({ ok: true, ...fontsBrief(r), fonts_bytes: r.fonts_bytes || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// smazání záznamu (z DB; soubor na R2 zůstává)
app.delete('/api/sub/:subId', requireUser1, async (req, res) => {
  const subId = Number(req.params.subId);
  const alsoR2 = req.query.r2 === '1' || req.query.r2 === 'true';

  let r2Deleted = false;
  if (alsoR2) {
    const sub = getSub(subId);
    if (sub?.r2_key) {
      try {
        r2Deleted = await r2Delete(sub.r2_key);
      } catch (e) {
        return res.status(500).json({ deleted: false, error: 'R2: ' + e.message });
      }
    }
  }
  const n = deleteSub(subId);
  res.json({ deleted: n > 0, r2_deleted: r2Deleted });
});

// vrácení staženého záznamu zpět mezi nestažené — smaže soubor z R2 a vyčistí
// evidenci, takže u něj zase půjde 📤 (nahrát správný titulek) i ⬇ (stáhnout
// znovu). Záznam v DB zůstává, ID i metadata se nemění. Jen user1.
app.post('/api/sub/:subId/reset', requireUser1, async (req, res) => {
  const subId = Number(req.params.subId);
  const sub = getSub(subId);
  if (!sub) return res.status(404).json({ error: 'Záznam nenalezen.' });

  let r2Deleted = false;
  if (sub.r2_key) {
    try {
      r2Deleted = await r2Delete(sub.r2_key);
    } catch (e) {
      return res.status(500).json({ error: 'R2: ' + e.message });
    }
  }

  // zpátky do stavu, ve kterém záznam vznikl
  const status =
    sub.kind === 'manual' ? 'not_downloaded'
    : sub.kind === 'direct' ? (CONFIG.downloadEnabled ? 'new' : 'not_downloaded')
    : 'pending_extern';

  const n = resetSubDownload(subId, status);
  res.json({ ok: n > 0, status, r2_deleted: r2Deleted });
});

// „přečas na BD" (BD auto): z původního staženého CZ titulku → indexer (anidb) →
// Tosho (BD reference) → subsync (alass) → uložení strojové verze na R2 + DB.
// Nemění původní záznam; vytvoří/přepíše navázanou strojovou verzi.
const bdOpts = (req) => ({ infohash: req.body?.infohash || null, ignorePin: !!req.body?.ignorePin });

app.post('/api/sub/:subId/bd-resync', express.json(), async (req, res) => {
  const subId = Number(req.params.subId);
  const sub = getSub(subId);
  if (!sub) return res.status(404).json({ ok: false, error: 'Záznam nenalezen.' });
  if (sub.machine_of || sub.group_name === 'BD auto') {
    return res.status(400).json({ ok: false, error: 'Tohle už je strojová verze.' });
  }
  if (sub.status !== 'downloaded' || !sub.r2_key) {
    return res.status(400).json({ ok: false, error: 'Přečas jde jen u staženého titulku (na R2).' });
  }
  if (sub.episode == null) {
    return res.status(400).json({ ok: false, error: 'Záznam nemá číslo dílu.' });
  }
  try {
    const r = await bdResync(sub, 'hiyori', bdOpts(req));
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ruční přečas na BD (hiyori): reference nahraje uživatel (raw body, .ass/.srt/.xz),
// filename v query. Zbytek stejný jako auto — uloží strojovou verzi.
app.post('/api/sub/:subId/bd-resync-manual',
  express.raw({ type: '*/*', limit: '50mb' }),
  async (req, res) => {
    const subId = Number(req.params.subId);
    const sub = getSub(subId);
    if (!sub) return res.status(404).json({ ok: false, error: 'Záznam nenalezen.' });
    if (sub.machine_of || sub.group_name === 'BD auto') {
      return res.status(400).json({ ok: false, error: 'Tohle už je strojová verze.' });
    }
    if (sub.status !== 'downloaded' || !sub.r2_key) {
      return res.status(400).json({ ok: false, error: 'Přečas jde jen u staženého titulku (na R2).' });
    }
    if (!req.body || !req.body.length) {
      return res.status(400).json({ ok: false, error: 'Prázdná reference.' });
    }
    const refName = String(req.query.filename || 'ref.ass').trim();
    try {
      const r = await bdResyncManual(sub, req.body, refName, 'hiyori');
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

// přečas na BD z ARCHIVU (akihabara). Originál je v akihabara.db (jiné ID pásmo);
// strojová verze se ukládá do HLAVNÍ subs (machine_source='akihabara'). Archiv má
// často anidb_id přímo → přečas přeskočí indexer.
function akiSubUnified(row) {
  return {
    sub_id: row.akihabara_id,
    hiyori_id: null,
    anilist_id: row.anilist_id,
    mal_id: row.mal_id,
    anidb_id: row.anidb_id,
    anime_title: row.anime_title,
    episode: row.episode,
    lang: row.lang,
    group_name: row.group_name,
    release: row.release,
    filename: row.filename,
    r2_key: row.r2_key,
    status: 'downloaded',
  };
}

// cíle hromadného přečasu — stažené díly anime bez strojové verze (hlavní tabulka)
app.get('/api/sub/:subId/bulk-bd-targets', (req, res) => {
  const ref = getSub(Number(req.params.subId));
  if (!ref) return res.status(404).json({ error: 'Záznam nenalezen.' });
  const pin = getBdPin(ref.anilist_id);
  const targets = bulkBdTargetsHiyori(ref.anilist_id, ref.mal_id, pin && pin.infohash);
  res.json({ anime_title: ref.anime_title, total: targets.length, targets, pin });
});

// cíle hromadného přečasu z archivu — dle reprezentativního akihabara_id
app.get('/api/akihabara/:akiId/bulk-bd-targets', (req, res) => {
  const ref = getAkiSub(Number(req.params.akiId));
  if (!ref) return res.status(404).json({ error: 'Archivní záznam nenalezen.' });
  const pin = getBdPin(ref.anilist_id);
  const targets = bulkBdTargetsAki(ref.anilist_id, pin && pin.infohash);
  res.json({ anime_title: ref.anime_title, total: targets.length, targets, pin });
});

// cíle hromadného přečasu z archivu — přímo dle anilist_id (tlačítko „přečasovat vše")
app.get('/api/akihabara/anime/:anilistId/bulk-bd-targets', (req, res) => {
  const pin = getBdPin(Number(req.params.anilistId));
  const targets = bulkBdTargetsAki(Number(req.params.anilistId), pin && pin.infohash);
  res.json({ total: targets.length, targets, pin });
});

// ── Ruční volba ripu ─────────────────────────────────────────────────────
// sub z hlavní tabulky nebo z archivu → jednotný tvar pro bdresync
function bdSubFrom(kind, id) {
  if (kind === 'akihabara') { const row = getAkiSub(Number(id)); return row && row.r2_key ? { sub: akiSubUnified(row) } : null; }
  const sub = getSub(Number(id));
  return sub && sub.r2_key && !sub.machine_of ? { sub } : null;
}
for (const kind of ['sub', 'akihabara']) {
  const base = kind === 'sub' ? '/api/sub/:id' : '/api/akihabara/:id';
  const src = kind === 'sub' ? 'hiyori' : 'akihabara';
  // aktuální ruční volba (levné — jen DB)
  app.get(`${base}/bd-pin`, (req, res) => {
    const x = bdSubFrom(src, req.params.id);
    if (!x) return res.status(404).json({ ok: false, error: 'Záznam nenalezen.' });
    res.json({ ok: true, anilist_id: x.sub.anilist_id || null, pin: getBdPin(x.sub.anilist_id) });
  });
  // seznam BD/DVD releasů pro okno „Vybrat rip"
  app.get(`${base}/bd-candidates`, async (req, res) => {
    const x = bdSubFrom(src, req.params.id);
    if (!x) return res.status(404).json({ ok: false, error: 'Záznam nenalezen.' });
    try { res.json(await bdCandidates(x.sub)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // „Zjistit stopy" jednoho ripu
  app.post(`${base}/bd-probe`, express.json(), async (req, res) => {
    const x = bdSubFrom(src, req.params.id);
    if (!x) return res.status(404).json({ ok: false, error: 'Záznam nenalezen.' });
    if (!req.body?.infohash) return res.status(400).json({ ok: false, error: 'Chybí infohash.' });
    try { res.json(await bdProbe(x.sub, req.body.infohash)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // zrušení ruční volby
  app.delete(`${base}/bd-pin`, (req, res) => {
    const x = bdSubFrom(src, req.params.id);
    if (!x) return res.status(404).json({ ok: false, error: 'Záznam nenalezen.' });
    clearBdPin(x.sub.anilist_id);
    res.json({ ok: true });
  });
}

app.post('/api/akihabara/:akiId/bd-resync', express.json(), async (req, res) => {
  const row = getAkiSub(Number(req.params.akiId));
  if (!row) return res.status(404).json({ ok: false, error: 'Archivní záznam nenalezen.' });
  if (!row.r2_key) return res.status(400).json({ ok: false, error: 'Archivní titulek není na R2.' });
  try {
    const r = await bdResync(akiSubUnified(row), 'akihabara', bdOpts(req));
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/akihabara/:akiId/bd-resync-manual',
  express.raw({ type: '*/*', limit: '50mb' }),
  async (req, res) => {
    const row = getAkiSub(Number(req.params.akiId));
    if (!row) return res.status(404).json({ ok: false, error: 'Archivní záznam nenalezen.' });
    if (!row.r2_key) return res.status(400).json({ ok: false, error: 'Archivní titulek není na R2.' });
    if (!req.body || !req.body.length) {
      return res.status(400).json({ ok: false, error: 'Prázdná reference.' });
    }
    const refName = String(req.query.filename || 'ref.ass').trim();
    try {
      const r = await bdResyncManual(akiSubUnified(row), req.body, refName, 'akihabara');
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

// editace popisných metadat (Fansub / Release / Jazyk). Nemění Ep ani Zdroj,
// takže stahování se nerozbije. Jen user1.
app.patch('/api/sub/:subId', requireUser1, express.json(), (req, res) => {
  const subId = Number(req.params.subId);
  if (!getSub(subId)) return res.status(404).json({ ok: false, error: 'Záznam nenalezen.' });
  const { group_name, release, lang, quality } = req.body || {};
  // prázdný string → null (vyprázdnění pole je legitimní)
  const norm = (v) => {
    if (v == null) return null;
    const t = String(v).trim();
    return t === '' ? null : t;
  };
  const n = updateSubMeta(subId, {
    group_name: norm(group_name),
    release: norm(release),
    lang: norm(lang),
    quality: norm(quality), // vyplněná = ruční volba → zamkne se
  });
  res.json({ ok: n > 0 });
});

// ── Hromadný edit celé sady (stejné anime + jazyk + skupina + release) ──
// GET  → kolik dílů sada má + jejich dnešní hodnoty (pro potvrzovací dotaz)
// PATCH → přepíše skupinu/release/jazyk/kvalitu u všech dílů sady najednou
app.get('/api/sub/:subId/set', requireUser1, (req, res) => {
  const rows = subSetSiblings(Number(req.params.subId));
  if (!rows) return res.status(404).json({ error: 'Záznam nenalezen.' });
  const counts = (pick) => {
    const m = {};
    for (const r of rows) { const k = pick(r) || '—'; m[k] = (m[k] || 0) + 1; }
    return m;
  };
  res.json({
    count: rows.length,
    episodes: rows.map((r) => r.episode),
    releases: counts((r) => r.release),
    groups: counts((r) => r.group_name),
  });
});
app.patch('/api/sub/:subId/set', requireUser1, express.json(), (req, res) => {
  const rows = subSetSiblings(Number(req.params.subId));
  if (!rows) return res.status(404).json({ ok: false, error: 'Záznam nenalezen.' });
  const norm = (v) => {
    if (v == null) return null;
    const t = String(v).trim();
    return t === '' ? null : t;
  };
  const { group_name, release, lang, quality } = req.body || {};
  const r = updateSubMetaMany(rows.map((x) => x.sub_id), {
    group_name: norm(group_name),
    release: norm(release),
    lang: norm(lang),
    quality: norm(quality),
  });
  res.json({ ok: r.updated > 0, ...r });
});

// (pře)plánování hodinového intervalu — resetuje se při každém ručním spuštění.
let intervalTimer = null;
function scheduleInterval() {
  if (CONFIG.intervalMin <= 0) return;
  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = setInterval(
    () => runOnce().catch((e) => console.error(e)),
    CONFIG.intervalMin * 60 * 1000
  );
  console.log(`Automatický scrape naplánován každých ${CONFIG.intervalMin} min (od teď).`);
}

// ruční plný běh (fetch hiyori + parsování + stahování). Reset intervalu.
app.post('/api/run', (req, res) => {
  if (isRunning()) return res.json({ started: false, reason: 'už běží' });
  runOnce().catch((e) => console.error('run error', e));
  scheduleInterval(); // od teď zas každou hodinu
  res.json({ started: true });
});

// ruční JEN stahování z fronty (bez fetche na hiyori). Neplánuje interval.
app.post('/api/download-only', (req, res) => {
  if (isRunning()) return res.json({ started: false, reason: 'už běží' });
  downloadOnce().catch((e) => console.error('download-only error', e));
  res.json({ started: true });
});

// stažení JEDNOHO konkrétního záznamu (tlačítko u čekajícího titulku).
// Synchronní — počká na výsledek a vrátí ho, ať dashboard hned ukáže stav.
app.post('/api/download-sub/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Neplatné id.' });
  try {
    const r = await downloadSingle(id);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ruční přidání anime z hiyori URL (nebo ID) — naparsuje titulky, zařadí do fronty
app.get('/api/add-anime', async (req, res) => {
  // Režim BEZ hiyori (anime na hiyori není, typicky 18+): AniList/MAL ID + rozsah dílů
  // → prázdné ruční záznamy jako u „Ruční titulky", jen bez hiyori_id.
  if (req.query.nohiyori) {
    const idFrom = (v, re) => {
      const t = String(v || '').trim();
      const m = t.match(re) || t.match(/^(\d+)$/);
      return m ? Number(m[1]) : null;
    };
    const anilistId = idFrom(req.query.anilist, /anilist\.co\/anime\/(\d+)/i);
    const malId = idFrom(req.query.mal, /myanimelist\.net\/anime\/(\d+)/i);
    const epFrom = Number(req.query.ep_from) || null;
    const epTo = Number(req.query.ep_to) || null;
    if (!anilistId && !malId) {
      return res.status(400).json({ error: 'Zadej AniList ID nebo MAL ID (číslo nebo odkaz).' });
    }
    if (!epFrom || !epTo || epTo < epFrom) {
      return res.status(400).json({ error: 'Zadej platný rozsah dílů (od–do).' });
    }
    try {
      const r = await addManualNoHiyori({
        anilistId, malId,
        title: String(req.query.title || '').trim() || null,
        epFrom, epTo,
        lang: req.query.lang || 'CZ',
        group: req.query.group || null,
        release: req.query.release || null,
      });
      if (r.error) return res.status(400).json({ error: r.error });
      return res.json({ ok: true, manual: true, nohiyori: true, ...r });
    } catch (e) {
      return res.status(500).json({ error: 'Nepodařilo se přidat anime: ' + e.message });
    }
  }

  const input = String(req.query.url || req.query.id || '').trim();
  // vytáhni hiyori_id z URL (…/anime/12345) nebo z holého čísla
  const m = input.match(/\/anime\/(\d+)/) || input.match(/^(\d+)$/);
  const hiyoriId = m ? Number(m[1]) : null;
  if (!hiyoriId) {
    return res.status(400).json({
      error: 'Zadej odkaz na anime z hiyori (např. https://hiyori.cz/anime/21389) nebo číslo.',
    });
  }
  // Ruční režim: zadán rozsah dílů → vytvoř prázdné záznamy (hiyori nemá titulky).
  const epFrom = req.query.ep_from != null ? Number(req.query.ep_from) : null;
  const epTo = req.query.ep_to != null ? Number(req.query.ep_to) : null;
  const manual = epFrom != null || epTo != null;

  try {
    if (manual) {
      const r = await addManualEpisodes(hiyoriId, {
        epFrom, epTo,
        lang: req.query.lang || 'CZ',
        group: req.query.group || null,
        release: req.query.release || null,
      });
      return res.json({
        ok: true,
        manual: true,
        hiyori_id: hiyoriId,
        title: (r.title || '').replace(/\s*-\s*Hiyori$/i, ''),
        anilist_id: r.anilistId,
        mal_id: r.malId,
        from: r.from,
        to: r.to,
        added: r.added,
      });
    }

    const r = await ingestAnime(hiyoriId, {}, { manualAdd: true });
    res.json({
      ok: true,
      hiyori_id: hiyoriId,
      title: (r.title || '').replace(/\s*-\s*Hiyori$/i, ''),
      anilist_id: r.anilistId,
      mal_id: r.malId,
      found: r.found,
      added: r.added,
      blocked: r.blocked,
      download_enabled: CONFIG.downloadEnabled,
    });
  } catch (e) {
    res.status(500).json({ error: 'Nepodařilo se načíst anime: ' + e.message });
  }
});

// ruční vložení hanabi ZIP odkazu → server stáhne z CDN, rozbalí .ass, na R2
app.post('/api/hanabi-link', express.json(), async (req, res) => {
  const subId = Number(req.body?.sub_id);
  const url = String(req.body?.url || '').trim();
  if (!subId || !url) {
    return res.status(400).json({ error: 'Chybí sub_id nebo url.' });
  }
  if (!hanabi.isValidHanabiUrl(url)) {
    return res.status(400).json({ error: 'Odkaz musí být https://img.hanabi.fan/…/*.zip' });
  }
  const sub = getSub(subId);
  if (!sub) return res.status(404).json({ error: 'Titulek nenalezen.' });

  try {
    const saved = await hanabi.downloadFromUrl(sub, url);
    // ruční akce → zpráva addonu počká, až bude anime kompletní (notify.js)
    asManualUpload(manualKeyOf(sub), () => markDownloaded({
      sub_id: subId,
      filename: saved.filename,
      local_path: saved.local_path,
      file_bytes: saved.file_bytes,
      r2_key: saved.r2_key ?? null,
    }));
    res.json({ ok: true, sub_id: subId, filename: saved.filename, file_bytes: saved.file_bytes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ruční nahrání titulku k existujícímu záznamu (.ass/.srt/.ssa/.zip)
// soubor jde jako raw binary body, sub_id a filename v query
// --- Hromadné nahrání ze ZIPu ---
// Prohlížeč archiv rozbalit neumí, dělá to server. Dvě fáze: nejdřív výpis
// obsahu (pro náhled), po potvrzení nahrání vybraných souborů.

// 1) obsah archivu — jen titulkové soubory
app.post('/api/bulk-zip', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Prázdný soubor.' });
  let entries;
  try {
    entries = new AdmZip(req.body).getEntries()
      .filter((e) => !e.isDirectory && /\.(ass|srt|ssa)$/i.test(e.entryName))
      .map((e) => ({ entry: e.entryName, name: e.entryName.split('/').pop(), size: e.header.size }));
  } catch (e) {
    return res.status(400).json({ error: 'Archiv nejde otevřít (podporovaný je jen ZIP): ' + e.message });
  }
  if (!entries.length) return res.status(400).json({ error: 'V archivu nejsou .ass/.srt/.ssa soubory.' });
  res.json({ entries });
});

// 2) nahrání: map = { "cesta/v/zipu.ass": sub_id }
app.post('/api/bulk-zip-commit', express.json({ limit: '80mb' }), async (req, res) => {
  const b64 = req.body?.zip_b64;
  const map = req.body?.map;
  if (!b64 || !map || typeof map !== 'object') return res.status(400).json({ error: 'Chybí archiv nebo přiřazení dílů.' });

  let zip;
  try { zip = new AdmZip(Buffer.from(b64, 'base64')); }
  catch (e) { return res.status(400).json({ error: 'Archiv nejde otevřít: ' + e.message }); }

  const chyby = [];
  let nahrano = 0;
  beginSubsBatch();          // addon dostane jednu zprávu za celé hromadné nahrání (notify.js)
  try {
  for (const [entryName, subIdRaw] of Object.entries(map)) {
    const subId = Number(subIdRaw);
    try {
      const entry = zip.getEntry(entryName);
      if (!entry) { chyby.push({ entry: entryName, error: 'v archivu nenalezeno' }); continue; }
      const sub = getSub(subId);
      if (!sub) { chyby.push({ entry: entryName, error: 'záznam nenalezen' }); continue; }
      const name = entryName.split('/').pop();
      const grp = sub.group_name || (name.match(/\[([^\]]+)\]/)?.[1]?.trim() ?? null);
      const saved = await saveSubFile({ ...sub, group_name: grp }, entry.getData(), name);
      markDownloaded({
        sub_id: subId,
        filename: saved.filename,
        local_path: saved.local_path,
        file_bytes: saved.file_bytes,
        r2_key: saved.r2_key ?? null,
      });
      nahrano++;
    } catch (e) {
      chyby.push({ entry: entryName, error: e.message });
    }
  }
  } finally {
    endSubsBatch();
  }
  res.json({ ok: true, uploaded: nahrano, errors: chyby });
});

app.post('/api/upload-sub',
  express.raw({ type: '*/*', limit: '50mb' }),
  async (req, res) => {
    const subId = Number(req.query.sub_id);
    const rawName = String(req.query.filename || 'titulky').trim();
    if (!subId) return res.status(400).json({ error: 'Chybí sub_id.' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Prázdný soubor.' });

    const sub = getSub(subId);
    if (!sub) return res.status(404).json({ error: 'Záznam nenalezen.' });

    const ext = (rawName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    if (!['ass', 'srt', 'ssa', 'zip'].includes(ext)) {
      return res.status(400).json({ error: 'Povolené: .ass, .srt, .ssa, .zip' });
    }

    try {
      let buf = req.body;
      let name = rawName;

      // ZIP → vytáhni první titulek
      if (ext === 'zip') {
        const zip = new AdmZip(buf);
        const entry =
          zip.getEntries().find((e) => /\.ass$/i.test(e.entryName) && !e.isDirectory) ||
          zip.getEntries().find((e) => /\.(srt|ssa)$/i.test(e.entryName) && !e.isDirectory);
        if (!entry) return res.status(400).json({ error: 'V ZIPu není .ass/.srt titulek.' });
        buf = entry.getData();
        name = entry.entryName.split('/').pop();
      }

      // skupina z názvu, když v DB chybí
      const grp = sub.group_name || (name.match(/\[([^\]]+)\]/)?.[1]?.trim() ?? null);
      const saved = await saveSubFile({ ...sub, group_name: grp }, buf, name);

      // ruční nahrání → zpráva addonu počká, až bude anime kompletní (notify.js)
      asManualUpload(manualKeyOf(sub), () => markDownloaded({
        sub_id: subId,
        filename: saved.filename,
        local_path: saved.local_path,
        file_bytes: saved.file_bytes,
        r2_key: saved.r2_key ?? null,
      }));
      res.json({ ok: true, sub_id: subId, filename: saved.filename, file_bytes: saved.file_bytes });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
app.get('/api/file/:subId', async (req, res) => {
  const sub = getSub(Number(req.params.subId));
  if (!sub) return res.status(404).send('Titulek nenalezen.');

  let outName = (sub.filename || `sub-${sub.sub_id}.ass`).replace(/\.gz$/i, '');

  // ?fonts=1 → verze s vloženými fonty (když k aktuálnímu souboru existuje)
  let key = sub.r2_key;
  if (req.query.fonts === '1' && sub.r2_key) {
    const fr = getSubFonts('hiyori', sub.sub_id);
    if (fr?.fonts_key && fr.r2_key === sub.r2_key) {
      key = fr.fonts_key;
      outName = outName.replace(/(\.[^.]+)?$/, (ext) => ` (fonty)${ext}`);
    }
  }

  // 1) primárně z R2 (.gz) → rozbalit → poslat .ass
  if (key) {
    try {
      const gz = await r2Get(key);
      if (gz) {
        const ass = zlib.gunzipSync(gz);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(outName)}"`);
        return res.send(ass);
      }
    } catch (e) {
      console.error('R2 file fetch:', e.message);
    }
  }

  // 2) fallback: lokální syrová kopie (když R2 není / selhalo)
  if (sub.local_path && fs.existsSync(sub.local_path)) {
    return res.download(sub.local_path, outName);
  }

  return res.status(404).send('Soubor není k dispozici.');
});

// Chyby vracej jako JSON — frontend všude dělá res.json(), takže HTML chybová
// stránka Expressu by skončila jako „Unexpected token '<'". Např. příliš velký
// nahraný soubor (PayloadTooLargeError).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tooBig = err && (err.type === 'entity.too.large' || err.status === 413);
  console.error('[error]', req.method, req.path, '-', err && err.message);
  res.status(tooBig ? 413 : err.status || 500).json({
    ok: false,
    error: tooBig
      ? `Soubor je příliš velký (limit ${req.path.startsWith('/api/fonts') ? '300' : '50'} MB).`
      : (err && err.message) || 'Neočekávaná chyba serveru.',
  });
});


// přečíslování starých strojových ID (2e9/3e9) do nového pásma — dřív, než přijde první požadavek
try {
  const n = migrateMachineIds();
  if (n) console.log(`[machine-ids] přečíslováno ${n} strojových verzí do nového pásma`);
} catch (e) { console.error('[machine-ids] migrace selhala:', e.message); }

// knihovna fontů pro vkládání do .ass (čte jen nové/změněné soubory, zbytek z .index.json)
try {
  const lib = loadLibrary();
  console.log(
    `[fonty] knihovna ${lib.dir}: ${lib.faces.length} řezů v ${lib.files} souborech (${Math.round(lib.bytes / 1048576)} MB)` +
    (lib.faces.length ? '' : ' — vkládání fontů je vypnuté, dokud v dashboardu nenahraješ fonty')
  );
} catch (e) { console.error('[fonty] knihovna:', e.message); }

app.listen(CONFIG.port, () => {
  console.log(`NimeToDex Titulky běží na portu ${CONFIG.port}`);
  // jednorázové doplnění kvality u starších záznamů (ruční volby nechá být)
  try {
    const n = backfillQuality();
    if (n) console.log(`[quality] doplněno u ${n} titulků`);
  } catch (e) { console.error('[quality] backfill selhal:', e.message); }
  // animetitulky.com odhlašuje po 24 h neaktivity → 2× denně se ozvat s cookie
  startAtKeepAlive();
  console.log(`Data dir: ${CONFIG.dataDir}`);
  if (!CONFIG.auth.user || !CONFIG.auth.pass) {
    console.log('⚠ Dashboard NENÍ chráněný (nastav AUTH_USER a AUTH_PASS).');
  } else {
    console.log(
      '🔒 Dashboard chráněný Basic Auth' +
      (CONFIG.auth.user2 && CONFIG.auth.pass2 ? ' (2 účty).' : ' (1 účet).')
    );
  }

  // Žádný automatický fetch po startu ani pevný interval.
  // Interval se rozjede až po ručním "Spustit teď" (viz scheduleInterval).
  console.log('Po startu se automaticky NEfetchuje. Spusť ručně přes "Spustit teď".');

  // Keep-alive: webzdarma smaže web, když na něj měsíc nikdo nepřijde.
  // Jednou týdně pingneme hostitele agenta (GET na jeho kořen) — udrží web
  // naživu a zároveň ověří, že agent žije.
  startAgentKeepAlive();

  // Denní záloha DB na R2 (retence 7 dní).
  startDbBackup();
});

function startAgentKeepAlive() {
  if (!CONFIG.agent.url) return; // agent nenastaven → nic
  let host;
  try {
    host = new URL(CONFIG.agent.url).origin; // http://nimetodex.xf.cz
  } catch {
    return;
  }
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const ping = async () => {
    try {
      const r = await fetch(host + '/', {
        headers: { 'User-Agent': 'NimeToDex-KeepAlive/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      console.log(`[keep-alive] ${host} → HTTP ${r.status} (${new Date().toISOString()})`);
    } catch (e) {
      console.log(`[keep-alive] ${host} selhalo: ${e.message}`);
    }
  };
  // první ping za 1 min po startu (ať se to nepere se startem), pak každý týden
  setTimeout(ping, 60_000);
  setInterval(ping, WEEK).unref();
}
