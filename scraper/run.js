// scraper/run.js — jeden běh scrapu: feed -> detaily -> uložení -> stažení přímých.
import { CONFIG, assertConfig } from '../config.js';
import { getFeed } from './feed.js';
import { getDetail } from './detail.js';
import { downloadDirect } from './download.js';
import { downloadExtern, hasSourceFor } from './sources/index.js';
import { sleep, throttle, RateLimited } from './http.js';
import {
  getMeta, setMeta, upsertAnime, insertSub, getSub,
  markDownloaded, markFailed, startRun, finishRun,
  getDownloadCandidates, pendingExternByDomain,
} from '../db.js';

let running = false;
export const isRunning = () => running;

// Naparsuje jedno anime z hiyori (detail) a uloží jeho titulky do DB.
// onlyEpisodes = Set čísel epizod → uloží jen ty díly (automatický scrape z feedu).
// onlyEpisodes = null/prázdné → uloží celou tabulku (ruční přidání přes URL).
// Vrací { found, added, title, anilistId, malId }.
export async function ingestAnime(hiyoriId, card = {}, { onlyEpisodes = null } = {}) {
  const detail = await getDetail(hiyoriId);
  upsertAnime({
    hiyori_id: hiyoriId,
    anilist_id: detail.anilist_id,
    mal_id: detail.mal_id,
    title: detail.title || card.title,
    type: detail.type,
  });

  // filtr na přidané epizody (jen u automatického scrape)
  const useFilter = onlyEpisodes && onlyEpisodes.size > 0;
  const rows = useFilter
    ? detail.rows.filter((r) => r.episode != null && onlyEpisodes.has(r.episode))
    : detail.rows;

  let added = 0;
  for (const row of rows) {
    const changed = insertSub({
      sub_id: row.sub_id,
      hiyori_id: hiyoriId,
      anilist_id: detail.anilist_id,
      mal_id: detail.mal_id,
      anime_title: detail.title || card.title,
      episode: row.episode,
      lang: row.lang || card.lang,
      group_id: row.group_id,
      group_name: row.group_name,
      release: row.release,
      version: row.version,
      kind: row.kind,
      url: row.url,
      extern_domain: row.extern_domain,
      added_date: row.added_date || card.addedDate,
      first_seen: new Date().toISOString(),
      status:
        row.kind === 'direct'
          ? CONFIG.downloadEnabled ? 'new' : 'not_downloaded'
          : 'pending_extern',
    });
    if (changed) added++;
  }
  return {
    found: rows.length,
    added,
    title: detail.title,
    anilistId: detail.anilist_id,
    malId: detail.mal_id,
  };
}

// Stahovací fáze — vezme frontu z DB, per-web limit, stáhne + nahraje na R2.
// Sdílená mezi plným během (runOnce) a ručním "jen stahování" (downloadOnce).
async function downloadQueue({ log, stats }) {
  if (!CONFIG.downloadEnabled) {
    log('Stahování vypnuté (DOWNLOAD_ENABLED != true) — jen evidence.');
    return;
  }
  // vezmi širokou frontu a rozděl per web (direct = hiyori.cz)
  const candidates = getDownloadCandidates(500);
  const perHost = new Map();
  const hostOf = (s) => (s.kind === 'direct' ? 'hiyori.cz' : s.extern_domain || '?');
  const batch = [];

  for (const s of candidates) {
    if (CONFIG.maxDownloadsPerRun > 0 && batch.length >= CONFIG.maxDownloadsPerRun) break;
    if (s.kind === 'extern' && !hasSourceFor(s.extern_domain)) continue;
    const host = hostOf(s);
    const used = perHost.get(host) || 0;
    if (used >= CONFIG.maxDownloadsPerHost) continue;
    perHost.set(host, used + 1);
    batch.push(s.sub_id);
  }

  stats.extern_pending = pendingExternByDomain()
    .filter((r) => !hasSourceFor(r.extern_domain))
    .reduce((sum, r) => sum + r.c, 0);

  const perHostSummary = [...perHost.entries()].map(([h, n]) => `${h}:${n}`).join(', ');
  log(
    `Ke stažení teď: ${batch.length}` +
    (perHostSummary ? ` (max ${CONFIG.maxDownloadsPerHost}/web — ${perHostSummary})` : '')
  );

  for (const subId of batch) {
    const sub = getSub(subId);
    if (!sub) continue;
    try {
      let res;
      if (sub.kind === 'direct') {
        res = await downloadDirect(sub);
      } else {
        const ext = await downloadExtern(sub);
        if (!ext.supported) continue;
        res = ext;
      }
      markDownloaded({
        sub_id: subId,
        filename: res.filename,
        local_path: res.local_path,
        file_bytes: res.file_bytes,
        r2_key: res.r2_key ?? null,
      });
      stats.downloaded++;
    } catch (e) {
      if (e instanceof RateLimited) {
        log('  ⛔ ' + e.message + ' — utínám stahování.');
        throw e;
      }
      markFailed(subId, e.message);
      stats.failed++;
      log(`  ✗ stažení sub ${subId}: ${e.message}`);
    }
    await throttle();
  }
}

// Ruční "jen stahování" — dočistí frontu z DB, ŽÁDNÝ dotaz na hiyori feed.
export async function downloadOnce({ log = console.log } = {}) {
  if (running) {
    log('Už běží, přeskočeno.');
    return { skipped: true };
  }
  running = true;
  const runId = startRun();
  const stats = {
    feed_cards: 0, anime_checked: 0, new_subs: 0,
    downloaded: 0, extern_pending: 0, failed: 0,
  };
  let ok = 0;
  let errMsg = null;
  try {
    log('Ruční stahování z fronty (bez fetche na hiyori).');
    await downloadQueue({ log, stats });
    ok = 1;
    log(`Hotovo (jen stahování): staženo=${stats.downloaded}, chyby=${stats.failed}`);
  } catch (e) {
    errMsg = e.message;
    log('CHYBA stahování: ' + e.message);
  } finally {
    finishRun({ id: runId, ok, error: errMsg, ...stats });
    running = false;
  }
  return { ok: !!ok, ...stats, error: errMsg };
}

export async function runOnce({ log = console.log } = {}) {
  if (running) {
    log('Scrape už běží, přeskočeno.');
    return { skipped: true };
  }
  running = true;
  assertConfig();

  const runId = startRun();
  const stats = {
    feed_cards: 0, anime_checked: 0, new_subs: 0,
    downloaded: 0, extern_pending: 0, failed: 0,
  };
  let ok = 0;
  let errMsg = null;

  try {
    // 1) feed
    const feed = await getFeed();
    stats.feed_cards = feed.length;
    log(`Feed: ${feed.length} karet`);

    // 2) filtr podle času posledního běhu (s překryvem)
    const lastRunIso = getMeta('last_run_iso');
    let cutoff = null;
    if (lastRunIso) {
      cutoff = new Date(lastRunIso);
      cutoff.setMinutes(cutoff.getMinutes() - CONFIG.feedOverlapMin);
    }
    const fresh = feed.filter((c) => !cutoff || !c.addedAt || c.addedAt >= cutoff);

    // 3) seskup podle hiyori_id — posbírej VŠECHNY přidané epizody (anime může být ve feedu víckrát)
    const byId = new Map(); // hiyoriId -> { card, episodes:Set }
    for (const c of fresh) {
      if (!byId.has(c.hiyoriId)) byId.set(c.hiyoriId, { card: c, episodes: new Set() });
      if (c.episode != null) byId.get(c.hiyoriId).episodes.add(c.episode);
    }
    let ids = [...byId.keys()].slice(0, CONFIG.maxDetailsPerRun);
    log(`Ke kontrole: ${ids.length} anime (z ${byId.size} čerstvých)`);

    // 4) detaily — z detailu vezmi jen přidané epizody (dané feedem)
    let consecErrors = 0;
    for (const hiyoriId of ids) {
      stats.anime_checked++;
      const { card, episodes } = byId.get(hiyoriId);
      try {
        const r = await ingestAnime(hiyoriId, card, { onlyEpisodes: episodes });
        stats.new_subs += r.added;
        consecErrors = 0; // úspěch → vynulovat řadu chyb
      } catch (e) {
        if (e instanceof RateLimited) {
          log('  ⛔ ' + e.message + ' — utínám běh, ať nedostaneme ban.');
          throw e; // rate-limit = okamžitě ukončit celý běh
        }
        consecErrors++;
        log(`  ⚠ detail ${hiyoriId}: ${e.message} (chyb v řadě: ${consecErrors})`);
        if (consecErrors >= CONFIG.maxConsecutiveErrors) {
          throw new Error(
            `${consecErrors} chyb v řadě — utínám běh (server možná brzdí / je dole).`
          );
        }
      }
      await throttle();
    }

    // 5) stahování — sdílená fronta z DB (i nedostažené z minulých běhů)
    await downloadQueue({ log, stats });

    setMeta('last_run_iso', new Date().toISOString());
    ok = 1;
    log(
      `Hotovo: nové=${stats.new_subs}, staženo=${stats.downloaded}, ` +
      `extern_čeká=${stats.extern_pending}, chyby=${stats.failed}`
    );
  } catch (e) {
    errMsg = e.message;
    log('CHYBA běhu: ' + e.message);
  } finally {
    finishRun({ id: runId, ok, error: errMsg, ...stats });
    running = false;
  }

  return { ok: !!ok, ...stats, error: errMsg };
}

// umožní spustit ručně: `node scraper/run.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  runOnce().then(() => process.exit(0));
}
