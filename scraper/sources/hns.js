// scraper/sources/hns.js — parser pro hns.sk (Yii2 + přihlášení).
//
// hiyori odkazuje buď rovnou na stránku epizody (/anime/episode/{slug}/{id}),
// nebo jen na stránku anime (/anime/{slug}) — typicky u BD sad. V druhém
// případě se na stránce najde blok daného dílu; jeho nadpis je zároveň
// odkazem na epizodu (<a href="/anime/episode/{slug}/{id}">{Nazev} {N}</a>),
// takže z něj máme číslo dílu i cílovou adresu.
//
// Stahuje se VŽDY jen ta varianta, kterou hiyori uvádí v poli `release`
// (SubsPlease / BDRip / Erai-raws …). Pro každý release má hiyori vlastní
// záznam, takže se ostatní řádky na stránce ignorují — nezakládají se žádné
// extra záznamy. Když se release netrefí, radši chyba než cizí soubor.
//
// Pozor na číslování: párujeme na číslo v NADPISU bloku, ne na číslo v názvu
// souboru titulku — hns pojmenovává soubory podle TVDB (u pokračování posunuté).
//
// Stažení = <form method="POST"> s hidden id/name/_csrf/action=download na URL epizody.

import * as cheerio from 'cheerio';
import { getHtml, postBinary } from './hns-http.js';
import { saveSubFile } from '../download.js';
import { setRelease } from '../../db.js';

export const name = 'hns.sk';

function filenameFromCD(cd) {
  const star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1]); } catch {} }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

// Normalizace názvu release na porovnatelný tvar. hiyori a hns se v zápisu
// rozcházejí — „BDRip (MTTB)" × „BDRip (MTBB)" × „BD Rip (Ember)" — takže
// zahazujeme obsah závorky i všechny mezery, pomlčky a tečky.
function releaseKey(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, '')   // (MTBB), (Ember) …
    .replace(/[\s._-]+/g, '')    // mezery, pomlčky, tečky, podtržítka
    .toLowerCase()
    .trim();
}

// Ze stránky anime posbírá odkazy na epizody i s číslem z nadpisu bloku.
// Speciály se zlomkem („16.5") přeskakujeme — do číslování dílů nepatří.
function episodeLinks($) {
  const out = [];
  $('a[href*="/anime/episode/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = $(a).text().replace(/\s+/g, ' ').trim().match(/(\d+(?:\.\d+)?)\s*$/);
    if (!m || m[1].includes('.')) return;
    out.push({ n: Number(m[1]), url: href.startsWith('http') ? href : 'https://hns.sk' + href });
  });
  return out;
}

// Zjistí URL stránky epizody — buď ji hiyori dala rovnou, nebo ji najdeme
// na stránce anime podle čísla dílu.
async function resolveEpisodeUrl(sub) {
  if (/\/anime\/episode\//i.test(sub.url)) return sub.url;

  const html = await getHtml(sub.url);
  const $ = cheerio.load(html);
  const links = episodeLinks($);
  if (!links.length) {
    throw new Error(`hns.sk: na stránce anime nejsou odkazy na epizody (${sub.url}).`);
  }

  const hit = links.find((l) => l.n === sub.episode);
  if (!hit) {
    const rozsah = `${Math.min(...links.map((l) => l.n))}–${Math.max(...links.map((l) => l.n))}`;
    throw new Error(
      `hns.sk: na stránce anime není díl ${sub.episode} (stránka má díly ${rozsah}). ${sub.url}`
    );
  }
  return hit.url;
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

// Vybere řádek odpovídající release z hiyori záznamu. Když hiyori release
// nemá vyplněný, vezme se první (typicky jediný) řádek. Když ho má, ale na
// stránce takový není, vrací null → volající to nahlásí jako chybu.
function pickVariant(variants, wantedRelease) {
  const key = releaseKey(wantedRelease);
  if (!key) return variants[0];
  return variants.find((v) => releaseKey(v.release) === key) || null;
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

  const variant = pickVariant(variants, sub.release);
  if (!variant) {
    const nabidka = variants.map((v) => v.release || '?').join(', ');
    throw new Error(
      `hns.sk: release „${sub.release}" na stránce dílu není (nabízí: ${nabidka}). ` +
      `Nestahuji — doplň ručně přes 📤, nebo uprav parser. ${epUrl}`
    );
  }

  const { buf, rawName } = await fetchVariant(epUrl, variant);
  const saved = await saveSubFile(sub, buf, rawName);
  if (variant.release) setRelease(sub.sub_id, variant.release);

  return saved; // run.js označí záznam jako downloaded
}
