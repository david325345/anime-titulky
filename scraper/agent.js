// scraper/agent.js — stahování z webů, které nepustí náš Hetzner server.
//
// ange.3mka.cz a wosir.cz blokují zahraniční IP, ojiisans.top je za Cloudflare.
// Potřebujeme českou IP. SÁM NIC NEPARSUJE — vrací syrová data.
//
// Dvě cesty (parsery volají jen agentFetch, o cestě nevědí):
//  1) AGENT_PROXY (přednost) — HTTP proxy s českou IP (tinyproxy na Forpsi VPS, její
//     filtr pouští jen tyto domény, firewall jen náš Hetzner). Stahuje se přímo přes ni,
//     HTTPS tunelem → šifrované až na web (i přihlášení k wosiru).
//  2) AGENT_URL + AGENT_TOKEN — agent.php na webzdarma (záloha, původní řešení).
//
// Env: AGENT_PROXY (např. http://195.181.211.101:8888), AGENT_URL, AGENT_TOKEN.

import { ProxyAgent, request } from 'undici';
import { CONFIG } from '../config.js';

export function hasAgent() {
  return !!(CONFIG.agent.proxy || (CONFIG.agent.url && CONFIG.agent.token));
}

// ── cesta 1: přímo přes HTTP proxy ───────────────────────────────────────────
// Chová se jako agent.php: stejný prohlížečový UA a hlavičky, jen https a povolené
// domény, nejvýš 5 přesměrování (POST se po 301/302/303 mění na GET jako v curl),
// Set-Cookie ze všech odpovědí v řetězu, strop 8 MB, timeout 15 s.
const PROXY_ALLOWED = new Set([
  'ange.3mka.cz', '3mka.cz', 'wosir.cz', 'www.wosir.cz', 'ojiisans.top', 'www.ojiisans.top',
]);
const PROXY_MAX_BYTES = 8 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 15_000;
const PROXY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
let proxyAgent = null;
const getProxyAgent = () => (proxyAgent ||= new ProxyAgent(CONFIG.agent.proxy));

async function proxyFetch(url, opts = {}) {
  let method = String(opts.method || 'GET').toUpperCase();
  let body = opts.body ?? null;
  const follow = !!opts.follow;
  const cookies = [];
  let cur = url;
  for (let hop = 0; ; hop++) {
    let u;
    try { u = new URL(cur); } catch { throw new Error(`Agent: neplatná URL ${cur}`); }
    if (u.protocol !== 'https:') throw new Error('Agent: jen https URL.');
    if (!PROXY_ALLOWED.has(u.hostname.toLowerCase())) throw new Error(`Agent: doména '${u.hostname}' není povolena.`);

    const headers = {
      'user-agent': PROXY_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'cs-CZ,cs;q=0.9,en;q=0.8',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    };
    let res;
    try {
      res = await request(cur, {
        method,
        headers,
        body: method === 'POST' ? String(body ?? '') : undefined,
        dispatcher: getProxyAgent(),
        headersTimeout: PROXY_TIMEOUT_MS,
        bodyTimeout: PROXY_TIMEOUT_MS,
      });
    } catch (e) {
      throw new Error(`Agent nedostupný (proxy ${CONFIG.agent.proxy}): ${e.message}`);
    }

    const sc = res.headers['set-cookie'];
    if (sc) cookies.push(...(Array.isArray(sc) ? sc : [sc]));
    const loc = res.headers.location;
    const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode) && loc;

    if (follow && isRedirect) {
      await res.body.dump().catch(() => {});
      if (hop >= 5) throw new Error('Agent: příliš mnoho přesměrování.');
      cur = new URL(String(Array.isArray(loc) ? loc[0] : loc), cur).href;
      if ([301, 302, 303].includes(res.statusCode) && method === 'POST') { method = 'GET'; body = null; }
      continue;
    }

    // tělo se stropem 8 MB
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > PROXY_MAX_BYTES) {
        res.body.destroy();
        throw new Error('Agent: Soubor je prilis velky.');
      }
      chunks.push(chunk);
    }
    const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
    const out = {};
    for (const k of ['content-type', 'content-disposition', 'location', 'content-length']) {
      if (res.headers[k] != null) out[k] = String(one(res.headers[k]));
    }
    if (cookies.length) out['set-cookie'] = cookies;
    return { status: res.statusCode, buf: Buffer.concat(chunks), headers: out, effectiveUrl: cur, cookies };
  }
}

// Stáhne URL (přes proxy, jinak přes agent.php). Vrací { status, buf, headers, effectiveUrl, cookies[] }.
// opts: { method, body, cookie, follow }
export async function agentFetch(url, opts = {}) {
  if (CONFIG.agent.proxy) return proxyFetch(url, opts);
  if (!hasAgent()) {
    throw new Error(
      'Chybí AGENT_PROXY (nebo AGENT_URL / AGENT_TOKEN) — tento zdroj se stahuje přes českou IP.'
    );
  }
  const payload = {
    token: CONFIG.agent.token,
    url,
    method: opts.method || 'GET',
    ...(opts.body ? { body: opts.body } : {}),
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(opts.follow ? { follow: true } : {}),
  };

  let res;
  try {
    res = await fetch(CONFIG.agent.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`Agent nedostupný (${CONFIG.agent.url}): ${e.message}`);
  }

  let j;
  try {
    j = await res.json();
  } catch {
    throw new Error(`Agent vrátil nečitelnou odpověď (HTTP ${res.status}).`);
  }
  if (!j.ok) throw new Error(`Agent: ${j.error || 'neznámá chyba'}`);

  return {
    status: j.status,
    buf: Buffer.from(j.body_b64 || '', 'base64'),
    headers: j.headers || {},
    effectiveUrl: j.effective_url || url,
    cookies: j.headers?.['set-cookie'] || [],
  };
}

// Pohodlný wrapper pro HTML stránky.
export async function agentGetHtml(url, opts = {}) {
  const r = await agentFetch(url, { follow: true, ...opts });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} (${url})`);
  return r.buf.toString('utf8');
}

// Vytáhne jméno souboru z Content-Disposition hlavičky.
export function filenameFromHeaders(headers) {
  const cd = headers?.['content-disposition'] || '';
  const m = cd.match(/filename\*?=(?:UTF-8''|["']?)([^;"']+)/i);
  return m ? decodeURIComponent(m[1].trim()) : null;
}

// Sestaví Cookie hlavičku z pole Set-Cookie (bere jen name=value).
export function cookieHeaderFrom(setCookies = []) {
  return setCookies
    .map((c) => String(c).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}
