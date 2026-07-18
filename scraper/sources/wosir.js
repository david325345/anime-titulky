// scraper/sources/wosir.js — parser pro wosir.cz (skupiny WOSUBS a Širase).
//
// Web blokuje zahraniční/datacenter IP → vše jde přes český agent (scraper/agent.js).
// Navíc vyžaduje vlastní účet (env WOSIR_EMAIL / WOSIR_PASS).
//
// Mechanismus:
//  1) LOGIN: GET /prihlaseni → z HTML csrf_token, ze Set-Cookie PHPSESSID.
//     POST /prihlaseni  (prezdivka=e-mail, heslo, csrf_token, sub=Prihlasit)
//     Chyba → v odpovědi je <script>alert('Neplatné uživatelské jméno nebo heslo.')</script>
//  2) hiyori dává odkaz na konkrétní soubor:
//       https://www.wosir.cz/download.php?id=2017     (běžná verze)
//       https://www.wosir.cz/download_bd.php?id=1311  (BD verze)
//     Ten 302 přesměruje na stránku anime (…/anime?id=5561) — to není chyba,
//     říká nám to, kde titulek najít.
//  3) Na stránce anime je pro každý díl formulář:
//       <form method="post" class="form-test">
//         <input type="hidden" name="file_to_download" value="./s/Hjakkano_3_1.ass">
//         <input type="submit" name="dwl" value="Stáhnout">
//         <input type="text" name="hiddenid" value="2017">   ← ID z hiyori odkazu
//       </form>
//     Podle hiddenid == id z URL najdeme PRÁVĚ ten náš řádek (žádné hádání dle epizody).
//  4) POST na stránku anime s těmi poli → přímo .ass (Content-Disposition).

import * as cheerio from 'cheerio';
import { CONFIG } from '../../config.js';
import { agentFetch, filenameFromHeaders, cookieHeaderFrom } from '../agent.js';
import { saveSubFile } from '../download.js';

export const name = 'wosir.cz';

const LOGIN_URL = 'https://www.wosir.cz/prihlaseni';

// Session držíme mezi stahováními (šetří logins). Vyprší → zalogujeme znovu.
let sessionCookie = null;

function alertFrom(html) {
  const m = String(html).match(/alert\('([^']+)'\)/);
  return m ? m[1] : null;
}

// Přihlásí se a vrátí Cookie hlavičku se session.
async function login() {
  const { email, pass } = CONFIG.wosir;
  if (!email || !pass) {
    throw new Error('wosir: chybí WOSIR_EMAIL / WOSIR_PASS (nastav v Coolify).');
  }

  // 1) GET → csrf_token + session cookie
  const g = await agentFetch(LOGIN_URL, { follow: true });
  if (g.status !== 200) throw new Error(`wosir: login stránka vrátila HTTP ${g.status}.`);
  const $ = cheerio.load(g.buf.toString('utf8'));
  const csrf = $('input[name="csrf_token"]').attr('value');
  if (!csrf) throw new Error('wosir: na přihlašovací stránce chybí csrf_token.');

  let cookie = cookieHeaderFrom(g.cookies);
  if (!/PHPSESSID/i.test(cookie)) {
    throw new Error('wosir: nedostali jsme session cookie (PHPSESSID).');
  }

  // 2) POST se stejnou session
  const body = new URLSearchParams({
    prezdivka: email,
    heslo: pass,
    csrf_token: csrf,
    sub: 'Prihlasit',
  }).toString();

  const p = await agentFetch(LOGIN_URL, { method: 'POST', body, cookie, follow: false });
  const alert = alertFrom(p.buf.toString('utf8'));
  if (alert) throw new Error(`wosir: login odmítnut — ${alert}`);

  // server může session po loginu vyměnit
  const fresh = cookieHeaderFrom(p.cookies);
  if (/PHPSESSID/i.test(fresh)) cookie = fresh;

  sessionCookie = cookie;
  return cookie;
}

async function ensureSession() {
  if (sessionCookie) return sessionCookie;
  return login();
}

// Z odkazu hiyori vytáhne ID souboru (download.php?id=2017 / download_bd.php?id=1311).
function fileIdFrom(url) {
  const m = String(url).match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

// Najde ve stránce anime formulář s daným hiddenid. wosir má ROZBITÉ vnořené
// HTML (</td></td>, formuláře přes sebe), na kterém cheerio nespáruje hiddenid
// s file_to_download → hledáme regexem v syrovém HTML.
// Rozlišuje BD verzi (file_to_download_BD + dwl_bd) od běžné (file_to_download + dwl).
// Vrací { fileToDownload, isBD, fileField, dwlField }.
export function findFormByHiddenId(html, id) {
  const hiRe = new RegExp('name="hiddenid"\\s+value="' + id + '"');
  const m = hiRe.exec(html);
  if (!m) return null;
  const formStart = html.lastIndexOf('<form', m.index);
  if (formStart < 0) return null;
  const block = html.slice(formStart, m.index + 40);

  const isBD = /name="file_to_download_BD"/.test(block);
  const fileField = isBD ? 'file_to_download_BD' : 'file_to_download';
  const dwlField = isBD ? 'dwl_bd' : 'dwl';
  const fileRe = new RegExp('name="' + fileField + '"\\s+value="([^"]+)"');
  const file = (block.match(fileRe) || [])[1];
  if (!file) return null;
  return { fileToDownload: file.trim(), isBD, fileField, dwlField };
}

export async function download(sub) {
  const id = fileIdFrom(sub.url);
  if (!id) throw new Error(`wosir: z odkazu nejde vyčíst id (${sub.url}).`);

  // Hiyori dává odkaz bez www (wosir.cz/download.php?id=…). Ten dělá 301 na
  // www.wosir.cz, a při tom cross-domain redirectu se ZTRATÍ session cookie
  // → wosir nás bere jako nepřihlášené a hodí na /index1. Proto na www
  // přepneme rovnou, ať k redirectu vůbec nedojde.
  const startUrl = sub.url.replace(/^https?:\/\/(?:www\.)?wosir\.cz/i, 'https://www.wosir.cz');

  let cookie = await ensureSession();

  // příznak: přistáli jsme na stránce anime? (přihlášená session tam přesměruje)
  const landedOnAnime = (resp) => /\/anime\?id=/i.test(resp.effectiveUrl || '');

  // 1) odkaz z hiyori → má přesměrovat na stránku anime
  let r = await agentFetch(startUrl, { cookie, follow: true });

  // Když nás to hodilo na index1 / přihlašovací stránku (ne na anime),
  // session vypršela → přihlas se jednou znovu a zopakuj.
  if (!landedOnAnime(r)) {
    cookie = await login();
    r = await agentFetch(startUrl, { cookie, follow: true });
  }
  if (r.status !== 200) throw new Error(`wosir: HTTP ${r.status} (${sub.url}).`);
  if (!landedOnAnime(r)) {
    throw new Error(
      `wosir: po přihlášení nás to nepřesměrovalo na stránku anime ` +
      `(skončili jsme na ${r.effectiveUrl}). Zkontroluj přihlášení nebo id=${id}.`
    );
  }

  const pageUrl = r.effectiveUrl; // …/anime?id=5561
  const html = r.buf.toString('utf8');

  // 2) najdi náš řádek podle hiddenid (regex — cheerio nezvládá rozbité HTML)
  const form = findFormByHiddenId(html, id);
  if (!form) {
    throw new Error(`wosir: na stránce ${pageUrl} není titulek s id=${id}.`);
  }

  // 3) POST → .ass. BD verze posílá jiná pole (file_to_download_BD + dwl_bd).
  const body = new URLSearchParams({
    [form.fileField]: form.fileToDownload,
    hiddenid: id,
    [form.dwlField]: form.isBD ? 'Stáhnout BD' : 'Stáhnout',
  }).toString();

  const d = await agentFetch(pageUrl, { method: 'POST', body, cookie, follow: true });
  if (d.status !== 200) throw new Error(`wosir: HTTP ${d.status} při stahování titulku.`);
  const buf = d.buf;

  const head = buf.slice(0, 200).toString('utf8');
  if (/<html|<!doctype/i.test(head)) {
    throw new Error('wosir: download nevrátil titulek (HTML stránka — vypršela session?).');
  }

  // 4) jméno souboru + release (BD verzi označíme)
  const rawName =
    filenameFromHeaders(d.headers) ||
    form.fileToDownload.split('/').pop() ||
    `wosir-ep${sub.episode}.ass`;

  const grp = sub.group_name || 'WoŠir';
  // BD verzi označíme v release (ať se odliší od web-ripu v katalogu).
  // Když už release z hiyori existuje, přidáme "BD"; jinak "BD" samotné.
  const release = form.isBD
    ? (sub.release ? `${sub.release} (BD)` : 'BD')
    : sub.release;
  return saveSubFile({ ...sub, group_name: grp, release }, buf, rawName);
}
