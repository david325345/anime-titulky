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

// Najde ve stránce anime formulář s daným hiddenid → { fileToDownload }.
export function findFormByHiddenId($, id) {
  let hit = null;
  $('form.form-test, form').each((_, f) => {
    if (hit) return;
    const $f = $(f);
    const hidden = $f.find('input[name="hiddenid"]').attr('value');
    if (String(hidden || '').trim() !== String(id)) return;
    const file = $f.find('input[name="file_to_download"]').attr('value');
    if (file) hit = { fileToDownload: file.trim() };
  });
  return hit;
}

export async function download(sub) {
  const id = fileIdFrom(sub.url);
  if (!id) throw new Error(`wosir: z odkazu nejde vyčíst id (${sub.url}).`);

  let cookie = await ensureSession();

  // 1) odkaz z hiyori → přesměruje na stránku anime
  let r = await agentFetch(sub.url, { cookie, follow: true });

  // session mohla vypršet → zkus jednou znovu přihlásit
  if (r.status === 200 && /P.ihl.šen. u.ivatele|name="csrf_token"/i.test(r.buf.toString('utf8').slice(0, 3000))) {
    cookie = await login();
    r = await agentFetch(sub.url, { cookie, follow: true });
  }
  if (r.status !== 200) throw new Error(`wosir: HTTP ${r.status} (${sub.url}).`);

  const pageUrl = r.effectiveUrl; // …/anime?id=5561
  const $ = cheerio.load(r.buf.toString('utf8'));

  // 2) najdi náš řádek podle hiddenid
  const form = findFormByHiddenId($, id);
  if (!form) {
    throw new Error(`wosir: na stránce ${pageUrl} není titulek s id=${id}.`);
  }

  // 3) POST → .ass (stejně jako to dělá prohlížeč, ať se započítá stažení)
  const body = new URLSearchParams({
    file_to_download: form.fileToDownload,
    hiddenid: id,
    dwl: 'Stáhnout',
  }).toString();

  const d = await agentFetch(pageUrl, { method: 'POST', body, cookie, follow: true });
  if (d.status !== 200) throw new Error(`wosir: HTTP ${d.status} při stahování titulku.`);
  const buf = d.buf;

  const head = buf.slice(0, 200).toString('utf8');
  if (/<html|<!doctype/i.test(head)) {
    throw new Error('wosir: download nevrátil titulek (HTML stránka — vypršela session?).');
  }

  // 4) jméno souboru
  const rawName =
    filenameFromHeaders(d.headers) ||
    form.fileToDownload.split('/').pop() ||
    `wosir-ep${sub.episode}.ass`;

  const grp = sub.group_name || 'WoŠir';
  return saveSubFile({ ...sub, group_name: grp }, buf, rawName);
}
