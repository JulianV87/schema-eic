/**
 * Génération rapide des tuiles DZI depuis le PNG déjà rendu
 * Usage: node scripts/make_tiles.js
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PNG_PATH = path.join(__dirname, '..', 'tiles', 'schema.png');
const TILES_DIR = path.join(__dirname, '..', 'tiles');
const TILE_SIZE = 256;
const OVERLAP = 1;
const JPEG_QUALITY = 85;

async function main() {
  console.log('=== Generation des tuiles Deep Zoom ===\n');

  if (!fs.existsSync(PNG_PATH)) {
    console.error('ERREUR: schema.png introuvable dans tiles/');
    console.log('Lancez d\'abord: python scripts/generate_tiles.py');
    process.exit(1);
  }

  // Lire les métadonnées de l'image
  const metadata = await sharp(PNG_PATH).metadata();
  const fullWidth = metadata.width;
  const fullHeight = metadata.height;
  console.log(`Source: ${fullWidth} x ${fullHeight} px`);

  const maxLevel = Math.ceil(Math.log2(Math.max(fullWidth, fullHeight)));
  console.log(`Niveaux de zoom: ${maxLevel + 1} (0 a ${maxLevel})\n`);

  // Écrire le fichier DZI
  const dzi = `<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"
       Format="jpeg"
       Overlap="${OVERLAP}"
       TileSize="${TILE_SIZE}">
  <Size Width="${fullWidth}" Height="${fullHeight}"/>
</Image>`;
  fs.writeFileSync(path.join(TILES_DIR, 'schema.dzi'), dzi);

  const tilesSubdir = path.join(TILES_DIR, 'schema_files');

  let totalTiles = 0;
  const t0 = Date.now();

  // Générer les tuiles niveau par niveau
  for (let level = maxLevel; level >= 0; level--) {
    const scale = Math.pow(2, level - maxLevel);
    const levelW = Math.max(1, Math.ceil(fullWidth * scale));
    const levelH = Math.max(1, Math.ceil(fullHeight * scale));

    const cols = Math.ceil(levelW / TILE_SIZE);
    const rows = Math.ceil(levelH / TILE_SIZE);

    const levelDir = path.join(tilesSubdir, String(level));
    fs.mkdirSync(levelDir, { recursive: true });

    // Redimensionner l'image source pour ce niveau (une seule fois)
    let resizedBuffer;
    if (level === maxLevel) {
      // Niveau max = image originale, pas de resize
      resizedBuffer = await sharp(PNG_PATH).raw().toBuffer({ resolveWithObject: true });
    } else {
      resizedBuffer = await sharp(PNG_PATH)
        .resize(levelW, levelH, { fit: 'fill', kernel: 'lanczos3' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    }

    const { data: rawPixels, info } = resizedBuffer;
    const actualW = info.width;
    const actualH = info.height;
    const channels = info.channels;

    // Découper en tuiles
    const promises = [];
    for (let col = 0; col < cols; col++) {
      for (let row = 0; row < rows; row++) {
        const x = col * TILE_SIZE;
        const y = row * TILE_SIZE;

        // Avec overlap
        const x0 = Math.max(0, x - (col > 0 ? OVERLAP : 0));
        const y0 = Math.max(0, y - (row > 0 ? OVERLAP : 0));
        const x1 = Math.min(actualW, x + TILE_SIZE + (col < cols - 1 ? OVERLAP : 0));
        const y1 = Math.min(actualH, y + TILE_SIZE + (row < rows - 1 ? OVERLAP : 0));

        const tw = x1 - x0;
        const th = y1 - y0;
        if (tw <= 0 || th <= 0) continue;

        // Extraire la tuile depuis le buffer brut
        const tileBuffer = Buffer.alloc(tw * th * channels);
        for (let ty = 0; ty < th; ty++) {
          const srcOffset = ((y0 + ty) * actualW + x0) * channels;
          const dstOffset = ty * tw * channels;
          rawPixels.copy(tileBuffer, dstOffset, srcOffset, srcOffset + tw * channels);
        }

        const tilePath = path.join(levelDir, `${col}_${row}.jpeg`);
        promises.push(
          sharp(tileBuffer, { raw: { width: tw, height: th, channels } })
            .jpeg({ quality: JPEG_QUALITY })
            .toFile(tilePath)
            .then(() => { totalTiles++; })
            .catch(() => {})
        );
      }
    }

    await Promise.all(promises);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (level >= maxLevel - 4 || level <= 3) {
      console.log(`  Niveau ${String(level).padStart(2)}: ${String(cols).padStart(3)}x${String(rows).padStart(3)} tuiles (${actualW}x${actualH}px) [${elapsed}s]`);
    } else if (level === maxLevel - 5) {
      console.log('  ...');
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  ${totalTiles} tuiles generees en ${elapsed}s`);

  // Taille totale
  let totalSize = 0;
  const countFiles = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) countFiles(p);
      else totalSize += fs.statSync(p).size;
    }
  };
  countFiles(tilesSubdir);
  console.log(`  Taille totale: ${(totalSize / 1024 / 1024).toFixed(1)} Mo`);
  console.log(`\n[OK] Tuiles pretes !`);
  console.log(`  Lancez: npx http-server app -p 8080 -c-1`);
  console.log(`  Ouvrez: http://localhost:8080`);
}

main().catch(err => {
  console.error('Erreur:', err.message);
  process.exit(1);
});
