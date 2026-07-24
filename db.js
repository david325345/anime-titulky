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

// akihabara.db — samostatný statický archiv (mrtvý web anime.akihabara.cz).
// READ-ONLY: jen čteme, žádné zápisy. Když soubor chybí, akiDb = null a
// všechny akihabara dotazy se přeskočí (služba běží dál jen s hiyori).
export const akiDbPath = path.join(CONFIG.dataDir, 'akihabara.db');
export let akiDb = null;
try {
  if (fs.existsSync(akiDbPath)) {
    akiDb = new Database(akiDbPath, { readonly: true, fileMustExist: true });
    akiDb.pragma('busy_timeout = 8000');
    const n = akiDb.prepare('SELECT COUNT(*) c FROM subs').get().c;
    console.log(`[akihabara] archiv připojen: ${n} titulků (read-only)`);
  } else {
    console.log('[akihabara] /data/akihabara.db nenalezen — archiv se přeskočí');
  }
} catch (e) {
  console.error('[akihabara] chyba otevření archivu:', e.message);
  akiDb = null;
}

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
  downloaded_at TEXT,
  manual_add    INTEGER DEFAULT 0  -- 0 = automatický scrape, 1 = ručně přidané přes URL (ve frontě až potom)
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
ensureColumn('subs', 'manual_add', 'INTEGER DEFAULT 0');

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
     release,version,kind,url,extern_domain,added_date,first_seen,status,manual_add)
  VALUES
    (@sub_id,@hiyori_id,@anilist_id,@mal_id,@anime_title,@episode,@lang,@group_id,@group_name,
     @release,@version,@kind,@url,@extern_domain,@added_date,@first_seen,@status,@manual_add)
`);
export const subExists = (id) => !!_subExists.get(id);
export const insertSub = (row) =>
  _insertSub.run({ manual_add: 0, ...row }).changes; // 1 = nově vloženo

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

// editace popisných metadat z webu (Fansub / Release / Jazyk) — nemění Ep ani Zdroj
const _updateSubMeta = db.prepare(
  'UPDATE subs SET group_name=@group_name, release=@release, lang=@lang WHERE sub_id=@sub_id'
);
export const updateSubMeta = (sub_id, { group_name, release, lang }) =>
  _updateSubMeta.run({
    sub_id,
    group_name: group_name ?? null,
    release: release ?? null,
    lang: lang ?? null,
  }).changes;

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
export const overviewCounts = () => {
  const h = db
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

  // přičti akihabara archiv (statický, vše je na R2 = downloaded)
  let aki = 0;
  if (akiDb) {
    try {
      aki = akiDb.prepare("SELECT COUNT(*) c FROM subs WHERE r2_key IS NOT NULL AND r2_key<>''").get().c;
    } catch { aki = 0; }
  }

  // počet UNIKÁTNÍCH anime napříč zdroji (stejné anilist_id = jedno anime).
  // Spojíme anilist_id z hiyori + archivu do jedné množiny.
  const animeSet = new Set();
  try {
    for (const r of db.prepare(
      "SELECT DISTINCT anilist_id FROM subs WHERE anilist_id IS NOT NULL AND r2_key IS NOT NULL AND r2_key<>''"
    ).all()) animeSet.add('al:' + r.anilist_id);
    // hiyori titulky bez anilist ale s mal
    for (const r of db.prepare(
      "SELECT DISTINCT mal_id FROM subs WHERE anilist_id IS NULL AND mal_id IS NOT NULL AND r2_key IS NOT NULL AND r2_key<>''"
    ).all()) animeSet.add('mal:' + r.mal_id);
  } catch {}
  if (akiDb) {
    try {
      for (const r of akiDb.prepare(
        "SELECT DISTINCT anilist_id FROM subs WHERE anilist_id IS NOT NULL AND r2_key IS NOT NULL AND r2_key<>''"
      ).all()) animeSet.add('al:' + r.anilist_id);
      for (const r of akiDb.prepare(
        "SELECT DISTINCT mal_id FROM subs WHERE anilist_id IS NULL AND mal_id IS NOT NULL AND r2_key IS NOT NULL AND r2_key<>''"
      ).all()) animeSet.add('mal:' + r.mal_id);
    } catch {}
  }

  return {
    total: (h.total || 0) + aki,
    downloaded: (h.downloaded || 0) + aki,
    extern_pending: h.extern_pending || 0,
    failed: h.failed || 0,
    on_r2: (h.on_r2 || 0) + aki,
    anime: animeSet.size,   // unikátních anime napříč zdroji
    hiyori: h.total || 0,   // rozpad pro případ, že by ho web chtěl
    akihabara: aki,
  };
};
// --- hns.sk: pomocné dotazy pro překlad odkazu na seriál → odkaz na díl ---
// Najde URL na konkrétní epizodu u JINÉHO záznamu téhož anime a téhož dílu
// (typicky web-dl sada, která odkaz na díl má). hiyori drží každou sezónu pod
// vlastním hiyori_id, takže se dotaz nemůže trefit do jiné série ani půlky.
// Vrací null, když takový záznam neexistuje.
export function findEpisodeUrlSibling({ hiyori_id, episode, extern_domain, sub_id = null }) {
  if (!hiyori_id || episode == null || !extern_domain) return null;
  const row = db
    .prepare(
      `SELECT url FROM subs
        WHERE hiyori_id = @hiyori_id
          AND episode = @episode
          AND extern_domain = @extern_domain
          AND url LIKE '%/anime/episode/%'
          AND (@sub_id IS NULL OR sub_id <> @sub_id)
        ORDER BY sub_id
        LIMIT 1`
    )
    .get({ hiyori_id, episode, extern_domain, sub_id });
  return row?.url || null;
}

// Nejvyšší číslo dílu, které hiyori pro dané anime eviduje — slouží ke kontrole,
// jestli číslování na stránce zdroje odpovídá právě téhle sezóně.
export function maxEpisodeForHiyoriId(hiyori_id) {
  if (!hiyori_id) return null;
  const row = db.prepare('SELECT MAX(episode) AS mx FROM subs WHERE hiyori_id = ?').get(hiyori_id);
  return row?.mx ?? null;
}

// Vrátí stažený záznam do stavu „nestaženo" — smaže odkaz na soubor i velikost,
// takže se u něj v dashboardu zase objeví 📤 a ⬇. Samotný soubor na R2 maže
// volající (server.js), tady jen čistíme evidenci.
export function resetSubDownload(sub_id, status) {
  return db
    .prepare(
      `UPDATE subs
          SET status = @status, r2_key = NULL, filename = NULL,
              file_bytes = NULL, local_path = NULL, error = NULL
        WHERE sub_id = @sub_id`
    )
    .run({ sub_id, status }).changes;
}

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
       ORDER BY manual_add ASC, first_seen ASC, sub_id ASC LIMIT ?`
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
// Titulky z akihabara archivu (read-only). Schéma se liší: akihabara_id místo
// sub_id, nemá status/kind/hiyori_id. Aliasujeme na stejný tvar jako hiyori,
// aby se řádky daly spojit a server je zpracoval jednotně.
function findAkiSubs({ anilist = null, mal = null, episode = null, lang = null }) {
  if (!akiDb) return [];
  const langCond = lang ? ' AND UPPER(lang)=UPPER(@lang)' : '';
  const epCond = episode != null ? ' AND episode=@episode' : '';
  const base =
    "SELECT akihabara_id AS sub_id, anilist_id, mal_id, anime_title, episode, lang, " +
    "group_name, release, version, NULL AS kind, " +
    "COALESCE(extern_domain,'akihabara') AS extern_domain, filename, file_bytes, r2_key " +
    "FROM subs WHERE r2_key IS NOT NULL AND r2_key<>''";
  try {
    if (anilist) {
      const rows = akiDb
        .prepare(`${base} AND anilist_id=@anilist${epCond}${langCond} ORDER BY lang, group_name`)
        .all({ anilist, episode, lang });
      if (rows.length) return rows;
    }
    if (mal) {
      const rows = akiDb
        .prepare(`${base} AND mal_id=@mal${epCond}${langCond} ORDER BY lang, group_name`)
        .all({ mal, episode, lang });
      if (rows.length) return rows;
    }
  } catch (e) {
    console.error('[akihabara] findAkiSubs chyba:', e.message);
  }
  return [];
}

export function findSubs({ anilist = null, mal = null, episode = null, lang = null }) {
  const langCond = lang ? ' AND UPPER(lang)=UPPER(@lang)' : '';
  const epCond = episode != null ? ' AND episode=@episode' : '';
  const base =
    "SELECT sub_id, anilist_id, mal_id, anime_title, episode, lang, group_name, " +
    "release, version, kind, extern_domain, filename, file_bytes, r2_key " +
    "FROM subs WHERE status='downloaded' AND r2_key IS NOT NULL AND r2_key<>''";

  // akihabara titulky pro tentýž dotaz (přidají se ZA hiyori)
  const aki = findAkiSubs({ anilist, mal, episode, lang });

  if (anilist) {
    const rows = db
      .prepare(`${base} AND anilist_id=@anilist${epCond}${langCond} ORDER BY lang, group_name`)
      .all({ anilist, episode, lang });
    if (rows.length || aki.length) return { matchedBy: 'anilist', rows: [...rows, ...aki] };
  }
  if (mal) {
    const rows = db
      .prepare(`${base} AND mal_id=@mal${epCond}${langCond} ORDER BY lang, group_name`)
      .all({ mal, episode, lang });
    if (rows.length || aki.length) return { matchedBy: 'mal', rows: [...rows, ...aki] };
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

  // akihabara varianty (read-only archiv) — přidají se ZA hiyori varianty
  const akiRows = (idCol, id) => {
    if (!akiDb) return [];
    try {
      return akiDb
        .prepare(
          "SELECT episode, lang, group_name, release, anime_title, " +
          "COALESCE(extern_domain,'akihabara') AS extern_domain " +
          "FROM subs WHERE r2_key IS NOT NULL AND r2_key<>'' " +
          `AND ${idCol}=@id${epCond} ORDER BY episode, lang, group_name`
        )
        .all({ id, episode });
    } catch (e) {
      console.error('[akihabara] subsAvailability chyba:', e.message);
      return [];
    }
  };

  const summarize = (idCol, id) => {
    const hRows = db
      .prepare(
        `SELECT episode, lang, group_name, release, anime_title, extern_domain ${base} AND ${idCol}=@id${epCond} ` +
        'ORDER BY episode, lang, group_name'
      )
      .all({ id, episode });
    const aRows = akiRows(idCol, id);
    // hiyori první, akihabara za ním
    const rows = [...hRows, ...aRows];
    if (!rows.length) return null;

    const anime_title = (rows[0].anime_title || '').replace(/\s*-\s*Hiyori$/i, '');
    const langs = [...new Set(rows.map((r) => r.lang).filter(Boolean))].sort();

    // seskup podle epizody → varianty {lang, group, release, source}
    const epMap = new Map();
    for (const r of rows) {
      if (r.episode == null) continue;
      if (!epMap.has(r.episode)) epMap.set(r.episode, []);
      epMap.get(r.episode).push({
        lang: r.lang,
        group: r.group_name,
        release: r.release,
        source: r.extern_domain || 'hiyori',
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

// ==================================================================
// AKIHABARA ARCHIV (read-only) — funkce pro webovou sekci
// ==================================================================

// Seznam anime v akihabara archivu, seskupený (1 anime = 1 řádek).
// Podporuje hledání podle názvu (q) + stránkování. Vrací počet dílů,
// jazyky a skupiny per anime.
export function listAkihabaraAnime({ limit = 100, offset = 0, q = null } = {}) {
  if (!akiDb) return { rows: [], total: 0 };
  const like = q ? `%${q}%` : null;
  const where = q ? "WHERE anime_title LIKE @like" : "";

  try {
    // celkový počet anime (pro stránkování)
    const total = akiDb
      .prepare(
        `SELECT COUNT(*) c FROM (SELECT anilist_id FROM subs ${where} GROUP BY anilist_id)`
      )
      .get(q ? { like } : {}).c;

    // stránka anime + agregace
    const rows = akiDb
      .prepare(
        "SELECT anilist_id, mal_id, " +
        "MAX(anime_title) AS anime_title, " +
        "COUNT(DISTINCT episode) AS episodes_count, " +
        "COUNT(*) AS subs_total, " +
        "GROUP_CONCAT(DISTINCT lang) AS langs, " +
        "GROUP_CONCAT(DISTINCT group_name) AS groups " +
        `FROM subs ${where} ` +
        "GROUP BY anilist_id " +
        "ORDER BY anime_title " +
        "LIMIT @limit OFFSET @offset"
      )
      .all(q ? { like, limit, offset } : { limit, offset });

    // uprav agregované sloupce (langs/groups CSV → pole, očisti null)
    const clean = rows.map((r) => ({
      anilist_id: r.anilist_id,
      mal_id: r.mal_id,
      anime_title: r.anime_title,
      episodes_count: r.episodes_count,
      subs_total: r.subs_total,
      langs: (r.langs || '').split(',').filter(Boolean).sort(),
      groups: (r.groups || '').split(',').filter(Boolean).sort(),
    }));

    return { rows: clean, total };
  } catch (e) {
    console.error('[akihabara] listAkihabaraAnime chyba:', e.message);
    return { rows: [], total: 0 };
  }
}

// Detail jednoho anime z archivu — jednotlivé díly a jejich titulky
// (pro rozbalení řádku ve webové sekci).
export function akihabaraAnimeDetail(anilistId) {
  if (!akiDb) return { episodes: [] };
  try {
    const rows = akiDb
      .prepare(
        "SELECT episode, lang, group_name, release, filename " +
        "FROM subs WHERE anilist_id=@id AND r2_key IS NOT NULL AND r2_key<>'' " +
        "ORDER BY episode, lang, group_name"
      )
      .all({ id: anilistId });

    // seskup po epizodě
    const epMap = new Map();
    for (const r of rows) {
      if (!epMap.has(r.episode)) epMap.set(r.episode, []);
      epMap.get(r.episode).push({
        lang: r.lang,
        group: r.group_name,
        release: r.release,
      });
    }
    const episodes = [...epMap.entries()]
      .map(([ep, subs]) => ({ episode: ep, subs }))
      .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));

    return { episodes };
  } catch (e) {
    console.error('[akihabara] akihabaraAnimeDetail chyba:', e.message);
    return { episodes: [] };
  }
}

// Souhrn archivu pro hlavičku sekce (počet titulků + anime).
export function akihabaraStats() {
  if (!akiDb) return { subs: 0, anime: 0, enabled: false };
  try {
    const subs = akiDb.prepare('SELECT COUNT(*) c FROM subs').get().c;
    const anime = akiDb.prepare('SELECT COUNT(DISTINCT anilist_id) c FROM subs').get().c;
    return { subs, anime, enabled: true };
  } catch {
    return { subs: 0, anime: 0, enabled: false };
  }
}
