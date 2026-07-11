// scraper/sources/kamui-http.js — vlastní session/login pro kamui-subs.cz (WordPress).
// Login: GET /wp-login.php (nastaví wordpress_test_cookie) → POST log/pwd/wp-submit
//        → wordpress_logged_in_* cookie. Bez Cloudflare, bez captchy.
// Env: KAMUI_USER / KAMUI_PASS.

import { CONFIG } from '../../config.js';

const BASE = 'https://kamui-subs.cz';
const cookies = new Map();

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function capture(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const pair = line.split(';')[0];
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const name = pair.slice(0, i).trim();
    const val = pair.slice(i + 1).trim();
    if (val === '' || /^deleted$/i.test(val)) cookies.delete(name);
    else cookies.set(name, val);
  }
}
function headers(extra = {}, withCookie = true) {
  const h = {
    'User-Agent': CONFIG.userAgent,
    'Accept-Language': 'cs,sk;q=0.9,en;q=0.8',
    ...extra,
  };
  if (withCookie && cookies.size) h.Cookie = cookieHeader();
  return h;
}

const creds = () => ({
  user: process.env.KAMUI_USER || '',
  pass: process.env.KAMUI_PASS || '',
});

function isLoggedIn() {
  for (const k of cookies.keys()) if (k.startsWith('wordpress_logged_in')) return true;
  return false;
}

let loginInFlight = null;
export async function login() {
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    const { user, pass } = creds();
    if (!user || !pass) {
      throw new Error('Chybí přihlášení ke kamui-subs.cz (env KAMUI_USER / KAMUI_PASS).');
    }
    // 1) GET wp-login → wordpress_test_cookie
    const gres = await fetch(BASE + '/wp-login.php', {
      headers: headers({}, true),
      redirect: 'follow',
    });
    capture(gres);
    await gres.arrayBuffer().catch(() => {});

    // 2) POST přihlášení
    const body = new URLSearchParams({
      log: user,
      pwd: pass,
      'wp-submit': 'Log In',
      redirect_to: BASE + '/',
      testcookie: '1',
    });
    const pres = await fetch(BASE + '/wp-login.php', {
      method: 'POST',
      headers: headers(
        { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + '/wp-login.php', Origin: BASE },
        true
      ),
      body,
      redirect: 'manual',
    });
    capture(pres);
    await pres.arrayBuffer().catch(() => {});

    if (!isLoggedIn()) {
      throw new Error(`kamui-subs login selhal (status ${pres.status}). Zkontroluj KAMUI_USER/KAMUI_PASS.`);
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

// GET HTML stránky (s auto-reloginem)
export async function getHtml(url) {
  await ensureLogin();
  const abs = url.startsWith('http') ? url : BASE + url;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(abs, { headers: headers({}, true), redirect: 'follow' });
    capture(res);
    const text = await res.text();
    // přihlášenou stránku poznáme podle odkazu na logout/wp-admin
    if (/logout|wp-admin|wordpress_logged_in/i.test(text) || isLoggedIn()) return text;
    if (attempt === 0) { await login(); continue; }
    return text; // vrátíme i tak, parser si poradí / vyhodí chybu
  }
}

// GET binárního souboru (archiv). Vrací {buf, contentDisposition, contentType}.
export async function getBinary(url, { referer } = {}) {
  await ensureLogin();
  const abs = url.startsWith('http') ? url : BASE + url;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(abs, {
      headers: headers({ Referer: referer || BASE + '/' }, true),
      redirect: 'manual',
    });
    capture(res);
    const ct = (res.headers.get('content-type') || '').toLowerCase();

    if (res.status >= 300 && res.status < 400) {
      await res.arrayBuffer().catch(() => {});
      if (attempt === 0) { await login(); continue; }
      throw new Error('kamui-subs: redirect při stahování (odhlášeno?): ' + abs);
    }
    if (ct.includes('text/html')) {
      await res.arrayBuffer().catch(() => {});
      if (attempt === 0) { await login(); continue; }
      throw new Error('kamui-subs: dostal jsem HTML místo archivu: ' + abs);
    }

    return {
      buf: Buffer.from(await res.arrayBuffer()),
      contentDisposition: res.headers.get('content-disposition') || '',
      contentType: ct,
    };
  }
}

export { BASE as KAMUI_BASE };
