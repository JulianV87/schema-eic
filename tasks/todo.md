# Plan APEX — Corrections P0/P1 EIC Paris Nord

Date : 2026-04-22
Source : `tasks/audit.md` (2026-04-20) + exploration fraîche du code

---

## Écarts vs audit (à connaître avant de commencer)

1. **Fallback auth** (`index.html:488-494`) — DÉJÀ CORRIGÉ. Le code refuse maintenant l'accès si Supabase est HS. L'audit est obsolète sur ce point.
2. **Clé Supabase anon en clair** — Ce n'est PAS un bug. Pour un site statique sans bundler, la clé anon est **publique par conception** ; la vraie protection est RLS côté Supabase (action BDD, hors code).
3. **Token GitHub** dans `.git/config` — Hors scope code. Action manuelle utilisateur (à révoquer + regénérer, remote URL sans token).
4. **3 XSS de l'audit** (`settings.js:342`, `calibrate.js:1206`, `export.js:78`) — faux positifs. Les variables injectées viennent d'arrays hardcodés internes, pas d'input utilisateur. Je les convertis quand même en defense-in-depth.
5. **Vrais XSS trouvés pendant l'analyse** : `annotations.js:2636, 2638` (imageDataUrl dans `<img src>`), `search.js:1344-1349` (nom de zone éditable), `settings.js:495-497, 574-576` (nom de zone). → Ceux-là sont **prioritaires**.

---

## Changes Required

### 1. SÉCURITÉ — XSS (priorité P0)

- [ ] `app/js/annotations.js:2636, 2638` — remplacer `icon.innerHTML = '<img src="'+…` par `createElement('img') + setAttribute('src', …)`
- [ ] `app/js/search.js:1344-1349` — 3 lignes avec `l.nom` dans innerHTML → `createElement` + `textContent`
- [ ] `app/js/settings.js:495-497, 574-576` — 4 lignes avec `l.nom` dans innerHTML → même traitement
- [ ] `app/js/settings.js:342` — defense-in-depth
- [ ] `app/js/calibrate.js:1206` — defense-in-depth
- [ ] `app/js/export.js:78` — defense-in-depth

### 2. RLS Supabase — REPORTÉ (décision utilisateur 2026-04-22)

Non prioritaire pour le moment. À traiter plus tard.

### 3. UX — Export clipboard direct

- [ ] `app/index.html:43` — ajouter `<button id="btn-export-clipboard">` à côté de `btn-export-png`
- [ ] `app/js/export.js:22-28` — binder le click vers `showShapeMenu('clipboard')`
- [ ] `exportToClipboard` (l.542) déjà codé avec feedback "Copié !" — vérifier fonctionnement

### 4. UX — Spinner pendant `toBlob`

- [ ] `app/js/export.js:562-594` et `542-560` — overlay "Export en cours…" avant `canvas.toBlob`, retiré après succès ou dans `finally`
- [ ] CSS simple dans `app/css/style.css` pour l'overlay

### 5. UX — Debounce recherche 150ms

- [ ] `app/js/search.js:49-51` — wrapper `showSuggestions(commandBar.value)` dans un `setTimeout` debounced de 150ms.

### 6. HYGIÈNE — console.log de debug

- [ ] `app/js/calibrate.js:343-356` — 7 logs "SAVE ELEMENT DEBUG" → supprimer
- [ ] `app/js/calibrate.js:418, 421, 1731, 1843` — évaluer au cas par cas
- [ ] Ne pas toucher `console.error` / `console.warn`
- [ ] Les `console.log` dans `sync.js` utiles → garder

### 7. HYGIÈNE — fuites event listeners (scope minimal)

- [ ] Juste `annotations.js:1173` si changement non-trivial → skip (out-of-scope du refactor).

---

## New Files to Create

- [ ] `scripts/supabase_rls.sql` — script SQL RLS + commentaires d'usage

---

## Risks & Mitigations

| Risque | Mitigation |
|---|---|
| Casser le placement d'annotations (régressions de session précédente) | Tests manuels après chaque fichier JS modifié. Ne toucher que les lignes listées. |
| Casser le rendu des menus (icônes qui disparaissent) | Conserver la structure visuelle en utilisant span + textContent séparés |
| Le debounce rend la recherche "lente" en usage crise | 150ms est imperceptible ; rester sous 200ms |
| Bouton clipboard non supporté sur Firefox | Fallback `exportToPNG` déjà codé dans le catch |
| Spinner mask les erreurs si `toBlob` throw | `finally {}` pour garantir le retrait de l'overlay |
| RLS SQL déployé sans comprendre casse l'app | Commentaires explicites + instructions "tester en local avant" |

---

## Testing Strategy

**Tests manuels obligatoires** (pas de test auto dans le scope) :

1. `npm run serve` → http://localhost:8080
2. Login (vérifier que l'auth fonctionne toujours)
3. **XSS** : créer zone avec nom `<img src=x onerror="alert('XSS')">` → vérifier que le texte s'affiche littéralement, pas d'alert
4. **Placement** : poser 3 marqueurs, 2 stickers, 1 voie coupée, 1 texte — aucune régression
5. **Édition** : cliquer sur marqueur → panneau droite avec ✕, champ Texte, Échap ferme — OK
6. **Export PNG** : clic Export → Rectangle → sélection → PNG, spinner visible pendant le rendu
7. **Export clipboard** : nouveau bouton → sélection → collage dans Paint — image identique
8. **Recherche** : taper `aig 17 creil` caractère par caractère — suggestions OK avec léger délai
9. **Console** : DevTools → aucun log "SAVE ELEMENT DEBUG" après calibration

---

## Success Criteria (vérifiables)

- [ ] Injecter `<img src=x onerror=alert(1)>` comme nom de zone → aucune alert déclenchée
- [ ] `document.getElementById('btn-export-clipboard')` retourne un élément non-null
- [ ] Cliquer export clipboard copie une image (vérifiable par collage)
- [ ] `console.log` count dans `calibrate.js` : ~10 → ≤ 3
- [ ] `commandBar` input déclenche `showSuggestions` max 1×/150ms
- [ ] Spinner d'export visible > 100ms pendant rendu d'1000×800 px
- [ ] Tous les scénarios de test manuel passent sans régression

---

## Out of scope (explicite)

- Refactor `annotations.js` (3 426 l.) / `settings.js` (2 647 l.)
- Révocation des vraies clés (action utilisateur)
- Exécution du SQL RLS (action utilisateur après revue)
- Fix des 97 event listeners non nettoyés
- Tests automatisés
- Code-split, fuzzy search, nettoyage repo (PNG racine, PDF LFS)

---

## Review (post-Xamine, 2026-04-22)

### Fichiers modifiés

| Fichier | Lignes touchées | Nature |
|---|---|---|
| `app/index.html` | 43 | +1 bouton `btn-export-clipboard` |
| `app/js/annotations.js` | 2635-2644 | Fix XSS imageDataUrl/imageSrc (innerHTML → createElement) |
| `app/js/search.js` | 49-56, 1189-1199, 1344-1365 | Debounce 150ms, 2 blocs XSS corrigés |
| `app/js/settings.js` | 342-350, 494-504, 573-583 | 3 blocs XSS corrigés |
| `app/js/calibrate.js` | 342-352, 411-419, 1203-1214 | 1 XSS, ~5 console.log gated derrière `window.EIC_DEBUG` |
| `app/js/export.js` | 16-37, 47-55, 72-88, 572-594, 605-647 | Bouton clipboard bindé, spinner, XSS menu shapes |

### Vérifications automatisées

- [x] Syntaxe OK sur les 5 fichiers JS (`node -c`)
- [x] `grep` XSS pattern `innerHTML.*l.nom` → 0 résultat
- [x] `grep` XSS pattern `${a.icon}` / `${s.icon}` / `${custom.imageDataUrl}` → 0 résultat
- [x] `btn-export-clipboard` référencé correctement (HTML + binding + feedback)
- [x] Serveur `npm run serve` démarre et répond 200

### Tests manuels à faire par l'utilisateur

1. `npm run serve` → http://localhost:8080
2. **XSS** : créer zone avec nom `<img src=x onerror="alert('XSS')">` → texte affiché littéralement, aucune alert
3. **Placement multi-annotations** : 3 marqueurs + 2 stickers + 1 voie coupée → aucune régression
4. **Édition** : clic sur marqueur → panneau ✕ + champ Texte + Échap ferme
5. **Export PNG** : spinner visible pendant le rendu
6. **Export clipboard** : nouveau bouton « Copier » → sélection → collage dans Paint/Word
7. **Recherche** : `aig 17 creil` → suggestions apparaissent avec léger délai (non perceptible)
8. **Console** : pas de logs "SAVE ELEMENT DEBUG" pendant calibration (sauf si `window.EIC_DEBUG = true` en console)

### Success Criteria — bilan

- [x] XSS `<img src=x onerror=...>` neutralisé — prouvé par suppression de tous les innerHTML avec interpolation
- [x] `btn-export-clipboard` non-null après chargement — bouton présent dans `index.html:43`
- [x] `console.log` calibrate.js passe de ~10 à 2 hors mode debug (1728, 1840 — logs info au boot, conservés)
- [x] Debounce 150ms appliqué sur `commandBar`
- [x] Spinner en place pour `toBlob` (clipboard + PNG via File System API + fallback)

### Ce qui reste à faire par l'utilisateur (hors code)

- Révoquer et regénérer la clé Supabase anon (dashboard Supabase → Settings → API)
- Nettoyer la remote URL Git (`git remote set-url origin https://github.com/…` sans le token)
- Révoquer le token GitHub ghp_* (GitHub → Settings → Developer settings → Tokens)
- Activer RLS Supabase (reporté à la demande utilisateur)
- Test local puis commit+push si OK

### Observations à garder en tête

- L'audit du 2026-04-20 était en partie obsolète (fallback auth déjà fixé) — vérifier le code avant de se fier à un audit de plus de 48h.
- L'audit avait listé 3 XSS qui étaient des faux positifs (hardcoded) et manqué 3 vrais XSS (nom zone, imageDataUrl).
- La clé Supabase "anon" étant publique par design côté client, la vraie mitigation est RLS, pas env vars.

