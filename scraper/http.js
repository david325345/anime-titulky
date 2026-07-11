// scraper/http.js — správa session (cookie 'Hiyori'), login a autentizované requesty.
// Bez prohlížeče, přes nativní fetch (Node 20+). Login formulář hiyori NEMÁ captchu.
import { CONFIG } from '../config.js';
import { hostGate } from './ratelimit.js';

const cookies = new Map(); // name -> value

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Chyba signalizující, že nás server brzdí (429/503). Běh se má okamžitě utnout.
export class RateLimited extends Error {
  constructor(msg) { super(msg); this.name = 'RateLimited'; }
}

// náhodná pauza v rozsahu (jitter) — pravidelný rytmus je pro rate-limiter čitelný
export function throttle() {
  let min = CONFIG.delayMinMs;
  let max = CONFIG.delayMaxMs;
  if (!min || !max || max < min) {
    const base = CONFIG.requestDelayMs;
    min = Math.round(base * 0.8);
    max = Math.round(base * 1.6);
  }
  const ms = min + Math.floor(Math.random() * (max - min + 1));
  return new Promise((r) => setTimeout(r, ms));
}

// z hlavičky Retry-After (sekundy nebo HTTP datum) spočítá čekání v ms
function retryAfterMs(res) {
  const ra = res.headers.get('retry-after');
  if (!ra) return null;
  if (/^\d+$/.test(ra.trim())) return Number(ra.trim()) * 1000;
  const t = Date.parse(ra);
  return isNaN(t) ? null : Math.max(0, t - Date.now());
}

// vrátí true, pokud jde o rate-limit odpověď (a po počkání se má zkusit znovu)
async function handleRateLimit(res, url, tries) {
  if (res.status !== 429 && res.status !== 503) return false;
  await res.arrayBuffer().catch(() => {});
  if (tries >= CONFIG.rateLimitRetries) {
    throw new RateLimited(`Server brzdí (HTTP ${res.status}) i po ${tries} pokusech: ${url}`);
  }
  const wait = retryAfterMs(res) ?? CONFIG.rateLimitBackoffMs * (tries + 1);
  console.log(`  ⏳ HTTP ${res.status}, čekám ${Math.round(wait / 1000)}s a zkouším znovu…`);
  await new Promise((r) => setTimeout(r, wait));
  return true;
}

function captureSetCookies(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const pair = line.split(';')[0];
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const name = pair.slice(0, i).trim();
    const val = pair.slice(i + 1).trim();
    if (val === '') cookies.delete(name); // server maže cookie (expirací)
    else cookies.set(name, val);
  }
}

function baseHeaders(extra = {}, withCookie = false) {
  const h = {
    'User-Agent': CONFIG.userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'cs,sk;q=0.9,en;q=0.8',
    ...extra,
  };
  if (withCookie && cookies.size) h.Cookie = cookieHeader();
  return h;
}

export function isLoggedIn() {
  return cookies.has('Hiyori') && cookies.get('Hiyori');
}

let loginInFlight = null;

export async function login() {
  // deduplikace paralelních loginů
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    // 1) warm-up GET (může nastavit init cookie)
    await hostGate(CONFIG.baseUrl);
    const home = await fetch(CONFIG.baseUrl + '/', {
      headers: baseHeaders(),
      redirect: 'manual',
    });
    captureSetCookies(home);
    await home.arrayBuffer().catch(() => {});

    // 2) POST /account/login
    const body = new URLSearchParams({
      username: CONFIG.user,
      Password: CONFIG.pass, // pozor: velké 'P' (přesně jak má formulář)
      remember_me: 'true',
    });
    await hostGate(CONFIG.baseUrl);
    const res = await fetch(CONFIG.baseUrl + '/account/login', {
      method: 'POST',
      headers: baseHeaders({
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: CONFIG.baseUrl + '/',
        Origin: CONFIG.baseUrl,
      }),
      body,
      redirect: 'manual',
    });
    captureSetCookies(res);
    await res.arrayBuffer().catch(() => {});

    const ok = res.status >= 300 && res.status < 400 && isLoggedIn();
    if (!ok) {
      throw new Error(
        `Login selhal (status ${res.status}, cookie ${
          isLoggedIn() ? 'ano' : 'ne'
        }). Zkontroluj HIYORI_USER/HIYORI_PASS.`
      );
    }
    return true;
  })();
  try {
    return await loginInFlight;
  } finally {
    loginInFlight = null;
  }
}

async function ensureLogin() {
  if (!isLoggedIn()) await login();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET HTML stránky s auto-reloginem + zvládnutím rate-limitu (429/503).
export async function getHtml(pathOrUrl, { referer } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : CONFIG.baseUrl + pathOrUrl;
  await ensureLogin();
  let rlTries = 0;
  let loginTries = 0;
  while (true) {
    await hostGate(url);
    const res = await fetch(url, {
      headers: baseHeaders({ Referer: referer || CONFIG.baseUrl + '/' }, true),
      redirect: 'follow',
    });
    if (await handleRateLimit(res, url, rlTries)) { rlTries++; continue; }
    captureSetCookies(res);
    const text = await res.text();
    if (text.includes('/account/logout')) return text; // jsme přihlášeni
    if (loginTries === 0) {
      loginTries++;
      await login(); // spadli jsme na login stránku → přihlásit a zkusit znovu
      continue;
    }
    throw new Error('Stránka nedostupná / nelze se přihlásit: ' + url);
  }
}

// GET binárního souboru (stažení titulku). Vrací buffer + název z Content-Disposition.
export async function getBinary(pathOrUrl, { referer } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : CONFIG.baseUrl + pathOrUrl;
  await ensureLogin();
  let rlTries = 0;
  let loginTries = 0;
  while (true) {
    await hostGate(url);
    const res = await fetch(url, {
      headers: baseHeaders({ Referer: referer || CONFIG.baseUrl + '/' }, true),
      redirect: 'manual',
    });
    if (await handleRateLimit(res, url, rlTries)) { rlTries++; continue; }
    captureSetCookies(res);
    const ct = (res.headers.get('content-type') || '').toLowerCase();

    // redirect nebo HTML = nejspíš vypadlá session
    if (res.status >= 300 && res.status < 400) {
      await res.arrayBuffer().catch(() => {});
      if (loginTries === 0) { loginTries++; await login(); continue; }
      throw new Error('Redirect při stahování (odhlášeno?): ' + url);
    }
    if (ct.includes('text/html')) {
      await res.arrayBuffer().catch(() => {});
      if (loginTries === 0) { loginTries++; await login(); continue; }
      throw new Error('Dostal jsem HTML místo souboru: ' + url);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return {
      buf,
      contentType: ct,
      contentDisposition: res.headers.get('content-disposition') || '',
    };
  }
}

export { sleep };
