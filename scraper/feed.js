// scraper/feed.js — parse feedu /anime/posledni-pridane-titulky (kartová mřížka).
// Feed slouží jen k zjištění, KTERÁ anime mají čerstvé titulky (+ jazyk/skupina/datum).
// sub_id a download URL feed NEMÁ — ty jsou až na detailu.
import * as cheerio from 'cheerio';
import { getHtml } from './http.js';

const FEED_PATH = '/anime/posledni-pridane-titulky';

// "11.07.2026 10:15:18" -> Date
function parseCzDateTime(s) {
  const m = String(s).trim().match(
    /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!m) return null;
  const [, d, mo, y, hh = '0', mm = '0', ss = '0'] = m;
  return new Date(+y, +mo - 1, +d, +hh, +mm, +ss);
}

function langFromFlag(src = '') {
  if (/czech|czech-republic|\/cz|cz-/i.test(src)) return 'CZ';
  if (/slovak|slovakia|\/sk|sk-/i.test(src)) return 'SK';
  return null;
}

export async function getFeed() {
  const html = await getHtml(FEED_PATH);
  const $ = cheerio.load(html);
  const cards = [];

  // každá karta obsahuje odkaz /anime/{id}; bereme kartu jako nejbližšího předka
  $('a[href^="/anime/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/^\/anime\/(\d+)$/);
    if (!m) return;
    const hiyoriId = Number(m[1]);

    // předek reprezentující celou kartu
    const card = $(a).closest('.prehled-anime-pozadi');
    if (!card.length) return;
    // dedup: jednu kartu chytneme jen jednou (má víc /anime/{id} odkazů uvnitř)
    if (card.data('_seen')) return;
    card.data('_seen', true);

    const text = card.text().replace(/\s+/g, ' ').trim();
    const title =
      $(a).attr('title') ||
      card.find('a[href^="/anime/"] b').first().text().trim() ||
      null;

    const epM = text.match(/Epizoda:\s*(\d+)/i);
    const flag = card.find('img[src*="/flags/"]').attr('src') || '';
    const fansubA = card.find('a[href^="/fansuby/"]').first();
    const groupId = (fansubA.attr('href') || '').match(/\/fansuby\/(\d+)/)?.[1];
    const relM = text.match(/Release:\s*([^\n]+?)(?:\s+\d{1,2}\.\d{1,2}\.\d{4}|$)/i);
    const dateM = text.match(/(\d{1,2}\.\d{1,2}\.\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/);

    cards.push({
      hiyoriId,
      title,
      episode: epM ? Number(epM[1]) : null,
      lang: langFromFlag(flag),
      groupId: groupId ? Number(groupId) : null,
      groupName: fansubA.text().trim() || null,
      release: relM ? relM[1].trim() : null,
      addedDate: dateM ? dateM[1] : null,
      addedAt: dateM ? parseCzDateTime(dateM[1]) : null,
    });
  });

  return cards;
}

export { parseCzDateTime };
