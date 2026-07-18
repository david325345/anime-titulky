// r2.js — upload titulků na Cloudflare R2 (S3-kompatibilní API) přes aws4fetch.
// Když nejsou nastavené R2 klíče, upload se přeskočí (služba jede jen lokálně).
import { AwsClient } from 'aws4fetch';
import { CONFIG } from './config.js';

let client = null;
function getClient() {
  const { accountId, accessKeyId, secretKey } = CONFIG.r2;
  if (!accountId || !accessKeyId || !secretKey) return null;
  if (!client) {
    client = new AwsClient({
      accessKeyId,
      secretAccessKey: secretKey,
      region: 'auto',
      service: 's3',
    });
  }
  return client;
}

export function r2Enabled() {
  return !!getClient();
}

function endpoint(key) {
  const safe = key.split('/').map(encodeURIComponent).join('/');
  return `https://${CONFIG.r2.accountId}.r2.cloudflarestorage.com/${CONFIG.r2.bucket}/${safe}`;
}

// veřejné URL (pokud je nastaven R2_PUBLIC_BASE), jinak null
export function r2PublicUrl(key) {
  if (!CONFIG.r2.publicBase) return null;
  const safe = key.split('/').map(encodeURIComponent).join('/');
  return `${CONFIG.r2.publicBase}/${safe}`;
}

// nahraje buffer na R2. Vrací key, nebo hodí chybu.
export async function r2Put(key, body, contentType = 'application/octet-stream') {
  const c = getClient();
  if (!c) return null;
  const res = await c.fetch(endpoint(key), {
    method: 'PUT',
    body,
    headers: { 'Content-Type': contentType },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`R2 PUT ${res.status}: ${t.slice(0, 200)}`);
  }
  return key;
}

// stáhne objekt z R2 → Buffer (nebo null, když R2 není / objekt chybí).
export async function r2Get(key) {
  const c = getClient();
  if (!c) return null;
  const res = await c.fetch(endpoint(key), { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`R2 GET ${res.status}: ${t.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// smaže objekt z R2. Vrací true když proběhlo (i 404 bereme jako "už není").
export async function r2Delete(key) {
  const c = getClient();
  if (!c || !key) return false;
  const res = await c.fetch(endpoint(key), { method: 'DELETE' });
  if (res.ok || res.status === 204 || res.status === 404) return true;
  const t = await res.text().catch(() => '');
  throw new Error(`R2 DELETE ${res.status}: ${t.slice(0, 200)}`);
}

// vylistuje klíče pod prefixem → [{ key, size, lastModified }]. Stránkuje.
export async function r2List(prefix) {
  const c = getClient();
  if (!c) return [];
  const out = [];
  let token = null;
  do {
    const u = new URL(`https://${CONFIG.r2.accountId}.r2.cloudflarestorage.com/${CONFIG.r2.bucket}`);
    u.searchParams.set('list-type', '2');
    u.searchParams.set('prefix', prefix);
    u.searchParams.set('max-keys', '1000');
    if (token) u.searchParams.set('continuation-token', token);
    const res = await c.fetch(u.toString());
    if (!res.ok) throw new Error(`R2 LIST ${res.status}`);
    const xml = await res.text();
    const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1];
      const key = dec((block.match(/<Key>([^<]+)<\/Key>/) || [])[1] || '');
      const size = Number((block.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
      const lastModified = (block.match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1] || '';
      if (key) out.push({ key, size, lastModified });
    }
    const t = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = t ? t[1] : null;
  } while (token);
  return out;
}
