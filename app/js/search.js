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

    commandBar.addEventListener('input', () => {
      showSuggestions(commandBar.value);
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
      item.innerHTML = `<span style="display:inline-block;width:16px;text-align:center;margin-right:4px;">${a.icon}</span>${a.label}`;
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

        if (isCurrentLine) {
          item.style.color = 'var(--accent2)';
          item.innerHTML = `<span style="width:14px;text-align:center;">●</span>${l.nom} (actuelle)`;
        } else if (alreadyIn) {
          item.style.opacity = '0.5';
          item.innerHTML = `<span style="width:14px;text-align:center;">✓</span>${l.nom}`;
        } else {
          item.innerHTML = `<span style="width:14px;text-align:center;">○</span>${l.nom}`;
        }

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

    // Chercher dans les PN
    const pnResults = [];
    const seenPos = new Set();
    const gares = Data.getGares();
    Data.searchElementFuzzy('').forEach(el => {
      if (el.type !== 'pn') return;
      const posKey = Math.round(el.x_pct * 300) + ',' + Math.round(el.y_pct * 300);
      if (seenPos.has(posKey)) return;
      seenPos.add(posKey);
      // Chercher par numéro exact d'abord, puis par contenu
      const qNum = q.replace(/\s+/g, '').match(/^pn(\d+)/i);
      const elNum = el.identifiant.match(/^PN\s*(\d+(?:\.\d+)?)/i);
      let match = false;
      if (qNum && elNum) {
        // Match exact sur le numéro : "pn4" ne doit pas matcher "pn47"
        match = elNum[1] === qNum[1] || elNum[1].startsWith(qNum[1] + '.');
      } else {
        // Match générique (type, texte libre)
        match = normalize(el.identifiant).includes(q) || (el.pn_type && normalize(el.pn_type).includes(q));
      }
      if (match) {
        // Trouver la desserte associée
        const gare = el.gare_id ? gares.find(g => g.id === el.gare_id) : null;
        const label = el.identifiant + (gare ? ' — ' + gare.nom : '');
        pnResults.push({ type: 'pn', id: el.id, nom: label, data: el });
      }
    });

    const results = [...desserteResults.slice(0, 8), ...pnResults.slice(0, 8)];
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
      item.innerHTML = `
        <div class="item-id">${el.identifiant}</div>
        <div class="item-context">
          ${gare ? gare.nom : '?'} · ${el.ligne || '?'} · Km ${el.pk || '?'} · ${el.secteur || '?'}
        </div>
      `;
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
      item.innerHTML = `
        <div class="item-id">${g.nom}</div>
        <div class="item-context">Zone : ${g.zone_id}</div>
      `;
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
