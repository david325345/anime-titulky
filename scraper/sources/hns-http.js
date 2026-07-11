// scraper/sources/hns-http.js — vlastní session/login pro hns.sk (jiný web než hiyori).
// Yii2 (PHP): PHPSESSID + _csrf cookie, přihlašovací token _csrf z formuláře.
// Login: GET /site/login (CSRF z hidden pole) → POST LoginForm[email]/[password] → _identity cookie.
// Bez Cloudflare, bez captchy. Env: HNS_EMAIL / HNS_PASS.

import * as cheerio from 'cheerio';
import { CONFIG } from '../../config.js';
import { hostGate } from '../ratelimit.js';

const BASE = 'https://hns.sk';
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
    if (val === '') cookies.delete(name);
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
  email: process.env.HNS_EMAIL || '',
  pass: process.env.HNS_PASS || '',
});

function isLoggedIn() {
  return cookies.has('_identity');
}

let loginInFlight = null;
export async function login() {
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    const { email, pass } = creds();
    if (!email || !pass) {
      throw new Error('Chybí přihlášení k hns.sk (env HNS_EMAIL / HNS_PASS).');
    }
    // 1) GET login formulář → CSRF token
    await hostGate(BASE);
    const gres = await fetch(BASE + '/site/login', {
      headers: headers({}, true),
      redirect: 'follow',
    });
    capture(gres);
    const html = await gres.text();
    const $ = cheerio.load(html);
    const csrf = $('#login-form input[name="_csrf"]').attr('value') ||
      $('input[name="_csrf"]').first().attr('value');
    if (!csrf) throw new Error('hns.sk: nenašel jsem CSRF token na /site/login.');

    // 2) POST přihlášení
    const body = new URLSearchParams({
      _csrf: csrf,
      'LoginForm[email]': email,
      'LoginForm[password]': pass,
      'LoginForm[rememberMe]': '1',
    });
    await hostGate(BASE);
    const pres = await fetch(BASE + '/site/login', {
      method: 'POST',
      headers: headers(
        { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + '/site/login', Origin: BASE },
        true
      ),
      body,
      redirect: 'manual',
    });
    capture(pres);
    await pres.arrayBuffer().catch(() => {});

    if (!isLoggedIn()) {
      throw new Error(`hns.sk login selhal (status ${pres.status}). Zkontroluj HNS_EMAIL/HNS_PASS.`);
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

// GET HTML (s auto-reloginem když session vyprší → redirect na /site/login)
export async function getHtml(url) {
  await ensureLogin();
  const abs = url.startsWith('http') ? url : BASE + url;
  for (let attempt = 0; attempt < 2; attempt++) {
    await hostGate(abs);
    await hostGate(abs);
  const res = await fetch(abs, { headers: headers({}, true), redirect: 'manual' });
    capture(res);
    if (res.status >= 300 && res.status < 400 && /\/site\/login/.test(res.headers.get('location') || '')) {
      await res.arrayBuffer().catch(() => {});
      if (attempt === 0) { await login(); continue; }
      throw new Error('hns.sk: přesměrování na login i po přihlášení: ' + abs);
    }
    return await res.text();
  }
}

// POST (form) → binární soubor. Vrací {buf, contentDisposition}.
export async function postBinary(url, form) {
  await ensureLogin();
  const abs = url.startsWith('http') ? url : BASE + url;
  const body = new URLSearchParams(form);
  await hostGate(abs);
  const res = await fetch(abs, {
    method: 'POST',
    headers: headers(
      { 'Content-Type': 'application/x-www-form-urlencoded', Referer: abs, Origin: BASE },
      true
    ),
    body,
    redirect: 'manual',
  });
  capture(res);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html') || (res.status >= 300 && res.status < 400)) {
    await res.arrayBuffer().catch(() => {});
    throw new Error(`hns.sk: stažení vrátilo ${res.status}/${ct} místo souboru.`);
  }
  return {
    buf: Buffer.from(await res.arrayBuffer()),
    contentDisposition: res.headers.get('content-disposition') || '',
  };
}

export { BASE as HNS_BASE };
