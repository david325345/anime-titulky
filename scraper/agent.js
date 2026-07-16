// scraper/agent.js — klient pro agent.php běžící na českém hostingu.
//
// ange.3mka.cz a wosir.cz blokují zahraniční/datacenter IP (náš Hetzner server).
// Agent má českou IP a pro nás obsah stáhne. SÁM NIC NEPARSUJE — vrací syrová data.
//
// Env: AGENT_URL (např. http://nimetodex.xf.cz/agent.php), AGENT_TOKEN.

import { CONFIG } from '../config.js';

export function hasAgent() {
  return !!(CONFIG.agent.url && CONFIG.agent.token);
}

// Stáhne URL přes agenta. Vrací { status, buf, headers, effectiveUrl, cookies[] }.
// opts: { method, body, cookie, follow }
export async function agentFetch(url, opts = {}) {
  if (!hasAgent()) {
    throw new Error(
      'Chybí AGENT_URL / AGENT_TOKEN — tento zdroj se stahuje přes český agent.'
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
