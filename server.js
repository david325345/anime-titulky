// server.js — web dashboard + API + hodinový scrape interval.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { runOnce, downloadOnce, isRunning, ingestAnime } from './scraper/run.js';
import {
  overviewCounts, recentSubs, recentRuns, getMeta, getSub, findSubs, subsAvailability,
  listSubs, deleteSub, recentlyAdded, markDownloaded, allSubs,
} from './db.js';
import * as hanabi from './scraper/sources/hanabi.js';
import { saveSubFile } from './scraper/download.js';
import AdmZip from 'adm-zip';
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

// GET /api/all — kompletní výpis všeho staženého na R2, seskupené po anime.
// Bez stránkování. Pro zálohu / import do jiného nástroje / přehled.
app.get('/api/all', (req, res) => {
  const { items, subsTotal } = allSubs();
  // dopočítej veřejný R2 odkaz, r2_key ven neposíláme (duplikoval by gz_url)
  for (const a of items) {
    for (const ep of a.episodes) {
      for (const s of ep.subs) {
        s.gz_url = r2PublicUrl(s.r2_key);
        delete s.r2_key;
      }
    }
  }
  res.json({ count: items.length, subs_total: subsTotal, items });
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
    markDownloaded({
      sub_id: subId,
      filename: saved.filename,
      local_path: saved.local_path,
      file_bytes: saved.file_bytes,
      r2_key: saved.r2_key ?? null,
    });
    res.json({ ok: true, sub_id: subId, filename: saved.filename, file_bytes: saved.file_bytes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ruční nahrání titulku k existujícímu záznamu (.ass/.srt/.ssa/.zip)
// soubor jde jako raw binary body, sub_id a filename v query
app.post('/api/upload-sub',
  express.raw({ type: '*/*', limit: '5mb' }),
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

      markDownloaded({
        sub_id: subId,
        filename: saved.filename,
        local_path: saved.local_path,
        file_bytes: saved.file_bytes,
        r2_key: saved.r2_key ?? null,
      });
      res.json({ ok: true, sub_id: subId, filename: saved.filename, file_bytes: saved.file_bytes });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
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

  // Žádný automatický fetch po startu ani pevný interval.
  // Interval se rozjede až po ručním "Spustit teď" (viz scheduleInterval).
  console.log('Po startu se automaticky NEfetchuje. Spusť ručně přes "Spustit teď".');
});
