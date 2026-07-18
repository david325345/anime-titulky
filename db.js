// db.js — SQLite (better-sqlite3). Jeden writer = tato služba, takže běžné zápisy jsou OK.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

fs.mkdirSync(CONFIG.dataDir, { recursive: true });
export const dbPath = path.join(CONFIG.dataDir, 'hiyori.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 8000');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- cache mapování hiyori_id -> externí ID (detail navštěvujeme jen kvůli novým titulkům)
CREATE TABLE IF NOT EXISTS anime_map (
  hiyori_id   INTEGER PRIMARY KEY,
  anilist_id  INTEGER,
  mal_id      INTEGER,
  title       TEXT,
  type        TEXT,
  first_seen  TEXT,
  last_seen   TEXT
);

-- jeden řádek = jeden titulek. sub_id = dedup klíč (z hiyori).
CREATE TABLE IF NOT EXISTS subs (
  sub_id        INTEGER PRIMARY KEY,
  hiyori_id     INTEGER,
  anilist_id    INTEGER,
  mal_id        INTEGER,
  anime_title   TEXT,
  episode       INTEGER,
  lang          TEXT,          -- CZ / SK
  group_id      INTEGER,
  group_name    TEXT,
  release       TEXT,          -- na jaký video release titulek sedí
  version       TEXT,
  kind          TEXT,          -- 'direct' | 'extern'
  url           TEXT,          -- downloadsubtitles?id=... NEBO externí URL
  extern_domain TEXT,          -- NULL | wosir.cz | hns.sk | ...
  added_date    TEXT,          -- datum přidání na hiyori (jak ho hlásí web)
  first_seen    TEXT,          -- kdy to poprvé viděl scraper
  status        TEXT,          -- 'new' | 'downloaded' | 'failed' | 'pending_extern' | 'skipped'
  error         TEXT,
  filename      TEXT,
  local_path    TEXT,
  file_bytes    INTEGER,
  r2_key        TEXT,           -- klíč na R2 (subs/{anilist}/E{ep}/...gz)
  downloaded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_subs_status   ON subs(status);
CREATE INDEX IF NOT EXISTS idx_subs_anilist  ON subs(anilist_id);
CREATE INDEX IF NOT EXISTS idx_subs_seen     ON subs(first_seen);

-- log jednotlivých běhů scrapu (pro dashboard)
CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     TEXT,
  finished_at    TEXT,
  ok             INTEGER,       -- 1/0
  feed_cards     INTEGER,
  anime_checked  INTEGER,
  new_subs       INTEGER,
  downloaded     INTEGER,
  extern_pending INTEGER,
  failed         INTEGER,
  error          TEXT
);
`);

// --- migrace: doplní chybějící sloupce ve starších DB (idempotentně) ---
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
ensureColumn('subs', 'r2_key', 'TEXT');

// --- meta helpers ---
const _getMeta = db.prepare('SELECT value FROM meta WHERE key=?');
const _setMeta = db.prepare(
  'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
);
export const getMeta = (k) => _getMeta.get(k)?.value ?? null;
export const setMeta = (k, v) => _setMeta.run(k, String(v));

// --- anime_map ---
const _getAnime = db.prepare('SELECT * FROM anime_map WHERE hiyori_id=?');
const _upsertAnime = db.prepare(`
  INSERT INTO anime_map(hiyori_id,anilist_id,mal_id,title,type,first_seen,last_seen)
  VALUES(@hiyori_id,@anilist_id,@mal_id,@title,@type,@now,@now)
  ON CONFLICT(hiyori_id) DO UPDATE SET
    anilist_id=COALESCE(excluded.anilist_id,anime_map.anilist_id),
    mal_id    =COALESCE(excluded.mal_id,anime_map.mal_id),
    title     =COALESCE(excluded.title,anime_map.title),
    type      =COALESCE(excluded.type,anime_map.type),
    last_seen =excluded.last_seen
`);
export const getAnime = (id) => _getAnime.get(id);
export const upsertAnime = (row) =>
  _upsertAnime.run({ now: new Date().toISOString(), ...row });

// --- subs ---
const _subExists = db.prepare('SELECT 1 FROM subs WHERE sub_id=?');
const _insertSub = db.prepare(`
  INSERT OR IGNORE INTO subs
    (sub_id,hiyori_id,anilist_id,mal_id,anime_title,episode,lang,group_id,group_name,
     release,version,kind,url,extern_domain,added_date,first_seen,status)
  VALUES
    (@sub_id,@hiyori_id,@anilist_id,@mal_id,@anime_title,@episode,@lang,@group_id,@group_name,
     @release,@version,@kind,@url,@extern_domain,@added_date,@first_seen,@status)
`);
export const subExists = (id) => !!_subExists.get(id);
export const insertSub = (row) => _insertSub.run(row).changes; // 1 = nově vloženo

const _markDownloaded = db.prepare(`
  UPDATE subs SET status='downloaded', filename=@filename, local_path=@local_path,
    file_bytes=@file_bytes, r2_key=@r2_key, downloaded_at=@downloaded_at, error=NULL
  WHERE sub_id=@sub_id
`);
const _markFailed = db.prepare(
  "UPDATE subs SET status='failed', error=@error WHERE sub_id=@sub_id"
);
export const markDownloaded = (row) =>
  _markDownloaded.run({ downloaded_at: new Date().toISOString(), ...row });
export const markFailed = (sub_id, error) =>
  _markFailed.run({ sub_id, error: String(error).slice(0, 500) });

export const getSub = (id) => db.prepare('SELECT * FROM subs WHERE sub_id=?').get(id);

// doplní release jen když je prázdný (nepřepisuje hodnotu z hiyori)
const _setReleaseIfEmpty = db.prepare(
  "UPDATE subs SET release=@release WHERE sub_id=@sub_id AND (release IS NULL OR release='')"
);
export const setReleaseIfEmpty = (sub_id, release) =>
  _setReleaseIfEmpty.run({ sub_id, release });

// force update release (hns varianty: SubsPlease / BDRip)
const _setRelease = db.prepare('UPDATE subs SET release=@release WHERE sub_id=@sub_id');
export const setRelease = (sub_id, release) => _setRelease.run({ sub_id, release });

// --- runs ---
const _startRun = db.prepare(
  'INSERT INTO runs(started_at,ok) VALUES(?,0)'
);
const _finishRun = db.prepare(`
  UPDATE runs SET finished_at=@finished_at, ok=@ok, feed_cards=@feed_cards,
    anime_checked=@anime_checked, new_subs=@new_subs, downloaded=@downloaded,
    extern_pending=@extern_pending, failed=@failed, error=@error WHERE id=@id
`);
export const startRun = () => _startRun.run(new Date().toISOString()).lastInsertRowid;
export const finishRun = (row) =>
  _finishRun.run({ finished_at: new Date().toISOString(), ...row });

// --- dashboard dotazy ---
export const overviewCounts = () =>
  db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(status='downloaded')     AS downloaded,
        SUM(status='pending_extern') AS extern_pending,
        SUM(status='failed')         AS failed,
        SUM(r2_key IS NOT NULL AND r2_key<>'') AS on_r2
       FROM subs`
    )
    .get();
export const recentSubs = (limit = 100) =>
  db.prepare('SELECT * FROM subs ORDER BY first_seen DESC, sub_id DESC LIMIT ?').all(limit);

// stránkovaný výpis s volitelným hledáním podle názvu anime
export function listSubs({ limit = 100, offset = 0, q = null } = {}) {
  const where = q ? "WHERE anime_title LIKE @like" : '';
  const like = q ? `%${q}%` : null;
  const rows = db
    .prepare(
      `SELECT * FROM subs ${where}
       ORDER BY first_seen DESC, sub_id DESC LIMIT @limit OFFSET @offset`
    )
    .all({ limit, offset, like });
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM subs ${where}`)
    .get({ like }).c;
  return { rows, total };
}

// smazání záznamu z DB (soubor na R2 zůstává). Vrací počet smazaných řádků.
const _deleteSub = db.prepare('DELETE FROM subs WHERE sub_id=?');
export const deleteSub = (sub_id) => _deleteSub.run(sub_id).changes;

export const recentRuns = (limit = 12) =>
  db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);

// kandidáti ke stažení: nedostažené direct + extern (i z minulých běhů), nejstarší první
export const getDownloadCandidates = (limit = 30) =>
  db
    .prepare(
      `SELECT * FROM subs
       WHERE status IN ('new','not_downloaded','pending_extern')
         AND kind <> 'manual'
       ORDER BY first_seen ASC, sub_id ASC LIMIT ?`
    )
    .all(limit);

// přehled extern titulků čekajících na parser, seskupeno podle domény
export const pendingExternByDomain = () =>
  db
    .prepare(
      "SELECT extern_domain, COUNT(*) AS c FROM subs WHERE status='pending_extern' GROUP BY extern_domain"
    )
    .all();

// lookup pro addon: stažené titulky (na R2) podle anilist NEBO mal + episode.
// Přednost má anilist; když nic, zkusí mal. Vrací {matchedBy, rows}.
export function findSubs({ anilist = null, mal = null, episode = null, lang = null }) {
  const langCond = lang ? ' AND UPPER(lang)=UPPER(@lang)' : '';
  const epCond = episode != null ? ' AND episode=@episode' : '';
  const base =
    "SELECT sub_id, anilist_id, mal_id, anime_title, episode, lang, group_name, " +
    "release, version, kind, extern_domain, filename, file_bytes, r2_key " +
    "FROM subs WHERE status='downloaded' AND r2_key IS NOT NULL AND r2_key<>''";

  if (anilist) {
    const rows = db
      .prepare(`${base} AND anilist_id=@anilist${epCond}${langCond} ORDER BY lang, group_name`)
      .all({ anilist, episode, lang });
    if (rows.length) return { matchedBy: 'anilist', rows };
  }
  if (mal) {
    const rows = db
      .prepare(`${base} AND mal_id=@mal${epCond}${langCond} ORDER BY lang, group_name`)
      .all({ mal, episode, lang });
    if (rows.length) return { matchedBy: 'mal', rows };
  }
  return { matchedBy: null, rows: [] };
}

// Kompletní výpis všeho, co máme stažené na R2. Seskupeno po anime → epizody → titulky.
// Vrací syrové řádky seskupené; gz_url dopočítá server (zná R2_PUBLIC_BASE).
export function allSubs() {
  const rows = db
    .prepare(
      "SELECT sub_id, hiyori_id, anilist_id, mal_id, anime_title, episode, lang, " +
      "group_name, release, version, kind, extern_domain, r2_key " +
      "FROM subs WHERE status='downloaded' AND r2_key IS NOT NULL AND r2_key<>'' " +
      "ORDER BY anime_title, episode, lang, group_name"
    )
    .all();

  // anime (anilist|mal|hiyori) → epizoda → titulky
  const anime = new Map();
  for (const r of rows) {
    const key = `${r.anilist_id || ''}|${r.mal_id || ''}|${r.hiyori_id || ''}`;
    if (!anime.has(key)) {
      anime.set(key, {
        hiyori_id: r.hiyori_id,
        anilist_id: r.anilist_id,
        mal_id: r.mal_id,
        anime_title: (r.anime_title || '').replace(/\s*-\s*Hiyori$/i, ''),
        _eps: new Map(), // episode -> subs[]
      });
    }
    const a = anime.get(key);
    if (!a._eps.has(r.episode)) a._eps.set(r.episode, []);
    a._eps.get(r.episode).push({
      sub_id: r.sub_id,
      lang: r.lang,
      group: r.group_name,
      release: r.release,
      version: r.version,
      source: r.extern_domain || 'hiyori',
      r2_key: r.r2_key, // server z něj udělá gz_url
    });
  }

  const items = [...anime.values()].map((a) => {
    const episodes = [...a._eps.entries()]
      .map(([episode, subs]) => ({ episode, subs }))
      .sort((x, y) => x.episode - y.episode);
    const { _eps, ...rest } = a;
    return { ...rest, episodes };
  });

  return { items, subsTotal: rows.length };
}

// "Dnes přidané" pro addon: stažené titulky (na R2) podle first_seen.
// Seskupeno PO ANIME. Každé anime má episodes[] = [{episode, langs[]}], řazeno.
export function recentlyAdded(sinceIso) {
  const rows = db
    .prepare(
      "SELECT anilist_id, mal_id, anime_title, episode, lang, added_date, first_seen " +
      "FROM subs WHERE status='downloaded' AND r2_key IS NOT NULL AND r2_key<>'' " +
      "AND first_seen >= ? ORDER BY first_seen DESC"
    )
    .all(sinceIso);

  // seskup podle anime (anilist|mal), uvnitř podle epizody s jazyky
  const anime = new Map();
  for (const r of rows) {
    const key = `${r.anilist_id || ''}|${r.mal_id || ''}`;
    if (!anime.has(key)) {
      anime.set(key, {
        anilist_id: r.anilist_id,
        mal_id: r.mal_id,
        anime_title: (r.anime_title || '').replace(/\s*-\s*Hiyori$/i, ''),
        latest_first_seen: r.first_seen, // ORDER BY DESC → první výskyt = nejnovější
        _eps: new Map(), // episode -> Set(langs)
      });
    }
    const a = anime.get(key);
    if (!a._eps.has(r.episode)) a._eps.set(r.episode, new Set());
    if (r.lang) a._eps.get(r.episode).add(r.lang);
  }

  // finalizace: episodes jako seřazené pole objektů {episode, langs}
  return [...anime.values()].map((a) => {
    const episodes = [...a._eps.entries()]
      .map(([episode, langs]) => ({ episode, langs: [...langs].sort() }))
      .sort((x, y) => x.episode - y.episode);
    const { _eps, ...rest } = a;
    return { ...rest, episodes };
  });
}
// Přehled dostupnosti pro addon. episodes = pole objektů s rozpadem variant.
// Vrací {matchedBy, anime_title, episodes_count, subs_total, langs, episodes} — nebo total 0.
export function subsAvailability({ anilist = null, mal = null, episode = null }) {
  const epCond = episode != null ? ' AND episode=@episode' : '';
  const base =
    "FROM subs WHERE status='downloaded' AND r2_key IS NOT NULL AND r2_key<>''";

  const summarize = (idCol, id) => {
    const rows = db
      .prepare(
        `SELECT episode, lang, group_name, release, anime_title ${base} AND ${idCol}=@id${epCond} ` +
        'ORDER BY episode, lang, group_name'
      )
      .all({ id, episode });
    if (!rows.length) return null;

    const anime_title = (rows[0].anime_title || '').replace(/\s*-\s*Hiyori$/i, '');
    const langs = [...new Set(rows.map((r) => r.lang).filter(Boolean))].sort();

    // seskup podle epizody → varianty {lang, group, release}
    const epMap = new Map();
    for (const r of rows) {
      if (r.episode == null) continue;
      if (!epMap.has(r.episode)) epMap.set(r.episode, []);
      epMap.get(r.episode).push({
        lang: r.lang,
        group: r.group_name,
        release: r.release,
      });
    }
    const episodes = [...epMap.entries()]
      .map(([ep, subs]) => ({ episode: ep, subs }))
      .sort((a, b) => a.episode - b.episode);

    return {
      anime_title,
      episodes_count: episodes.length, // kolik různých dílů
      subs_total: rows.length,         // kolik titulků celkem (vč. variant)
      langs,
      episodes,
    };
  };

  if (anilist) {
    const s = summarize('anilist_id', anilist);
    if (s) return { matchedBy: 'anilist', ...s };
  }
  if (mal) {
    const s = summarize('mal_id', mal);
    if (s) return { matchedBy: 'mal', ...s };
  }
  return {
    matchedBy: null, anime_title: null,
    episodes_count: 0, subs_total: 0, langs: [], episodes: [],
  };
}
