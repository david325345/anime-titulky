// server.js — web dashboard + API + hodinový scrape interval.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { runOnce, isRunning } from './scraper/run.js';
import {
  overviewCounts, recentSubs, recentRuns, getMeta, getSub,
} from './db.js';

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
