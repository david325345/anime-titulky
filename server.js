// server.js — web dashboard + API + hodinový scrape interval.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { runOnce, isRunning, ingestAnime } from './scraper/run.js';
import {
  overviewCounts, recentSubs, recentRuns, getMeta, getSub, findSubs, subsAvailability,
  listSubs, deleteSub, recentlyAdded,
} from './db.js';
import { r2PublicUrl, r2Get } from './r2.js';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// --- Basic Auth (dashboard + admin). Když AUTH_USER/AUTH_PASS chybí, nechrání se. ---
function basicAuth(req, res, next) {
  const { user, pass } = CONFIG.auth;
  if (!user || !pass) return next(); // nenastaveno → veřejné (viz upozornění v logu)
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/i);
  if (m) {
    const [u, p] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    if (u === user && p === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="NimeToDex Titulky"');
  return res.status(401).send('Přihlášení vyžadováno.');
}

// ==================================================================
// VEŘEJNÉ endpointy pro addon (registrované PŘED auth → nechráněné)
// ==================================================================

// GET /api/subs?anilist=154587&mal=52991&episode=5[&lang=CZ]
// Vrací stažené titulky (na R2) — přednost anilist, fallback mal.
app.get('/api/subs', (req, res) => {
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
  const subs = rows.map((r) => ({
    sub_id: r.sub_id,
    lang: r.lang,
    group: r.group_name,
    release: r.release,
    version: r.version,
    episode: r.episode,
    kind: r.kind,
    source: r.extern_domain || 'hiyori',
    filename: r.filename ? r.filename.replace(/\.gz$/i, '') : null,
    file_bytes: r.file_bytes,
    r2_key: r.r2_key,
    gz_url: r2PublicUrl(r.r2_key), // veřejný odkaz na .gz (addon si rozbalí)
  }));

  res.json({ matched_by: matchedBy, count: subs.length, subs });
});

// GET /api/subs/available?anilist=154587&mal=52991[&episode=5]
// Rychlá odpověď, zda pro anime/díl máme titulky na R2 (bez plných dat).
app.get('/api/subs/available', (req, res) => {
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
  });
});

// GET /api/recent[?days=N] — dnes přidané stažené titulky (na R2), seskupené.
// Bez days = dnešní den od půlnoci. Veřejné (pro addon).
app.get('/api/recent', (req, res) => {
  const days = req.query.days != null && req.query.days !== ''
    ? Math.max(1, Number(req.query.days) || 1)
    : null;
  let since;
  if (days) {
    since = new Date(Date.now() - days * 86400000); // posledních N dní
  } else {
    since = new Date();
    since.setHours(0, 0, 0, 0); // dnešní den od půlnoci (lokální čas serveru)
  }
  const sinceIso = since.toISOString();
  const items = recentlyAdded(sinceIso);
  res.json({ since: sinceIso, count: items.length, items });
});

// ==================================================================
// Od tohoto bodu je vše CHRÁNĚNO Basic Auth (dashboard + admin)
// ==================================================================
app.use(basicAuth);

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
  res.json({
    page,
    per_page: perPage,
    total,
    pages: Math.max(1, Math.ceil(total / perPage)),
    subs: rows,
  });
});

// smazání záznamu (z DB; soubor na R2 zůstává)
app.delete('/api/sub/:subId', (req, res) => {
  const n = deleteSub(Number(req.params.subId));
  res.json({ deleted: n > 0 });
});

// ruční spuštění scrapu
app.post('/api/run', (req, res) => {
  if (isRunning()) return res.json({ started: false, reason: 'už běží' });
  runOnce().catch((e) => console.error('run error', e));
  res.json({ started: true });
});

// ruční přidání anime z hiyori URL (nebo ID) — naparsuje titulky, zařadí do fronty
app.get('/api/add-anime', async (req, res) => {
  const input = String(req.query.url || req.query.id || '').trim();
  // vytáhni hiyori_id z URL (…/anime/12345) nebo z holého čísla
  const m = input.match(/\/anime\/(\d+)/) || input.match(/^(\d+)$/);
  const hiyoriId = m ? Number(m[1]) : null;
  if (!hiyoriId) {
    return res.status(400).json({
      error: 'Zadej odkaz na anime z hiyori (např. https://hiyori.cz/anime/21389) nebo číslo.',
    });
  }
  try {
    const r = await ingestAnime(hiyoriId);
    res.json({
      ok: true,
      hiyori_id: hiyoriId,
      title: (r.title || '').replace(/\s*-\s*Hiyori$/i, ''),
      anilist_id: r.anilistId,
      mal_id: r.malId,
      found: r.found,
      added: r.added,
      download_enabled: CONFIG.downloadEnabled,
    });
  } catch (e) {
    res.status(500).json({ error: 'Nepodařilo se načíst anime: ' + e.message });
  }
});

// stažení konkrétního titulku z UI — rozbalený .ass (z R2 .gz, fallback lokální)
app.get('/api/file/:subId', async (req, res) => {
  const sub = getSub(Number(req.params.subId));
  if (!sub) return res.status(404).send('Titulek nenalezen.');

  const outName = (sub.filename || `sub-${sub.sub_id}.ass`).replace(/\.gz$/i, '');

  // 1) primárně z R2 (.gz) → rozbalit → poslat .ass
  if (sub.r2_key) {
    try {
      const gz = await r2Get(sub.r2_key);
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

app.listen(CONFIG.port, () => {
  console.log(`NimeToDex Titulky běží na portu ${CONFIG.port}`);
  console.log(`Data dir: ${CONFIG.dataDir}`);
  if (!CONFIG.auth.user || !CONFIG.auth.pass) {
    console.log('⚠ Dashboard NENÍ chráněný (nastav AUTH_USER a AUTH_PASS).');
  } else {
    console.log('🔒 Dashboard chráněný Basic Auth.');
  }

  if (CONFIG.runOnBoot) {
    setTimeout(() => runOnce().catch((e) => console.error(e)), 5000);
  }
  if (CONFIG.intervalMin > 0) {
    setInterval(
      () => runOnce().catch((e) => console.error(e)),
      CONFIG.intervalMin * 60 * 1000
    );
    console.log(`Automatický scrape každých ${CONFIG.intervalMin} min.`);
  }
});
