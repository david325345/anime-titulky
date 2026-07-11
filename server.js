// server.js — web dashboard + API + hodinový scrape interval.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { runOnce, isRunning } from './scraper/run.js';
import {
  overviewCounts, recentSubs, recentRuns, getMeta, getSub, findSubs, subsAvailability,
} from './db.js';
import { r2PublicUrl } from './r2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

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
    subs: recentSubs(120),
    runs: recentRuns(12),
  });
});

// ruční spuštění scrapu
app.post('/api/run', (req, res) => {
  if (isRunning()) return res.json({ started: false, reason: 'už běží' });
  runOnce().catch((e) => console.error('run error', e));
  res.json({ started: true });
});

// === LOOKUP endpoint pro addon ===
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

// === AVAILABILITY endpoint pro addon ===
// GET /api/subs/available?anilist=154587&mal=52991
// Rychlá odpověď, zda pro anime máme titulky na R2 (bez plných dat).
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
    available: a.total > 0,
    matched_by: a.matchedBy,
    episode, // který díl se ptal (null = celé anime)
    total: a.total,
    langs: a.langs, // ['CZ','SK']
    episodes: a.episodes, // [1,2,3,4] (u dotazu na díl jen ten díl)
  });
});

// stažení konkrétního titulku z UI
app.get('/api/file/:subId', (req, res) => {
  const sub = getSub(Number(req.params.subId));
  if (!sub || !sub.local_path || !fs.existsSync(sub.local_path)) {
    return res.status(404).send('Soubor není k dispozici.');
  }
  res.download(sub.local_path, sub.filename || `sub-${sub.sub_id}`);
});

app.listen(CONFIG.port, () => {
  console.log(`NimeToDex Titulky běží na portu ${CONFIG.port}`);
  console.log(`Data dir: ${CONFIG.dataDir}`);

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
