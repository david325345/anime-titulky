// backup.js — záloha SQLite DB na R2.
//
// SQLite se NESMÍ kopírovat obyčejným readFile za běhu (může být rozepsaná
// transakce / WAL) → použijeme better-sqlite3 .backup(), který udělá
// konzistentní snapshot i za provozu. Snapshot zgzipujeme a nahrajeme na R2.
//
// Klíče: db-backups/hiyori-YYYY-MM-DD.db.gz  (jeden na den, přepíše se při
// opakování téhož dne). Retence: držíme posledních KEEP_BACKUPS, starší mažou.
//
// Automaticky 1× denně (viz startDbBackup v server.js).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { db, dbPath } from './db.js';
import { r2Put, r2List, r2Delete, r2Enabled } from './r2.js';

const gzip = promisify(zlib.gzip);

const PREFIX = 'titulky-db-backup/';
const KEEP_BACKUPS = 7;
const BACKUP_HOUR = 3; // noční záloha ve 3:00 (lokální čas serveru)

// konzistentní snapshot DB do dočasného souboru → Buffer
async function snapshotBuffer() {
  const tmp = path.join(os.tmpdir(), `hiyori-backup-${Date.now()}.db`);
  try {
    await db.backup(tmp); // better-sqlite3: bezpečné i za běhu (kopíruje i WAL)
    return fs.readFileSync(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function todayKey() {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${PREFIX}hiyori-${d}.db.gz`;
}

// Vytvoří zálohu a nahraje na R2. Vrací { key, bytes } nebo hodí chybu.
export async function backupDbToR2() {
  if (!r2Enabled()) throw new Error('R2 není nastavené — zálohu nelze nahrát.');
  const raw = await snapshotBuffer();
  const gz = await gzip(raw);
  const key = todayKey();
  await r2Put(key, gz, 'application/gzip');
  await pruneOldBackups();
  return { key, bytes: gz.length, raw_bytes: raw.length };
}

// Nechá jen posledních KEEP_BACKUPS, starší smaže.
async function pruneOldBackups() {
  const list = await r2List(PREFIX);
  const backups = list
    .filter((o) => /hiyori-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(o.key))
    .sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1)); // nejnovější první
  const toDelete = backups.slice(KEEP_BACKUPS);
  for (const o of toDelete) {
    try { await r2Delete(o.key); } catch {}
  }
  return { kept: Math.min(backups.length, KEEP_BACKUPS), deleted: toDelete.length };
}

// Živá DB jako gzip buffer — pro tlačítko "stáhnout" (aktuální stav).
export async function liveDbGzip() {
  const raw = await snapshotBuffer();
  return { buffer: await gzip(raw), raw_bytes: raw.length };
}

// Naplánuje denní zálohu na noční hodinu (BACKUP_HOUR). NEspouští po startu
// (restartů může být za den víc) — čeká na nejbližší BACKUP_HOUR, pak každých 24 h.
export function startDbBackup(log = console.log) {
  if (!r2Enabled()) {
    log('[backup] R2 není nastavené — automatická záloha DB vypnutá.');
    return;
  }
  const DAY = 24 * 60 * 60 * 1000;
  const run = async () => {
    try {
      const r = await backupDbToR2();
      log(`[backup] DB → R2 ${r.key} (${(r.bytes / 1024).toFixed(0)} KB) ${new Date().toISOString()}`);
    } catch (e) {
      log(`[backup] selhalo: ${e.message}`);
    }
  };

  // ms do nejbližší BACKUP_HOUR:00 (lokální čas)
  const now = new Date();
  const next = new Date(now);
  next.setHours(BACKUP_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1); // už proběhla → zítra
  const delay = next - now;

  log(`[backup] první záloha naplánována na ${next.toISOString()} (za ${(delay / 3600000).toFixed(1)} h)`);
  setTimeout(() => {
    run();
    setInterval(run, DAY).unref();
  }, delay).unref();
}
