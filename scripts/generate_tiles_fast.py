"""
Generation rapide des tuiles Deep Zoom depuis le PDF
Utilise PyMuPDF pour rendre directement a chaque niveau de zoom
sans charger l'image complete en memoire.
"""

import os
import sys
import math
import time
import struct
import zlib

import fitz  # PyMuPDF

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
PDF_PATH = os.path.join(ROOT_DIR, "Schema Global EIC PN  04052023 PCD4.pdf")
TILES_DIR = os.path.join(ROOT_DIR, "tiles")
TILE_SIZE = 256
OVERLAP = 1
JPEG_QUALITY = 85

# DPI cible au niveau de zoom maximum
MAX_DPI = 200  # 200 DPI = lisible, et gerable en memoire


def main():
    print("=== Generation des tuiles Deep Zoom ===\n")

    doc = fitz.open(PDF_PATH)
    page = doc[0]
    pw, ph = page.rect.width, page.rect.height
    print(f"PDF: {pw:.0f} x {ph:.0f} pts")

    # Dimensions au niveau max
    scale_max = MAX_DPI / 72.0
    full_w = int(pw * scale_max)
    full_h = int(ph * scale_max)
    print(f"Rendu max ({MAX_DPI} DPI): {full_w} x {full_h} px")

    max_level = math.ceil(math.log2(max(full_w, full_h)))
    print(f"Niveaux: {max_level + 1} (0 a {max_level})\n")

    # Ecrire le DZI
    tiles_sub = os.path.join(TILES_DIR, "schema_files")
    os.makedirs(tiles_sub, exist_ok=True)

    dzi = f"""<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"
       Format="jpeg"
       Overlap="{OVERLAP}"
       TileSize="{TILE_SIZE}">
  <Size Width="{full_w}" Height="{full_h}"/>
</Image>"""
    with open(os.path.join(TILES_DIR, "schema.dzi"), "w") as f:
        f.write(dzi)

    total_tiles = 0
    t0 = time.time()

    # Generer les niveaux du plus petit au plus grand
    # Pour les petits niveaux on rend le PDF entier a basse resolution
    # Pour les grands niveaux on rend tuile par tuile
    for level in range(max_level, -1, -1):
        level_scale = 2 ** (level - max_level)
        level_w = max(1, math.ceil(full_w * level_scale))
        level_h = max(1, math.ceil(full_h * level_scale))

        cols = math.ceil(level_w / TILE_SIZE)
        rows = math.ceil(level_h / TILE_SIZE)

        level_dir = os.path.join(tiles_sub, str(level))
        os.makedirs(level_dir, exist_ok=True)

        # Scale par rapport au PDF original
        pdf_scale = level_w / pw

        if level_w * level_h < 50_000_000:
            # Petit/moyen niveau : rendre le PDF entier puis decouper
            mat = fitz.Matrix(pdf_scale, pdf_scale)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            actual_w, actual_h = pix.width, pix.height

            for col in range(cols):
                for row in range(rows):
                    x = col * TILE_SIZE
                    y = row * TILE_SIZE
                    x0 = max(0, x - (OVERLAP if col > 0 else 0))
                    y0 = max(0, y - (OVERLAP if row > 0 else 0))
                    x1 = min(actual_w, x + TILE_SIZE + (OVERLAP if col < cols - 1 else 0))
                    y1 = min(actual_h, y + TILE_SIZE + (OVERLAP if row < rows - 1 else 0))

                    if x1 - x0 <= 0 or y1 - y0 <= 0:
                        continue

                    clip = fitz.IRect(x0, y0, x1, y1)
                    tile = fitz.Pixmap(pix, clip)
                    tile_path = os.path.join(level_dir, f"{col}_{row}.jpeg")
                    tile.save(tile_path, jpg_quality=JPEG_QUALITY)
                    total_tiles += 1

            pix = None  # Liberer la memoire
        else:
            # Grand niveau : rendre tuile par tuile directement depuis le PDF
            for col in range(cols):
                for row in range(rows):
                    x = col * TILE_SIZE
                    y = row * TILE_SIZE
                    x0 = max(0, x - (OVERLAP if col > 0 else 0))
                    y0 = max(0, y - (OVERLAP if row > 0 else 0))
                    x1 = min(level_w, x + TILE_SIZE + (OVERLAP if col < cols - 1 else 0))
                    y1 = min(level_h, y + TILE_SIZE + (OVERLAP if row < rows - 1 else 0))

                    if x1 - x0 <= 0 or y1 - y0 <= 0:
                        continue

                    # Convertir les coordonnees pixel en coordonnees PDF
                    pdf_x0 = x0 / pdf_scale
                    pdf_y0 = y0 / pdf_scale
                    pdf_x1 = x1 / pdf_scale
                    pdf_y1 = y1 / pdf_scale

                    clip = fitz.Rect(pdf_x0, pdf_y0, pdf_x1, pdf_y1)
                    mat = fitz.Matrix(pdf_scale, pdf_scale)
                    pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)

                    tile_path = os.path.join(level_dir, f"{col}_{row}.jpeg")
                    pix.save(tile_path, jpg_quality=JPEG_QUALITY)
                    total_tiles += 1
                    pix = None

            # Afficher la progression pour les grands niveaux
            if level >= max_level - 1:
                elapsed = time.time() - t0
                tiles_per_sec = total_tiles / elapsed if elapsed > 0 else 0
                print(f"  Niveau {level:2d}: {cols:3d}x{rows:3d} = {cols*rows} tuiles ({level_w}x{level_h}px) [{elapsed:.1f}s, {tiles_per_sec:.0f} t/s]")

        if level < max_level - 1:
            elapsed = time.time() - t0
            print(f"  Niveau {level:2d}: {cols:3d}x{rows:3d} tuiles ({level_w}x{level_h}px) [{elapsed:.1f}s]")

    elapsed = time.time() - t0
    print(f"\n  {total_tiles} tuiles en {elapsed:.1f}s")

    # Taille totale
    total_size = 0
    for root, dirs, files in os.walk(tiles_sub):
        for f in files:
            total_size += os.path.getsize(os.path.join(root, f))
    print(f"  Taille: {total_size / 1024 / 1024:.1f} Mo")

    print(f"\n[OK] Tuiles pretes !")
    print(f"  Lancez: npx http-server app -p 8080 -c-1")
    print(f"  Ouvrez: http://localhost:8080")

    doc.close()


if __name__ == "__main__":
    main()
