// scraper/detail.js — parse detailu /anime/{hiyori_id}.
// Vytáhne: anilist/mal ID + typ, a všechny řádky titulků (sub_id, epizoda, jazyk,
// skupina, release, verze, kind direct/extern, download URL).
import * as cheerio from 'cheerio';
import { getHtml } from './http.js';

function extractIds($) {
  const anilist =
    $('a[href*="anilist.co/anime/"]').attr('href')?.match(/anime\/(\d+)/)?.[1] || null;
  const mal =
    $('a[href*="myanimelist.net/anime/"]').attr('href')?.match(/anime\/(\d+)/)?.[1] ||
    null;
  return { anilist_id: anilist ? Number(anilist) : null, mal_id: mal ? Number(mal) : null };
}

function extractTitleType($) {
  const title =
    $('h1').first().text().trim() ||
    ($('title').text() || '').split('|')[0].trim() ||
    null;
  // typ ("TV Série" / "Film" / "OVA"...) — best-effort, není kritické
  const type =
    $('*:contains("TV Série"),*:contains("TV Serie")').first().text().match(
      /TV S[ée]rie|Film|OVA|ONA|Speci[aá]l/i
    )?.[0] || null;
  return { title, type };
}

// z jednoho <tr> vytáhne titulek. Vrací null, pokud řádek není titulkový.
function parseRow($, tr) {
  const $tr = $(tr);
  const dl = $tr.find('a[onclick^="DownloadSubtitles"], a[onclick^="DownloadExternSubtitles"]').first();
  if (!dl.length) return null;

  const onclick = dl.attr('onclick') || '';
  const isExtern = /DownloadExternSubtitles/i.test(onclick);
  const subId = Number(onclick.match(/\((\d+)\)/)?.[1]);
  if (!subId) return null;

  const url = dl.attr('href') || '';
  let externDomain = null;
  if (isExtern) {
    try {
      externDomain = new URL(url, 'https://hiyori.cz').hostname.replace(/^www\./, '');
    } catch {
      externDomain = null;
    }
  }

  // projdeme buňky řádku
  const tds = $tr.find('td').toArray().map((td) => $(td).text().replace(/\s+/g, ' ').trim());
  const rowText = $tr.text().replace(/\s+/g, ' ').trim();

  const episode = Number(rowText.match(/Epizoda\s*:?\s*(\d+)/i)?.[1]) || null;
  const lang = tds.find((t) => /^(CZ|SK|CS)$/i.test(t)) || null;
  const addedDate = rowText.match(/\b(\d{1,2}\.\d{1,2}\.\d{4})\b/)?.[1] || null;
  const version = rowText.match(/Verze:\s*([^\s<]+)/i)?.[1] || null;

  const fansubA = $tr.find('a[href^="/fansuby/"]').first();
  const groupId = Number((fansubA.attr('href') || '').match(/\/fansuby\/(\d+)/)?.[1]) || null;
  const groupName =
    fansubA.find('b').first().text().trim() || fansubA.text().replace(/\s+/g, ' ').trim() || null;

  // release = krátká text-center buňka, která není epizoda/jazyk/datum/skupina/sub_id
  let release = null;
  for (const t of tds) {
    if (!t) continue;
    if (/^\d+$/.test(t)) continue;
    if (/Epizoda/i.test(t)) continue;
    if (/^(CZ|SK|CS)$/i.test(t)) continue;
    if (/\d{1,2}\.\d{1,2}\.\d{4}/.test(t)) continue;
    if (/Verze/i.test(t)) continue;
    if (groupName && t === groupName) continue;
    if (t.length > 60) continue; // autoři/dlouhé texty přeskočíme
    if (/Překlad|Korektura|Časování|Navštíveno/i.test(t)) continue;
    release = t;
    break;
  }

  return {
    sub_id: subId,
    episode,
    lang: lang ? lang.toUpperCase().replace('CS', 'CZ') : null,
    group_id: groupId,
    group_name: groupName,
    release,
    version,
    kind: isExtern ? 'extern' : 'direct',
    url,
    extern_domain: externDomain,
    added_date: addedDate,
  };
}

export async function getDetail(hiyoriId) {
  const html = await getHtml(`/anime/${hiyoriId}`, {
    referer: 'https://hiyori.cz/anime/posledni-pridane-titulky',
  });
  const $ = cheerio.load(html);

  const ids = extractIds($);
  const meta = extractTitleType($);

  const rows = [];
  $('tr').each((_, tr) => {
    const r = parseRow($, tr);
    if (r) rows.push(r);
  });

  return { hiyoriId, ...ids, ...meta, rows };
}
