/**
 * Génération des tuiles Deep Zoom depuis un PNG et upload vers Supabase Storage.
 *
 * Usage: node scripts/generate_tiles_supabase.js schema.png
 *
 * Variables d'environnement requises:
 *   SUPABASE_URL         - URL du projet Supabase
 *   SUPABASE_SERVICE_KEY - Clé de service Supabase
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fbcwsgqrwolxnqpasbgl.supabase.co';
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').replace(/\s+/g, '');

if (!SUPABASE_SERVICE_KEY) {
  console.error('ERREUR: SUPABASE_SERVICE_KEY non définie');
  process.exit(1);
}

const TILE_SIZE = 256;
const OVERLAP = 1;
const JPEG_QUALITY = 92;
const UPLOAD_BATCH_SIZE = 10;
const BUCKET = 'tiles';

// ── Supabase helpers ────────────────────────────────────────────────

async function supabaseUpload(storagePath, buffer, contentType) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed ${storagePath}: ${res.status} ${text}`);
  }
}

async function supabaseUpdateConfig(key, value) {
  const url = `${SUPABASE_URL}/rest/v1/config`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify([{ key, value }]),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Config update failed for ${key}: ${res.status} ${text}`);
  }
}

async function uploadBatch(tasks) {
  for (let i = 0; i < tasks.length; i += UPLOAD_BATCH_SIZE) {
    const batch = tasks.slice(i, i + UPLOAD_BATCH_SIZE);
    await Promise.all(batch.map(t => supabaseUpload(t.path, t.buffer, t.contentType)));
    console.log(`  Uploaded ${Math.min(i + UPLOAD_BATCH_SIZE, tasks.length)}/${tasks.length}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath || !fs.existsSync(imagePath)) {
    console.error('Usage: node generate_tiles_supabase.js <image.png>');
    process.exit(1);
  }

  console.log('=== Génération des tuiles Deep Zoom (Supabase) ===\n');

  // 0. Set status to processing
  await supabaseUpdateConfig('eic_schema_status', {
    status: 'processing',
    started: new Date().toISOString(),
  });
  console.log('Statut: processing\n');

  // 1. Lire l'image source
  console.log('Chargement de l\'image:', imagePath);
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width;
  const height = metadata.height;
  console.log(`  Dimensions: ${width} x ${height} px\n`);

  // 2. Preview (max 2000px wide)
  console.log('Génération de la preview...');
  const previewWidth = Math.min(width, 2000);
  const previewBuf = await sharp(imagePath)
    .resize(previewWidth, null, { fit: 'inside' })
    .png()
    .toBuffer();
  await supabaseUpload('schema_preview.png', previewBuf, 'image/png');
  console.log(`  Preview uploadée (${previewWidth}px wide)\n`);

  // 3. DZI descriptor
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)));
  console.log(`Niveaux de zoom: 0-${maxLevel} (${maxLevel + 1} niveaux)`);

  const dziXml = `<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"
       Format="jpeg"
       Overlap="${OVERLAP}"
       TileSize="${TILE_SIZE}">
  <Size Width="${width}" Height="${height}"/>
</Image>`;

  await supabaseUpload('schema.dzi', Buffer.from(dziXml, 'utf-8'), 'application/xml');
  console.log('schema.dzi uploadé\n');

  // 4. Générer et uploader les tuiles niveau par niveau
  console.log('Génération des tuiles...');
  let totalTiles = 0;

  for (let level = maxLevel; level >= 0; level--) {
    const levelScale = Math.pow(2, level - maxLevel);
    const levelWidth = Math.max(1, Math.ceil(width * levelScale));
    const levelHeight = Math.max(1, Math.ceil(height * levelScale));
    const cols = Math.ceil(levelWidth / TILE_SIZE);
    const rows = Math.ceil(levelHeight / TILE_SIZE);

    const tileTasks = [];

    for (let col = 0; col < cols; col++) {
      for (let row = 0; row < rows; row++) {
        const x = col * TILE_SIZE - (col > 0 ? OVERLAP : 0);
        const y = row * TILE_SIZE - (row > 0 ? OVERLAP : 0);
        const tileW = Math.min(
          TILE_SIZE + (col > 0 ? OVERLAP : 0) + (col < cols - 1 ? OVERLAP : 0),
          levelWidth - col * TILE_SIZE + (col > 0 ? OVERLAP : 0)
        );
        const tileH = Math.min(
          TILE_SIZE + (row > 0 ? OVERLAP : 0) + (row < rows - 1 ? OVERLAP : 0),
          levelHeight - row * TILE_SIZE + (row > 0 ? OVERLAP : 0)
        );

        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const extractW = Math.min(tileW, levelWidth - left);
        const extractH = Math.min(tileH, levelHeight - top);

        if (extractW <= 0 || extractH <= 0) continue;

        try {
          const tileBuffer = await sharp(imagePath)
            .resize(levelWidth, levelHeight, { fit: 'fill' })
            .extract({ left, top, width: extractW, height: extractH })
            .jpeg({ quality: JPEG_QUALITY })
            .toBuffer();

          tileTasks.push({
            path: `schema_files/${level}/${col}_${row}.jpeg`,
            buffer: tileBuffer,
            contentType: 'image/jpeg',
          });
        } catch (e) {
          // Skip edge-case tiles
        }
      }
    }

    if (tileTasks.length > 0) {
      await uploadBatch(tileTasks);
      totalTiles += tileTasks.length;
    }

    if (level >= maxLevel - 3 || level <= 2) {
      console.log(`  Niveau ${level}: ${cols}x${rows} tuiles (${levelWidth}x${levelHeight}px)`);
    }
  }

  console.log(`\n  Total: ${totalTiles} tuiles uploadées`);

  // 5. Update config
  console.log('\nMise à jour de la configuration...');
  const now = new Date().toISOString();

  await supabaseUpdateConfig('eic_schema_meta', {
    source: 'supabase',
    updated: now,
    width,
    height,
    dpi: 300,
    complete: true,
  });

  await supabaseUpdateConfig('eic_schema_status', {
    status: 'complete',
    finished: now,
  });

  console.log('Terminé avec succès !');
}

main().catch(err => {
  console.error('\nERREUR:', err.message);
  supabaseUpdateConfig('eic_schema_status', {
    status: 'failed',
    finished: new Date().toISOString(),
    error: err.message,
  }).catch(() => {});
  process.exit(1);
});
