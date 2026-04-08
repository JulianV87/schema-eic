/**
 * Génération des tuiles Deep Zoom depuis un PDF stocké sur Supabase Storage
 * et upload des tuiles vers Supabase Storage.
 *
 * Usage: node scripts/generate_tiles_supabase.js
 *
 * Variables d'environnement requises:
 *   SUPABASE_URL         - URL du projet Supabase
 *   SUPABASE_SERVICE_KEY - Clé de service Supabase
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fbcwsgqrwolxnqpasbgl.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('ERREUR: SUPABASE_SERVICE_KEY non définie');
  process.exit(1);
}

const DPI = 300;
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

// ── Upload in batches ───────────────────────────────────────────────

async function uploadBatch(tasks) {
  for (let i = 0; i < tasks.length; i += UPLOAD_BATCH_SIZE) {
    const batch = tasks.slice(i, i + UPLOAD_BATCH_SIZE);
    await Promise.all(batch.map(t => supabaseUpload(t.path, t.buffer, t.contentType)));
    console.log(`  Uploaded ${Math.min(i + UPLOAD_BATCH_SIZE, tasks.length)}/${tasks.length}`);
  }
}

// ── Canvas factory for pdf.js ───────────────────────────────────────

function createCanvasFactory() {
  return {
    create(w, h) {
      const ctx = createContext(w, h);
      return { canvas: { width: w, height: h, getContext: () => ctx }, context: ctx };
    },
    reset(obj, w, h) {
      obj.canvas.width = w;
      obj.canvas.height = h;
      obj.context = createContext(w, h);
    },
    destroy() {},
  };
}

function createContext(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  // Fill white background
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  return {
    _data: data,
    _width: w,
    _height: h,
    putImageData(imgData, dx, dy) {
      for (let y = 0; y < imgData.height; y++) {
        for (let x = 0; x < imgData.width; x++) {
          const srcIdx = (y * imgData.width + x) * 4;
          const dstX = dx + x;
          const dstY = dy + y;
          if (dstX < 0 || dstX >= w || dstY < 0 || dstY >= h) continue;
          const dstIdx = (dstY * w + dstX) * 4;
          data[dstIdx] = imgData.data[srcIdx];
          data[dstIdx + 1] = imgData.data[srcIdx + 1];
          data[dstIdx + 2] = imgData.data[srcIdx + 2];
          data[dstIdx + 3] = imgData.data[srcIdx + 3];
        }
      }
    },
    createImageData(w2, h2) {
      return { data: new Uint8ClampedArray(w2 * h2 * 4), width: w2, height: h2 };
    },
    getImageData(x, y, w2, h2) {
      const out = new Uint8ClampedArray(w2 * h2 * 4);
      for (let py = 0; py < h2; py++) {
        for (let px = 0; px < w2; px++) {
          const sx = x + px;
          const sy = y + py;
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          const srcIdx = (sy * w + sx) * 4;
          const dstIdx = (py * w2 + px) * 4;
          out[dstIdx] = data[srcIdx];
          out[dstIdx + 1] = data[srcIdx + 1];
          out[dstIdx + 2] = data[srcIdx + 2];
          out[dstIdx + 3] = data[srcIdx + 3];
        }
      }
      return { data: out, width: w2, height: h2 };
    },
    drawImage() {},
    save() {},
    restore() {},
    transform() {},
    setTransform() {},
    resetTransform() {},
    clip() {},
    fill() {},
    stroke() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    rect() {},
    arc() {},
    fillRect(x, y, w3, h3) {
      for (let py = Math.max(0, y); py < Math.min(h, y + h3); py++) {
        for (let px = Math.max(0, x); px < Math.min(w, x + w3); px++) {
          const idx = (py * w + px) * 4;
          data[idx] = 255;
          data[idx + 1] = 255;
          data[idx + 2] = 255;
          data[idx + 3] = 255;
        }
      }
    },
    strokeRect() {},
    clearRect() {},
    translate() {},
    rotate() {},
    scale() {},
    set fillStyle(_) {},
    get fillStyle() { return '#ffffff'; },
    set strokeStyle(_) {},
    set lineWidth(_) {},
    set lineCap(_) {},
    set lineJoin(_) {},
    set miterLimit(_) {},
    set globalAlpha(_) {},
    set globalCompositeOperation(_) {},
    set font(_) {},
    set textAlign(_) {},
    set textBaseline(_) {},
    measureText() { return { width: 0 }; },
    fillText() {},
    strokeText() {},
    setLineDash() {},
    getLineDash() { return []; },
    set lineDashOffset(_) {},
    set shadowColor(_) {},
    set shadowBlur(_) {},
    set shadowOffsetX(_) {},
    set shadowOffsetY(_) {},
    set imageSmoothingEnabled(_) {},
  };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Génération des tuiles Deep Zoom (Supabase) ===\n');

  // 0. Set status to processing
  await supabaseUpdateConfig('eic_schema_status', {
    status: 'processing',
    started: new Date().toISOString(),
  });
  console.log('Statut: processing\n');

  // 1. Download PDF
  console.log('Téléchargement du PDF depuis Supabase Storage...');
  const pdfUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/schema_update.pdf`;
  const pdfResponse = await fetch(pdfUrl);
  if (!pdfResponse.ok) {
    throw new Error(`Impossible de télécharger le PDF: ${pdfResponse.status}`);
  }
  const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
  console.log(`  PDF téléchargé: ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} Mo`);

  // Save locally for processing
  const localPdf = path.join(__dirname, 'schema_update.pdf');
  fs.writeFileSync(localPdf, pdfBuffer);

  // 2. Load PDF with pdf.js
  console.log('Chargement du PDF avec pdf.js...');
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(pdfBuffer);
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  console.log(`  Pages: ${pdf.numPages}`);

  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  console.log(`  Dimensions natives: ${viewport.width.toFixed(0)} x ${viewport.height.toFixed(0)} pts`);

  // 3. Render at 300 DPI
  const scale = DPI / 72;
  const scaledViewport = page.getViewport({ scale });
  const width = Math.floor(scaledViewport.width);
  const height = Math.floor(scaledViewport.height);
  console.log(`  Rendu à ${DPI} DPI: ${width} x ${height} px (scale x${scale.toFixed(2)})`);

  console.log('\nRendu de la page...');
  const canvasFactory = createCanvasFactory();
  const canvasObj = canvasFactory.create(width, height);

  await page.render({
    canvasContext: canvasObj.context,
    viewport: scaledViewport,
    canvasFactory,
  }).promise;
  console.log('  Rendu terminé.');

  // Extract raw RGBA buffer
  const rawPixels = Buffer.from(canvasObj.context._data.buffer);

  // Convert to PNG via sharp for further processing
  const fullImage = sharp(rawPixels, {
    raw: { width, height, channels: 4 },
  });

  // Save a local temp PNG for tile extraction
  const tempPng = path.join(__dirname, '_temp_schema.png');
  await fullImage.clone().png().toFile(tempPng);
  console.log(`  Image temporaire sauvegardée: ${tempPng}`);

  // 4. Generate preview (max 2000px wide)
  console.log('\nGénération de la preview...');
  const previewWidth = Math.min(width, 2000);
  const previewBuf = await sharp(tempPng)
    .resize(previewWidth, null, { fit: 'inside' })
    .png()
    .toBuffer();
  await supabaseUpload('schema_preview.png', previewBuf, 'image/png');
  console.log(`  Preview uploadée (${previewWidth}px wide)`);

  // 5. Generate Deep Zoom tiles
  console.log('\nGénération des tuiles Deep Zoom...');
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)));
  console.log(`  Niveaux de zoom: 0-${maxLevel} (${maxLevel + 1} niveaux)`);

  // Generate DZI descriptor
  const dziXml = `<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"
       Format="jpeg"
       Overlap="${OVERLAP}"
       TileSize="${TILE_SIZE}">
  <Size Width="${width}" Height="${height}"/>
</Image>`;

  await supabaseUpload('schema.dzi', Buffer.from(dziXml, 'utf-8'), 'application/xml');
  console.log('  schema.dzi uploadé');

  let totalTiles = 0;

  for (let level = maxLevel; level >= 0; level--) {
    const levelScale = Math.pow(2, level - maxLevel);
    const levelWidth = Math.max(1, Math.ceil(width * levelScale));
    const levelHeight = Math.max(1, Math.ceil(height * levelScale));
    const cols = Math.ceil(levelWidth / TILE_SIZE);
    const rows = Math.ceil(levelHeight / TILE_SIZE);

    // Resize image for this level
    const resizedBuf = await sharp(tempPng)
      .resize(levelWidth, levelHeight, { fit: 'fill' })
      .raw()
      .toBuffer();

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
          const tileBuffer = await sharp(resizedBuf, {
            raw: { width: levelWidth, height: levelHeight, channels: 3 },
          })
            .extract({ left, top, width: extractW, height: extractH })
            .jpeg({ quality: JPEG_QUALITY })
            .toBuffer();

          tileTasks.push({
            path: `schema_files/${level}/${col}_${row}.jpeg`,
            buffer: tileBuffer,
            contentType: 'image/jpeg',
          });
        } catch (e) {
          // Skip tiles that fail extraction (edge cases)
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

  // 6. Update config metadata
  console.log('\nMise à jour de la configuration...');
  const now = new Date().toISOString();

  await supabaseUpdateConfig('eic_schema_meta', {
    source: 'supabase',
    updated: now,
    width,
    height,
    dpi: DPI,
    complete: true,
  });

  await supabaseUpdateConfig('eic_schema_status', {
    status: 'complete',
    finished: now,
  });

  console.log('  Configuration mise à jour');

  // Cleanup
  try { fs.unlinkSync(localPdf); } catch {}
  try { fs.unlinkSync(tempPng); } catch {}

  console.log('\nTerminé avec succès !');
}

main().catch(err => {
  console.error('\nERREUR:', err.message);

  // Update status to failed
  supabaseUpdateConfig('eic_schema_status', {
    status: 'failed',
    finished: new Date().toISOString(),
    error: err.message,
  }).catch(() => {});

  process.exit(1);
});
