// scraper/sources/hajimarisubs.js — hajimarisubs.net.
//
// Veřejný WordPress (download-monitor). Stránka anime má seznam dílů:
//   .hs-episode-card → .hs-episode-number ("Epizoda 01") + .hs-episode-download (href).
// Download odkaz (/download/{id}/) vrací PŘÍMO obsah .ass (byť content-type text/html).
// Bez přihlášení, přímé odkazy.

import * as cheerio from 'cheerio';
import { saveSubFile } from '../download.js';

export const name = 'hajimarisubs.net';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// skupina z meta ([Bird]) nebo z názvu souboru
function groupFromText(t) {
  const m = (t || '').match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

// ze stránky anime udělá mapu { episode: {url, group} }
function parseEpisodeMap($) {
  const map = {};
  $('.hs-episode-card, article.hs-episode-card').each((_, card) => {
    const $c = $(card);
    const numTxt = $c.find('.hs-episode-number').first().text(); // "Epizoda 01"
    const ep = Number((numTxt.match(/(\d+)/) || [])[1]);
    if (!ep) return;
    const href = ($c.find('.hs-episode-download').first().attr('href') || '').trim();
    if (!href) return;
    const meta = $c.find('.hs-episode-meta').first().text();
    if (map[ep] == null) map[ep] = { url: href, group: groupFromText(meta) };
  });
  return map;
}

export async function download(sub) {
  // 1) načti stránku anime
  const pageRes = await fetch(sub.url, { headers: { 'User-Agent': UA } });
  if (!pageRes.ok) throw new Error(`hajimarisubs: HTTP ${pageRes.status} (${sub.url}).`);
  const html = await pageRes.text();
  const $ = cheerio.load(html);

  // 2) najdi díl podle čísla
  const map = parseEpisodeMap($);
  const hit = map[sub.episode];
  if (!hit) {
    throw new Error(`hajimarisubs: na stránce není díl ${sub.episode} (${sub.url}).`);
  }

  // 3) stáhni titulek (přímý obsah .ass)
  const dlRes = await fetch(hit.url, {
    headers: { 'User-Agent': UA, Referer: sub.url },
  });
  if (!dlRes.ok) throw new Error(`hajimarisubs: HTTP ${dlRes.status} při stahování titulku.`);
  const buf = Buffer.from(await dlRes.arrayBuffer());

  // ověř, že je to titulek (ASS/SRT), ne HTML chybová stránka
  const head = buf.slice(0, 200).toString('utf8');
  const looksLikeSub =
    /\[Script Info\]|^\uFEFF?\[/.test(head) || /Format:|Dialogue:|^\d+\s*$/m.test(head) ||
    /-->/.test(head);
  if (!looksLikeSub && /<html|<!doctype/i.test(head)) {
    throw new Error('hajimarisubs: download nevrátil titulek (HTML stránka).');
  }

  // 4) název souboru z Content-Disposition, jinak sestav
  const cd = dlRes.headers.get('content-disposition') || '';
  const cdName = (cd.match(/filename\*?=(?:UTF-8''|["']?)([^;"']+)/i) || [])[1];
  const rawName = cdName
    ? decodeURIComponent(cdName)
    : `hajimari-ep${sub.episode}.ass`;

  const grp = sub.group_name || hit.group;
  return saveSubFile({ ...sub, group_name: grp }, buf, rawName);
}
