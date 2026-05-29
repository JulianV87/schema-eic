/**
 * Migration : images base64 (table config) -> Supabase Storage.
 *
 * Lit eic_image_library et eic_stickers, uploade chaque image base64 unique
 * (adressée par hash de contenu) dans le bucket `tiles` sous stickers/<hash>.<ext>,
 * puis réécrit les lignes pour ne contenir que des URLs publiques.
 *
 * Idempotent : relançable sans risque (upsert + dedup par hash ; les valeurs
 * déjà converties en URL sont ignorées).
 *
 * Usage : node scripts/migrate_images_to_storage.js
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://fbcwsgqrwolxnqpasbgl.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZiY3dzZ3Fyd29seG5xcGFzYmdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NDM5NDgsImV4cCI6MjA4OTUxOTk0OH0.yxadPWsLZwYbpet9wlYfTxW9Halx-XMV56PvorCKwIU';
const BUCKET = 'tiles';
const PREFIX = 'stickers';
const CONCURRENCY = 8;

function authHeaders(extra) {
  return Object.assign({ apikey: KEY, Authorization: 'Bearer ' + KEY }, extra || {});
}

async function getRow(key) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/config?select=value&key=eq.' + encodeURIComponent(key), { headers: authHeaders() });
  if (!r.ok) throw new Error('getRow ' + key + ' HTTP ' + r.status);
  const rows = await r.json();
  return rows.length ? rows[0].value : null;
}

async function setRow(key, value) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/config', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify([{ key: key, value: value }]),
  });
  if (!r.ok) throw new Error('setRow ' + key + ' HTTP ' + r.status + ' ' + (await r.text()));
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

function isDataUrl(s) { return typeof s === 'string' && s.startsWith('data:image'); }

function parseDataUrl(d) {
  const i = d.indexOf(';base64,');
  if (i < 0) return null;
  const mime = d.slice(5, i);
  const buf = Buffer.from(d.slice(i + 8), 'base64');
  return { mime: mime, buf: buf };
}

const inflight = new Map(); // hash -> Promise<url>
let uploaded = 0, skipped = 0;

async function uploadDataUrl(d) {
  const parsed = parseDataUrl(d);
  if (!parsed) return d;
  const hash = crypto.createHash('sha256').update(parsed.buf).digest('hex');
  const ext = EXT[parsed.mime] || 'png';
  const objPath = PREFIX + '/' + hash + '.' + ext;
  const publicUrl = SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + objPath;

  if (inflight.has(hash)) { skipped++; return inflight.get(hash); }

  const p = (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 400 * Math.pow(2, attempt)));
      try {
        const resp = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + objPath, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': parsed.mime, 'x-upsert': 'true' }),
          body: parsed.buf,
        });
        if (resp.ok || resp.status === 409) { uploaded++; return publicUrl; }
        if (resp.status === 429) continue;
        if (attempt === 3) throw new Error('upload ' + objPath + ' HTTP ' + resp.status + ' ' + (await resp.text()));
      } catch (e) {
        if (attempt === 3) throw e;
      }
    }
    throw new Error('upload ' + objPath + ' : échec après retries');
  })();
  inflight.set(hash, p);
  return p;
}

async function pool(items, n, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
      if ((uploaded + skipped) % 50 === 0) {
        process.stdout.write('  ... ' + (uploaded + skipped) + '/' + items.length + ' (uploads uniques: ' + uploaded + ')\r');
      }
    }
  });
  await Promise.all(workers);
}

async function main() {
  console.log('Lecture des lignes Supabase...');
  const lib = await getRow('eic_image_library');
  const stickers = await getRow('eic_stickers');

  const backupDir = path.join('_staging', 'migration_backup');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'eic_image_library.json'), JSON.stringify(lib));
  fs.writeFileSync(path.join(backupDir, 'eic_stickers.json'), JSON.stringify(stickers));
  console.log('Backup écrit dans ' + backupDir);

  // Collecter toutes les références d'images base64
  const refs = [];
  if (Array.isArray(lib)) {
    lib.forEach(img => { if (isDataUrl(img.dataUrl)) refs.push({ obj: img, key: 'dataUrl' }); });
  }
  if (Array.isArray(stickers)) {
    stickers.forEach(s => { if (isDataUrl(s.imageSrc)) refs.push({ obj: s, key: 'imageSrc' }); });
  }
  console.log(refs.length + ' références base64 à traiter...');
  if (refs.length === 0) { console.log('Rien à migrer (déjà fait ?).'); return; }

  await pool(refs, CONCURRENCY, async (ref) => {
    ref.obj[ref.key] = await uploadDataUrl(ref.obj[ref.key]);
  });
  process.stdout.write('\n');
  console.log('Uploads uniques: ' + uploaded + ' | refs déduppliquées: ' + skipped);

  console.log('Réécriture des lignes Supabase...');
  if (lib != null) await setRow('eic_image_library', lib);
  if (stickers != null) await setRow('eic_stickers', stickers);
  console.log('Migration terminée.');
}

main().catch(e => { console.error('ERREUR:', e.message); process.exit(1); });
