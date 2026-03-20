"""
Extraction automatique des données du PDF du schéma EIC
Usage: python scripts/extract_data.py

Extrait tous les textes du PDF avec leurs coordonnées,
les classifie par type (aiguille, signal, PN, CV, gare, PK),
et génère un fichier JSON exploitable par l'application.
"""

import os
import sys
import json
import re
from collections import defaultdict

import fitz  # PyMuPDF

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
PDF_PATH = os.path.join(ROOT_DIR, "Schema Global EIC PN  04052023 PCD4.pdf")
OUTPUT_PATH = os.path.join(ROOT_DIR, "app", "js", "data_extracted.json")


# Patterns de classification
PATTERNS = {
    "aiguille": re.compile(r"^(aig\.?\s*\d{1,5}[a-z]?)$", re.IGNORECASE),
    "pn": re.compile(r"^(PN\s*\d{1,3}(?:\.\d{1,2})?)\b", re.IGNORECASE),
    "signal": re.compile(r"^(C\d{3,5}[a-z]?)$", re.IGNORECASE),
    "cv": re.compile(r"^(Cv\s*\d{1,5}[a-z]?)$", re.IGNORECASE),
    "pk": re.compile(r"^(Km\s*\d{1,3}[,\.]\d{1,3})$", re.IGNORECASE),
}

# Pattern pour extraire le type de PN (SAL2, SAL4, Non Gardé, Piétons, etc.)
PN_TYPE_PATTERN = re.compile(r"\(\s*([^)]+)\s*\)", re.IGNORECASE)

# Gares connues (pour matching)
GARES_CONNUES = [
    "Paris-Nord", "La Chapelle", "Saint-Denis", "Stade de France",
    "La Plaine", "Epinay-Villetaneuse", "Pierrefitte-Stains",
    "Le Bourget", "Aulnay sous Bois", "Sevran-Beaudottes",
    "Sevran-Livry", "Mitry-Claye", "Villeparisis", "Villepinte",
    "Parc des expositions", "Aéroport Charles de Gaulle",
    "Goussainville", "Survilliers-Fosses", "Orry-la-ville",
    "Chantilly-Gouvieux", "Creil", "Montataire", "Laigneville",
    "Clermont-de-L'Oise", "Saint-Just-en-Chaussée",
    "Longueil-Sainte-Marie", "Pont-Ste-Maxence", "Compiègne",
    "Noyon", "Tergnier", "Laon", "Beauvais",
    "Persan-Beaumont", "Pontoise", "Ermont-Eaubonne",
    "Longueau", "Saint-Denis", "Drancy", "Bobigny",
    "La Barre Ormesson", "Enghien", "Saint Gratien",
    "Deuil-Montmagny", "Groslay", "Sarcelles",
    "Villiers-le-Bel", "Montsoult", "Valmondois",
    "Luzarches", "Montigny-Beauchamp", "Méru",
    "Liancourt-Rantigny", "Boran sur Oise", "Précy sur Oise",
    "St Leu d'Esserent", "Crépy-en-Valois", "Ormoy-Villers",
    "Nanteuil le Haudouin", "Le Plessis-Belleville",
    "Villers-Cotterets", "Soissons", "Verberie",
    "Rieux-Angicourt", "Nogent sur Oise", "Villers St-Paul",
    "Thourotte", "Ribécourt", "Chauny", "La Fère",
    "Rochy-Condé", "Hermes-Berthecourt", "Mouy-Bury",
    "Balagny", "Cires-les-Mello", "Cramoisy",
    "St-Ouen l'Aumône", "Bruyères sur Oise",
    "Champagne/Oise", "L'Isle-Adam", "Mériel",
]


def dedup_chars(text):
    """Dédouble les caractères (PPoossttee → Poste) mais PAS les chiffres"""
    if len(text) < 2:
        return text
    result = []
    i = 0
    while i < len(text):
        result.append(text[i])
        # Ne dédoubler que les lettres, pas les chiffres (sinon PN 11 → PN 1)
        if i + 1 < len(text) and text[i] == text[i + 1] and not text[i].isdigit():
            i += 2  # Sauter le doublon
        else:
            i += 1
    return "".join(result)


def classify(text):
    """Classifier un texte en type d'élément infra"""
    for type_name, pattern in PATTERNS.items():
        m = pattern.match(text.strip())
        if m:
            return type_name, m.group(1)
    return None, None


def main():
    print("=== Extraction des données du schéma EIC ===\n")

    if not os.path.exists(PDF_PATH):
        print(f"ERREUR: PDF introuvable: {PDF_PATH}")
        sys.exit(1)

    doc = fitz.open(PDF_PATH)
    page = doc[0]

    page_w = page.rect.width
    page_h = page.rect.height
    print(f"Page: {page_w:.0f} x {page_h:.0f} pts")

    # Extraire tous les blocs de texte
    text_dict = page.get_text("dict")
    blocks = text_dict.get("blocks", [])

    raw_items = []
    for block in blocks:
        if "lines" not in block:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                text = span["text"].strip()
                if not text:
                    continue
                bbox = span["bbox"]  # (x0, y0, x1, y1)
                raw_items.append({
                    "text": text,
                    "text_dedup": dedup_chars(text),
                    "x0": bbox[0],
                    "y0": bbox[1],
                    "x1": bbox[2],
                    "y1": bbox[3],
                    "x_pct": (bbox[0] + bbox[2]) / 2 / page_w,
                    "y_pct": (bbox[1] + bbox[3]) / 2 / page_h,
                    "font_size": span.get("size", 0),
                })

    print(f"Textes extraits: {len(raw_items)}")

    # Dédoublonner les items à la même position
    deduped = []
    seen_positions = set()
    for item in raw_items:
        key = (round(item["x0"], 1), round(item["y0"], 1), item["text"])
        if key not in seen_positions:
            seen_positions.add(key)
            deduped.append(item)

    print(f"Après dédup positions: {len(deduped)}")

    # Classifier chaque texte
    elements = []
    gares_found = []
    pks_found = []
    unclassified = []
    stats = defaultdict(int)

    for item in deduped:
        # Essayer le texte brut d'abord (pour les chiffres corrects), puis la version dédoublée
        for text in [item["text"], item["text_dedup"]]:
            type_name, identifiant = classify(text)
            if type_name:
                elem = {
                    "type": type_name,
                    "identifiant": identifiant,
                    "x_pct": round(item["x_pct"], 6),
                    "y_pct": round(item["y_pct"], 6),
                    "font_size": item["font_size"],
                    "raw_text": item["text"],
                }
                # Pour les PN, extraire le type (SAL2, SAL4, Non Gardé, etc.)
                if type_name == "pn":
                    m = PN_TYPE_PATTERN.search(item["text"])
                    if m:
                        elem["pn_type"] = m.group(1).strip()
                elements.append(elem)
                stats[type_name] += 1
                break
        else:
            # Vérifier si c'est une gare connue
            for gare in GARES_CONNUES:
                if gare.lower() in item["text_dedup"].lower() or gare.lower() in item["text"].lower():
                    gares_found.append({
                        "nom": gare,
                        "x_pct": round(item["x_pct"], 6),
                        "y_pct": round(item["y_pct"], 6),
                        "raw_text": item["text"],
                    })
                    stats["gare"] += 1
                    break
            else:
                unclassified.append({
                    "text": item["text"],
                    "text_dedup": item["text_dedup"],
                    "x_pct": round(item["x_pct"], 6),
                    "y_pct": round(item["y_pct"], 6),
                })

    doc.close()

    # === POST-TRAITEMENT DES PN ===
    # Associer chaque PN à la gare la plus proche et dédoublonner les identifiants
    pn_elements = [e for e in elements if e["type"] == "pn"]
    other_elements = [e for e in elements if e["type"] != "pn"]

    # Trouver la gare la plus proche de chaque PN
    for pn in pn_elements:
        min_dist = float("inf")
        closest_gare = None
        for g in gares_found:
            dx = pn["x_pct"] - g["x_pct"]
            dy = pn["y_pct"] - g["y_pct"]
            dist = (dx * dx + dy * dy) ** 0.5
            if dist < min_dist:
                min_dist = dist
                closest_gare = g
        if closest_gare and min_dist < 0.08:
            pn["nearest_gare"] = closest_gare["nom"]
        else:
            pn["nearest_gare"] = ""

    # Compter les occurrences de chaque identifiant PN
    pn_counts = defaultdict(int)
    for pn in pn_elements:
        pn_counts[pn["identifiant"]] += 1

    # Pour les PN en doublon, ajouter le type pour différencier,
    # puis les coordonnées si toujours en doublon
    for pn in pn_elements:
        if pn_counts[pn["identifiant"]] > 1:
            parts = [pn["identifiant"]]
            if pn.get("pn_type"):
                parts.append("(" + pn["pn_type"] + ")")
            pn["identifiant"] = " ".join(parts)

    # Recompter — si toujours des doublons, ajouter les coordonnées
    seen_ids = defaultdict(int)
    for pn in pn_elements:
        seen_ids[pn["identifiant"]] += 1
    for pn in pn_elements:
        if seen_ids[pn["identifiant"]] > 1:
            pn["identifiant"] += f" [{pn['x_pct']:.2f},{pn['y_pct']:.2f}]"

    # Aussi corriger les types mal extraits (parenthèses coupées)
    for pn in pn_elements:
        if not pn.get("pn_type"):
            raw = pn.get("raw_text", "")
            # Essayer d'extraire le type même sans parenthèse fermante
            m = re.search(r"\(\s*([^)]+)", raw)
            if m:
                pn["pn_type"] = m.group(1).strip()
            elif "privé" in raw.lower() or "prive" in raw.lower():
                pn["pn_type"] = "Privé"
            elif "piéton" in raw.lower() or "pieton" in raw.lower():
                pn["pn_type"] = "Piétons"
            elif "gardé" in raw.lower() or "garde" in raw.lower():
                pn["pn_type"] = "Gardé"

    elements = other_elements + pn_elements
    print(f"\n  PN dédoublonnés: {sum(1 for c in pn_counts.values() if c > 1)} identifiants avaient des doublons")

    # Résumé
    print(f"\n--- Classification ---")
    for type_name, count in sorted(stats.items()):
        print(f"  {type_name:15s} : {count}")
    print(f"  {'non classe':15s} : {len(unclassified)}")
    print(f"  {'TOTAL':15s} : {len(elements) + len(gares_found) + len(unclassified)}")

    # Sauvegarder
    output = {
        "metadata": {
            "pdf": os.path.basename(PDF_PATH),
            "page_width_pts": page_w,
            "page_height_pts": page_h,
            "total_texts": len(raw_items),
            "deduped_texts": len(deduped),
        },
        "elements": elements,
        "gares": gares_found,
        "unclassified_count": len(unclassified),
        "unclassified_sample": unclassified[:100],  # Seulement les 100 premiers
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n[OK] Donnees sauvegardees: {OUTPUT_PATH}")
    print(f"  {len(elements)} elements infra classifies")
    print(f"  {len(gares_found)} gares identifiees")

    return output


if __name__ == "__main__":
    main()
