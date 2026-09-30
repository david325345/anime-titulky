// scraper/anilist.js — dohledání anime na AniListu (veřejné GraphQL API, bez klíče).
// Použití: ruční přidání anime, které na hiyori není (typicky 18+) — z AniList ID
// nebo MAL ID doplní druhé ID, název a počet dílů.
//
// Limit AniListu ~90 dotazů/min (občas sníženo na 30) — tady jde o jednotlivé ruční akce.

import { CONFIG } from '../config.js';

const URL = 'https://graphql.anilist.co';
const QUERY = `query ($id: Int, $idMal: Int) {
  Media(id: $id, idMal: $idMal, type: ANIME) {
    id idMal episodes isAdult format
    title { romaji english native }
  }
}`;

// Vrátí { anilist_id, mal_id, title, episodes, isAdult } nebo null (AniList anime nezná).
// Chyba sítě / limitu → hodí výjimku.
export async function lookupAnilist({ anilistId = null, malId = null } = {}) {
  const variables = {};
  if (anilistId) variables.id = Number(anilistId);
  else if (malId) variables.idMal = Number(malId);
  else return null;

  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': CONFIG.userAgent || 'anime-titulky',
    },
    body: JSON.stringify({ query: QUERY, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) throw new Error('AniList: překročen limit dotazů, zkus to za minutu.');
  const json = await res.json().catch(() => null);
  const m = json?.data?.Media;
  if (!m) {
    // 404 = anime neexistuje; jiné chyby nahlas
    const errs = json?.errors || [];
    if (res.status === 404 || errs.some((e) => e.status === 404)) return null;
    throw new Error('AniList: ' + (errs[0]?.message || `HTTP ${res.status}`));
  }
  return {
    anilist_id: m.id,
    mal_id: m.idMal || null,
    title: m.title?.romaji || m.title?.english || m.title?.native || null,
    episodes: m.episodes || null,
    isAdult: !!m.isAdult,
  };
}
