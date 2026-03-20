/**
 * Génération des tuiles Deep Zoom depuis le PDF du schéma EIC
 *
 * Usage: node scripts/generate_tiles.js
 *
 * Étapes:
 * 1. Charge le PDF avec pdf.js
 * 2. Rend la page à 300 DPI dans un canvas (via sharp)
 * 3. Découpe en tuiles Deep Zoom Image (DZI)
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// pdf.js en mode Node
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');

const PDF_PATH = path.resolve(__dirname, '..', 'Schema Global EIC PN  04052023 PCD4.pdf');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'tiles');
const DPI = 300;
const TILE_SIZE = 256;
const OVERLAP = 1;

async function main() {
  console.log('=== Génération des tuiles Deep Zoom ===\n');

  // 1. Charger le PDF
  console.log('Chargement du PDF...');
  const data = new Uint8Array(fs.readFileSync(PDF_PATH));
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  console.log(`  Pages: ${pdf.numPages}`);

  // On ne prend que la page 1 (le schéma)
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  console.log(`  Dimensions natives: ${viewport.width.toFixed(0)} × ${viewport.height.toFixed(0)} pts`);

  // 2. Calculer l'échelle pour le DPI cible
  const scale = DPI / 72; // PDF est en 72 DPI natif
  const scaledViewport = page.getViewport({ scale });
  const width = Math.floor(scaledViewport.width);
  const height = Math.floor(scaledViewport.height);
  console.log(`  Rendu à ${DPI} DPI: ${width} × ${height} px`);
  console.log(`  Échelle: ×${scale.toFixed(2)}\n`);

  // 3. Rendre dans un buffer RGBA via OffscreenCanvas (Node 18+) ou canvas simulé
  console.log('Rendu de la page (cela peut prendre 1-2 minutes)...');

  // Créer un buffer RGBA brut
  const pixelData = new Uint8ClampedArray(width * height * 4);

  // On utilise l'API de rendu en mode "opération" pour obtenir les données brutes
  // pdf.js a besoin d'un objet canvas-like
  const canvasFactory = {
    create(w, h) {
      return {
        canvas: {
          width: w,
          height: h,
          getContext() {
            return {
              _data: new Uint8ClampedArray(w * h * 4),
              _width: w,
              _height: h,
              putImageData(imgData, dx, dy) {
                // Copier les données dans notre buffer
                for (let y = 0; y < imgData.height; y++) {
                  for (let x = 0; x < imgData.width; x++) {
                    const srcIdx = (y * imgData.width + x) * 4;
                    const dstIdx = ((dy + y) * w + (dx + x)) * 4;
                    this._data[dstIdx] = imgData.data[srcIdx];
                    this._data[dstIdx + 1] = imgData.data[srcIdx + 1];
                    this._data[dstIdx + 2] = imgData.data[srcIdx + 2];
                    this._data[dstIdx + 3] = imgData.data[srcIdx + 3];
                  }
                }
              },
              createImageData(w2, h2) {
                return { data: new Uint8ClampedArray(w2 * h2 * 4), width: w2, height: h2 };
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
                // Remplir avec fillStyle
                for (let py = Math.max(0, y); py < Math.min(h, y + h3); py++) {
                  for (let px = Math.max(0, x); px < Math.min(w, x + w3); px++) {
                    const idx = (py * w + px) * 4;
                    this._data[idx] = 255;
                    this._data[idx + 1] = 255;
                    this._data[idx + 2] = 255;
                    this._data[idx + 3] = 255;
                  }
                }
              },
              strokeRect() {},
              clearRect() {},
              translate() {},
              rotate() {},
              scale() {},
              set fillStyle(v) {},
              get fillStyle() { return '#ffffff'; },
              set strokeStyle(v) {},
              set lineWidth(v) {},
              set lineCap(v) {},
              set lineJoin(v) {},
              set miterLimit(v) {},
              set globalAlpha(v) {},
              set globalCompositeOperation(v) {},
              set font(v) {},
              set textAlign(v) {},
              set textBaseline(v) {},
              measureText() { return { width: 0 }; },
              fillText() {},
              strokeText() {},
              setLineDash() {},
              getLineDash() { return []; },
              set lineDashOffset(v) {},
              set shadowColor(v) {},
              set shadowBlur(v) {},
              set shadowOffsetX(v) {},
              set shadowOffsetY(v) {},
              set imageSmoothingEnabled(v) {},
              getImageData(x, y, w2, h2) {
                const data = new Uint8ClampedArray(w2 * h2 * 4);
                for (let py = 0; py < h2; py++) {
                  for (let px = 0; px < w2; px++) {
                    const srcIdx = ((y + py) * w + (x + px)) * 4;
                    const dstIdx = (py * w2 + px) * 4;
                    data[dstIdx] = this._data[srcIdx];
                    data[dstIdx + 1] = this._data[srcIdx + 1];
                    data[dstIdx + 2] = this._data[srcIdx + 2];
                    data[dstIdx + 3] = this._data[srcIdx + 3];
                  }
                }
                return { data, width: w2, height: h2 };
              },
            };
          },
        },
        context: null,
      };
    },
    reset(obj, w, h) {
      obj.canvas.width = w;
      obj.canvas.height = h;
    },
    destroy(obj) {},
  };

  // Approche alternative : rendre directement en PNG via sharp
  // pdf.js Node ne supporte pas bien le rendu sans canvas natif
  // On va utiliser une approche plus simple : convertir via la ligne de commande Python

  console.log('\n⚠ Le rendu PDF en Node.js pur est limité.');
  console.log('  Utilisation de Python (pdf2image) comme alternative...\n');

  // Vérifier si Python et pdf2image sont disponibles
  const { execSync } = require('child_process');

  // Essayer avec Python + pdf2image (nécessite poppler)
  // Sinon, générer un script Python que l'utilisateur peut exécuter

  const pythonScript = `
import sys
import os

# Essayer pdf2image (nécessite poppler)
try:
    from pdf2image import convert_from_path
    print("pdf2image disponible")

    images = convert_from_path(
        r"${PDF_PATH.replace(/\\/g, '\\\\')}",
        dpi=${DPI},
        first_page=1,
        last_page=1,
        fmt='png'
    )

    output_path = r"${OUTPUT_DIR.replace(/\\/g, '\\\\')}${path.sep.replace(/\\/g, '\\\\')}schema.png"
    images[0].save(output_path, 'PNG')
    print(f"Image sauvegardée: {output_path}")
    print(f"Dimensions: {images[0].size}")

except ImportError:
    print("pdf2image non installé. Installation...")
    os.system(f"{sys.executable} -m pip install pdf2image")
    print("\\nATTENTION: pdf2image nécessite aussi Poppler.")
    print("Téléchargez Poppler pour Windows:")
    print("https://github.com/oschwartz10612/poppler-windows/releases")
    print("Extrayez-le et ajoutez le dossier bin au PATH.")
    sys.exit(1)
`;

  const pythonScriptPath = path.join(__dirname, '_convert_pdf.py');
  fs.writeFileSync(pythonScriptPath, pythonScript);

  try {
    console.log('Tentative de conversion via Python...');
    const result = execSync(`python "${pythonScriptPath}"`, {
      encoding: 'utf-8',
      timeout: 300000, // 5 minutes
      stdio: 'pipe'
    });
    console.log(result);

    // Si ça a marché, générer les tuiles DZI avec sharp
    const pngPath = path.join(OUTPUT_DIR, 'schema.png');
    if (fs.existsSync(pngPath)) {
      console.log('\nGénération des tuiles Deep Zoom...');
      await generateDZI(pngPath);
      console.log('\n✓ Tuiles générées avec succès !');
      console.log(`  Dossier: ${OUTPUT_DIR}`);
      console.log(`  Fichier DZI: ${path.join(OUTPUT_DIR, 'schema.dzi')}`);
    }
  } catch (err) {
    console.error('Erreur Python:', err.message);
    console.log('\n--- INSTRUCTIONS MANUELLES ---');
    console.log('1. Installez Poppler pour Windows:');
    console.log('   https://github.com/oschwartz10612/poppler-windows/releases');
    console.log('2. Ajoutez le dossier bin de Poppler au PATH');
    console.log('3. Installez pdf2image: pip install pdf2image');
    console.log('4. Relancez: node scripts/generate_tiles.js');
    console.log('\nOU: Exportez manuellement le PDF en PNG haute résolution');
    console.log('    et placez-le dans tiles/schema.png');
    console.log('    puis relancez ce script.');

    // Vérifier si un PNG existe déjà
    const pngPath = path.join(OUTPUT_DIR, 'schema.png');
    if (fs.existsSync(pngPath)) {
      console.log('\n→ Un fichier schema.png existe déjà, génération des tuiles...');
      await generateDZI(pngPath);
    }
  }

  // Nettoyage
  try { fs.unlinkSync(pythonScriptPath); } catch {}
}

/**
 * Générer les tuiles DZI depuis une image PNG
 */
async function generateDZI(imagePath) {
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  console.log(`  Source: ${metadata.width} × ${metadata.height} px`);

  const maxLevel = Math.ceil(Math.log2(Math.max(metadata.width, metadata.height)));
  console.log(`  Niveaux de zoom: ${maxLevel + 1}`);

  // Créer le dossier de tuiles
  const tilesDir = path.join(OUTPUT_DIR, 'schema_files');
  if (!fs.existsSync(tilesDir)) fs.mkdirSync(tilesDir, { recursive: true });

  // Écrire le fichier DZI
  const dzi = `<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"
       Format="jpeg"
       Overlap="${OVERLAP}"
       TileSize="${TILE_SIZE}">
  <Size Width="${metadata.width}" Height="${metadata.height}"/>
</Image>`;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'schema.dzi'), dzi);

  // Générer les tuiles niveau par niveau
  let totalTiles = 0;
  for (let level = maxLevel; level >= 0; level--) {
    const levelScale = Math.pow(2, level - maxLevel);
    const levelWidth = Math.max(1, Math.ceil(metadata.width * levelScale));
    const levelHeight = Math.max(1, Math.ceil(metadata.height * levelScale));

    const cols = Math.ceil(levelWidth / TILE_SIZE);
    const rows = Math.ceil(levelHeight / TILE_SIZE);

    const levelDir = path.join(tilesDir, String(level));
    if (!fs.existsSync(levelDir)) fs.mkdirSync(levelDir, { recursive: true });

    // Redimensionner l'image pour ce niveau
    const resized = sharp(imagePath).resize(levelWidth, levelHeight, { fit: 'fill' });

    for (let col = 0; col < cols; col++) {
      for (let row = 0; row < rows; row++) {
        const x = col * TILE_SIZE - (col > 0 ? OVERLAP : 0);
        const y = row * TILE_SIZE - (row > 0 ? OVERLAP : 0);
        const w = Math.min(TILE_SIZE + (col > 0 ? OVERLAP : 0) + (col < cols - 1 ? OVERLAP : 0), levelWidth - col * TILE_SIZE + (col > 0 ? OVERLAP : 0));
        const h = Math.min(TILE_SIZE + (row > 0 ? OVERLAP : 0) + (row < rows - 1 ? OVERLAP : 0), levelHeight - row * TILE_SIZE + (row > 0 ? OVERLAP : 0));

        if (w <= 0 || h <= 0) continue;

        const tilePath = path.join(levelDir, `${col}_${row}.jpeg`);
        try {
          await sharp(imagePath)
            .resize(levelWidth, levelHeight, { fit: 'fill' })
            .extract({ left: Math.max(0, x), top: Math.max(0, y), width: Math.min(w, levelWidth - Math.max(0, x)), height: Math.min(h, levelHeight - Math.max(0, y)) })
            .jpeg({ quality: 85 })
            .toFile(tilePath);
          totalTiles++;
        } catch (e) {
          // Ignorer les tuiles hors limites
        }
      }
    }

    if (level >= maxLevel - 3) {
      process.stdout.write(`  Niveau ${level}: ${cols}×${rows} tuiles (${levelWidth}×${levelHeight}px)\n`);
    }
  }

  console.log(`  Total: ${totalTiles} tuiles générées`);
}

main().catch(console.error);
