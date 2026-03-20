"""
Génération des tuiles Deep Zoom depuis le PDF du schéma EIC
Usage: python scripts/generate_tiles.py

1. Rend la page 1 du PDF en PNG haute résolution (300 DPI)
2. Découpe en tuiles Deep Zoom Image (DZI) pour OpenSeadragon
"""

import os
import sys
import math
import time

import fitz  # PyMuPDF

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
PDF_PATH = os.path.join(ROOT_DIR, "Schema Global EIC PN  04052023 PCD4.pdf")
TILES_DIR = os.path.join(ROOT_DIR, "tiles")
DPI = 300
TILE_SIZE = 256
OVERLAP = 1
JPEG_QUALITY = 85


def main():
    print("=== Génération des tuiles Deep Zoom ===\n")

    if not os.path.exists(PDF_PATH):
        print(f"ERREUR: PDF introuvable: {PDF_PATH}")
        sys.exit(1)

    os.makedirs(TILES_DIR, exist_ok=True)

    # 1. Ouvrir le PDF
    print("Chargement du PDF...")
    doc = fitz.open(PDF_PATH)
    page = doc[0]  # Page 1 = le schéma
    print(f"  Pages: {len(doc)}")
    print(f"  Dimensions page 1: {page.rect.width:.0f} x {page.rect.height:.0f} pts")

    # 2. Rendu haute résolution
    scale = DPI / 72.0
    mat = fitz.Matrix(scale, scale)
    width = int(page.rect.width * scale)
    height = int(page.rect.height * scale)
    print(f"  Rendu à {DPI} DPI: {width} x {height} px")
    print(f"  Échelle: x{scale:.2f}\n")

    print("Rendu de la page (peut prendre 30-60 secondes)...")
    t0 = time.time()
    pix = page.get_pixmap(matrix=mat, alpha=False)
    t1 = time.time()
    print(f"  Rendu terminé en {t1 - t0:.1f}s")

    # Sauvegarder le PNG complet (utile comme fallback)
    png_path = os.path.join(TILES_DIR, "schema.png")
    print(f"  Sauvegarde PNG: {png_path}")
    pix.save(png_path)
    png_size_mb = os.path.getsize(png_path) / (1024 * 1024)
    print(f"  Taille: {png_size_mb:.1f} Mo\n")

    # 3. Générer les tuiles DZI
    print("Génération des tuiles Deep Zoom...")
    generate_dzi(pix, width, height)

    doc.close()
    print("\n✓ Terminé !")
    print(f"  Dossier tuiles: {TILES_DIR}")
    print(f"  Fichier DZI:    {os.path.join(TILES_DIR, 'schema.dzi')}")
    print(f"  PNG complet:    {png_path}")
    print(f"\n  Lancez le serveur: npx http-server app -p 8080 -c-1")
    print(f"  Ouvrez: http://localhost:8080")


def generate_dzi(pix, full_width, full_height):
    """Génère les tuiles DZI depuis un pixmap PyMuPDF"""

    max_dim = max(full_width, full_height)
    max_level = math.ceil(math.log2(max_dim)) if max_dim > 1 else 0

    # Écrire le fichier .dzi
    dzi_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"
       Format="jpeg"
       Overlap="{OVERLAP}"
       TileSize="{TILE_SIZE}">
  <Size Width="{full_width}" Height="{full_height}"/>
</Image>"""

    dzi_path = os.path.join(TILES_DIR, "schema.dzi")
    with open(dzi_path, "w") as f:
        f.write(dzi_content)

    tiles_subdir = os.path.join(TILES_DIR, "schema_files")
    os.makedirs(tiles_subdir, exist_ok=True)

    total_tiles = 0
    t0 = time.time()

    # Convertir le pixmap en bytes bruts une seule fois
    samples = pix.samples  # bytes RGB
    stride = pix.stride

    for level in range(max_level, -1, -1):
        level_scale = 2 ** (level - max_level)
        level_w = max(1, math.ceil(full_width * level_scale))
        level_h = max(1, math.ceil(full_height * level_scale))

        cols = math.ceil(level_w / TILE_SIZE)
        rows = math.ceil(level_h / TILE_SIZE)

        level_dir = os.path.join(tiles_subdir, str(level))
        os.makedirs(level_dir, exist_ok=True)

        # Redimensionner l'image pour ce niveau avec PyMuPDF
        if level == max_level:
            # Niveau maximum = image complète, pas de redimensionnement
            level_pix = pix
        else:
            # Créer un pixmap redimensionné
            # PyMuPDF n'a pas de resize direct, on re-rend la page à la bonne échelle
            doc = fitz.open(PDF_PATH)
            page = doc[0]
            level_scale_abs = level_w / page.rect.width
            level_mat = fitz.Matrix(level_scale_abs, level_scale_abs)
            level_pix = page.get_pixmap(matrix=level_mat, alpha=False)
            doc.close()

        # Découper en tuiles
        for col in range(cols):
            for row in range(rows):
                # Calculer les coordonnées avec overlap
                x = col * TILE_SIZE
                y = row * TILE_SIZE

                # Overlap
                x0 = max(0, x - (OVERLAP if col > 0 else 0))
                y0 = max(0, y - (OVERLAP if row > 0 else 0))
                x1 = min(level_w, x + TILE_SIZE + (OVERLAP if col < cols - 1 else 0))
                y1 = min(level_h, y + TILE_SIZE + (OVERLAP if row < rows - 1 else 0))

                tw = x1 - x0
                th = y1 - y0

                if tw <= 0 or th <= 0:
                    continue

                # Extraire la tuile
                clip = fitz.IRect(x0, y0, x1, y1)
                try:
                    tile_pix = fitz.Pixmap(level_pix, clip)
                    tile_path = os.path.join(level_dir, f"{col}_{row}.jpeg")
                    tile_pix.save(tile_path, jpg_quality=JPEG_QUALITY)
                    total_tiles += 1
                except Exception:
                    pass

        if level >= max_level - 4 or level <= 2:
            elapsed = time.time() - t0
            print(f"  Niveau {level:2d}: {cols:3d}x{rows:3d} tuiles ({level_w}x{level_h}px) [{elapsed:.1f}s]")

    elapsed = time.time() - t0
    print(f"\n  {total_tiles} tuiles générées en {elapsed:.1f}s")


if __name__ == "__main__":
    main()
