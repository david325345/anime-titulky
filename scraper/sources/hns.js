// scraper/sources/hns.js — parser pro hns.sk (Yii2 + přihlášení).
//
// hiyori odkazuje buď na stránku epizody (/anime/episode/{slug}/{id}),
// nebo na stránku anime (/anime/{slug}) — pak dohledáme epizodu podle čísla dílu.
// Stažení = <form method="POST"> s hidden id/name/_csrf/action=download na URL epizody.
//
// Na jedné epizodě může být VÍC variant (SubsPlease / BDRip). Stahujeme VŠECHNY:
// první = hlavní (hiyori sub_id), další dostanou vlastní sub_id (700000000 + hns_id).
// Release (SubsPlease / BDRip (MTBB)) se bere z prvního sloupce řádku.

import * as cheerio from 'cheerio';
import { getHtml, postBinary } from './hns-http.js';
import { saveSubFile } from '../download.js';
import { insertSub, markDownloaded, subExists, setRelease } from '../../db.js';

export const name = 'hns.sk';

const VARIANT_ID_BASE = 700000000; // vyhrazený rozsah pro extra varianty (nekoliduje s hiyori)

function filenameFromCD(cd) {
  const star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1]); } catch {} }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

// skupina z prvního [..] názvu ([SubsPlease] → SubsPlease)
function groupFromName(nm) {
  const m = (nm || '').match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

// ze stránky anime najde URL epizody podle čísla dílu (číslo na konci textu odkazu)
async function resolveEpisodeUrl(sub) {
  if (/\/anime\/episode\//i.test(sub.url)) return sub.url;
  const html = await getHtml(sub.url);
  const $ = cheerio.load(html);
  let match = null;
  $('a[href*="/anime/episode/"]').each((_, a) => {
    if (match) return;
    const href = $(a).attr('href') || '';
    const n = Number(($(a).text().match(/(\d+)\s*$/) || [])[1]);
    if (n === sub.episode) match = href.startsWith('http') ? href : 'https://hns.sk' + href;
  });
  if (!match) {
    throw new Error(`hns.sk: na stránce anime nenašel odkaz na díl ${sub.episode} (${sub.url}).`);
  }
  return match;
}

// vytáhne všechny download varianty ze stránky epizody
function parseVariants($) {
  const out = [];
  $('form')
    .filter((_, f) => $(f).find('input[name="action"][value="download"]').length > 0)
    .each((_, f) => {
      const $f = $(f);
      const id = $f.find('input[name="id"]').attr('value');
      const fname = $f.find('input[name="name"]').attr('value');
      const csrf = $f.find('input[name="_csrf"]').attr('value');
      const release = $f.closest('tr').find('td').first().text().replace(/\s+/g, ' ').trim();
      if (id && csrf) out.push({ id, fname: fname || '', csrf, release });
    });
  return out;
}

// stáhne jeden .ass podle varianty (POST na epUrl)
async function fetchVariant(epUrl, v) {
  const { buf, contentDisposition } = await postBinary(epUrl, {
    _csrf: v.csrf,
    id: v.id,
    name: v.fname,
    action: 'download',
  });
  const rawName = v.fname || filenameFromCD(contentDisposition) || `hns-${v.id}.ass`;
  return { buf, rawName };
}

export async function download(sub) {
  const epUrl = await resolveEpisodeUrl(sub);
  const html = await getHtml(epUrl);
  const $ = cheerio.load(html);

  const variants = parseVariants($);
  if (!variants.length) {
    throw new Error(`hns.sk: na stránce epizody není download formulář (${epUrl}).`);
  }

  // 1) hlavní varianta = první → uloží se pod hiyori sub_id (vrací se do run.js)
  const main = variants[0];
  const { buf, rawName } = await fetchVariant(epUrl, main);
  const mainSaved = await saveSubFile(sub, buf, rawName);
  if (main.release) setRelease(sub.sub_id, main.release); // SubsPlease / BDRip

  // 2) další varianty → vlastní sub_id, uloží a označí jako stažené přímo tady
  for (const v of variants.slice(1)) {
    const variantSubId = VARIANT_ID_BASE + Number(v.id);
    // už staženo dřív? přeskoč (idempotentní)
    if (subExists(variantSubId)) continue;

    insertSub({
      sub_id: variantSubId,
      hiyori_id: sub.hiyori_id,
      anilist_id: sub.anilist_id,
      mal_id: sub.mal_id,
      anime_title: sub.anime_title,
      episode: sub.episode,
      lang: sub.lang,
      group_id: null,
      group_name: groupFromName(v.fname),
      release: v.release || null,
      version: null,
      kind: 'extern',
      url: epUrl,
      extern_domain: 'hns.sk',
      added_date: sub.added_date,
      first_seen: new Date().toISOString(),
      status: 'pending_extern',
    });

    try {
      const r = await fetchVariant(epUrl, v);
      const saved = await saveSubFile(
        { ...sub, sub_id: variantSubId, group_name: groupFromName(v.fname) },
        r.buf,
        r.rawName
      );
      markDownloaded({
        sub_id: variantSubId,
        filename: saved.filename,
        local_path: saved.local_path,
        file_bytes: saved.file_bytes,
        r2_key: saved.r2_key ?? null,
      });
      if (v.release) setRelease(variantSubId, v.release);
    } catch (e) {
      // varianta selhala — hlavní titulek tím nerozbijeme, jen zalogujeme
      console.error(`hns varianta ${variantSubId} selhala: ${e.message}`);
    }
  }

  return mainSaved; // run.js označí hlavní jako downloaded
}
