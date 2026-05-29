/**
 * Reclasse les scénarios "bagage oublié" : sous-catégorie
 * "Bagage oublié à bord d'un train" -> "Bagage oublié à quai".
 *
 * Cible la table config / clé eic_scenarios. Backup avant écriture.
 * Idempotent (relançable : ne touche que les lignes encore "à bord d'un train").
 *
 * Usage : node scripts/recategorize_baggage_scenarios.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://fbcwsgqrwolxnqpasbgl.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZiY3dzZ3Fyd29seG5xcGFzYmdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NDM5NDgsImV4cCI6MjA4OTUxOTk0OH0.yxadPWsLZwYbpet9wlYfTxW9Halx-XMV56PvorCKwIU';

const FROM = "Bagage oublié à bord d'un train";
const TO = 'Bagage oublié à quai';

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

async function main() {
  const scenarios = await getRow('eic_scenarios');
  if (!Array.isArray(scenarios)) { throw new Error('eic_scenarios inattendu (pas un tableau)'); }

  const backupDir = path.join('_staging', 'scenarios_backup');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'eic_scenarios.json'), JSON.stringify(scenarios));
  console.log('Backup écrit dans ' + backupDir + ' (' + scenarios.length + ' scénarios)');

  let changed = 0;
  scenarios.forEach(sc => {
    if (sc.subcategory === FROM) {
      sc.subcategory = TO;
      changed++;
      console.log('  ' + (sc.name || sc.id) + ' : « ' + FROM + ' » -> « ' + TO + ' »');
    }
  });

  if (changed === 0) { console.log('Aucun scénario à reclasser (déjà fait ?).'); return; }

  await setRow('eic_scenarios', scenarios);
  console.log('Terminé : ' + changed + ' scénarios reclassés en « ' + TO + ' ».');
}

main().catch(e => { console.error('ERREUR:', e.message); process.exit(1); });
