/**
 * Couche de données
 * Charge les données extraites du PDF + corrections manuelles (localStorage)
 */
const Data = (() => {

  let GARES = [];
  let ELEMENTS = [];
  let ZONES = [];
  let loaded = false;
  let yRatio = 0.1964; // ratio hauteur/largeur pour coordonnées OSD

  /**
   * Charger les données — Supabase est la source unique.
   * Le JSON du PDF sert de seed initial (une seule fois).
   */
  async function loadData() {
    if (loaded) return;

    // 1. Vérifier si Supabase a déjà les données (importées précédemment)
    const savedGares = Store.getJSON('eic_gares', null);
    const savedElements = Store.getJSON('eic_elements', null);

    if (savedGares && savedElements) {
      // Données déjà dans Supabase → les utiliser directement
      console.log('Chargement depuis Supabase...');
      GARES = savedGares;
      ELEMENTS = savedElements;
      yRatio = Store.getJSON('eic_yratio', 0.1964);
      // Nettoyer les identifiants pollués par des coordonnées [x,y]
      let cleaned = 0;
      ELEMENTS.forEach(e => {
        const clean = (e.identifiant || '').replace(/\s*\[[\d\.,]+\]\s*/g, '').trim();
        if (clean !== e.identifiant) { e.identifiant = clean; cleaned++; }
      });
      if (cleaned > 0) {
        Store.set('eic_elements', ELEMENTS);
        console.log(`Nettoyage: ${cleaned} identifiants corrigés`);
      }
      // Purger les shapes avec des bounds invalides / cassées
      let purged = 0;
      ELEMENTS.forEach(e => {
        if (!e.shape || !e.shape.bounds) return;
        const b = e.shape.bounds;
        const invalid =
          b.w <= 0 || b.h <= 0 ||
          isNaN(b.x) || isNaN(b.y) ||
          b.x < -1 || b.x > 2 ||
          b.y < -1 || b.y > 1;
        if (invalid) {
          delete e.shape;
          purged++;
        }
      });
      if (purged > 0) {
        Store.set('eic_elements', ELEMENTS);
        console.log(`Purge: ${purged} shapes cassées supprimées`);
      }
      console.log(`Données Supabase: ${GARES.length} gares, ${ELEMENTS.length} éléments`);
    } else {
      // Première utilisation → importer depuis le JSON du PDF
      console.log('Import initial depuis data_extracted.json...');
      try {
        const resp = await fetch('/app/js/data_extracted.json');
        if (resp.ok) {
          const data = await resp.json();
          processExtractedData(data);
          // Sauvegarder dans Supabase (seed unique)
          Store.set('eic_gares', GARES);
          Store.set('eic_elements', ELEMENTS);
          Store.set('eic_yratio', yRatio);
          console.log(`Import initial: ${GARES.length} gares, ${ELEMENTS.length} éléments → Supabase`);
        } else {
          console.warn('data_extracted.json non trouvé');
          loadFallbackData();
        }
      } catch (e) {
        console.error('Erreur import initial:', e);
        loadFallbackData();
      }
    }

    // 2. Construire les zones automatiquement
    buildZones();

    loaded = true;
  }

  /**
   * Transformer les données extraites en format exploitable
   */
  function processExtractedData(data) {
    // Ratio hauteur/largeur du schéma pour convertir les coordonnées PDF → OSD
    // OSD normalise x de 0 à 1, y de 0 à (height/width)
    const pdfW = data.metadata?.page_width_pts || 13039;
    const pdfH = data.metadata?.page_height_pts || 2562;
    yRatio = pdfH / pdfW;

    // Gares — dédoublonner par nom
    const garesMap = new Map();
    (data.gares || []).forEach(g => {
      const key = g.nom.toLowerCase();
      if (!garesMap.has(key) || g.raw_text.length > garesMap.get(key).raw_text.length) {
        garesMap.set(key, g);
      }
    });

    let gareId = 1;
    garesMap.forEach((g, key) => {
      GARES.push({
        id: 'gare-' + gareId++,
        nom: g.nom,
        nom_court: generateShortName(g.nom),
        zone_id: null, // sera rempli par buildZones
        x_pct: g.x_pct,
        y_pct: g.y_pct * yRatio,
        source: 'extracted',
      });
    });

    // Éléments infra — filtrer les supprimés
    const deletedElements = Store.getJSON('eic_deleted_elements', []);
    const deletedSet = new Set(deletedElements);
    let elemId = 1;
    (data.elements || []).forEach(e => {
      const id = 'elem-' + elemId++;
      if (deletedSet.has(id)) return; // Élément supprimé
      ELEMENTS.push({
        id: id,
        type: e.type,
        identifiant: (e.identifiant || '').replace(/\s*\[[\d\.,]+\]\s*/g, '').trim(),
        gare_id: null, // sera associé par proximité
        ligne: '',
        pk: '',
        secteur: '',
        x_pct: e.x_pct,
        y_pct: e.y_pct * yRatio,
        source: 'extracted',
        validated: false,
      });
    });

    // Associer chaque élément à la gare la plus proche
    ELEMENTS.forEach(el => {
      let minDist = Infinity;
      let closestGare = null;
      GARES.forEach(g => {
        const dx = el.x_pct - g.x_pct;
        const dy = el.y_pct - g.y_pct;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist) {
          minDist = dist;
          closestGare = g;
        }
      });
      if (closestGare && minDist < 0.05) {
        el.gare_id = closestGare.id;
      }
    });
  }

  function generateShortName(nom) {
    // "Epinay-Villetaneuse" → "Epinay-V"
    // "Chantilly-Gouvieux" → "Chantilly"
    const parts = nom.split(/[-\s]/);
    if (parts.length > 1 && nom.length > 12) {
      return parts[0];
    }
    return '';
  }

  /**
   * Construire les zones automatiquement à partir des positions des gares
   */
  function buildZones() {
    // Zones prédéfinies basées sur la géographie du réseau
    // Les gares ont déjà des y_pct convertis en coordonnées OSD
    const r = yRatio;

    // Bornes en coordonnées OSD (x: 0-1, y: 0-~0.20)
    // Les gares ont déjà y converti (y_pct * yRatio)
    const zoneDefs = [
      { id: 'paris', nom: 'Paris-Nord / Chapelle', xMin: 0, xMax: 0.18, yMin: 0, yMax: 0.20 },
      { id: 'dionysien', nom: 'PCD Dionysien', xMin: 0.18, xMax: 0.32, yMin: 0.02, yMax: 0.12 },
      { id: 'bourget-drancy', nom: 'Le Bourget / Drancy', xMin: 0.24, xMax: 0.35, yMin: 0.02, yMax: 0.20 },
      { id: 'ermont-valmondois', nom: 'Ermont / Valmondois / Pontoise', xMin: 0.15, xMax: 0.44, yMin: 0, yMax: 0.07 },
      { id: 'goussainville-chantilly', nom: 'Goussainville → Chantilly', xMin: 0.37, xMax: 0.50, yMin: 0, yMax: 0.12 },
      { id: 'persan-boran', nom: 'Persan / Boran / Bruyères', xMin: 0.43, xMax: 0.52, yMin: 0, yMax: 0.10 },
      { id: 'creil', nom: 'Creil', xMin: 0.50, xMax: 0.65, yMin: 0.02, yMax: 0.16 },
      { id: 'beauvais', nom: 'Beauvais / Rochy-Condé', xMin: 0.55, xMax: 0.80, yMin: 0, yMax: 0.06 },
      { id: 'compiegne', nom: 'Compiègne', xMin: 0.60, xMax: 0.80, yMin: 0.04, yMax: 0.14 },
      { id: 'noyon', nom: 'Noyon / Tergnier', xMin: 0.75, xMax: 0.92, yMin: 0.04, yMax: 0.14 },
      { id: 'laon', nom: 'Laon', xMin: 0.88, xMax: 1.0, yMin: 0, yMax: 0.18 },
      { id: 'longueau', nom: 'Longueau / Amiens', xMin: 0.85, xMax: 1.0, yMin: 0, yMax: 0.06 },
      { id: 'est', nom: 'Paris-Est / GC', xMin: 0, xMax: 0.30, yMin: 0.11, yMax: 0.20 },
      { id: 'soissons', nom: 'Soissons', xMin: 0.55, xMax: 0.85, yMin: 0.13, yMax: 0.20 },
      { id: 'mitry', nom: 'Mitry / Dammartin', xMin: 0.35, xMax: 0.60, yMin: 0.11, yMax: 0.18 },
    ];

    ZONES = zoneDefs.map(z => ({
      ...z,
      gares: [],
    }));

    // Assigner chaque gare à la zone la plus appropriée
    GARES.forEach(g => {
      for (const z of ZONES) {
        if (g.x_pct >= z.xMin && g.x_pct <= z.xMax && g.y_pct >= z.yMin && g.y_pct <= z.yMax) {
          g.zone_id = z.id;
          z.gares.push(g.id);
          break;
        }
      }
      // Si aucune zone trouvée, assigner à la plus proche
      if (!g.zone_id) {
        let minDist = Infinity;
        let closestZone = ZONES[0];
        ZONES.forEach(z => {
          const cx = (z.xMin + z.xMax) / 2;
          const cy = (z.yMin + z.yMax) / 2;
          const dist = Math.sqrt((g.x_pct - cx) ** 2 + (g.y_pct - cy) ** 2);
          if (dist < minDist) { minDist = dist; closestZone = z; }
        });
        g.zone_id = closestZone.id;
        closestZone.gares.push(g.id);
      }
    });
  }

  /**
   * Données de base si l'extraction n'est pas disponible
   */
  function loadFallbackData() {
    GARES = [
      { id: 'creil', nom: 'Creil', nom_court: '', zone_id: 'creil', x_pct: 0.558, y_pct: 0.582, source: 'manual' },
      { id: 'paris-nord', nom: 'Paris-Nord', nom_court: 'Paris', zone_id: 'paris', x_pct: 0.05, y_pct: 0.40, source: 'manual' },
    ];
    ELEMENTS = [];
  }

  // === SAUVEGARDE ÉLÉMENTS (Supabase) ===

  function saveManualElement(element) {
    // Mettre à jour dans ELEMENTS (mémoire)
    const elemIdx = ELEMENTS.findIndex(e => e.id === element.id);
    if (elemIdx >= 0) {
      ELEMENTS[elemIdx] = { ...ELEMENTS[elemIdx], ...element, validated: true };
      console.log('Element modifié:', element.id, element.type, element.identifiant);
    } else {
      ELEMENTS.push({ ...element, validated: true });
      console.log('Element ajouté:', element.id, element.type, element.identifiant);
    }
    console.log('Sauvegarde', ELEMENTS.length, 'éléments vers Supabase...');
    // Sauvegarder dans Supabase
    Store.set('eic_elements', ELEMENTS);

    // Si c'est une gare, aussi mettre à jour GARES
    if (element._isGare || element.type === 'gare') {
      const gareIdx = GARES.findIndex(g => g.id === element.id);
      if (gareIdx >= 0) {
        GARES[gareIdx] = { ...GARES[gareIdx], ...element };
      } else {
        GARES.push({ ...element, nom: element.identifiant || element.nom, nom_court: '' });
      }
      Store.set('eic_gares', GARES);
    }
  }

  function deleteManualElement(id) {
    ELEMENTS = ELEMENTS.filter(e => e.id !== id);
    Store.set('eic_elements', ELEMENTS);
  }

  // === ACCESSEURS ===

  function getGares() { return GARES; }
  function getGare(id) { return GARES.find(g => g.id === id); }

  function searchGare(query) {
    const q = query.toLowerCase();
    return GARES.filter(g =>
      g.nom.toLowerCase().includes(q) ||
      (g.nom_court && g.nom_court.toLowerCase().includes(q))
    );
  }

  function getElementsForZone(zoneId) {
    const zone = ZONES.find(z => z.id === zoneId);
    if (!zone) return [];
    return ELEMENTS.filter(e => zone.gares.includes(e.gare_id));
  }

  function searchElement(identifiant) {
    const q = identifiant.toLowerCase().replace(/\s+/g, ' ').trim();
    return ELEMENTS.filter(e =>
      e.identifiant.toLowerCase().replace(/\s+/g, ' ').trim() === q
    );
  }

  function searchElementFuzzy(query) {
    const q = query.toLowerCase();
    return ELEMENTS.filter(e =>
      e.identifiant.toLowerCase().includes(q)
    );
  }

  function getZone(id) { return ZONES.find(z => z.id === id); }
  function getZones() { return ZONES; }

  function getGareForElement(element) {
    return GARES.find(g => g.id === element.gare_id);
  }

  function generateId() {
    return 'manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  }

  // === FONCTIONS PARTAGÉES (utilisées par search, settings, calibrate) ===

  function getAllDessertes() {
    const result = new Map();
    const overrides = Store.getJSON('eic_zone_overrides', {});
    const hidden = new Set(Store.getJSON('eic_hidden_zones', []));

    ZONES.forEach(z => {
      if (hidden.has(z.id)) return;
      const o = overrides[z.id];
      result.set(z.id, o ? { ...z, ...o } : { ...z });
    });

    // Custom zones
    const cz = Store.getJSON('eic_custom_zones', []);
    cz.forEach(z => { if (!result.has(z.id)) result.set(z.id, { ...z }); });

    // Also include gares that aren't zones
    GARES.forEach(g => {
      if (hidden.has(g.id)) return;
      if (!result.has(g.id)) {
        const o = overrides[g.id];
        result.set(g.id, o ? { ...g, ...o } : g);
      }
    });

    return result;
  }

  function getDessertePk(zoneId, lineId) {
    const pks = Store.getJSON('eic_desserte_pks', {});
    return pks[zoneId + ':' + lineId] || '';
  }

  function setDessertePk(zoneId, lineId, pk) {
    const pks = Store.getJSON('eic_desserte_pks', {});
    if (pk) { pks[zoneId + ':' + lineId] = pk; } else { delete pks[zoneId + ':' + lineId]; }
    Store.set('eic_desserte_pks', pks);
  }

  function hasSavedView(id) {
    const saved = Store.getJSON('eic_zone_views', {});
    return !!saved[id];
  }

  function getHiddenZones() {
    return Store.getJSON('eic_hidden_zones', []);
  }

  return {
    loadData,
    getGares,
    getGare,
    searchGare,
    getElementsForZone,
    searchElement,
    searchElementFuzzy,
    getZone,
    getZones,
    getGareForElement,
    saveManualElement,
    deleteManualElement,
    generateId,
    getAllDessertes,
    getDessertePk,
    setDessertePk,
    hasSavedView,
    getHiddenZones,
  };
})();
