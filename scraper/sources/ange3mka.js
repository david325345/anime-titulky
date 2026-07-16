// scraper/sources/ange3mka.js — parser pro ange.3mka.cz (skupina Ange).
//
// Joomla + jDownloads, veřejné (bez loginu). ALE web blokuje zahraniční/datacenter IP,
// takže vše jde přes český agent (scraper/agent.js → agent.php na CZ hostingu).
//
// Struktura stránky anime: každá epizoda = vlastní <table>:
//   <img src=".../jdownloads/fileimages/01.png">        ← číslo dílu
//   <span class="anime-jdownloads-soubory">Sféra</span>  ← název
//   <span style="color:#bb1010;">v2</span>               ← verze
//   <a href="/component/jdownloads/send/{kat}/{file}" class="jdbutton">Stáhnout</a>
//
// Položky bez čísla (fonty.png) se přeskočí. Download vrací přímo .ass
// s Content-Disposition: filename="Gachiakuta - 08 [3Mka] [].ass".

import * as cheerio from 'cheerio';
import { agentFetch, agentGetHtml, filenameFromHeaders } from '../agent.js';
import { saveSubFile } from '../download.js';

export const name = 'ange.3mka.cz';

const BASE = 'https://ange.3mka.cz';

function groupFromName(nm) {
  const m = (nm || '').match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

// ze stránky anime udělá mapu { episode: {url, title, version} }
export function parseEpisodeMap($) {
  const map = {};
  // hlavní seznam pozná podle tlačítka a.jdbutton (postranní modul ho nemá)
  $('a.jdbutton[href*="/jdownloads/send/"]').each((_, a) => {
    const $a = $(a);
    const href = ($a.attr('href') || '').trim();
    if (!href) return;

    // číslo dílu z obrázku ve stejné tabulce (fileimages/01.png)
    const $row = $a.closest('table');
    const img = $row.find('img[src*="/jdownloads/fileimages/"]').first().attr('src') || '';
    const numTxt = (img.match(/fileimages\/([^/"']+)\.png/i) || [])[1] || '';
    const ep = Number(numTxt);
    if (!ep || Number.isNaN(ep)) return; // 'fonty.png' apod. → přeskoč

    if (map[ep] != null) return; // první výskyt vyhrává
    map[ep] = {
      url: href.startsWith('http') ? href : BASE + href,
      title: $row.find('.anime-jdownloads-soubory').first().text().trim() || null,
      version: ($row.find('span').filter((_, s) =>
        /^v\d/i.test($(s).text().trim())).first().text().trim()) || null,
    };
  });
  return map;
}

export async function download(sub) {
  // 1) stránka anime (přes agenta — přímo by nás web zablokoval)
  const html = await agentGetHtml(sub.url);
  const $ = cheerio.load(html);

  // 2) najdi díl
  const map = parseEpisodeMap($);
  const hit = map[sub.episode];
  if (!hit) {
    const known = Object.keys(map).join(', ') || 'žádné';
    throw new Error(
      `3mka: na stránce není díl ${sub.episode} (nalezené díly: ${known}).`
    );
  }

  // 3) stáhni titulek (přímý .ass)
  const r = await agentFetch(hit.url, { follow: true });
  if (r.status !== 200) throw new Error(`3mka: HTTP ${r.status} při stahování titulku.`);
  const buf = r.buf;

  // ověř, že je to titulek, ne HTML chybovka
  const head = buf.slice(0, 200).toString('utf8');
  if (/<html|<!doctype/i.test(head)) {
    throw new Error('3mka: download nevrátil titulek (HTML stránka).');
  }

  // 4) název souboru z Content-Disposition ("Gachiakuta - 08 [3Mka] [].ass")
  const rawName = filenameFromHeaders(r.headers) || `3mka-ep${sub.episode}.ass`;

  const grp = sub.group_name || groupFromName(rawName) || 'Ange';
  return saveSubFile({ ...sub, group_name: grp }, buf, rawName);
}
