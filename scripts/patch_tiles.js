/**
 * Mise à jour partielle des tuiles Deep Zoom
 * Compare l'ancien et le nouveau schéma, ne regénère que les tuiles modifiées.
 *
 * Usage:
 *   node scripts/patch_tiles.js [nouveau_schema.png]
 *
 * Si pas d'argument, cherche "schema_new.png" dans tiles/
 * L'ancien schéma doit être dans tiles/schema.png
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUTPUT_DIR = path.resolve(__dirname, '..', 'tiles');
const TILE_SIZE = 256;
const OVERLAP = 1;
// Taille des blocs de comparaison (en pixels sur l'image source)
// Plus grand = plus rapide mais moins précis
const COMPARE_BLOCK = 512;
// Seuil de différence (0-255) pour considérer qu'un pixel a changé
const DIFF_THRESHOLD = 10;
// % minimum de pixels différents dans un bloc pour le considérer modifié
const BLOCK_CHANGE_PCT = 0.5;

async function main() {
  const newPath = process.argv[2] || path.join(OUTPUT_DIR, 'schema_new.png');
  const oldPath = path.join(OUTPUT_DIR, 'schema.png');

  if (!fs.existsSync(oldPath)) {
    console.log('Pas d\'ancien schéma trouvé. Lancez generate_tiles.js pour la première génération.');
    process.exit(1);
  }
  if (!fs.existsSync(newPath)) {
    console.log(`Nouveau schéma non trouvé: ${newPath}`);
    console.log('Usage: node scripts/patch_tiles.js [chemin/vers/nouveau_schema.png]');
    console.log('  ou placez le fichier dans tiles/schema_new.png');
    process.exit(1);
  }

  console.log('=== Mise à jour partielle des tuiles ===\n');

  // 1. Charger les métadonnées des deux images
  const oldMeta = await sharp(oldPath).metadata();
  const newMeta = await sharp(newPath).metadata();

  console.log(`Ancien: ${oldMeta.width} × ${oldMeta.height}`);
  console.log(`Nouveau: ${newMeta.width} × ${newMeta.height}`);

  if (oldMeta.width !== newMeta.width || oldMeta.height !== newMeta.height) {
    console.log('\n⚠ Les dimensions ont changé — regénération complète nécessaire.');
    console.log('  Lancez: node scripts/generate_tiles.js');
    process.exit(1);
  }

  const W = oldMeta.width;
  const H = oldMeta.height;

  // 2. Comparer par blocs pour trouver les régions modifiées
  console.log(`\nComparaison par blocs de ${COMPARE_BLOCK}px...`);

  const cols = Math.ceil(W / COMPARE_BLOCK);
  const rows = Math.ceil(H / COMPARE_BLOCK);
  const changedBlocks = [];

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const left = bx * COMPARE_BLOCK;
      const top = by * COMPARE_BLOCK;
      const width = Math.min(COMPARE_BLOCK, W - left);
      const height = Math.min(COMPARE_BLOCK, H - top);

      const oldBlock = await sharp(oldPath)
        .extract({ left, top, width, height })
        .raw().toBuffer();

      const newBlock = await sharp(newPath)
        .extract({ left, top, width, height })
        .raw().toBuffer();

      // Compter les pixels différents
      const totalPixels = width * height;
      let diffPixels = 0;
      for (let i = 0; i < oldBlock.length; i += 3) {
        const dr = Math.abs(oldBlock[i] - newBlock[i]);
        const dg = Math.abs(oldBlock[i + 1] - newBlock[i + 1]);
        const db = Math.abs(oldBlock[i + 2] - newBlock[i + 2]);
        if (dr > DIFF_THRESHOLD || dg > DIFF_THRESHOLD || db > DIFF_THRESHOLD) {
          diffPixels++;
        }
      }

      const pct = (diffPixels / totalPixels) * 100;
      if (pct >= BLOCK_CHANGE_PCT) {
        changedBlocks.push({ bx, by, left, top, width, height, pct: pct.toFixed(1) });
      }
    }
    process.stdout.write(`  Ligne ${by + 1}/${rows}\r`);
  }

  console.log(`\n\nBlocs modifiés: ${changedBlocks.length} / ${cols * rows} (${(changedBlocks.length / (cols * rows) * 100).toFixed(1)}%)`);

  if (changedBlocks.length === 0) {
    console.log('\nAucune différence détectée. Rien à mettre à jour.');
    process.exit(0);
  }

  // Afficher les zones touchées
  changedBlocks.forEach(b => {
    console.log(`  [${b.left},${b.top}] ${b.width}×${b.height} — ${b.pct}% modifié`);
  });

  // 3. Calculer le bounding box global des changements
  const changeMinX = Math.min(...changedBlocks.map(b => b.left));
  const changeMinY = Math.min(...changedBlocks.map(b => b.top));
  const changeMaxX = Math.max(...changedBlocks.map(b => b.left + b.width));
  const changeMaxY = Math.max(...changedBlocks.map(b => b.top + b.height));

  console.log(`\nZone impactée: [${changeMinX},${changeMinY}] → [${changeMaxX},${changeMaxY}]`);
  console.log(`  = ${changeMaxX - changeMinX} × ${changeMaxY - changeMinY} px`);
  console.log(`  = ${((changeMaxX - changeMinX) * (changeMaxY - changeMinY) / (W * H) * 100).toFixed(1)}% de l'image\n`);

  // 4. Regénérer uniquement les tuiles qui intersectent les blocs modifiés
  const maxLevel = Math.ceil(Math.log2(Math.max(W, H)));
  const tilesDir = path.join(OUTPUT_DIR, 'schema_files');
  let totalRegenerated = 0;
  let totalSkipped = 0;

  console.log('Regénération des tuiles impactées...');

  for (let level = maxLevel; level >= 0; level--) {
    const levelScale = Math.pow(2, level - maxLevel);
    const levelWidth = Math.max(1, Math.ceil(W * levelScale));
    const levelHeight = Math.max(1, Math.ceil(H * levelScale));

    const tileCols = Math.ceil(levelWidth / TILE_SIZE);
    const tileRows = Math.ceil(levelHeight / TILE_SIZE);

    const levelDir = path.join(tilesDir, String(level));
    if (!fs.existsSync(levelDir)) fs.mkdirSync(levelDir, { recursive: true });

    let levelRegenerated = 0;

    for (let col = 0; col < tileCols; col++) {
      for (let row = 0; row < tileRows; row++) {
        // Coordonnées de cette tuile dans l'image source
        const tileSourceX = col * TILE_SIZE / levelScale;
        const tileSourceY = row * TILE_SIZE / levelScale;
        const tileSourceW = TILE_SIZE / levelScale;
        const tileSourceH = TILE_SIZE / levelScale;

        // Vérifier si cette tuile intersecte un bloc modifié
        const intersects = changedBlocks.some(b =>
          tileSourceX < b.left + b.width &&
          tileSourceX + tileSourceW > b.left &&
          tileSourceY < b.top + b.height &&
          tileSourceY + tileSourceH > b.top
        );

        if (!intersects) {
          totalSkipped++;
          continue;
        }

        // Regénérer cette tuile
        const x = col * TILE_SIZE - (col > 0 ? OVERLAP : 0);
        const y = row * TILE_SIZE - (row > 0 ? OVERLAP : 0);
        const w = Math.min(
          TILE_SIZE + (col > 0 ? OVERLAP : 0) + (col < tileCols - 1 ? OVERLAP : 0),
          levelWidth - col * TILE_SIZE + (col > 0 ? OVERLAP : 0)
        );
        const h = Math.min(
          TILE_SIZE + (row > 0 ? OVERLAP : 0) + (row < tileRows - 1 ? OVERLAP : 0),
          levelHeight - row * TILE_SIZE + (row > 0 ? OVERLAP : 0)
        );

        if (w <= 0 || h <= 0) continue;

        const tilePath = path.join(levelDir, `${col}_${row}.jpeg`);
        try {
          await sharp(newPath)
            .resize(levelWidth, levelHeight, { fit: 'fill' })
            .extract({
              left: Math.max(0, x),
              top: Math.max(0, y),
              width: Math.min(w, levelWidth - Math.max(0, x)),
              height: Math.min(h, levelHeight - Math.max(0, y))
            })
            .jpeg({ quality: 85 })
            .toFile(tilePath);
          levelRegenerated++;
          totalRegenerated++;
        } catch (e) {
          // Tuile hors limites
        }
      }
    }

    if (levelRegenerated > 0) {
      console.log(`  Niveau ${level}: ${levelRegenerated} tuiles regénérées`);
    }
  }

  // 5. Remplacer l'ancien PNG par le nouveau
  const backupPath = path.join(OUTPUT_DIR, 'schema_old.png');
  fs.copyFileSync(oldPath, backupPath);
  fs.copyFileSync(newPath, oldPath);

  // Garder aussi un preview
  await sharp(newPath)
    .resize(2000, null, { withoutEnlargement: true })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'schema_preview.png'));

  console.log(`\n✓ Terminé !`);
  console.log(`  Tuiles regénérées: ${totalRegenerated}`);
  console.log(`  Tuiles inchangées: ${totalSkipped}`);
  console.log(`  Ancien schéma sauvegardé: ${backupPath}`);
  console.log(`  Nouveau schéma actif: ${oldPath}`);
}

main().catch(console.error);
