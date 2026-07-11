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

// z jednoho <tr> vytáhne titulek. col = mapa {klíč: index sloupce} z hlavičky.
// Vrací null, pokud řádek není titulkový.
function parseRow($, tr, col) {
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

  // buňky řádku jako pole (podle indexu z hlavičky)
  const cells = $tr.find('td').toArray().map((td) => $(td).text().replace(/\s+/g, ' ').trim());
  const rowText = $tr.text().replace(/\s+/g, ' ').trim();
  const at = (key) => (col[key] != null ? cells[col[key]] : undefined);

  // číslo dílu: primárně sloupec '#', fallback na "Epizoda N" v textu
  let episode =
    Number((at('episode') || '').match(/\d+/)?.[0]) ||
    Number(rowText.match(/Epizoda\s*:?\s*(\d+)/i)?.[1]) ||
    null;

  const langRaw = at('lang') || cells.find((t) => /^(CZ|SK|CS)$/i.test(t)) || null;
  const lang = langRaw ? langRaw.toUpperCase().replace('CS', 'CZ') : null;

  const release = at('release') || null;
  const episodeName = at('name') || null; // název dílu ("Nové dny")

  const addedDate =
    (at('date') || '').match(/\d{1,2}\.\d{1,2}\.\d{4}/)?.[0] ||
    rowText.match(/\b(\d{1,2}\.\d{1,2}\.\d{4})\b/)?.[1] ||
    null;
  const version = rowText.match(/Verze:\s*([^\s<]+)/i)?.[1] || null;

  const fansubA = $tr.find('a[href^="/fansuby/"]').first();
  const groupId = Number((fansubA.attr('href') || '').match(/\/fansuby\/(\d+)/)?.[1]) || null;
  const groupName =
    fansubA.find('b').first().text().trim() || fansubA.text().replace(/\s+/g, ' ').trim() || null;

  return {
    sub_id: subId,
    episode,
    episode_name: episodeName,
    lang,
    group_id: groupId,
    group_name: groupName,
    release: release && release.length <= 60 ? release : null,
    version,
    kind: isExtern ? 'extern' : 'direct',
    url,
    extern_domain: externDomain,
    added_date: addedDate,
  };
}

// z <thead> tabulky titulků udělá mapu {klíč: index sloupce}
function buildColumnMap($) {
  // najdi tabulku, která má download tlačítka (tabulka titulků)
  let table = $('table').filter((_, t) =>
    $(t).find('a[onclick^="DownloadSubtitles"], a[onclick^="DownloadExternSubtitles"]').length > 0
  ).first();
  if (!table.length) table = $('table').first();

  const headers = table
    .find('thead th')
    .toArray()
    .map((th) => $(th).text().replace(/\s+/g, ' ').trim().toLowerCase());

  const col = {};
  headers.forEach((h, i) => {
    if (h === '#' || /epizod|díl|dil/.test(h)) col.episode ??= i;
    else if (/n[áa]zev|title/.test(h)) col.name ??= i;
    else if (/jazyk|lang/.test(h)) col.lang ??= i;
    else if (/release/.test(h)) col.release ??= i;
    else if (/fansub|skupin|group/.test(h)) col.group ??= i;
    else if (/přid|pridan|datum|date/.test(h)) col.date ??= i;
    else if (/verze|version/.test(h)) col.version ??= i;
  });
  return col;
}

export async function getDetail(hiyoriId) {
  const html = await getHtml(`/anime/${hiyoriId}`, {
    referer: 'https://hiyori.cz/anime/posledni-pridane-titulky',
  });
  const $ = cheerio.load(html);

  const ids = extractIds($);
  const meta = extractTitleType($);
  const col = buildColumnMap($);

  const rows = [];
  $('tr').each((_, tr) => {
    const r = parseRow($, tr, col);
    if (r) rows.push(r);
  });

  return { hiyoriId, ...ids, ...meta, rows };
}
