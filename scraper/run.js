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

    // 3) distinct hiyori_id (zachovej metadata z karty pro title/lang)
    const byId = new Map();
    for (const c of fresh) if (!byId.has(c.hiyoriId)) byId.set(c.hiyoriId, c);
    let ids = [...byId.keys()].slice(0, CONFIG.maxDetailsPerRun);
    log(`Ke kontrole: ${ids.length} anime (z ${byId.size} čerstvých)`);

    // 4) detaily
    let consecErrors = 0;
    for (const hiyoriId of ids) {
      stats.anime_checked++;
      const card = byId.get(hiyoriId);
      try {
        const detail = await getDetail(hiyoriId);
        upsertAnime({
          hiyori_id: hiyoriId,
          anilist_id: detail.anilist_id,
          mal_id: detail.mal_id,
          title: detail.title || card.title,
          type: detail.type,
        });

        for (const row of detail.rows) {
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
                ? CONFIG.downloadEnabled
                  ? 'new'
                  : 'not_downloaded'
                : 'pending_extern',
          });
          if (changed) stats.new_subs++;
        }
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

    // 5) stahování — fronta z DB (i nedostažené z minulých běhů), limit za běh
    if (!CONFIG.downloadEnabled) {
      log('Stahování vypnuté (DOWNLOAD_ENABLED != true) — jen evidence.');
    }
    let batch = [];
    if (CONFIG.downloadEnabled) {
      const candidates = getDownloadCandidates(CONFIG.maxDownloadsPerRun * 6);
      for (const s of candidates) {
        if (batch.length >= CONFIG.maxDownloadsPerRun) break;
        if (s.kind === 'direct') batch.push(s.sub_id);
        else if (s.kind === 'extern' && hasSourceFor(s.extern_domain)) batch.push(s.sub_id);
      }
      // kolik extern titulků čeká na dosud nenapsaný parser (jen pro přehled)
      stats.extern_pending = pendingExternByDomain()
        .filter((r) => !hasSourceFor(r.extern_domain))
        .reduce((sum, r) => sum + r.c, 0);
      log(
        `Ke stažení teď: ${batch.length}` +
        (candidates.length > batch.length ? ` (limit ${CONFIG.maxDownloadsPerRun}/běh, ve frontě víc)` : '')
      );
    }
    for (const subId of batch) {
      const sub = getSub(subId);
      if (!sub) continue;
      try {
        let res;
        if (sub.kind === 'direct') {
          res = await downloadDirect(sub);
        } else {
          const ext = await downloadExtern(sub);
          if (!ext.supported) continue; // parser pro tuto doménu ještě není
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
