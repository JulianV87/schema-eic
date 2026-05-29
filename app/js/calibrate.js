/**
 * Popup d'édition d'élément (ex-"Mode Calibration")
 * Le mode calibration manuel a été retiré ; il ne reste que le popup
 * d'enregistrement d'élément + les prefills, réutilisés par la Baguette
 * magique (magicwand.js).
 */
const Calibrate = (() => {
  let active = false;       // conservé pour isActive() ; toujours false désormais
  let pendingCoords = null;
  let pendingShape = null;  // forme capturée (ex: contour de la baguette magique)

  function init() {
    // Le mode "Calibrer" manuel a été retiré. init() ne câble plus que le
    // popup d'édition d'élément + ses prefills, partagés avec la Baguette
    // magique (magicwand.js) qui réutilise #calibrate-popup et calibrate-confirm.

    // Popup events
    document.getElementById('calibrate-close').addEventListener('click', closePopup);
    document.querySelector('#calibrate-popup .popup-overlay').addEventListener('click', closePopup);
    document.getElementById('calibrate-confirm').addEventListener('click', saveElement);

    // Bouton enregistrer la vue
    document.getElementById('calibrate-save-view').addEventListener('click', () => {
      if (!pendingCoords) return;
      // Utiliser l'id de l'élément en cours d'édition, ou en générer un temporaire
      const popup = document.getElementById('calibrate-popup');
      const editId = popup.dataset.editId;
      const id = editId || ('view-' + pendingCoords.x.toFixed(4) + '-' + pendingCoords.y.toFixed(4));
      Viewer.saveCurrentViewForZone(id);
      const btn = document.getElementById('calibrate-save-view');
      btn.textContent = '✓ Vue sauvegardée';
      btn.style.borderColor = 'var(--accent2)';
      btn.style.color = 'var(--accent2)';
      setTimeout(() => {
        btn.textContent = '📌 Enregistrer la vue';
        btn.style.borderColor = '';
        btn.style.color = '';
      }, 2000);
    });

    // Dropdown gare
    setupGareDropdown();

    // Les prefills ne tournent qu'une fois (flag dans Supabase)
    // Après l'import initial ils ne font plus rien
    prefillPNData();
    prefillSectorsInLines();
  }

  function saveElement() {
    const popup = document.getElementById('calibrate-popup');
    const identifiant = document.getElementById('calibrate-id').value.trim();
    if (!identifiant) {
      document.getElementById('calibrate-id').focus();
      return;
    }

    const type = document.getElementById('calibrate-type').value;
    const gareName = document.getElementById('calibrate-gare').value.trim();
    const ligne = document.getElementById('calibrate-ligne').value.trim();
    const pk = document.getElementById('calibrate-pk').value.trim();
    const secteur = document.getElementById('calibrate-secteur').value.trim();

    // Récupérer l'ancienne gare_id (pour ne pas la perdre si le nom ne matche pas)
    const editId = popup.dataset.editId;
    let previousGareId = null;
    if (editId) {
      const existing = Data.searchElementFuzzy('').find(e => e.id === editId);
      if (existing) previousGareId = existing.gare_id;
    }

    // Trouver la desserte par nom (toutes les dessertes, pas juste les gares PDF)
    let gareId = null;
    if (gareName) {
      const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-''\.]/g, ' ').replace(/\s+/g, ' ').trim();
      const q = norm(gareName);

      // 1. Correspondance exacte
      Data.getAllDessertes().forEach((d, id) => {
        if (!gareId && norm(d.nom) === q) gareId = id;
      });

      // 2. Le nom de desserte est contenu dans la saisie (ex: "Paris-Nord" dans "Paris-Nord Grandes Lignes")
      if (!gareId) {
        let bestLen = 0;
        Data.getAllDessertes().forEach((d, id) => {
          const n = norm(d.nom);
          if (q.includes(n) && n.length > bestLen) {
            bestLen = n.length;
            gareId = id;
          }
        });
      }

      // 3. La saisie est contenue dans un nom de desserte
      if (!gareId) {
        Data.getAllDessertes().forEach((d, id) => {
          if (!gareId && norm(d.nom).includes(q)) gareId = id;
        });
      }

      // 4. Fallback gares PDF
      if (!gareId) {
        const matches = Data.searchGare(gareName);
        if (matches.length > 0) gareId = matches[0].id;
      }

      // Si toujours rien trouvé, garder l'ancienne valeur
      if (!gareId) {
        console.warn('Desserte non trouvée pour "' + gareName + '", conservation de l\'ancienne valeur');
        gareId = previousGareId;
      }
    }

    // Tracer la résolution de desserte uniquement si debug activé
    if (window.EIC_DEBUG && gareName) {
      console.log('SAVE ELEMENT DEBUG', { gareName, gareId, previousGareId });
      const norm2 = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-''\.]/g, ' ').replace(/\s+/g, ' ').trim();
      console.log('gareName normalisé:', JSON.stringify(norm2(gareName)));
      const dessertes = Data.getAllDessertes();
      console.log('Nb dessertes:', dessertes.size);
      dessertes.forEach((d, id) => {
        if (norm2(d.nom).includes('paris')) console.log('  -', id, '→', d.nom, '→ norm:', JSON.stringify(norm2(d.nom)));
      });
    }

    const id = editId || Data.generateId();

    const element = {
      id: id,
      type: type,
      identifiant: identifiant,
      gare_id: gareId,
      ligne: ligne,
      pk: pk,
      secteur: secteur,
      x_pct: pendingCoords.x,
      y_pct: pendingCoords.y,
      source: 'manual',
      validated: true,
    };

    // Si c'est une gare
    if (type === 'gare') {
      element._isGare = true;
      element.nom = identifiant;
      element.nom_court = '';
      element.zone_id = null;
    }

    // Sauvegarder la forme dessinée (rectangle, cercle, libre) ou le contour baguette magique
    if (pendingShape) {
      element.shape = pendingShape;
    } else {
      const contourData = popup.dataset.contour;
      if (contourData) {
        try { element.shape = JSON.parse(contourData); } catch {}
        popup.dataset.contour = '';
      }
    }

    Data.saveManualElement(element);

    // Sauvegarder la vue pour cet élément (si elle n'existe pas encore)
    if (!Data.hasSavedView(id)) {
      Viewer.saveCurrentViewForZone(id);
    }

    closePopup();

    // Feedback visuel
    showStatusMsg(`${identifiant} enregistré à (${pendingCoords.x.toFixed(4)}, ${pendingCoords.y.toFixed(4)})`);

    // Rafraîchir le sidebar si une zone est active
    const zone = Viewer.getCurrentZone();
    if (zone) {
      Search.loadSidebarForZone(zone.id);
    }

    // Rafraîchir les paramètres s'ils sont ouverts
    try {
      const settingsPopup = document.getElementById('settings-popup');
      if (settingsPopup && !settingsPopup.classList.contains('hidden')) {
        Settings.renderTab(null);
      }
    } catch (e) {
      console.error('Erreur rafraîchissement paramètres:', e);
    }
  }

  function closePopup() {
    document.getElementById('calibrate-popup').classList.add('hidden');
    pendingShape = null;
  }


  function showStatusMsg(msg) {
    let el = document.getElementById('calibrate-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'calibrate-status';
      el.style.cssText = `position:absolute; top:8px; left:50%; transform:translateX(-50%); z-index:30;
        background:rgba(255,149,32,0.9); color:#fff; font-family:'JetBrains Mono',monospace;
        font-size:11px; padding:4px 14px; border-radius:4px; pointer-events:none;`;
      document.getElementById('viewer-container').appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
  }

  // === DROPDOWN GARE GROUPÉ PAR TABLE ===

  function setupGareDropdown() {
    const input = document.getElementById('calibrate-gare');
    const dropdown = document.getElementById('calibrate-gare-dropdown');
    if (!input || !dropdown) return;

    input.addEventListener('focus', () => {
      populateGareDropdown(input.value);
      dropdown.classList.remove('hidden');
    });

    input.addEventListener('input', () => {
      populateGareDropdown(input.value);
      dropdown.classList.remove('hidden');
    });

    input.addEventListener('blur', () => {
      // Délai pour laisser le clic se propager
      setTimeout(() => dropdown.classList.add('hidden'), 150);
      autoFillSecteur(input.value);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        dropdown.classList.add('hidden');
      }
    });
  }

  function populateGareDropdown(filter) {
    const dropdown = document.getElementById('calibrate-gare-dropdown');
    if (!dropdown) return;
    dropdown.innerHTML = '';

    const input = document.getElementById('calibrate-gare');
    const q = (filter || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[-'']/g, ' ').replace(/\bsaint\b/g, 'st').replace(/\bsainte\b/g, 'ste');

    // Liste unifiée via Data.getAllDessertes()
    const allDessertes = Data.getAllDessertes();

    // Construire index desserte → zoneIds dans le layout
    let layout = null;
    try { layout = Store.getJSON('eic_zone_layout', {}); } catch {}

    const desserteByLine = new Map(); // zoneId → [table names]
    const assignedIds = new Set();
    if (layout && layout.tables) {
      layout.tables.forEach(table => {
        (table.lines || []).forEach(line => {
          (line.zoneIds || []).forEach(zoneId => {
            assignedIds.add(zoneId);
            if (!desserteByLine.has(zoneId)) desserteByLine.set(zoneId, new Set());
            desserteByLine.get(zoneId).add(table.nom);
          });
        });
      });
    }

    function norm(s) {
      return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[-'']/g, ' ').replace(/\bsaint\b/g, 'st').replace(/\bsainte\b/g, 'ste');
    }

    // Grouper par table
    if (layout && layout.tables) {
      layout.tables.forEach(table => {
        const tableDessertes = [];
        const seen = new Set();
        (table.lines || []).forEach(line => {
          (line.zoneIds || []).forEach(zoneId => {
            if (seen.has(zoneId)) return;
            seen.add(zoneId);
            const d = allDessertes.get(zoneId);
            if (!d) return;
            if (q && !norm(d.nom).includes(q)) return;
            tableDessertes.push(d);
          });
        });

        if (tableDessertes.length === 0) return;

        const groupEl = document.createElement('div');
        groupEl.className = 'calibrate-dropdown-group';
        groupEl.textContent = table.nom;
        dropdown.appendChild(groupEl);

        tableDessertes.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
        tableDessertes.forEach(d => {
          const item = document.createElement('div');
          item.className = 'calibrate-dropdown-item';
          item.textContent = d.nom;
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            input.value = d.nom;
            dropdown.classList.add('hidden');
            autoFillSecteur(d.nom);
          });
          dropdown.appendChild(item);
        });
      });
    }

    // Non classées
    const others = [];
    allDessertes.forEach((d, id) => {
      if (assignedIds.has(id)) return;
      if (q && !norm(d.nom).includes(q)) return;
      others.push(d);
    });

    if (others.length > 0) {
      const groupEl = document.createElement('div');
      groupEl.className = 'calibrate-dropdown-group';
      groupEl.textContent = 'Autres';
      dropdown.appendChild(groupEl);

      others.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
      others.forEach(d => {
        const item = document.createElement('div');
        item.className = 'calibrate-dropdown-item';
        item.textContent = d.nom;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = d.nom;
          dropdown.classList.add('hidden');
          autoFillSecteur(d.nom);
        });
        dropdown.appendChild(item);
      });
    }
  }

  // === AUTO-REMPLISSAGE SECTEUR ET LIGNE SELON DESSERTE ===

  const DESSERTE_SECTEUR_MAP = {
    'paris nord grandes lignes': '1 GL',
  };

  function autoFillSecteur(gareName) {
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-''\.]/g, ' ').replace(/\s+/g, ' ').trim();
    // Auto-remplir le secteur
    const secteur = DESSERTE_SECTEUR_MAP[norm(gareName)];
    if (secteur) {
      document.getElementById('calibrate-secteur').value = secteur;
    }
    // Auto-remplir la ligne à partir du layout (desserte → ligne)
    autoFillLigne(gareName);
  }

  function autoFillLigne(gareName) {
    if (!gareName) return;
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-''\.]/g, ' ').replace(/\s+/g, ' ').trim();
    const q = norm(gareName);

    // Trouver l'id de la desserte
    let desserteId = null;
    Data.getAllDessertes().forEach((d, id) => {
      if (!desserteId && norm(d.nom) === q) desserteId = id;
    });
    if (!desserteId) return;

    // Chercher dans le layout quelle(s) ligne(s) contiennent cette desserte
    let layout = null;
    try { layout = Store.getJSON('eic_zone_layout', {}); } catch { return; }
    if (!layout || !layout.tables) return;

    const ligneNames = [];
    layout.tables.forEach(t => {
      (t.lines || []).forEach(line => {
        if ((line.zoneIds || []).includes(desserteId)) {
          ligneNames.push(line.nom);
        }
      });
    });

    const unique = [...new Set(ligneNames)];
    if (unique.length === 0) return;

    const ligneInput = document.getElementById('calibrate-ligne');
    if (unique.length === 1) {
      ligneInput.value = unique[0];
    } else {
      // Plusieurs lignes : afficher un sélecteur
      showLigneSelector(ligneInput, unique);
    }
  }

  function showLigneSelector(inputEl, lignes) {
    // Supprimer un éventuel sélecteur existant
    const old = document.getElementById('ligne-selector-dropdown');
    if (old) old.remove();

    const dropdown = document.createElement('div');
    dropdown.id = 'ligne-selector-dropdown';
    dropdown.style.cssText = 'position:absolute;left:0;right:0;background:var(--surface);border:1px solid var(--accent);border-radius:3px;z-index:200;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-height:150px;overflow-y:auto;';

    lignes.forEach(nom => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:6px 10px;font-family:var(--mono);font-size:11px;color:var(--text);cursor:pointer;';
      item.textContent = nom;
      item.addEventListener('mouseenter', () => item.style.background = 'var(--surface2)');
      item.addEventListener('mouseleave', () => item.style.background = 'none');
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inputEl.value = nom;
        dropdown.remove();
      });
      dropdown.appendChild(item);
    });

    // Positionner sous l'input
    const parent = inputEl.parentElement;
    if (parent) {
      parent.style.position = 'relative';
      parent.appendChild(dropdown);
    }

    // Fermer si on clique ailleurs
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target !== inputEl) {
        dropdown.remove();
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeHandler), 50);
  }

  // === PRÉ-REMPLISSAGE DES PN ===

  function prefillPNData() {
    // Ne faire qu'une seule fois
    if (Store.get('eic_pn_prefilled') === '1') return;

    const gares = Data.getGares();
    if (gares.length === 0) return; // Pas de données chargées

    // Récupérer les éléments manuels existants pour ne pas les écraser
    let manual = [];
    try { manual = Store.getJSON('eic_manual_elements', []); } catch {}
    const manualIds = new Set(manual.map(m => m.id));

    // Récupérer les lignes depuis le layout pour associer les PN
    let linesByZone = new Map();
    try {
      const layout = Store.getJSON('eic_zone_layout', {});
      if (layout.tables) {
        layout.tables.forEach(t => (t.lines || []).forEach(line => {
          (line.zoneIds || []).forEach(zoneId => {
            if (!linesByZone.has(zoneId)) linesByZone.set(zoneId, []);
            linesByZone.get(zoneId).push(line.nom);
          });
        }));
      }
    } catch {}

    // Tous les PN extraits
    const allElements = Data.searchElementFuzzy('');
    const pns = allElements.filter(e => e.type === 'pn');
    if (pns.length === 0) return;

    let count = 0;
    pns.forEach(pn => {
      // Ne pas écraser un élément déjà calibré manuellement
      if (manualIds.has(pn.id)) return;

      // Trouver la gare la plus proche
      let closestGare = null;
      let minDist = Infinity;
      gares.forEach(g => {
        const dx = pn.x_pct - g.x_pct;
        const dy = pn.y_pct - g.y_pct;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist) { minDist = dist; closestGare = g; }
      });

      if (!closestGare || minDist > 0.08) return;

      // Trouver la ligne associée via la zone de la gare
      const zoneLines = linesByZone.get(closestGare.zone_id) || [];
      const ligne = zoneLines[0] || '';

      // Extraire le type de PN depuis raw_text
      let pnType = pn.pn_type || '';

      const element = {
        id: pn.id,
        type: 'pn',
        identifiant: pn.identifiant,
        gare_id: closestGare.id,
        ligne: ligne,
        pk: pn.pk || '',
        secteur: pnType ? `PN ${pnType}` : '',
        x_pct: pn.x_pct,
        y_pct: pn.y_pct,
        source: 'prefilled',
        validated: false,
        pn_type: pnType,
      };

      Data.saveManualElement(element);
      count++;
    });

    Store.set('eic_pn_prefilled', '1');
    if (count > 0) {
      console.log(`Pré-remplissage: ${count} PN associés à leur gare et ligne`);
    }
  }

  // === PRÉ-REMPLISSAGE DES SECTEURS DANS LES LIGNES ===

  // Mapping officiel : numéro de ligne SNCF → secteurs traversés (dans l'ordre)
  // Basé sur la géographie réelle du réseau EIC Paris Nord
  const LINE_SECTOR_MAP = {
    // Ligne 272000 : Paris-Nord → Lille (via Creil, Chantilly, Longueau)
    '272000': ['paris', 'dionysien', 'goussainville-chantilly', 'creil', 'longueau'],
    // Ligne 330000 : St-Denis → Dieppe (via Enghien, Pontoise, Gisors)
    '330000': ['paris', 'dionysien', 'ermont-valmondois'],
    // Ligne 242000 : Creil → Jeumont (via Compiègne, Noyon, Tergnier)
    '242000': ['creil', 'compiegne', 'noyon', 'laon'],
    // Ligne 325000 : Épinay-Villetaneuse → Le Tréport-Mers (via Persan, Beauvais)
    '325000': ['dionysien', 'persan-boran', 'beauvais'],
    // Ligne 328000 : Ermont-Eaubonne → Valmondois
    '328000': ['ermont-valmondois'],
    // Ligne 229000 : La Plaine → Hirson (via Mitry, Crépy-en-Valois, Soissons)
    '229000': ['bourget-drancy', 'mitry', 'soissons'],
    // Ligne 311000 : Longueau → Boulogne (via Amiens)
    '311000': ['longueau'],
    // Ligne 017000 : Paris-Est / Grande Ceinture
    '017000': ['est'],
    // Ligne 340000 : Creil → Beauvais (via Hermes, Rochy-Condé)
    '340000': ['creil', 'beauvais'],
    // Ligne 262000 : Creil → Pontoise (via Précy, Boran, Persan)
    '262000': ['creil', 'persan-boran', 'ermont-valmondois'],
    // Ligne 267000 : Orry-la-Ville → Crépy-en-Valois
    '267000': ['goussainville-chantilly', 'mitry'],
    // Ligne 269000 : Chantilly → Creil
    '269000': ['goussainville-chantilly', 'creil'],
    // Ligne 254000 : Compiègne → Soissons
    '254000': ['compiegne', 'soissons'],
    // Ligne 247000 : Tergnier → Laon
    '247000': ['noyon', 'laon'],
    // Ligne 302000 : Amiens → Longueau / Tergnier
    '302000': ['longueau', 'noyon'],
    // Ligne 990000 : Grande Ceinture
    '990000': ['est', 'bourget-drancy'],
    // Ligne H — Tronc commun + Paris → Pontoise (via Ermont)
    'H-pontoise': ['paris', 'dionysien', 'ermont-valmondois'],
    // Ligne H — Paris → Luzarches (via Montsoult)
    'H-luzarches': ['paris', 'dionysien', 'goussainville-chantilly'],
    // Ligne H — Paris → Persan-Beaumont (via Valmondois)
    'H-persan': ['paris', 'dionysien', 'ermont-valmondois', 'persan-boran'],
    // Ligne H — Pontoise → Creil (transversale)
    'H-creil': ['ermont-valmondois', 'persan-boran', 'creil'],
    // Ligne H — complète (toutes branches)
    'ligne h': ['paris', 'dionysien', 'ermont-valmondois', 'persan-boran', 'goussainville-chantilly', 'creil'],
    // Ligne K Transilien — Paris → Crépy-en-Valois
    'K': ['paris', 'bourget-drancy', 'mitry'],
    // Ligne D RER — tronçon nord (Paris → Creil via Goussainville)
    'ligne d': ['paris', 'dionysien', 'goussainville-chantilly', 'creil'],
  };

  // Version du mapping — incrémenter pour forcer un re-remplissage
  const SECTOR_MAP_VERSION = '3';

  function prefillSectorsInLines() {
    if (Store.get('eic_sectors_prefilled') === SECTOR_MAP_VERSION) return;

    let layout;
    try { layout = Store.getJSON('eic_zone_layout', {}); } catch { return; }
    if (!layout || !layout.tables) return;

    const zones = Data.getZones();
    if (zones.length === 0) return;
    const zoneIds = new Set(zones.map(z => z.id));

    let changed = false;

    layout.tables.forEach(table => {
      (table.lines || []).forEach(line => {
        // Ne PAS toucher les lignes déjà remplies (manuellement ou précédemment)
        if (line.zoneIds && line.zoneIds.length > 0) return;

        // Extraire le numéro de ligne du nom (ex: "L272000 Paris-Nord → Lille" → "272000")
        const numMatch = line.nom.match(/\b(\d{6})\b/);
        const lineNum = numMatch ? numMatch[1] : null;

        // Chercher aussi par mot-clé Transilien (H-persan, H-pontoise, K)
        const nomLower = line.nom.toLowerCase();

        let sectors = null;

        if (lineNum && LINE_SECTOR_MAP[lineNum]) {
          sectors = LINE_SECTOR_MAP[lineNum];
        } else {
          // Recherche par mot-clé dans le nom
          for (const [key, secs] of Object.entries(LINE_SECTOR_MAP)) {
            if (nomLower.includes(key.toLowerCase())) {
              sectors = secs;
              break;
            }
          }
        }

        if (sectors) {
          // Filtrer pour ne garder que les secteurs qui existent
          const valid = sectors.filter(id => zoneIds.has(id));
          if (valid.length > 0) {
            line.zoneIds = valid;
            changed = true;
          }
        }
      });
    });

    if (changed) {
      Store.set('eic_zone_layout', layout);
      console.log('Pré-remplissage: secteurs assignés aux lignes depuis le référentiel SNCF');
      try { Search.reloadLayout(); } catch {}
    }

    Store.set('eic_sectors_prefilled', SECTOR_MAP_VERSION);
  }

  function populateLigneList() {
    const datalist = document.getElementById('calibrate-ligne-list');
    if (!datalist) return;
    datalist.innerHTML = '';

    // Collecter les noms de lignes depuis le layout + les lignes déjà saisies manuellement
    const lignes = new Set();

    // Depuis le layout (tables > lines)
    try {
      const layout = Store.getJSON('eic_zone_layout', {});
      if (layout.tables) {
        layout.tables.forEach(t => {
          (t.lines || []).forEach(l => {
            if (l.nom) lignes.add(l.nom);
          });
        });
      }
    } catch {}

    // Depuis les éléments manuels déjà calibrés
    try {
      const manual = Store.getJSON('eic_manual_elements', []);
      manual.forEach(m => {
        if (m.ligne) lignes.add(m.ligne);
      });
    } catch {}

    // Créer les options
    lignes.forEach(nom => {
      const opt = document.createElement('option');
      opt.value = nom;
      datalist.appendChild(opt);
    });
  }

  // hasSavedViewForId supprimé — utiliser Data.hasSavedView

  function isActive() { return active; }

  return { init, isActive };
})();
