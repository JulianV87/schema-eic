/**
 * Recherche et navigation contextuelle
 * Gère la barre de commande, la disambiguation, et le panneau latéral
 */
const Search = (() => {

  let currentZoneIndex = 0;

  /** Normaliser un texte pour la recherche : minuscule, sans accents, sans tirets, abréviations courantes */
  function normalize(str) {
    return str.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // accents
      .replace(/[-''\.]/g, ' ')                         // tirets, apostrophes, points
      .replace(/\bsaint\b/g, 'st')                      // saint → st
      .replace(/\bsainte\b/g, 'ste')                    // sainte → ste
      .replace(/\s+/g, ' ').trim();
  }

  // Suggestions dropdown
  let suggestionsEl = null;
  let selectedSuggestion = -1;

  function init() {
    const commandBar = document.getElementById('command-bar');

    commandBar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedSuggestion >= 0 && suggestionsEl) {
          const items = suggestionsEl.querySelectorAll('.suggestion-item');
          if (items[selectedSuggestion]) {
            items[selectedSuggestion].click();
            return;
          }
        }
        closeSuggestions();
        executeCommand(commandBar.value);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSuggestionSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSuggestionSelection(-1);
      } else if (e.key === 'Escape') {
        closeSuggestions();
      }
    });

    // Debounce 150ms — évite un re-render à chaque caractère tapé
    let suggestTimer = null;
    commandBar.addEventListener('input', () => {
      if (suggestTimer) clearTimeout(suggestTimer);
      const val = commandBar.value;
      suggestTimer = setTimeout(() => showSuggestions(val), 150);
    });

    commandBar.addEventListener('blur', () => {
      // Délai pour laisser le clic sur une suggestion se propager
      setTimeout(closeSuggestions, 150);
    });

    // Fermer disambiguation
    document.getElementById('disambiguation-close').addEventListener('click', closeDisambiguation);
    document.querySelector('#disambiguation-popup .popup-overlay').addEventListener('click', closeDisambiguation);

    // Charger les secteurs custom depuis localStorage
    loadCustomZones();

    // Charger le layout (groupes + ordre)
    loadLayout();

    // Charger la liste dans le sidebar
    loadZonesList();

    // Bouton + → menu créer secteur / groupe
    const addBtn = document.getElementById('btn-add-zone');
    if (addBtn) addBtn.addEventListener('click', showAddMenu);

    // Toggle sidebar gauche
    setupSidebarToggle();

    // Resize de la barre du bas
    setupBarResize();

    // Scénarios (save/load de configurations d'annotations)
    setupScenarios();
  }

  // === SCÉNARIOS ===
  let scenariosPopup = null;
  let gareCategoriesPopup = null;
  let gareScenariosPopup = null;

  function setupScenarios() {
    const btn = document.getElementById('btn-scenarios');
    if (btn) btn.addEventListener('click', openScenariosPopup);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (scenarioConfigurator) { closeConfigurator(); return; }
      if (gareScenariosPopup) { closeGareScenariosPopup(); return; }
      if (gareCategoriesPopup) { closeGareCategoriesPopup(); return; }
      if (scenariosPopup) closeScenariosPopup();
    });
    // Migration une-fois : reclasse les anciens scénarios Paris-Nord
    try { migrateParisBagageV1(); } catch (e) { console.warn('Migration Paris bagage:', e.message); }
  }

  // Migration idempotente : crée les 2 sous-catégories pour Paris-Nord et
  // reclasse les scénarios "Colis suspect" selon le préfixe de leur nom.
  // Gated par un flag persistant dans le Store (Supabase) → ne se rejoue pas.
  function migrateParisBagageV1() {
    if (Store.getJSON('eic_migration_paris_bagage_v1', null) === true) return;

    const gares = (typeof Data !== 'undefined' && Data.getGares) ? Data.getGares() : [];
    if (!gares.length) return; // Data pas encore prêt, on réessaiera au prochain chargement
    const paris = gares.find(g => /paris[\s\-]?nord/i.test(g.nom || ''));
    if (!paris) return;

    const SUB_TRAIN = 'Bagage oublié à bord d\'un train';
    const SUB_QUAI = 'Bagage oublié à quai';

    // Ajouter les deux sous-catégories à la liste stockée (sans toucher aux déduites)
    const all = Store.getJSON('eic_subcategories', {}) || {};
    const stored = Array.isArray(all[paris.id]) ? all[paris.id].slice() : [];
    let catsChanged = false;
    if (!stored.includes(SUB_TRAIN)) { stored.push(SUB_TRAIN); catsChanged = true; }
    if (!stored.includes(SUB_QUAI))  { stored.push(SUB_QUAI);  catsChanged = true; }
    if (catsChanged) saveSubcategoriesForGare(paris.id, stored);

    // Reclasser les scénarios "Colis suspect" de Paris-Nord
    const scs = getSavedScenarios();
    let touched = 0;
    scs.forEach(s => {
      if (s.gareId !== paris.id) return;
      if (normalizeSubcat(s) !== 'Colis suspect') return;
      const name = (s.name || '').trim();
      // "voie 3", "voie 5", "Voie3", etc. → à bord d'un train
      if (/^voie\b/i.test(name) || /^voie\s*\d/i.test(name)) {
        s.subcategory = SUB_TRAIN;
        touched++;
      // "bagage oublié …" → à quai (tolère é/e/è et espaces multiples)
      } else if (/^bagage\s+oubli[éeè]/i.test(name)) {
        s.subcategory = SUB_QUAI;
        touched++;
      }
    });
    if (touched > 0) saveScenariosList(scs);

    // Poser le flag pour ne plus rejouer la migration
    Store.set('eic_migration_paris_bagage_v1', true);
    console.log('Migration Paris bagage v1 : ' + touched + ' scénario(s) reclassé(s).');
  }

  function getSavedScenarios() {
    return Store.getJSON('eic_scenarios', []) || [];
  }

  function saveScenariosList(list) {
    Store.set('eic_scenarios', list);
  }

  // Catégorie d'un scénario (rétro-compat : absence → 'colis-suspect' par défaut,
  // puisque c'est la seule catégorie disponible aujourd'hui)
  function scenarioCategory(sc) {
    return sc.category || 'colis-suspect';
  }

  // Nom de sous-catégorie affichable pour un scénario (migration douce des legacy)
  function normalizeSubcat(sc) {
    if (sc.subcategory) return sc.subcategory;
    if (sc.category === 'colis-suspect' || !sc.category) return 'Colis suspect';
    return sc.category;
  }

  // Sous-catégories configurées + celles présentes dans les scénarios (fusion sans doublons)
  function getSubcategoriesForGare(gareId) {
    const all = Store.getJSON('eic_subcategories', {}) || {};
    const stored = Array.isArray(all[gareId]) ? all[gareId].slice() : [];
    const scs = getSavedScenarios().filter(s => s.gareId === gareId);
    const fromData = [];
    scs.forEach(s => {
      const n = normalizeSubcat(s);
      if (n && !fromData.includes(n)) fromData.push(n);
    });
    const merged = [];
    stored.concat(fromData).forEach(n => { if (n && !merged.includes(n)) merged.push(n); });
    // Garantir au moins la sous-cat par défaut si la gare a des scénarios legacy
    if (merged.length === 0 && scs.length > 0) merged.push('Colis suspect');
    return merged;
  }

  function saveSubcategoriesForGare(gareId, list) {
    const all = Store.getJSON('eic_subcategories', {}) || {};
    all[gareId] = list.slice();
    Store.set('eic_subcategories', all);
  }

  function countScenariosForGareSubcat(gareId, subcat) {
    return getSavedScenarios().filter(s => s.gareId === gareId && normalizeSubcat(s) === subcat).length;
  }

  function renameSubcategory(gareId, oldName, newName) {
    if (!newName || oldName === newName) return;
    // Mettre à jour la liste configurée
    const list = getSubcategoriesForGare(gareId).map(n => n === oldName ? newName : n);
    // Dédupliquer si fusion
    const dedup = [];
    list.forEach(n => { if (!dedup.includes(n)) dedup.push(n); });
    saveSubcategoriesForGare(gareId, dedup);
    // Cascade sur les scénarios
    const scs = getSavedScenarios();
    let touched = false;
    scs.forEach(s => {
      if (s.gareId === gareId && normalizeSubcat(s) === oldName) {
        s.subcategory = newName;
        touched = true;
      }
    });
    if (touched) saveScenariosList(scs);
  }

  function deleteSubcategory(gareId, name) {
    const scsCount = countScenariosForGareSubcat(gareId, name);
    if (scsCount > 0) {
      if (!confirm('Supprimer la sous-catégorie "' + name + '" ET ses ' + scsCount + ' scénario' + (scsCount > 1 ? 's' : '') + ' ?')) return false;
    } else {
      if (!confirm('Supprimer la sous-catégorie "' + name + '" ?')) return false;
    }
    // Supprimer de la liste
    const list = getSubcategoriesForGare(gareId).filter(n => n !== name);
    saveSubcategoriesForGare(gareId, list);
    // Supprimer les scénarios associés
    const scs = getSavedScenarios().filter(s => !(s.gareId === gareId && normalizeSubcat(s) === name));
    saveScenariosList(scs);
    return true;
  }

  function addSubcategory(gareId, name) {
    name = (name || '').trim();
    if (!name) return false;
    const list = getSubcategoriesForGare(gareId);
    if (list.includes(name)) { alert('Cette sous-catégorie existe déjà.'); return false; }
    list.push(name);
    saveSubcategoriesForGare(gareId, list);
    return true;
  }

  // Popup principal : tableau des gares avec compteur de scénarios "Colis suspect"
  function openScenariosPopup() {
    if (scenariosPopup) { closeScenariosPopup(); return; }
    const popup = document.createElement('div');
    popup.id = 'scenarios-popup';
    popup.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:500;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.7);width:420px;max-width:92vw;font-family:var(--mono);display:flex;flex-direction:column;max-height:80vh;';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;';
    const title = document.createElement('div');
    title.style.cssText = 'flex:1;';
    const titleSm = document.createElement('div');
    titleSm.style.cssText = 'font-size:10px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;';
    titleSm.textContent = 'Scénarios';
    const titleLg = document.createElement('div');
    titleLg.style.cssText = 'font-size:14px;color:var(--text);font-weight:600;margin-top:2px;';
    titleLg.textContent = 'Colis suspect';
    title.appendChild(titleSm);
    title.appendChild(titleLg);
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:var(--muted);font-size:16px;cursor:pointer;padding:0 4px;';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeScenariosPopup);
    header.appendChild(title);
    header.appendChild(closeBtn);
    popup.appendChild(header);

    // Corps : tableau des gares
    const body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;flex:1;';
    popup.appendChild(body);

    function renderTable() {
      body.textContent = '';
      const scenarios = getSavedScenarios();
      const countByGare = {};
      const orphans = [];
      scenarios.forEach(sc => {
        if (sc.gareId) {
          countByGare[sc.gareId] = (countByGare[sc.gareId] || 0) + 1;
        } else {
          orphans.push(sc);
        }
      });

      // Filtre temporaire : n'afficher que Paris-Nord pour le moment
      // (la liste complète des gares EIC sera réintroduite quand d'autres scénarios seront créés)
      const allGares = (typeof Data !== 'undefined' && Data.getGares) ? Data.getGares() : [];
      const gares = allGares.filter(g => /paris[\s\-]?nord/i.test(g.nom || ''));
      gares.sort((a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr'));

      if (gares.length === 0 && orphans.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:20px;text-align:center;color:var(--muted);font-size:11px;';
        empty.textContent = 'Aucune gare disponible';
        body.appendChild(empty);
        return;
      }

      gares.forEach(g => {
        const n = countByGare[g.id] || 0;
        const row = document.createElement('div');
        row.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;';
        row.addEventListener('mouseenter', () => row.style.background = 'var(--surface2)');
        row.addEventListener('mouseleave', () => row.style.background = '');
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'flex:1;color:var(--text);font-weight:' + (n > 0 ? '600' : '400') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        nameEl.textContent = g.nom;
        const countEl = document.createElement('div');
        countEl.style.cssText = 'color:' + (n > 0 ? 'var(--accent2)' : 'var(--muted)') + ';font-size:11px;';
        countEl.textContent = n > 0 ? (n + ' scénario' + (n > 1 ? 's' : '')) : '—';
        const arrow = document.createElement('div');
        arrow.style.cssText = 'color:var(--muted);font-size:11px;';
        arrow.textContent = '▸';
        row.appendChild(nameEl);
        row.appendChild(countEl);
        row.appendChild(arrow);
        row.addEventListener('click', () => openGareCategoriesPopup(g));
        body.appendChild(row);
      });

      // Section "Non classés" (rétro-compat pour les anciens scénarios sans gareId)
      if (orphans.length > 0) {
        const orphanRow = document.createElement('div');
        orphanRow.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;background:rgba(255,255,255,0.02);';
        orphanRow.addEventListener('mouseenter', () => orphanRow.style.background = 'var(--surface2)');
        orphanRow.addEventListener('mouseleave', () => orphanRow.style.background = 'rgba(255,255,255,0.02)');
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'flex:1;color:var(--muted);font-style:italic;';
        nameEl.textContent = 'Non classés';
        const countEl = document.createElement('div');
        countEl.style.cssText = 'color:var(--muted);font-size:11px;';
        countEl.textContent = orphans.length + ' scénario' + (orphans.length > 1 ? 's' : '');
        const arrow = document.createElement('div');
        arrow.style.cssText = 'color:var(--muted);font-size:11px;';
        arrow.textContent = '▸';
        orphanRow.appendChild(nameEl);
        orphanRow.appendChild(countEl);
        orphanRow.appendChild(arrow);
        orphanRow.addEventListener('click', () => openGareScenariosPopup({ id: '__orphans__', nom: 'Non classés' }, null));
        body.appendChild(orphanRow);
      }
    }

    document.body.appendChild(popup);
    scenariosPopup = popup;
    scenariosPopup._render = renderTable;
    renderTable();
  }

  // Popup intermédiaire : sous-catégories d'une gare (Colis suspect, …)
  function openGareCategoriesPopup(gare) {
    if (gareCategoriesPopup) closeGareCategoriesPopup();
    const popup = document.createElement('div');
    popup.id = 'gare-categories-popup';
    popup.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:540;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.7);width:440px;max-width:92vw;font-family:var(--mono);display:flex;flex-direction:column;max-height:80vh;';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;';
    const backBtn = document.createElement('button');
    backBtn.style.cssText = 'background:none;border:none;color:var(--muted);font-size:16px;cursor:pointer;padding:0 4px;';
    backBtn.textContent = '◂';
    backBtn.title = 'Retour';
    backBtn.addEventListener('click', closeGareCategoriesPopup);
    const title = document.createElement('div');
    title.style.cssText = 'flex:1;';
    const titleSm = document.createElement('div');
    titleSm.style.cssText = 'font-size:10px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;';
    titleSm.textContent = 'Sous-catégories';
    const titleLg = document.createElement('div');
    titleLg.style.cssText = 'font-size:14px;color:var(--text);font-weight:600;margin-top:2px;';
    titleLg.textContent = gare.nom;
    title.appendChild(titleSm);
    title.appendChild(titleLg);
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:var(--muted);font-size:16px;cursor:pointer;padding:0 4px;';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => { closeGareCategoriesPopup(); closeScenariosPopup(); });
    header.appendChild(backBtn);
    header.appendChild(title);
    header.appendChild(closeBtn);
    popup.appendChild(header);

    // Liste
    const listSection = document.createElement('div');
    listSection.style.cssText = 'overflow-y:auto;flex:1;';
    popup.appendChild(listSection);

    function renderList() {
      listSection.textContent = '';
      const cats = getSubcategoriesForGare(gare.id);
      if (cats.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:20px;text-align:center;color:var(--muted);font-size:11px;';
        empty.textContent = 'Aucune sous-catégorie. Crée-en une ci-dessous.';
        listSection.appendChild(empty);
        return;
      }
      cats.forEach(name => {
        const n = countScenariosForGareSubcat(gare.id, name);
        const row = document.createElement('div');
        row.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;';
        row.addEventListener('mouseenter', () => row.style.background = 'var(--surface2)');
        row.addEventListener('mouseleave', () => row.style.background = '');
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'flex:1;color:var(--text);font-weight:' + (n > 0 ? '600' : '400') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        nameEl.textContent = name;
        const countEl = document.createElement('div');
        countEl.style.cssText = 'color:' + (n > 0 ? 'var(--accent2)' : 'var(--muted)') + ';font-size:11px;';
        countEl.textContent = n > 0 ? (n + ' scénario' + (n > 1 ? 's' : '')) : '—';

        const renameBtn = document.createElement('button');
        renameBtn.textContent = '✎';
        renameBtn.title = 'Renommer';
        renameBtn.style.cssText = 'padding:3px 7px;background:none;border:1px solid var(--accent2);border-radius:3px;color:var(--accent2);font-family:inherit;font-size:10px;cursor:pointer;';
        renameBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const nv = prompt('Nouveau nom de la sous-catégorie :', name);
          if (nv == null) return;
          const trimmed = nv.trim();
          if (!trimmed || trimmed === name) return;
          renameSubcategory(gare.id, name, trimmed);
          renderList();
        });

        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.title = 'Supprimer';
        delBtn.style.cssText = 'padding:3px 7px;background:none;border:1px solid #ff4040;border-radius:3px;color:#ff4040;font-family:inherit;font-size:10px;cursor:pointer;';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (deleteSubcategory(gare.id, name)) renderList();
        });

        const arrow = document.createElement('div');
        arrow.style.cssText = 'color:var(--muted);font-size:11px;';
        arrow.textContent = '▸';

        row.appendChild(nameEl);
        row.appendChild(countEl);
        row.appendChild(renameBtn);
        row.appendChild(delBtn);
        row.appendChild(arrow);
        row.addEventListener('click', () => openGareScenariosPopup(gare, name));
        listSection.appendChild(row);
      });
    }

    // Footer : ajouter une sous-catégorie
    const addSection = document.createElement('div');
    addSection.style.cssText = 'padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;background:var(--surface2);';
    const newInput = document.createElement('input');
    newInput.type = 'text';
    newInput.placeholder = 'Nouvelle sous-catégorie…';
    newInput.style.cssText = 'flex:1;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:11px;outline:none;';
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Ajouter';
    addBtn.style.cssText = 'padding:6px 12px;background:var(--accent2);color:#000;border:none;border-radius:4px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;';
    function doAdd() {
      if (addSubcategory(gare.id, newInput.value)) { newInput.value = ''; renderList(); }
    }
    addBtn.addEventListener('click', doAdd);
    newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
    addSection.appendChild(newInput);
    addSection.appendChild(addBtn);
    popup.appendChild(addSection);

    document.body.appendChild(popup);
    gareCategoriesPopup = popup;
    gareCategoriesPopup._render = renderList;
    gareCategoriesPopup._gare = gare;
    renderList();
  }

  function closeGareCategoriesPopup() {
    if (gareCategoriesPopup) { gareCategoriesPopup.remove(); gareCategoriesPopup = null; }
    if (scenariosPopup && scenariosPopup._render) scenariosPopup._render();
  }

  // Popup secondaire : scénarios d'une gare donnée + sauvegarde de la scène
  function openGareScenariosPopup(gare, subcat) {
    if (gareScenariosPopup) closeGareScenariosPopup();
    const isOrphans = gare.id === '__orphans__';
    const popup = document.createElement('div');
    popup.id = 'gare-scenarios-popup';
    popup.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:550;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.7);width:460px;max-width:92vw;font-family:var(--mono);display:flex;flex-direction:column;max-height:80vh;';

    // Header avec retour
    const header = document.createElement('div');
    header.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;';
    const backBtn = document.createElement('button');
    backBtn.style.cssText = 'background:none;border:none;color:var(--muted);font-size:16px;cursor:pointer;padding:0 4px;';
    backBtn.textContent = '◂';
    backBtn.title = 'Retour';
    backBtn.addEventListener('click', closeGareScenariosPopup);
    const title = document.createElement('div');
    title.style.cssText = 'flex:1;';
    const titleSm = document.createElement('div');
    titleSm.style.cssText = 'font-size:10px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;';
    titleSm.textContent = isOrphans ? 'Scénarios' : (subcat || 'Colis suspect');
    const titleLg = document.createElement('div');
    titleLg.style.cssText = 'font-size:14px;color:var(--text);font-weight:600;margin-top:2px;';
    titleLg.textContent = gare.nom;
    title.appendChild(titleSm);
    title.appendChild(titleLg);
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:var(--muted);font-size:16px;cursor:pointer;padding:0 4px;';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => { closeGareScenariosPopup(); closeGareCategoriesPopup(); closeScenariosPopup(); });
    header.appendChild(backBtn);
    header.appendChild(title);
    header.appendChild(closeBtn);
    popup.appendChild(header);

    // Liste des scénarios
    const listSection = document.createElement('div');
    listSection.style.cssText = 'overflow-y:auto;flex:1;';
    popup.appendChild(listSection);

    function renderList() {
      listSection.textContent = '';
      const all = getSavedScenarios();
      const filtered = isOrphans
        ? all.filter(sc => !sc.gareId)
        : all.filter(sc => sc.gareId === gare.id && normalizeSubcat(sc) === subcat);

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:20px;text-align:center;color:var(--muted);font-size:11px;';
        empty.textContent = 'Aucun scénario pour ' + gare.nom;
        listSection.appendChild(empty);
        return;
      }

      filtered.forEach(sc => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:12px;';
        const info = document.createElement('div');
        info.style.cssText = 'flex:1;overflow:hidden;';
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        nameEl.textContent = sc.name;
        const metaEl = document.createElement('div');
        metaEl.style.cssText = 'color:var(--muted);font-size:10px;margin-top:2px;';
        const count = (sc.annotations || []).length;
        const d = sc.createdAt ? new Date(sc.createdAt).toLocaleDateString('fr-FR') : '';
        metaEl.textContent = count + ' annotation' + (count > 1 ? 's' : '') + (d ? ' · ' + d : '');
        info.appendChild(nameEl);
        info.appendChild(metaEl);

        const loadBtn = document.createElement('button');
        loadBtn.textContent = 'Charger';
        loadBtn.style.cssText = 'padding:4px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;color:var(--text);font-family:inherit;font-size:10px;cursor:pointer;';
        loadBtn.addEventListener('click', () => loadScenario(sc));

        const editBtn = document.createElement('button');
        editBtn.textContent = '✎';
        editBtn.title = 'Éditer';
        editBtn.style.cssText = 'padding:4px 8px;background:none;border:1px solid var(--accent2);border-radius:3px;color:var(--accent2);font-family:inherit;font-size:10px;cursor:pointer;';
        editBtn.addEventListener('click', () => enterEditMode(sc));

        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.title = 'Supprimer';
        delBtn.style.cssText = 'padding:4px 8px;background:none;border:1px solid #ff4040;border-radius:3px;color:#ff4040;font-family:inherit;font-size:10px;cursor:pointer;';
        delBtn.addEventListener('click', () => deleteScenario(sc.id));

        row.appendChild(info);
        row.appendChild(loadBtn);
        row.appendChild(editBtn);
        row.appendChild(delBtn);
        listSection.appendChild(row);
      });
    }

    // Footer : enregistrer la scène courante sous cette gare (sauf pour les orphans, lecture seule)
    let nameInput = null;
    if (!isOrphans) {
      const saveSection = document.createElement('div');
      saveSection.style.cssText = 'padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;background:var(--surface2);';
      nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'Nom du scénario à enregistrer…';
      nameInput.style.cssText = 'flex:1;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:11px;outline:none;';
      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'Enregistrer';
      saveBtn.style.cssText = 'padding:6px 12px;background:var(--accent2);color:#000;border:none;border-radius:4px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;';

      function doSave() {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        const annots = (typeof Annotations !== 'undefined' && Annotations.getAnnotations)
          ? Annotations.getAnnotations() : [];
        if (annots.length === 0) {
          if (!confirm('Aucune annotation sur le schéma. Enregistrer un scénario vide ?')) return;
        }
        // Capture la vue courante (zoom + pan) pour la restaurer au chargement
        let view = null;
        try {
          const mv = Viewer.getMainViewer && Viewer.getMainViewer();
          if (mv) {
            const c = mv.viewport.getCenter();
            view = { x: c.x, y: c.y, zoom: mv.viewport.getZoom() };
          }
        } catch {}
        const scenarios = getSavedScenarios();
        scenarios.push({
          id: 'sc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          name: name,
          createdAt: Date.now(),
          category: 'colis-suspect',
          subcategory: subcat || 'Colis suspect',
          gareId: gare.id,
          gareName: gare.nom,
          zoneId: gare.zone_id || null,
          zoneName: gare.nom,
          view: view,
          annotations: JSON.parse(JSON.stringify(annots)),
        });
        saveScenariosList(scenarios);
        nameInput.value = '';
        renderList();
      }

      saveBtn.addEventListener('click', doSave);
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });

      saveSection.appendChild(nameInput);
      saveSection.appendChild(saveBtn);
      popup.appendChild(saveSection);
    }

    document.body.appendChild(popup);
    gareScenariosPopup = popup;
    gareScenariosPopup._render = renderList;
    renderList();
    if (nameInput) setTimeout(() => nameInput.focus(), 50);
  }

  function closeGareScenariosPopup() {
    if (gareScenariosPopup) { gareScenariosPopup.remove(); gareScenariosPopup = null; }
    // Re-rafraîchir les compteurs des popups parents
    if (gareCategoriesPopup && gareCategoriesPopup._render) gareCategoriesPopup._render();
    if (scenariosPopup && scenariosPopup._render) scenariosPopup._render();
  }

  function loadScenario(sc) {
    const annots = sc.annotations || [];
    const stickers = annots.filter(a => a.type === 'image');
    if (stickers.length === 0) {
      // Pas de sticker à paramétrer → chargement direct
      finalizeScenarioLoad(sc, annots, null);
      return;
    }
    // Ouvrir le configurateur de remplacement
    openScenarioConfigurator(sc);
  }

  async function openScenarioConfigurator(sc) {
    closeGareScenariosPopup();
    closeScenariosPopup();
    const annots = sc.annotations || [];
    await Store.ensureKey('eic_stickers'); // clé lourde chargée à la demande
    const library = Store.getJSON('eic_stickers', []) || [];
    // Un "override" par sticker : { srcOverride, labelOverride }
    const overrides = new Map();

    const popup = document.createElement('div');
    popup.id = 'scenario-configurator';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:600;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.7);width:520px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;font-family:var(--mono);';

    const header = document.createElement('div');
    header.style.cssText = 'padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;';
    const title = document.createElement('div');
    title.style.cssText = 'flex:1;';
    const titleLabel = document.createElement('div');
    titleLabel.style.cssText = 'font-size:10px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;';
    titleLabel.textContent = 'Charger le scénario';
    const titleName = document.createElement('div');
    titleName.style.cssText = 'font-size:14px;color:var(--text);font-weight:600;margin-top:2px;';
    titleName.textContent = sc.name;
    title.appendChild(titleLabel);
    title.appendChild(titleName);
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeConfigurator);
    header.appendChild(title);
    header.appendChild(closeBtn);
    popup.appendChild(header);

    const body = document.createElement('div');
    body.style.cssText = 'padding:12px 16px;overflow-y:auto;flex:1;';
    popup.appendChild(body);

    const stickers = annots.filter(a => a.type === 'image');
    if (stickers.length === 0) {
      const msg = document.createElement('div');
      msg.style.cssText = 'color:var(--muted);font-size:11px;padding:8px 0;';
      msg.textContent = 'Aucun sticker à personnaliser.';
      body.appendChild(msg);
    } else {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:var(--muted);font-size:10px;margin-bottom:10px;';
      hint.textContent = stickers.length + ' sticker' + (stickers.length > 1 ? 's' : '') + ' dans ce scénario — position et taille conservées, choisis l\'image et le libellé.';
      body.appendChild(hint);

      stickers.forEach(st => {
        const row = buildStickerRow(st, library, overrides);
        body.appendChild(row);
      });
    }

    const footer = document.createElement('div');
    footer.style.cssText = 'padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;';
    const modeLabel = document.createElement('label');
    modeLabel.style.cssText = 'flex:1;color:var(--muted);font-size:11px;display:flex;align-items:center;gap:6px;cursor:pointer;';
    const modeChk = document.createElement('input');
    modeChk.type = 'checkbox';
    modeChk.checked = true;
    modeLabel.appendChild(modeChk);
    modeLabel.appendChild(document.createTextNode(' Remplacer les annotations actuelles'));
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Annuler';
    cancelBtn.style.cssText = 'padding:7px 14px;background:none;border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:11px;cursor:pointer;';
    cancelBtn.addEventListener('click', closeConfigurator);
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Charger';
    loadBtn.style.cssText = 'padding:7px 16px;background:var(--accent2);color:#000;border:none;border-radius:4px;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;';
    loadBtn.addEventListener('click', () => {
      // Appliquer les overrides sur les copies des annotations
      const modified = annots.map(a => {
        if (a.type !== 'image') return a;
        const ov = overrides.get(a.id);
        if (!ov) return a;
        return Object.assign({}, a, {
          src: ov.src != null ? ov.src : a.src,
          label: ov.label != null ? ov.label : a.label,
        });
      });
      finalizeScenarioLoad(sc, modified, modeChk.checked);
      closeConfigurator();
    });
    footer.appendChild(modeLabel);
    footer.appendChild(cancelBtn);
    footer.appendChild(loadBtn);
    popup.appendChild(footer);

    document.body.appendChild(popup);
    scenarioConfigurator = popup;
  }

  function buildStickerRow(annotation, library, overrides) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px;background:var(--surface2);border-radius:5px;margin-bottom:6px;';

    // Preview original
    const origBox = document.createElement('div');
    origBox.style.cssText = 'display:flex;flex-direction:column;align-items:center;min-width:64px;';
    const origImg = document.createElement('img');
    origImg.src = annotation.src;
    origImg.style.cssText = 'max-height:32px;max-width:56px;object-fit:contain;background:#fff;border-radius:3px;padding:2px;';
    const origLabel = document.createElement('div');
    origLabel.style.cssText = 'font-size:9px;color:var(--muted);margin-top:3px;';
    origLabel.textContent = annotation.label || '(sans nom)';
    origBox.appendChild(origImg);
    origBox.appendChild(origLabel);
    row.appendChild(origBox);

    // Flèche
    const arrow = document.createElement('span');
    arrow.style.cssText = 'color:var(--muted);font-size:14px;';
    arrow.textContent = '→';
    row.appendChild(arrow);

    // Preview destination (par défaut = original)
    const destBox = document.createElement('div');
    destBox.style.cssText = 'display:flex;flex-direction:column;align-items:center;min-width:64px;cursor:pointer;';
    destBox.title = 'Cliquer pour changer le sticker';
    const destImg = document.createElement('img');
    destImg.src = annotation.src;
    destImg.style.cssText = 'max-height:32px;max-width:56px;object-fit:contain;background:#fff;border-radius:3px;padding:2px;border:2px dashed var(--accent2);';
    const destLabel = document.createElement('div');
    destLabel.style.cssText = 'font-size:9px;color:var(--accent2);margin-top:3px;';
    destLabel.textContent = 'cliquer';
    destBox.appendChild(destImg);
    destBox.appendChild(destLabel);
    destBox.addEventListener('click', (e) => {
      e.stopPropagation();
      openStickerPickerInline(destBox, library, (chosen) => {
        const cur = overrides.get(annotation.id) || {};
        overrides.set(annotation.id, Object.assign(cur, { src: chosen.imageSrc, label: chosen.name }));
        destImg.src = chosen.imageSrc;
        destLabel.textContent = chosen.name;
        destLabel.style.color = 'var(--text)';
        destImg.style.border = '2px solid var(--accent2)';
        // Pré-remplir l'input libellé aussi
        if (labelInput.value === (annotation.label || '')) labelInput.value = chosen.name;
      });
    });
    row.appendChild(destBox);

    // Champ libellé
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Libellé (ex: 67432)';
    labelInput.value = annotation.label || '';
    labelInput.style.cssText = 'flex:1;padding:5px 8px;background:var(--surface);border:1px solid var(--border);border-radius:3px;color:var(--text);font-family:inherit;font-size:11px;outline:none;';
    labelInput.addEventListener('input', () => {
      const cur = overrides.get(annotation.id) || {};
      overrides.set(annotation.id, Object.assign(cur, { label: labelInput.value }));
    });
    row.appendChild(labelInput);

    return row;
  }

  // Charge la bibliothèque d'images (avec support chunked) et les catégories
  function loadStickerLibrary() {
    let library = Store.getJSON('eic_image_library', []);
    if (library && library.chunks) {
      let all = [];
      for (let i = 0; i < library.chunks; i++) {
        all = all.concat(Store.getJSON('eic_image_library_' + i, []) || []);
      }
      library = all;
    }
    if (!Array.isArray(library)) library = [];
    const categories = Store.getJSON('eic_sticker_categories', []) || [];
    return { library, categories };
  }

  async function openStickerPickerInline(anchor, _legacy, onChoose) {
    const existing = document.getElementById('sticker-picker-inline');
    if (existing) existing.remove();

    await Store.ensureKey('eic_image_library'); // palette chargée à la demande
    const { library, categories } = loadStickerLibrary();
    if (library.length === 0) {
      alert('Aucun sticker disponible. Va dans Paramètres > Stickers pour en créer.');
      return;
    }

    const menu = document.createElement('div');
    menu.id = 'sticker-picker-inline';
    menu.style.cssText = 'position:fixed;z-index:650;background:var(--surface);border:1px solid var(--accent2);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.7);max-height:440px;overflow-y:auto;width:280px;padding:6px;';
    const rect = anchor.getBoundingClientRect();
    menu.style.left = Math.min(window.innerWidth - 290, rect.left) + 'px';
    menu.style.top = Math.min(window.innerHeight - 450, rect.bottom + 4) + 'px';

    // Barre de recherche en haut
    const searchEl = document.createElement('input');
    searchEl.type = 'text';
    searchEl.placeholder = 'Rechercher un sticker…';
    searchEl.style.cssText = 'width:100%;padding:5px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;margin-bottom:6px;box-sizing:border-box;';
    menu.appendChild(searchEl);

    const listEl = document.createElement('div');
    menu.appendChild(listEl);

    function chooseAndClose(img) {
      menu.remove();
      onChoose({ imageSrc: img.dataUrl, name: img.name });
    }

    function render(query) {
      listEl.textContent = '';
      const q = (query || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

      if (categories.length === 0) {
        // Aucune catégorie configurée → liste plate
        const matches = library.filter(i => !q || (i.name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q));
        if (matches.length === 0) { showEmpty(); return; }
        listEl.appendChild(buildImageGrid(matches));
        return;
      }

      // Mode catégorisé — parcours récursif
      let anyShown = false;
      categories.forEach(cat => {
        const section = buildCategorySection(cat, q, chooseAndClose);
        if (section) { listEl.appendChild(section); anyShown = true; }
      });
      if (!anyShown) showEmpty();
    }

    function showEmpty() {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:10px;text-align:center;color:var(--muted);font-size:10px;';
      empty.textContent = 'Aucun résultat';
      listEl.appendChild(empty);
    }

    // Rend les images d'une catégorie (et filtrage par query)
    function buildImageGrid(imgs) {
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:4px 2px;';
      imgs.forEach(img => {
        const card = document.createElement('div');
        card.style.cssText = 'background:#fff;border:1px solid var(--border);border-radius:3px;padding:3px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;transition:border-color 0.1s;';
        card.title = img.name;
        card.addEventListener('mouseenter', () => card.style.borderColor = 'var(--accent2)');
        card.addEventListener('mouseleave', () => card.style.borderColor = 'var(--border)');
        card.addEventListener('click', () => chooseAndClose(img));
        const imgEl = document.createElement('img');
        imgEl.src = img.dataUrl;
        imgEl.style.cssText = 'max-height:32px;max-width:100%;object-fit:contain;pointer-events:none;';
        card.appendChild(imgEl);
        const nameEl = document.createElement('span');
        nameEl.style.cssText = 'font-family:var(--mono);font-size:8px;color:#333;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;pointer-events:none;';
        nameEl.textContent = img.name;
        card.appendChild(nameEl);
        grid.appendChild(card);
      });
      return grid;
    }

    function buildCategorySection(cat, query, onChooseCb) {
      // Collecte récursive de toutes les images de cette catégorie + descendants
      function collectImages(c) {
        let all = [];
        if (c.images) {
          c.images.forEach(n => {
            const img = library.find(i => i.name === n);
            if (img) all.push(img);
          });
        }
        if (c.children) c.children.forEach(ch => { all = all.concat(collectImages(ch)); });
        return all;
      }
      const all = collectImages(cat);
      const q = query || '';
      const matches = q
        ? all.filter(i => (i.name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q))
        : all;
      if (matches.length === 0) return null;

      const section = document.createElement('div');
      section.style.cssText = 'margin-bottom:4px;';

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 6px;background:var(--surface2);border-radius:3px;cursor:pointer;user-select:none;';
      const arrow = document.createElement('span');
      arrow.style.cssText = 'font-size:9px;color:var(--muted);width:10px;';
      const isOpen = !!q; // Ouvrir par défaut si recherche active
      arrow.textContent = isOpen ? '▾' : '▸';
      const titleEl = document.createElement('span');
      titleEl.style.cssText = 'flex:1;font-family:var(--mono);font-size:10px;color:var(--text);';
      titleEl.textContent = cat.nom;
      const countEl = document.createElement('span');
      countEl.style.cssText = 'font-size:9px;color:var(--muted);';
      countEl.textContent = matches.length;
      header.appendChild(arrow);
      header.appendChild(titleEl);
      header.appendChild(countEl);
      section.appendChild(header);

      const body = document.createElement('div');
      body.style.display = isOpen ? 'block' : 'none';
      body.appendChild(buildImageGrid(matches));
      section.appendChild(body);

      header.addEventListener('click', () => {
        const open = body.style.display === 'none';
        body.style.display = open ? 'block' : 'none';
        arrow.textContent = open ? '▾' : '▸';
      });

      return section;
    }

    searchEl.addEventListener('input', () => render(searchEl.value));
    render('');

    document.body.appendChild(menu);
    setTimeout(() => searchEl.focus(), 50);
    const closeHandler = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeHandler, true), 50);
  }

  let scenarioConfigurator = null;
  function closeConfigurator() {
    if (scenarioConfigurator) { scenarioConfigurator.remove(); scenarioConfigurator = null; }
  }

  function finalizeScenarioLoad(sc, annots, replaceMode) {
    // replaceMode : true = Annotations.clear() avant ; false = add ; null = toujours remplacer
    const mode = replaceMode === null ? true : replaceMode;
    if (mode) Annotations.clear();
    if (sc.zoneId && typeof Viewer !== 'undefined' && Viewer.showZone) {
      try { Viewer.showZone(sc.zoneId); } catch {}
    }
    // Restaurer la vue exacte (zoom + pan) après switch de zone
    if (sc.view) {
      try {
        const mv = Viewer.getMainViewer && Viewer.getMainViewer();
        if (mv && typeof OpenSeadragon !== 'undefined') {
          // Léger délai pour laisser showZone finir son animation
          setTimeout(() => {
            mv.viewport.panTo(new OpenSeadragon.Point(sc.view.x, sc.view.y), true);
            mv.viewport.zoomTo(sc.view.zoom, null, true);
          }, 50);
        }
      } catch {}
    }
    if (Annotations.addRaw) {
      Annotations.addRaw(annots);
    }
    closeGareScenariosPopup();
    closeScenariosPopup();
  }

  function deleteScenario(id) {
    if (!confirm('Supprimer ce scénario ?')) return;
    const scenarios = getSavedScenarios().filter(s => s.id !== id);
    saveScenariosList(scenarios);
    // Rafraîchir le popup actuellement ouvert
    if (gareScenariosPopup && gareScenariosPopup._render) {
      gareScenariosPopup._render();
    } else if (scenariosPopup && scenariosPopup._render) {
      scenariosPopup._render();
    }
  }

  // === ÉDITION D'UN SCÉNARIO ===
  let scenarioEditBar = null;

  function enterEditMode(sc) {
    // Ferme l'éventuelle barre précédente
    closeEditBar();
    // Charge le scénario tel quel (remplace les annotations actuelles), sans configurateur
    finalizeScenarioLoad(sc, sc.annotations || [], true);
    // Affiche la barre d'édition flottante
    openEditBar(sc);
  }

  function openEditBar(sc) {
    const bar = document.createElement('div');
    bar.id = 'scenario-edit-bar';
    bar.style.cssText = 'position:fixed;top:60px;right:20px;z-index:700;background:var(--surface);border:1px solid var(--accent2);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.7);padding:10px 12px;font-family:var(--mono);display:flex;flex-direction:column;gap:8px;min-width:320px;max-width:92vw;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    const labelSm = document.createElement('div');
    labelSm.style.cssText = 'font-size:10px;color:var(--accent2);letter-spacing:1px;text-transform:uppercase;';
    labelSm.textContent = 'Édition du scénario';
    const labelLg = document.createElement('div');
    labelLg.style.cssText = 'font-size:11px;color:var(--muted);';
    labelLg.textContent = sc.gareName ? ('Gare : ' + sc.gareName) : '';
    header.appendChild(labelSm);
    if (sc.gareName) header.appendChild(labelLg);
    bar.appendChild(header);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = sc.name || '';
    nameInput.placeholder = 'Nom du scénario';
    nameInput.style.cssText = 'padding:6px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:11px;outline:none;';
    bar.appendChild(nameInput);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10px;color:var(--muted);line-height:1.4;';
    hint.textContent = 'Modifie la vue (zoom/pan) et les annotations sur le schéma, puis enregistre.';
    bar.appendChild(hint);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Annuler';
    cancelBtn.style.cssText = 'padding:6px 12px;background:none;border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:11px;cursor:pointer;';
    cancelBtn.addEventListener('click', closeEditBar);
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Enregistrer les modifications';
    saveBtn.style.cssText = 'padding:6px 12px;background:var(--accent2);color:#000;border:none;border-radius:4px;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;';
    saveBtn.addEventListener('click', () => saveScenarioEdits(sc.id, nameInput.value));
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    bar.appendChild(btnRow);

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveScenarioEdits(sc.id, nameInput.value); }
      if (e.key === 'Escape') { e.preventDefault(); closeEditBar(); }
    });

    document.body.appendChild(bar);
    scenarioEditBar = bar;
    setTimeout(() => nameInput.focus(), 50);
  }

  function closeEditBar() {
    if (scenarioEditBar) { scenarioEditBar.remove(); scenarioEditBar = null; }
  }

  function saveScenarioEdits(id, newName) {
    const name = (newName || '').trim();
    if (!name) { alert('Le nom ne peut pas être vide.'); return; }
    const scenarios = getSavedScenarios();
    const idx = scenarios.findIndex(s => s.id === id);
    if (idx === -1) { alert('Scénario introuvable.'); closeEditBar(); return; }

    // Capture vue et annotations actuelles
    const annots = (typeof Annotations !== 'undefined' && Annotations.getAnnotations)
      ? Annotations.getAnnotations() : [];
    let view = scenarios[idx].view || null;
    try {
      const mv = Viewer.getMainViewer && Viewer.getMainViewer();
      if (mv) {
        const c = mv.viewport.getCenter();
        view = { x: c.x, y: c.y, zoom: mv.viewport.getZoom() };
      }
    } catch {}

    scenarios[idx] = Object.assign({}, scenarios[idx], {
      name: name,
      view: view,
      annotations: JSON.parse(JSON.stringify(annots)),
      updatedAt: Date.now(),
    });
    saveScenariosList(scenarios);
    closeEditBar();
  }

  function closeScenariosPopup() {
    if (scenariosPopup) { scenariosPopup.remove(); scenariosPopup = null; }
  }

  function setupSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const btn = document.getElementById('sidebar-toggle');
    if (!sidebar || !btn) return;

    // Restaurer l'état
    if (localStorage.getItem('eic_sidebar_minimized') === '1') {
      sidebar.classList.add('minimized');
      btn.textContent = '▸';
    }

    btn.addEventListener('click', () => {
      const minimized = sidebar.classList.toggle('minimized');
      btn.textContent = minimized ? '▸' : '◂';
      localStorage.setItem('eic_sidebar_minimized', minimized ? '1' : '0');
    });
  }

  function setupBarResize() {
    const handle = document.getElementById('sectors-resize-handle');
    const toggleBtn = document.getElementById('sectors-toggle');
    const bar = document.getElementById('sectors-bar');
    const content = document.getElementById('sectors-content');
    const tabs = document.getElementById('sectors-tabs');
    if (!handle || !content || !bar) return;

    // Restaurer la hauteur sauvegardée
    const saved = localStorage.getItem('eic_bar_height');
    if (saved) {
      const h = parseInt(saved, 10);
      if (h >= 40 && h <= 500) {
        content.style.maxHeight = h + 'px';
        if (tabs) tabs.style.maxHeight = h + 'px';
      }
    }

    // Restaurer l'état réduit
    if (localStorage.getItem('eic_bar_minimized') === '1') {
      bar.classList.add('minimized');
      if (toggleBtn) toggleBtn.textContent = '▴';
    }

    // Toggle réduire / agrandir
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const minimized = bar.classList.toggle('minimized');
        toggleBtn.textContent = minimized ? '▴' : '▾';
        localStorage.setItem('eic_bar_minimized', minimized ? '1' : '0');
      });
    }

    // Drag resize
    let startY = 0;
    let startH = 0;

    handle.addEventListener('mousedown', (e) => {
      if (bar.classList.contains('minimized')) return;
      e.preventDefault();
      startY = e.clientY;
      startH = content.offsetHeight;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', onDragEnd);
    });

    function onDrag(e) {
      const delta = startY - e.clientY;
      const newH = Math.max(40, Math.min(500, startH + delta));
      content.style.maxHeight = newH + 'px';
      if (tabs) tabs.style.maxHeight = newH + 'px';
    }

    function onDragEnd() {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', onDragEnd);
      localStorage.setItem('eic_bar_height', parseInt(content.style.maxHeight, 10));
    }
  }

  // === SECTEURS CUSTOM ===
  let customZones = [];

  function loadCustomZones() {
    customZones = Store.getJSON('eic_custom_zones', []);
  }

  function saveCustomZones() {
    Store.set('eic_custom_zones', customZones);
  }

  // === LAYOUT : TABLES > LIGNES > SECTEURS ===
  // Un secteur peut apparaître dans plusieurs lignes / tables

  const DEFAULT_TABLES = [
    { id: 'table-centre', nom: 'Table Centre', defaultLines: [
      { id: 'L272000', nom: 'L272000 Paris-Nord → Lille' },
      { id: 'L330000', nom: 'L330000 St-Denis → Dieppe' },
      { id: 'L242000', nom: 'L242000 Creil → Jeumont' },
    ]},
    { id: 'table-ouest', nom: 'Table Ouest', defaultLines: [] },
    { id: 'table-parc', nom: 'Table PARC', defaultLines: [] },
  ];

  // layout = { tables: [ { id, nom, lines: [ { id, nom, zoneIds: [] } ] } ] }
  let layout = null;

  function loadLayout() {
    // Test que localStorage fonctionne
    try {
      localStorage.setItem('eic_test', '1');
      const ok = localStorage.getItem('eic_test') === '1';
      localStorage.removeItem('eic_test');
      if (!ok) {
        console.error('localStorage ne fonctionne pas !');
        showStorageWarning();
      }
    } catch (e) {
      console.error('localStorage bloqué :', e);
      showStorageWarning();
    }

    const parsed = Store.getJSON('eic_zone_layout', null);
    if (parsed && Array.isArray(parsed.tables)) {
      layout = parsed;
    } else if (parsed && Array.isArray(parsed.groups)) {
      // Migration ancien format
      layout = {
        tables: parsed.groups.map(g => ({
          id: g.id, nom: g.nom,
          lines: (g.zoneIds && g.zoneIds.length > 0)
            ? [{ id: g.id + '-gen', nom: 'Général', zoneIds: g.zoneIds }]
            : [],
        })),
      };
      saveLayout();
    }

    if (!layout) {
      layout = {
        tables: DEFAULT_TABLES.map(t => ({
          id: t.id, nom: t.nom,
          lines: t.defaultLines.map(l => ({ id: l.id, nom: l.nom, zoneIds: [] })),
        })),
      };
      saveLayout();
    }
  }

  function showStorageWarning() {
    setTimeout(() => {
      const msg = document.createElement('div');
      msg.style.cssText = `position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:9999;
        background:rgba(255,64,64,0.95);color:#fff;font-family:'JetBrains Mono',monospace;
        font-size:12px;padding:10px 20px;border-radius:6px;max-width:500px;text-align:center;`;
      msg.innerHTML = 'Le stockage local ne fonctionne pas.<br>Vos modifications ne seront pas sauvegardées.<br>Lancez l\'app via un serveur HTTP (pas en file://)';
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 10000);
    }, 1000);
  }

  function saveLayout() {
    Store.set('eic_zone_layout', layout);
  }

  /**
   * Obtenir toutes les zones (data + custom), indexées par id
   * Applique les overrides (renommages) sauvegardés
   */
  function getAllZonesMap() {
    return Data.getAllDessertes();
  }

  /** IDs des zones placées dans au moins une ligne */
  function getAssignedZoneIds() {
    const set = new Set();
    layout.tables.forEach(t => t.lines.forEach(l => l.zoneIds.forEach(id => set.add(id))));
    return set;
  }

  // === ZONES MASQUÉES ===

  function addHiddenZone(zoneId) {
    const h = Data.getHiddenZones();
    if (!h.includes(zoneId)) {
      h.push(zoneId);
      Store.set('eic_hidden_zones', h);
    }
  }
  function removeHiddenZone(zoneId) {
    Store.set('eic_hidden_zones', Data.getHiddenZones().filter(id => id !== zoneId));
  }

  // === HELPERS : trouver une ligne par id ===

  function findLine(lineId) {
    for (const t of layout.tables) {
      for (const l of t.lines) {
        if (l.id === lineId) return { table: t, line: l };
      }
    }
    return null;
  }

  // === MENU + ===

  function showAddMenu() {
    const old = document.getElementById('add-menu');
    if (old) { old.remove(); return; }

    const menu = document.createElement('div');
    menu.id = 'add-menu';
    menu.className = 'add-context-menu';

    [
      ['+ Secteur', () => promptCreateZone()],
      ['+ Table', () => promptCreateTable()],
    ].forEach(([label, fn]) => {
      const item = document.createElement('div');
      item.className = 'add-menu-item';
      item.textContent = label;
      item.addEventListener('click', () => { menu.remove(); fn(); });
      menu.appendChild(item);
    });

    // Restaurer
    const hidden = Data.getHiddenZones();
    if (hidden.length > 0) {
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:var(--border);margin:2px 0;';
      menu.appendChild(sep);
      const opt = document.createElement('div');
      opt.className = 'add-menu-item';
      opt.textContent = 'Restaurer (' + hidden.length + ')';
      opt.addEventListener('click', () => { menu.remove(); showRestoreMenu(); });
      menu.appendChild(opt);
    }

    // Séparateur + Export/Import
    const sep2 = document.createElement('div');
    sep2.style.cssText = 'height:1px;background:var(--border);margin:2px 0;';
    menu.appendChild(sep2);

    const exportBtn = document.createElement('div');
    exportBtn.className = 'add-menu-item';
    exportBtn.textContent = 'Exporter config';
    exportBtn.addEventListener('click', () => { menu.remove(); exportConfig(); });
    menu.appendChild(exportBtn);

    const importBtn = document.createElement('div');
    importBtn.className = 'add-menu-item';
    importBtn.textContent = 'Importer config';
    importBtn.addEventListener('click', () => { menu.remove(); importConfig(); });
    menu.appendChild(importBtn);

    positionMenu(menu);
  }

  function positionMenu(menu) {
    const btn = document.getElementById('btn-add-zone');
    const rect = btn.getBoundingClientRect();
    // Positionner au-dessus du bouton +
    menu.style.position = 'fixed';
    menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    menu.style.right = '8px';
    document.body.appendChild(menu);
    const close = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== btn) {
        menu.remove(); document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  function showRestoreMenu() {
    const old = document.getElementById('restore-menu');
    if (old) { old.remove(); return; }
    const hidden = Data.getHiddenZones();
    if (hidden.length === 0) return;

    const allDataZones = new Map();
    Data.getZones().forEach(z => allDataZones.set(z.id, z));
    let overrides = {};
    try { overrides = Store.getJSON('eic_zone_overrides', {}); } catch {}

    const menu = document.createElement('div');
    menu.id = 'restore-menu';
    menu.className = 'add-context-menu';

    hidden.forEach(zoneId => {
      const zone = allDataZones.get(zoneId);
      if (!zone) return;
      const name = (overrides[zoneId] && overrides[zoneId].nom) || zone.nom;
      const item = document.createElement('div');
      item.className = 'add-menu-item';
      item.textContent = name;
      item.addEventListener('click', () => {
        removeHiddenZone(zoneId);
        menu.remove();
        loadZonesList();
      });
      menu.appendChild(item);
    });

    if (hidden.length > 1) {
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:var(--border);margin:2px 0;';
      menu.appendChild(sep);
      const all = document.createElement('div');
      all.className = 'add-menu-item';
      all.style.color = 'var(--accent2)';
      all.textContent = 'Tout restaurer';
      all.addEventListener('click', () => {
        Store.set('eic_hidden_zones', []);
        menu.remove(); loadZonesList();
      });
      menu.appendChild(all);
    }
    positionMenu(menu);
  }

  // === CRÉER ===

  function promptCreateTable() {
    const name = prompt('Nom de la nouvelle table :');
    if (!name || !name.trim()) return;
    layout.tables.push({ id: 'table-' + Date.now(), nom: name.trim(), lines: [] });
    saveLayout(); loadZonesList();
  }

  function promptCreateLine(tableId) {
    const name = prompt('Nom de la nouvelle ligne :');
    if (!name || !name.trim()) return;
    const table = layout.tables.find(t => t.id === tableId);
    if (!table) return;
    table.lines.push({ id: 'line-' + Date.now(), nom: name.trim(), zoneIds: [] });
    saveLayout(); loadZonesList();
  }

  function promptCreateZone() {
    const name = prompt('Nom du nouveau secteur :');
    if (!name || !name.trim()) return;
    const newZone = {
      id: 'custom-' + Date.now(), nom: name.trim(),
      gares: [], xMin: 0, xMax: 1, yMin: 0, yMax: 0.20,
    };
    customZones.push(newZone);
    saveCustomZones();
    Viewer.saveCurrentViewForZone(newZone.id);
    loadZonesList();
    selectZone(newZone.id);
  }

  // === ZONE PICKER — ajouter un secteur existant à une ligne ===

  function showZonePicker(lineId, anchorEl) {
    const old = document.getElementById('zone-picker');
    if (old) old.remove();

    const found = findLine(lineId);
    if (!found) return;

    const menu = document.createElement('div');
    menu.id = 'zone-picker';
    menu.className = 'add-context-menu zone-picker-menu';

    const allZones = getAllZonesMap();
    const existing = new Set(found.line.zoneIds);

    // Barre de recherche
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Chercher...';
    searchInput.className = 'zone-picker-search';
    menu.appendChild(searchInput);

    const listDiv = document.createElement('div');
    listDiv.className = 'zone-picker-list';
    menu.appendChild(listDiv);

    function renderPickerList(filter) {
      listDiv.innerHTML = '';
      const q = (filter || '').toLowerCase();
      allZones.forEach((zone, id) => {
        if (q && !zone.nom.toLowerCase().includes(q)) return;
        const item = document.createElement('div');
        item.className = 'add-menu-item';
        if (existing.has(id)) {
          item.style.opacity = '0.35';
          item.style.pointerEvents = 'none';
        }
        item.textContent = zone.nom;
        item.addEventListener('click', () => {
          found.line.zoneIds.push(id);
          saveLayout();
          menu.remove();
          loadZonesList();
        });
        listDiv.appendChild(item);
      });
    }

    searchInput.addEventListener('input', () => renderPickerList(searchInput.value));
    renderPickerList('');

    // Positionner au-dessus de l'ancre
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    menu.style.left = rect.left + 'px';
    menu.style.minWidth = '200px';
    document.body.appendChild(menu);
    searchInput.focus();

    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove(); document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  // === EXPORT / IMPORT CONFIG ===

  const CONFIG_KEYS = [
    'eic_zone_layout',
    'eic_custom_zones',
    'eic_zone_overrides',
    'eic_zone_views',
    'eic_hidden_zones',
    'eic_visible_tables',
    'eic_manual_elements',
    'eic_desserte_pks',
    'eic_bar_height',
    'eic_bar_minimized',
    'eic_sidebar_minimized',
    'eic_pn_prefilled',
    'eic_sectors_prefilled',
  ];

  function exportConfig() {
    const config = {};
    CONFIG_KEYS.forEach(key => {
      const val = Store.get(key);
      if (val !== null) config[key] = val;
    });

    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'eic_config_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function importConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const config = JSON.parse(reader.result);
          if (!config || typeof config !== 'object') throw new Error('Format invalide');

          // Vérifier qu'on a au moins le layout
          if (!config.eic_zone_layout) {
            if (!confirm('Ce fichier ne contient pas de layout. Importer quand même ?')) return;
          }

          const promises = Object.entries(config).map(([key, val]) => {
            const parsed = typeof val === 'string' ? JSON.parse(val) : val;
            return Store.set(key, parsed);
          });
          Promise.all(promises).then(() => location.reload());
        } catch (e) {
          alert('Erreur import : ' + e.message);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  // === TABLES VISIBLES ===

  function getVisibleTableIds() {
    const saved = Store.getJSON('eic_visible_tables', null);
    return saved || layout.tables.map(t => t.id);
  }

  function saveVisibleTableIds(ids) {
    Store.set('eic_visible_tables', ids);
  }

  function isTableVisible(tableId) {
    return getVisibleTableIds().includes(tableId);
  }

  function toggleTableVisibility(tableId) {
    const ids = getVisibleTableIds();
    const idx = ids.indexOf(tableId);
    if (idx >= 0) {
      ids.splice(idx, 1);
    } else {
      ids.push(tableId);
    }
    saveVisibleTableIds(ids);
  }

  // === DRAG & DROP STATE ===
  let dragZoneId = null;
  let dragSourceLineId = null;

  // Table active (affichée dans le contenu)
  let activeTableId = null;

  // === RENDU HORIZONTAL ===

  function loadZonesList() {
    const tabsEl = document.getElementById('sectors-tabs');
    const contentEl = document.getElementById('sectors-content');
    if (!tabsEl || !contentEl) return;
    tabsEl.innerHTML = '';
    contentEl.innerHTML = '';

    const allZones = getAllZonesMap();
    const assigned = getAssignedZoneIds();
    const visibleIds = getVisibleTableIds();
    const visibleTables = layout.tables.filter(t => visibleIds.includes(t.id));
    const hiddenCount = layout.tables.length - visibleTables.length;

    // Si la table active n'est plus visible, basculer sur la première visible
    if (activeTableId && activeTableId !== '__unassigned__' && !visibleIds.includes(activeTableId)) {
      activeTableId = visibleTables[0]?.id || null;
    }
    if (!activeTableId && visibleTables.length > 0) activeTableId = visibleTables[0].id;

    // Bouton gérer les tables (toujours en premier)
    const manageBtn = document.createElement('div');
    manageBtn.className = 'sectors-tab sectors-tab-manage';
    manageBtn.title = 'Choisir les tables affichées';
    manageBtn.textContent = '☰';
    if (hiddenCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'sectors-manage-badge';
      badge.textContent = hiddenCount;
      manageBtn.appendChild(badge);
    }
    manageBtn.addEventListener('click', (e) => { e.stopPropagation(); showTableManager(manageBtn); });
    tabsEl.appendChild(manageBtn);

    // Onglets des tables visibles
    visibleTables.forEach(table => {
      tabsEl.appendChild(renderTableTab(table));
    });

    // Onglet "Non classé"
    const unassigned = [];
    allZones.forEach((_, id) => { if (!assigned.has(id)) unassigned.push(id); });
    if (unassigned.length > 0) {
      const ncTab = document.createElement('div');
      ncTab.className = 'sectors-tab' + (activeTableId === '__unassigned__' ? ' active' : '');
      ncTab.innerHTML = `<span class="sectors-tab-name">Non classé (${unassigned.length})</span>`;
      ncTab.addEventListener('click', () => { activeTableId = '__unassigned__'; loadZonesList(); });
      tabsEl.appendChild(ncTab);
    }

    // Contenu de la table active
    if (activeTableId === '__unassigned__') {
      renderUnassignedContent(contentEl, unassigned, allZones);
    } else {
      const table = layout.tables.find(t => t.id === activeTableId);
      if (table) renderTableContent(contentEl, table, allZones);
    }
  }

  /** Menu pour afficher/masquer les tables */
  function showTableManager(anchorEl) {
    const old = document.getElementById('table-manager');
    if (old) { old.remove(); return; }

    const menu = document.createElement('div');
    menu.id = 'table-manager';
    menu.className = 'add-context-menu';

    const title = document.createElement('div');
    title.style.cssText = 'padding:6px 12px;font-family:var(--mono);font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);';
    title.textContent = 'Tables affichées';
    menu.appendChild(title);

    const visibleIds = getVisibleTableIds();

    layout.tables.forEach(table => {
      const item = document.createElement('div');
      item.className = 'add-menu-item';
      item.style.display = 'flex';
      item.style.alignItems = 'center';
      item.style.gap = '8px';

      const checkbox = document.createElement('span');
      checkbox.style.cssText = 'width:14px;height:14px;border:1px solid var(--border2);border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;';
      const isVisible = visibleIds.includes(table.id);
      if (isVisible) {
        checkbox.textContent = '✓';
        checkbox.style.borderColor = 'var(--accent2)';
        checkbox.style.color = 'var(--accent2)';
      }

      const label = document.createElement('span');
      label.textContent = table.nom;
      label.style.flex = '1';

      item.appendChild(checkbox);
      item.appendChild(label);

      item.addEventListener('click', () => {
        toggleTableVisibility(table.id);
        menu.remove();
        loadZonesList();
      });

      menu.appendChild(item);
    });

    // Tout afficher / tout masquer
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:var(--border);margin:2px 0;';
    menu.appendChild(sep);

    const showAll = document.createElement('div');
    showAll.className = 'add-menu-item';
    showAll.style.color = 'var(--accent2)';
    showAll.textContent = 'Tout afficher';
    showAll.addEventListener('click', () => {
      saveVisibleTableIds(layout.tables.map(t => t.id));
      menu.remove();
      loadZonesList();
    });
    menu.appendChild(showAll);

    // Positionner
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    menu.style.left = rect.left + 'px';
    document.body.appendChild(menu);

    const close = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== anchorEl) {
        menu.remove(); document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  // --- ONGLET TABLE ---

  function renderTableTab(table) {
    const tab = document.createElement('div');
    tab.className = 'sectors-tab' + (activeTableId === table.id ? ' active' : '');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'sectors-tab-name';
    nameSpan.textContent = table.nom;
    tab.appendChild(nameSpan);

    const isFixed = ['table-centre', 'table-ouest', 'table-parc'].includes(table.id);

    const actions = document.createElement('span');
    actions.className = 'sectors-tab-actions';

    const addLineBtn = document.createElement('button');
    addLineBtn.className = 'zone-item-btn';
    addLineBtn.textContent = '+';
    addLineBtn.title = 'Ajouter une ligne';
    addLineBtn.addEventListener('click', (e) => { e.stopPropagation(); promptCreateLine(table.id); });
    actions.appendChild(addLineBtn);

    if (!isFixed) {
      const renameBtn = document.createElement('button');
      renameBtn.className = 'zone-item-btn';
      renameBtn.textContent = '✎';
      renameBtn.title = 'Renommer';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const n = prompt('Nom de la table :', table.nom);
        if (n && n.trim()) { table.nom = n.trim(); saveLayout(); loadZonesList(); }
      });
      actions.appendChild(renameBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'zone-item-btn delete';
      delBtn.textContent = '✕';
      delBtn.title = 'Supprimer la table';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Supprimer "${table.nom}" ?`)) {
          layout.tables = layout.tables.filter(t => t.id !== table.id);
          if (activeTableId === table.id) activeTableId = layout.tables[0]?.id || null;
          saveLayout(); loadZonesList();
        }
      });
      actions.appendChild(delBtn);
    }

    tab.appendChild(actions);

    // Clic → activer
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.sectors-tab-actions')) return;
      activeTableId = table.id;
      loadZonesList();
    });

    // Drop sur l'onglet → ajouter dans la première ligne
    tab.addEventListener('dragover', (e) => { e.preventDefault(); tab.classList.add('drag-over'); });
    tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'));
    tab.addEventListener('drop', (e) => {
      e.preventDefault(); tab.classList.remove('drag-over');
      if (!dragZoneId) return;
      if (table.lines.length === 0) {
        table.lines.push({ id: 'line-' + Date.now(), nom: 'Général', zoneIds: [] });
      }
      if (!table.lines[0].zoneIds.includes(dragZoneId)) {
        removeZoneFromLine(dragZoneId, dragSourceLineId);
        table.lines[0].zoneIds.push(dragZoneId);
        activeTableId = table.id;
        saveLayout(); loadZonesList();
      }
    });

    return tab;
  }

  // --- CONTENU TABLE (lignes + chips) ---

  // Couleurs cycliques pour les lignes
  const LINE_COLORS = 6;

  function renderTableContent(container, table, allZones) {
    table.lines.forEach((line, i) => {
      container.appendChild(renderLineRow(line, table, allZones, i % LINE_COLORS));
    });
  }

  function renderLineRow(line, table, allZones, colorIdx) {
    const visibleCount = line.zoneIds.filter(id => allZones.has(id)).length;

    const wrapper = document.createElement('div');
    wrapper.className = 'sectors-line';
    wrapper.dataset.color = colorIdx;

    // Header cliquable
    const header = document.createElement('div');
    header.className = 'sectors-line-header';

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'sectors-line-collapse';

    const label = document.createElement('span');
    label.className = 'sectors-line-label';
    label.textContent = line.nom;

    const count = document.createElement('span');
    count.className = 'sectors-line-count';
    count.textContent = visibleCount + ' desserte' + (visibleCount > 1 ? 's' : '');

    // Actions
    const actions = document.createElement('span');
    actions.className = 'sectors-line-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'zone-item-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Ajouter un secteur';
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); showZonePicker(line.id, addBtn); });
    actions.appendChild(addBtn);

    // Copier dans une autre table
    const copyBtn = document.createElement('button');
    copyBtn.className = 'zone-item-btn';
    copyBtn.textContent = '⧉';
    copyBtn.title = 'Copier dans une autre table';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showCopyLineMenu(line, table.id, copyBtn);
    });
    actions.appendChild(copyBtn);

    const renameBtn = document.createElement('button');
    renameBtn.className = 'zone-item-btn';
    renameBtn.textContent = '✎';
    renameBtn.title = 'Renommer';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = prompt('Nom de la ligne :', line.nom);
      if (n && n.trim()) { line.nom = n.trim(); saveLayout(); loadZonesList(); }
    });
    actions.appendChild(renameBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'zone-item-btn delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Supprimer la ligne';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Supprimer "${line.nom}" ?`)) {
        table.lines = table.lines.filter(l => l.id !== line.id);
        saveLayout(); loadZonesList();
      }
    });
    actions.appendChild(delBtn);

    header.appendChild(collapseBtn);
    header.appendChild(label);
    header.appendChild(count);
    header.appendChild(actions);
    wrapper.appendChild(header);

    // Body — chips secteurs
    const body = document.createElement('div');
    body.className = 'sectors-line-body';

    // Replié par défaut — persister l'état
    const ck = 'eic_line_open_' + line.id;
    const isOpen = localStorage.getItem(ck) === '1';
    if (!isOpen) body.classList.add('collapsed');
    collapseBtn.textContent = isOpen ? '▾' : '▸';

    const toggleBody = (e) => {
      if (e && e.target.closest('.sectors-line-actions')) return;
      const open = body.classList.toggle('collapsed');
      collapseBtn.textContent = open ? '▸' : '▾';
      localStorage.setItem(ck, open ? '0' : '1');
    };
    header.addEventListener('click', toggleBody);

    // Drop zone
    body.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragZoneId || line.zoneIds.includes(dragZoneId)) return;
      removeZoneFromLine(dragZoneId, dragSourceLineId);
      line.zoneIds.push(dragZoneId);
      saveLayout(); loadZonesList();
    });

    line.zoneIds.forEach(zoneId => {
      const zone = allZones.get(zoneId);
      if (!zone) return;
      body.appendChild(renderChip(zone, line));
    });

    wrapper.appendChild(body);
    return wrapper;
  }

  // --- NON CLASSÉ ---

  function renderUnassignedContent(container, unassignedIds, allZones) {
    const body = document.createElement('div');
    body.style.cssText = 'padding:8px 12px;display:flex;flex-wrap:wrap;gap:4px;';

    unassignedIds.forEach(id => {
      const zone = allZones.get(id);
      if (!zone) return;
      body.appendChild(renderChip(zone, null));
    });

    container.appendChild(body);
  }

  // --- CHIP SECTEUR ---

  function renderChip(zone, line) {
    const isCustom = zone.id.startsWith('custom-');
    const lineId = line ? line.id : null;

    const chip = document.createElement('div');
    chip.className = 'sector-chip' + (isCustom ? ' custom' : '');
    chip.dataset.zoneId = zone.id;
    chip.draggable = true;
    chip.textContent = zone.nom;

    // Clic → sélectionner
    chip.addEventListener('click', () => selectZone(zone.id));

    // Clic droit → menu contextuel
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showChipContextMenu(e, zone, line, isCustom);
    });

    // Drag
    chip.addEventListener('dragstart', (e) => {
      dragZoneId = zone.id;
      dragSourceLineId = lineId;
      chip.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', zone.id);
    });
    chip.addEventListener('dragend', () => {
      dragZoneId = null; dragSourceLineId = null;
      chip.classList.remove('dragging');
      document.querySelectorAll('.drag-over-left,.drag-over-right,.drag-over').forEach(el => {
        el.classList.remove('drag-over-left', 'drag-over-right', 'drag-over');
      });
    });

    // Drop (reorder horizontal)
    chip.addEventListener('dragover', (e) => {
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      if (!dragZoneId || dragZoneId === zone.id) return;
      const rect = chip.getBoundingClientRect();
      chip.classList.remove('drag-over-left', 'drag-over-right');
      chip.classList.add(e.clientX < rect.left + rect.width / 2 ? 'drag-over-left' : 'drag-over-right');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('drag-over-left', 'drag-over-right'));
    chip.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      chip.classList.remove('drag-over-left', 'drag-over-right');
      if (!dragZoneId || dragZoneId === zone.id || !line) return;
      const before = e.clientX < chip.getBoundingClientRect().left + chip.getBoundingClientRect().width / 2;
      moveZoneToLine(dragZoneId, dragSourceLineId, line, zone.id, before);
    });

    return chip;
  }

  // === COPIER UNE LIGNE DANS UNE AUTRE TABLE ===

  function showCopyLineMenu(line, sourceTableId, anchorEl) {
    const old = document.getElementById('copy-line-menu');
    if (old) { old.remove(); return; }

    const otherTables = layout.tables.filter(t => t.id !== sourceTableId);
    if (otherTables.length === 0) return;

    const menu = document.createElement('div');
    menu.id = 'copy-line-menu';
    menu.className = 'add-context-menu';

    const title = document.createElement('div');
    title.style.cssText = 'padding:6px 12px;font-family:var(--mono);font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);';
    title.textContent = 'Copier "' + line.nom + '" dans';
    menu.appendChild(title);

    otherTables.forEach(t => {
      // Vérifier si une ligne avec le même nom existe déjà
      const alreadyExists = t.lines.some(l => l.nom === line.nom);

      const item = document.createElement('div');
      item.className = 'add-menu-item';
      if (alreadyExists) {
        item.style.opacity = '0.4';
        item.style.pointerEvents = 'none';
        item.textContent = t.nom + ' (déjà présente)';
      } else {
        item.textContent = t.nom;
      }

      item.addEventListener('click', () => {
        // Dupliquer la ligne avec un nouvel id mais les mêmes secteurs
        t.lines.push({
          id: 'line-' + Date.now(),
          nom: line.nom,
          zoneIds: [...line.zoneIds],
        });
        saveLayout();
        menu.remove();
        loadZonesList();
      });

      menu.appendChild(item);
    });

    // Positionner
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    menu.style.left = rect.left + 'px';
    document.body.appendChild(menu);

    const close = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== anchorEl) {
        menu.remove(); document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  // === PK PAR DESSERTE ET PAR LIGNE ===

  // getDessertePk / setDessertePk supprimés — utiliser Data.getDessertePk / Data.setDessertePk

  // === MENU CONTEXTUEL DESSERTE ===

  function showChipContextMenu(event, zone, line, isCustom) {
    const old = document.getElementById('chip-context-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.id = 'chip-context-menu';
    menu.className = 'add-context-menu';

    // 1. Modifier le nom
    const actions = [
      {
        label: 'Modifier le nom',
        icon: '✎',
        action: () => {
          const n = prompt('Nom de la desserte :', zone.nom);
          if (n && n.trim()) {
            zone.nom = n.trim();
            if (isCustom) saveCustomZones();
            else saveZoneOverride(zone.id, 'nom', zone.nom);
            loadZonesList();
          }
        }
      },
    ];

    // 2. Modifier les PK (toutes lignes)
    actions.push({
      label: 'Modifier les PK',
      icon: 'Km',
      action: () => {
        menu.remove();
        showPkSubMenu(event, zone);
      }
    });

    // 3. Changer de ligne
    actions.push({
      label: 'Changer de ligne',
      icon: '↔',
      action: () => {
        menu.remove();
        showChangeLineMenu(event, zone, line);
      }
    });

    // 4. Enregistrer la vue
    actions.push({
      label: 'Enregistrer cette vue',
      icon: '📌',
      action: () => {
        selectZone(zone.id);
        setTimeout(() => {
          Viewer.saveCurrentViewForZone(zone.id);
          const chip = document.querySelector(`.sector-chip[data-zone-id="${zone.id}"]`);
          if (chip) {
            chip.style.outline = '2px solid var(--accent2)';
            setTimeout(() => { chip.style.outline = ''; }, 1000);
          }
        }, 400);
      }
    });

    // 5. Retirer de cette ligne
    if (line) {
      actions.push({
        label: 'Retirer de cette ligne',
        icon: '↩',
        action: () => {
          line.zoneIds = line.zoneIds.filter(id => id !== zone.id);
          saveLayout(); loadZonesList();
        }
      });
    }

    // 6. Supprimer la desserte
    actions.push({
      label: 'Supprimer la desserte',
      icon: '✕',
      danger: true,
      action: () => {
        if (!confirm(`Supprimer définitivement "${zone.nom}" ?`)) return;
        if (isCustom) {
          customZones = customZones.filter(z => z.id !== zone.id);
          saveCustomZones();
        } else {
          addHiddenZone(zone.id);
        }
        layout.tables.forEach(t => t.lines.forEach(l => {
          l.zoneIds = l.zoneIds.filter(id => id !== zone.id);
        }));
        saveLayout(); loadZonesList();
      }
    });

    actions.forEach(a => {
      const item = document.createElement('div');
      item.className = 'add-menu-item';
      if (a.danger) item.style.color = 'var(--danger)';
      const iconSpan = document.createElement('span');
      iconSpan.style.cssText = 'display:inline-block;width:16px;text-align:center;margin-right:4px;';
      iconSpan.textContent = a.icon;
      item.appendChild(iconSpan);
      item.appendChild(document.createTextNode(a.label));
      item.addEventListener('click', () => { menu.remove(); a.action(); });
      menu.appendChild(item);
    });

    // Positionner au curseur
    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    // Si trop bas, afficher au-dessus
    const estimatedHeight = actions.length * 32;
    if (event.clientY + estimatedHeight > window.innerHeight - 10) {
      menu.style.bottom = (window.innerHeight - event.clientY) + 'px';
    } else {
      menu.style.top = event.clientY + 'px';
    }
    document.body.appendChild(menu);

    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove(); document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  // === SOUS-MENU PK PAR LIGNE ===

  function showPkSubMenu(event, zone) {
    const old = document.getElementById('chip-context-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.id = 'chip-context-menu';
    menu.className = 'add-context-menu';
    menu.style.minWidth = '280px';

    const title = document.createElement('div');
    title.style.cssText = 'padding:6px 12px;font-family:var(--mono);font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);';
    title.textContent = 'PK de ' + zone.nom;
    menu.appendChild(title);

    // Trouver toutes les lignes contenant cette desserte
    const linesWithZone = [];
    layout.tables.forEach(t => t.lines.forEach(l => {
      if ((l.zoneIds || []).includes(zone.id)) {
        linesWithZone.push({ table: t, line: l });
      }
    }));

    if (linesWithZone.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:10px 12px;font-family:var(--mono);font-size:11px;color:var(--muted);';
      empty.textContent = 'Aucune ligne assignée';
      menu.appendChild(empty);
    } else {
      linesWithZone.forEach(({ table, line }) => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:4px 12px;display:flex;align-items:center;gap:8px;';

        const label = document.createElement('span');
        label.style.cssText = 'font-family:var(--mono);font-size:10px;color:var(--muted);min-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        label.textContent = line.nom;
        label.title = table.nom + ' → ' + line.nom;
        row.appendChild(label);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = Data.getDessertePk(zone.id, line.id);
        input.placeholder = 'Km ...';
        input.style.cssText = 'flex:1;padding:3px 6px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;min-width:80px;';
        input.addEventListener('focus', () => { input.style.borderColor = 'var(--accent)'; });
        input.addEventListener('blur', () => {
          input.style.borderColor = 'var(--border)';
          Data.setDessertePk(zone.id, line.id, input.value.trim());
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { input.blur(); }
        });
        row.appendChild(input);

        menu.appendChild(row);
      });
    }

    // Bouton fermer
    const closeBtn = document.createElement('div');
    closeBtn.className = 'add-menu-item';
    closeBtn.style.cssText = 'text-align:center;color:var(--accent2);border-top:1px solid var(--border);margin-top:4px;';
    closeBtn.textContent = 'Fermer';
    closeBtn.addEventListener('click', () => { menu.remove(); loadZonesList(); });
    menu.appendChild(closeBtn);

    menu.style.position = 'fixed';
    menu.style.zIndex = '300';
    menu.style.left = event.clientX + 'px';
    const estH = (linesWithZone.length + 2) * 36;
    if (event.clientY + estH > window.innerHeight - 10) {
      menu.style.bottom = (window.innerHeight - event.clientY) + 'px';
    } else {
      menu.style.top = event.clientY + 'px';
    }
    document.body.appendChild(menu);

    // Ne PAS fermer au clic extérieur immédiat (pour pouvoir cliquer les inputs)
    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        // Sauvegarder les PK avant de fermer
        menu.querySelectorAll('input').forEach(inp => {
          const lineId = linesWithZone.find(lw => inp.closest('div').contains(inp))?.line?.id;
          // Déjà sauvé par le blur
        });
        menu.remove();
        loadZonesList();
        document.removeEventListener('mousedown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  }

  // === SOUS-MENU CHANGER DE LIGNE ===

  function showChangeLineMenu(event, zone, currentLine) {
    const old = document.getElementById('chip-context-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.id = 'chip-context-menu';
    menu.className = 'add-context-menu';
    menu.style.maxHeight = '300px';
    menu.style.overflowY = 'auto';

    const title = document.createElement('div');
    title.style.cssText = 'padding:6px 12px;font-family:var(--mono);font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);';
    title.textContent = zone.nom + ' → Changer de ligne';
    menu.appendChild(title);

    let currentTableNom = '';
    layout.tables.forEach(t => {
      // Header de table
      if (t.nom !== currentTableNom) {
        currentTableNom = t.nom;
        const group = document.createElement('div');
        group.style.cssText = 'padding:4px 12px 2px;font-family:var(--mono);font-size:8px;letter-spacing:0.8px;text-transform:uppercase;color:var(--accent);background:var(--surface2);border-top:1px solid var(--border);position:sticky;top:0;';
        group.textContent = t.nom;
        menu.appendChild(group);
      }

      (t.lines || []).forEach(l => {
        const isCurrentLine = currentLine && l.id === currentLine.id;
        const alreadyIn = l.zoneIds && l.zoneIds.includes(zone.id);

        const item = document.createElement('div');
        item.className = 'add-menu-item';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '6px';

        const iconSpan = document.createElement('span');
        iconSpan.style.cssText = 'width:14px;text-align:center;';
        const labelSpan = document.createElement('span');
        if (isCurrentLine) {
          item.style.color = 'var(--accent2)';
          iconSpan.textContent = '●';
          labelSpan.textContent = l.nom + ' (actuelle)';
        } else if (alreadyIn) {
          item.style.opacity = '0.5';
          iconSpan.textContent = '✓';
          labelSpan.textContent = l.nom;
        } else {
          iconSpan.textContent = '○';
          labelSpan.textContent = l.nom;
        }
        item.appendChild(iconSpan);
        item.appendChild(labelSpan);

        item.addEventListener('click', () => {
          if (isCurrentLine) return;

          if (alreadyIn) {
            // Retirer de cette ligne
            l.zoneIds = l.zoneIds.filter(id => id !== zone.id);
          } else {
            // Ajouter à cette ligne
            if (!l.zoneIds) l.zoneIds = [];
            l.zoneIds.push(zone.id);
          }

          saveLayout();
          menu.remove();
          loadZonesList();
        });

        menu.appendChild(item);
      });
    });

    // Positionner
    menu.style.position = 'fixed';
    menu.style.zIndex = '300';
    menu.style.left = event.clientX + 'px';
    const estimatedHeight = 300;
    if (event.clientY + estimatedHeight > window.innerHeight - 10) {
      menu.style.bottom = (window.innerHeight - event.clientY) + 'px';
    } else {
      menu.style.top = event.clientY + 'px';
    }
    document.body.appendChild(menu);

    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove(); document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  // === DÉPLACEMENT ===

  function removeZoneFromLine(zoneId, lineId) {
    if (!lineId) return; // depuis non classé
    const found = findLine(lineId);
    if (found) {
      found.line.zoneIds = found.line.zoneIds.filter(id => id !== zoneId);
    }
  }

  function moveZoneToLine(zoneId, fromLineId, toLine, targetZoneId, insertBefore) {
    removeZoneFromLine(zoneId, fromLineId);
    if (targetZoneId) {
      const idx = toLine.zoneIds.indexOf(targetZoneId);
      if (idx >= 0) {
        toLine.zoneIds.splice(insertBefore ? idx : idx + 1, 0, zoneId);
      } else {
        toLine.zoneIds.push(zoneId);
      }
    } else {
      toLine.zoneIds.push(zoneId);
    }
    saveLayout(); loadZonesList();
  }

  /**
   * Sauvegarder un override (renommage) sur un secteur par défaut
   */
  function saveZoneOverride(zoneId, key, value) {
    const o = Store.getJSON('eic_zone_overrides', {});
    if (!o[zoneId]) o[zoneId] = {};
    o[zoneId][key] = value;
    Store.set('eic_zone_overrides', o);
  }

  /**
   * Sélectionner un secteur → naviguer + charger les éléments
   */
  function selectZone(zoneId) {
    // Highlight (peut apparaître dans plusieurs lignes → highlight le premier)
    document.querySelectorAll('.sector-chip').forEach(el => el.classList.remove('active'));
    const activeItem = document.querySelector(`.sector-chip[data-zone-id="${zoneId}"]`);
    if (activeItem) activeItem.classList.add('active');

    const allZones = getAllZonesMap();
    const zone = allZones.get(zoneId);

    Viewer.showZone(zoneId, zone ? zone.nom : undefined);

    const flatIds = getFlatZoneIds();
    const idx = flatIds.indexOf(zoneId);
    if (idx >= 0) currentZoneIndex = idx;

    loadSidebarForZone(zoneId);

    const header = document.getElementById('sidebar-elements-header');
    if (header) {
      header.classList.remove('hidden');
      if (!document.getElementById('btn-save-zone-view')) {
        const btn = document.createElement('button');
        btn.id = 'btn-save-zone-view';
        btn.textContent = 'Enregistrer cette vue';
        btn.title = 'Sauvegarder la position et le zoom actuels pour ce secteur';
        btn.style.cssText = `
          display:block; width:100%; margin-top:4px; padding:4px 8px;
          background:var(--surface2); border:1px dashed var(--warn);
          border-radius:3px; color:var(--warn); font-family:var(--mono);
          font-size:9px; cursor:pointer; text-transform:uppercase;
          letter-spacing:0.5px;
        `;
        btn.addEventListener('click', () => {
          const cz = Viewer.getCurrentZone();
          if (cz) {
            Viewer.saveCurrentViewForZone(cz.id);
            btn.textContent = 'Vue enregistrée !';
            btn.style.borderColor = '#00d4a0'; btn.style.color = '#00d4a0';
            setTimeout(() => { btn.textContent = 'Enregistrer cette vue'; btn.style.borderColor = ''; btn.style.color = ''; }, 2000);
          }
        });
        header.appendChild(btn);
      }
    }
  }

  /** Liste plate unique de tous les zoneIds (sans doublons) dans l'ordre d'affichage */
  function getFlatZoneIds() {
    const seen = new Set();
    const ids = [];
    const allZones = getAllZonesMap();
    layout.tables.forEach(t => t.lines.forEach(l => l.zoneIds.forEach(id => {
      if (allZones.has(id) && !seen.has(id)) { seen.add(id); ids.push(id); }
    })));
    allZones.forEach((_, id) => { if (!seen.has(id)) { seen.add(id); ids.push(id); } });
    return ids;
  }

  function navigateZone(offset) {
    const flatIds = getFlatZoneIds();
    if (flatIds.length === 0) return;
    currentZoneIndex = Math.max(0, Math.min(flatIds.length - 1, currentZoneIndex + offset));
    selectZone(flatIds[currentZoneIndex]);
  }

  // === SUGGESTIONS / AUTOCOMPLÉTION ===

  function showSuggestions(query) {
    const q = normalize(query);
    if (q.length < 1) { closeSuggestions(); return; }

    const allDessertes = Data.getAllDessertes();

    // Chercher dans les dessertes
    const desserteResults = [];
    allDessertes.forEach((d, id) => {
      if (normalize(d.nom).includes(q)) {
        desserteResults.push({ type: 'desserte', id, nom: d.nom, data: d });
      }
    });

    // Chercher dans les éléments infra (PN, signaux, aiguilles, etc.)
    const elementResults = [];
    const seenPos = new Set();
    const allDesserteMap = Data.getAllDessertes();
    Data.searchElementFuzzy('').forEach(el => {
      const posKey = Math.round(el.x_pct * 300) + ',' + Math.round(el.y_pct * 300);
      if (seenPos.has(posKey)) return;
      seenPos.add(posKey);

      let match = false;
      if (el.type === 'pn') {
        // PN : match exact sur le numéro
        const qNum = q.replace(/\s+/g, '').match(/^pn(\d+)/i);
        const elNum = el.identifiant.match(/^PN\s*(\d+(?:\.\d+)?)/i);
        if (qNum && elNum) {
          match = elNum[1] === qNum[1] || elNum[1].startsWith(qNum[1] + '.');
        } else {
          match = normalize(el.identifiant).includes(q) || (el.pn_type && normalize(el.pn_type).includes(q));
        }
      } else {
        // Signaux, aiguilles, etc. : match sur identifiant, secteur, ligne
        match = normalize(el.identifiant).includes(q) ||
          (el.secteur && normalize(el.secteur).includes(q)) ||
          (el.ligne && normalize(el.ligne).includes(q));
      }

      if (match) {
        // Trouver la desserte associée (dessertes d'abord, puis gares PDF)
        const gare = el.gare_id ? (allDesserteMap.get(el.gare_id) || Data.getGare(el.gare_id) || null) : null;
        const label = el.identifiant + (gare ? ' — ' + gare.nom : '');
        elementResults.push({ type: el.type, id: el.id, nom: label, data: el });
      }
    });

    const results = [...desserteResults.slice(0, 8), ...elementResults.slice(0, 12)];
    if (results.length === 0) { closeSuggestions(); return; }

    // Créer ou réutiliser le dropdown
    if (!suggestionsEl) {
      suggestionsEl = document.createElement('div');
      suggestionsEl.id = 'suggestions-dropdown';
      suggestionsEl.className = 'suggestions-dropdown';
      document.body.appendChild(suggestionsEl);
    }
    suggestionsEl.innerHTML = '';
    selectedSuggestion = -1;

    results.forEach((r, i) => {
      const item = document.createElement('div');
      item.className = 'suggestion-item';
      item.dataset.index = i;

      const icon = document.createElement('span');
      icon.className = 'suggestion-icon';
      if (r.type === 'desserte') {
        icon.textContent = '◈';
        icon.style.color = 'var(--accent2)';
      } else if (r.type === 'signal') {
        icon.textContent = '●';
        icon.style.color = '#00d4a0';
      } else if (r.type === 'aiguille') {
        icon.textContent = '⬦';
        icon.style.color = '#ff6b6b';
      } else {
        icon.textContent = '⬥';
        icon.style.color = 'var(--warn)';
      }

      const text = document.createElement('span');
      text.className = 'suggestion-text';
      text.textContent = r.nom;

      const badge = document.createElement('span');
      badge.className = 'suggestion-badge';
      badge.textContent = r.type;

      item.appendChild(icon);
      item.appendChild(text);
      item.appendChild(badge);

      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        closeSuggestions();
        document.getElementById('command-bar').value = '';
        if (r.type === 'desserte') {
          selectZone(r.id);
        } else {
          // PN — naviguer vers la vue sauvegardée ou la position
          if (Data.hasSavedView(r.data.id)) {
            Viewer.showZone(r.data.id, r.data.identifiant);
          } else {
            Viewer.panTo(r.data.x_pct, r.data.y_pct, 12);
          }
        }
      });

      suggestionsEl.appendChild(item);
    });

    // Positionner sous la barre de commande
    const bar = document.getElementById('command-bar');
    const rect = bar.getBoundingClientRect();
    suggestionsEl.style.top = rect.bottom + 2 + 'px';
    suggestionsEl.style.left = rect.left + 'px';
    suggestionsEl.style.width = rect.width + 'px';
    suggestionsEl.classList.remove('hidden');
  }

  function closeSuggestions() {
    if (suggestionsEl) {
      suggestionsEl.classList.add('hidden');
    }
    selectedSuggestion = -1;
  }

  function moveSuggestionSelection(dir) {
    if (!suggestionsEl || suggestionsEl.classList.contains('hidden')) return;
    const items = suggestionsEl.querySelectorAll('.suggestion-item');
    if (items.length === 0) return;

    items.forEach(el => el.classList.remove('selected'));
    selectedSuggestion += dir;
    if (selectedSuggestion < 0) selectedSuggestion = items.length - 1;
    if (selectedSuggestion >= items.length) selectedSuggestion = 0;
    items[selectedSuggestion].classList.add('selected');
    items[selectedSuggestion].scrollIntoView({ block: 'nearest' });
  }

  /**
   * Exécuter une commande depuis la barre
   */
  function executeCommand(input) {
    if (!input.trim()) return;

    const parsed = Parser.parse(input);

    // Si on a un élément identifié → chercher
    if (parsed.identifiant) {
      const results = Data.searchElement(parsed.identifiant);

      if (results.length === 0) {
        // Essayer fuzzy
        const fuzzy = Data.searchElementFuzzy(parsed.identifiant);
        if (fuzzy.length === 0) {
          alert('Élément non trouvé : ' + parsed.identifiant);
          return;
        }
        showDisambiguation(fuzzy, parsed);
        return;
      }

      // Si contexte fourni → filtrer
      if (parsed.contexte && results.length > 1) {
        const filtered = results.filter(r => r.gare_id === parsed.contexte.id);
        if (filtered.length === 1) {
          selectElement(filtered[0], parsed);
          return;
        }
      }

      // Si plusieurs résultats et pas de contexte → disambiguation
      if (results.length > 1) {
        showDisambiguation(results, parsed);
        return;
      }

      // Un seul résultat
      selectElement(results[0], parsed);
      return;
    }

    // Si on a une gare → naviguer
    if (parsed.contexte) {
      const gare = parsed.contexte;
      Viewer.panTo(gare.x_pct, gare.y_pct, 5);
      Viewer.showZone(gare.zone_id);
      return;
    }

    // Recherche textuelle libre dans les gares
    const gareResults = Data.searchGare(input.trim());
    if (gareResults.length === 1) {
      Viewer.panTo(gareResults[0].x_pct, gareResults[0].y_pct, 5);
      Viewer.showZone(gareResults[0].zone_id);
    } else if (gareResults.length > 1) {
      showGareDisambiguation(gareResults);
    }
  }

  /**
   * Sélectionner un élément — naviguer, annoter, appliquer template
   */
  // ID du highlight de sélection courant (pour le nettoyer au prochain clic)
  let currentHighlightId = null;

  function selectElement(element, parsed) {
    const gare = Data.getGareForElement(element);

    // Naviguer sur la zone
    if (gare) {
      Viewer.showZone(gare.zone_id);
    }

    // Centrer sur l'élément à zoom 1300% (~13x le home zoom)
    Viewer.panTo(element.x_pct, element.y_pct, 10);

    // Nettoyer le highlight de sélection précédent (pas les annotations permanentes)
    if (currentHighlightId) {
      Annotations.remove(currentHighlightId);
      currentHighlightId = null;
    }

    // Si un template est détecté → appliquer via Templates.apply()
    if (parsed && parsed.template) {
      Templates.apply(parsed.template, element, parsed);
    } else {
      // Pas de template → highlight temporaire de sélection
      const highlight = Annotations.highlightElement(element, '');
      currentHighlightId = highlight.id;
    }

    // Marquer comme actif dans le sidebar
    document.querySelectorAll('.sidebar-item.active').forEach(el => el.classList.remove('active'));
    const sidebarItem = document.querySelector(`.sidebar-item[data-id="${element.id}"]`);
    if (sidebarItem) sidebarItem.classList.add('active');
  }

  /**
   * Afficher le popup de disambiguation
   */
  function showDisambiguation(elements, parsed) {
    const popup = document.getElementById('disambiguation-popup');
    const list = document.getElementById('disambiguation-list');
    list.innerHTML = '';

    elements.forEach(el => {
      const gare = Data.getGareForElement(el);
      const item = document.createElement('div');
      item.className = 'disambiguation-item';
      const idDiv = document.createElement('div');
      idDiv.className = 'item-id';
      idDiv.textContent = el.identifiant;
      const ctxDiv = document.createElement('div');
      ctxDiv.className = 'item-context';
      ctxDiv.textContent = `${gare ? gare.nom : '?'} · ${el.ligne || '?'} · Km ${el.pk || '?'} · ${el.secteur || '?'}`;
      item.appendChild(idDiv);
      item.appendChild(ctxDiv);
      item.addEventListener('click', () => {
        closeDisambiguation();
        selectElement(el, parsed);
      });
      list.appendChild(item);
    });

    popup.classList.remove('hidden');
  }

  function showGareDisambiguation(gares) {
    const popup = document.getElementById('disambiguation-popup');
    const list = document.getElementById('disambiguation-list');
    list.innerHTML = '';

    gares.forEach(g => {
      const item = document.createElement('div');
      item.className = 'disambiguation-item';
      const idDiv = document.createElement('div');
      idDiv.className = 'item-id';
      idDiv.textContent = g.nom;
      const ctxDiv = document.createElement('div');
      ctxDiv.className = 'item-context';
      ctxDiv.textContent = `Zone : ${g.zone_id}`;
      item.appendChild(idDiv);
      item.appendChild(ctxDiv);
      item.addEventListener('click', () => {
        closeDisambiguation();
        Viewer.panTo(g.x_pct, g.y_pct, 5);
        Viewer.showZone(g.zone_id);
      });
      list.appendChild(item);
    });

    popup.classList.remove('hidden');
  }

  function closeDisambiguation() {
    document.getElementById('disambiguation-popup').classList.add('hidden');
  }

  /**
   * Charger les éléments dans le panneau latéral pour une zone
   */
  function loadSidebarForZone(zoneId) {
    const elements = Data.getElementsForZone(zoneId);

    const allZones = getAllZonesMap();
    const zone = allZones.get(zoneId);
    const zoneLabel = document.getElementById('sidebar-zone');
    if (zoneLabel) zoneLabel.textContent = zone ? `${zone.nom} (${elements.length})` : '';

    const lists = {
      aiguille: document.getElementById('list-aiguilles'),
      signal: document.getElementById('list-signaux'),
      pn: document.getElementById('list-pn'),
      cv: document.getElementById('list-cv'),
      pk: document.getElementById('list-pk'),
    };

    // Vider les listes
    Object.values(lists).forEach(l => { if (l) l.innerHTML = ''; });

    // Compteurs par type
    const counts = {};

    elements.forEach(el => {
      const list = lists[el.type];
      if (!list) return;

      counts[el.type] = (counts[el.type] || 0) + 1;

      const item = document.createElement('div');
      item.className = 'sidebar-item';
      item.dataset.id = el.id;
      item.textContent = el.identifiant;
      if (el.validated) item.style.borderRightColor = '#00d4a0';

      item.addEventListener('click', () => {
        // Centrer sur l'élément à 1300%
        Viewer.panTo(el.x_pct, el.y_pct, 10);
        // Activer dans la liste
        document.querySelectorAll('.sidebar-item.active').forEach(e => e.classList.remove('active'));
        item.classList.add('active');
      });

      list.appendChild(item);
    });

    // Mettre à jour les titres de section avec les compteurs
    Object.entries(lists).forEach(([type, list]) => {
      if (!list) return;
      const section = list.closest('.sidebar-section');
      if (!section) return;
      const title = section.querySelector('.sidebar-section-title');
      const count = counts[type] || 0;
      if (count === 0) {
        section.style.display = 'none';
      } else {
        section.style.display = '';
        const labels = { signal: 'Signaux', pn: 'PN', cv: 'CV', aiguille: 'Aiguilles', pk: 'PK' };
        title.textContent = `${labels[type] || type} (${count})`;
      }
    });
  }

  function reloadLayout() {
    // Recharger tout : custom zones, layout, et re-render
    loadCustomZones();
    layout = null;
    loadLayout();
    loadZonesList();
  }

  return { init, executeCommand, loadSidebarForZone, selectElement, reloadLayout };
})();
