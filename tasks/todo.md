# Plan de corrections — EIC Paris Nord

## Batch 1 — Bugs critiques

- [x] **E1/E4 — export.js** : drawerType canvas, crossOriginPolicy, null checks toBlob
- [x] **A2 — annotations.js** : Polyfill roundRect()
- [x] **M1/V1 — main.js + viewer.js** : Null checks getElementById
- [x] **A1 — annotations.js** : ctx.save()/ctx.restore() dans chaque draw

## Batch 2 — Bugs fonctionnels

- [x] **S4 — search.js** : Nettoyer highlight précédent (currentHighlightId)
- [x] **T1/S2 — search.js** : Brancher Templates.apply() dans selectElement()
- [x] **M3 — main.js** : Race condition open (isOpen() check)
- [x] **V3 — viewer.js** : Cloner tileSource pour zoomViewer
- [x] **E2 — export.js** : Refactored compositeImage avec getOsdCanvas()
- [x] **P1 — parser.js** : Infra extrait AVANT train, train avec préfixe
- [x] **P2 — parser.js** : Word-boundary matching pour gares

## Batch 3 — Fonctionnalités MVP

- [x] **Confirmation "Tout effacer"** : confirm() dans export.js
- [x] **Undo/Redo** : Ctrl+Z / Ctrl+Y avec stack 50
- [x] **Persistance locale** : localStorage annotations
- [x] **Horloge** : Temps réel dans le header
- [x] **Chronomètre incident** : Bouton start/stop avec compteur
- [x] **Template voie_occupee** : Ajouté dans templates.js
- [ ] **Navigation contextuelle** : Boutons + gare / + secteur (nécessite données séquences)
- [ ] **Données extraites** : Brancher data_extracted.json

## Hors scope (phase 2)
- Supabase
- Collaboration temps réel
- Templates avancés avec formulaires
- Responsive mobile
- ARIA / accessibilité
