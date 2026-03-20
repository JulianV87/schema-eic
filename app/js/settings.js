/**
 * Panneau Paramètres — Gestion des dessertes, lignes et tables
 * Terme "desserte" = gare/point d'arrêt sur le schéma
 */
const Settings = (() => {

  let activeTab = 'dessertes';

  function init() {
    // Bouton ouvrir paramètres
    const btn = document.getElementById('btn-settings');
    if (btn) btn.addEventListener('click', openSettings);

    // Fermer
    const closeBtn = document.getElementById('settings-close');
    if (closeBtn) closeBtn.addEventListener('click', closeSettings);

    // Onglets paramètres
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeTab = tab.dataset.tab;
        renderTab(activeTab);
      });
    });

    // Créer les dessertes manquantes au premier lancement
    ensureAllDessertes();
  }

  function openSettings() {
    const popup = document.getElementById('settings-popup');
    popup.classList.remove('hidden');
    renderTab(activeTab);
    setupDraggable();
  }

  function closeSettings() {
    document.getElementById('settings-popup').classList.add('hidden');
  }

  function setupDraggable() {
    const content = document.querySelector('.settings-popup-content');
    const header = content.querySelector('.popup-header');
    if (!content || !header || content._draggableSetup) return;
    content._draggableSetup = true;

    header.style.cursor = 'move';
    let dragging = false, startX, startY, origX, origY;

    header.addEventListener('mousedown', (e) => {
      // Ne pas drag si clic sur un bouton/onglet
      if (e.target.closest('button') || e.target.closest('.settings-tab')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = content.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      // Passer en position fixe absolue
      content.style.position = 'fixed';
      content.style.left = origX + 'px';
      content.style.top = origY + 'px';
      content.style.transform = 'none';
      content.style.margin = '0';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      content.style.left = (origX + dx) + 'px';
      content.style.top = (origY + dy) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        document.body.style.userSelect = '';
      }
    });
  }

  function renderTab(tab) {
    if (tab) activeTab = tab;
    const container = document.getElementById('settings-content');
    if (!container) return;
    container.innerHTML = '';

    if (activeTab === 'dessertes') renderDessertes(container);
    else if (activeTab === 'pn') renderPN(container);
    else if (activeTab === 'lignes') renderLignes(container);
    else if (activeTab === 'tables') renderTables(container);

    // Synchroniser la barre du bas
    try { Search.reloadLayout(); } catch {}
  }

  // =========================================
  // DESSERTES (= gares du schéma)
  // =========================================

  function getAllDessertes() {
    const map = Data.getAllDessertes();
    return [...map.values()];
  }

  function getLayout() {
    return Store.getJSON('eic_zone_layout', {});
  }

  function saveLayoutObj(layout) {
    Store.set('eic_zone_layout', layout);
    try { Search.reloadLayout(); } catch {}
  }

  function renderDessertes(container) {
    const dessertes = getAllDessertes();
    const layout = getLayout();
    const hidden = getHiddenSet();

    // Indexer : desserte → lignes qui la contiennent
    const desserteLines = new Map();
    if (layout.tables) {
      layout.tables.forEach(t => (t.lines || []).forEach(l => {
        (l.zoneIds || []).forEach(zid => {
          if (!desserteLines.has(zid)) desserteLines.set(zid, []);
          desserteLines.get(zid).push(l.nom);
        });
      }));
    }

    // Toutes les lignes disponibles pour le select
    const allLines = [];
    if (layout.tables) {
      layout.tables.forEach(t => (t.lines || []).forEach(l => {
        allLines.push({ tableNom: t.nom, lineId: l.id, lineNom: l.nom, line: l });
      }));
    }

    // Barre de recherche
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Chercher une desserte...';
    searchInput.className = 'zone-picker-search';
    searchInput.style.cssText = 'margin-bottom:6px;border:1px solid var(--border);border-radius:3px;';
    container.appendChild(searchInput);

    const listDiv = document.createElement('div');
    container.appendChild(listDiv);

    function renderList(filter) {
      listDiv.innerHTML = '';
      const q = normalize(filter || '');

      // Trier alphabétiquement
      const sorted = [...dessertes].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

      sorted.forEach(d => {
        if (hidden.has(d.id)) return;
        if (q && !normalize(d.nom).includes(q)) return;

        const item = document.createElement('div');
        item.className = 'settings-item settings-desserte-item';

        // Indicateur vue sauvegardée
        const hasView = Data.hasSavedView(d.id);
        const viewDot = document.createElement('span');
        viewDot.className = 'settings-view-dot';
        viewDot.title = hasView ? 'Vue sauvegardée' : 'Pas de vue';
        viewDot.style.color = hasView ? 'var(--accent2)' : 'var(--border2)';
        viewDot.textContent = '●';
        item.appendChild(viewDot);

        const name = document.createElement('span');
        name.className = 'settings-item-name settings-clickable';
        name.textContent = d.nom;
        name.title = 'Cliquer pour voir / modifier la vue';
        item.appendChild(name);

        // Lignes associées
        const lines = desserteLines.get(d.id) || [];
        if (lines.length > 0) {
          const meta = document.createElement('span');
          meta.className = 'settings-item-meta';
          meta.textContent = lines.join(', ');
          meta.title = lines.join('\n');
          item.appendChild(meta);
        }

        // Clic gauche sur le nom → naviguer sur la vue
        name.addEventListener('click', (e) => {
          e.stopPropagation();
          listDiv.querySelectorAll('.settings-desserte-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
          Viewer.showZone(d.id, d.nom);
        });

        // Clic droit → menu contextuel complet
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showDesserteContextMenu(e, d, allLines);
        });

        listDiv.appendChild(item);
      });
    }

    searchInput.addEventListener('input', () => renderList(searchInput.value));
    renderList('');

    // Bouton créer
    const addBtn = document.createElement('button');
    addBtn.className = 'settings-add-btn';
    addBtn.textContent = '+ Créer une desserte';
    addBtn.addEventListener('click', () => {
      const n = prompt('Nom de la nouvelle desserte :');
      if (!n || !n.trim()) return;
      const newZone = { id: 'custom-' + Date.now(), nom: n.trim(), gares: [], xMin: 0, xMax: 1, yMin: 0, yMax: 0.20 };
      let cz = [];
      cz = Store.getJSON('eic_custom_zones', [])
      cz.push(newZone);
      Store.set('eic_custom_zones', cz);
      try { Sync.save('eic_custom_zones', cz); } catch {}
      Viewer.saveCurrentViewForZone(newZone.id);
      renderTab('dessertes');
    });
    container.appendChild(addBtn);
  }

  function showDesserteContextMenu(event, d, allLines) {
    const old = document.getElementById('settings-context-menu');
    if (old) old.remove();

    const isCustom = d.id.startsWith('custom-');

    const menu = document.createElement('div');
    menu.id = 'settings-context-menu';
    menu.className = 'add-context-menu';
    menu.style.zIndex = '310';

    const items = [
      {
        label: 'Modifier le nom',
        icon: '✎',
        action: () => {
          const n = prompt('Nom de la desserte :', d.nom);
          if (n && n.trim()) {
            if (isCustom) {
              let cz = [];
              cz = Store.getJSON('eic_custom_zones', [])
              const found = cz.find(z => z.id === d.id);
              if (found) {
                found.nom = n.trim();
                Store.set('eic_custom_zones', cz);
                try { Sync.save('eic_custom_zones', cz); } catch {}
              }
            } else {
              const o = Store.getJSON('eic_zone_overrides', {});
              if (!o[d.id]) o[d.id] = {};
              o[d.id].nom = n.trim();
              Store.set('eic_zone_overrides', o);
            }
            renderTab('dessertes');
          }
        }
      },
      {
        label: 'Modifier les PK',
        icon: 'Km',
        action: () => {
          menu.remove();
          showPkSubMenuSettings(event, d);
        }
      },
      {
        label: 'Assigner à une ligne',
        icon: '↔',
        action: () => {
          menu.remove();
          showChangeLineMenuSettings(event, d);
        }
      },
      {
        label: 'Assigner à une table',
        icon: '▤',
        action: () => {
          menu.remove();
          showAssignTableMenu(event, d);
        }
      },
      {
        label: 'Enregistrer cette vue',
        icon: '📌',
        action: () => {
          Viewer.saveCurrentViewForZone(d.id);
          renderTab('dessertes');
        }
      },
      {
        label: 'Supprimer la desserte',
        icon: '✕',
        danger: true,
        action: () => {
          if (!confirm(`Supprimer définitivement "${d.nom}" ?`)) return;
          if (isCustom) {
            let cz = [];
            cz = Store.getJSON('eic_custom_zones', [])
            cz = cz.filter(z => z.id !== d.id);
            Store.set('eic_custom_zones', cz);
          } else {
            const h = Store.getJSON('eic_hidden_zones', []);
            if (!h.includes(d.id)) {
              h.push(d.id);
              Store.set('eic_hidden_zones', h);
            }
          }
          // Retirer de toutes les lignes
          const layout = getLayout();
          if (layout.tables) {
            layout.tables.forEach(t => (t.lines || []).forEach(l => {
              l.zoneIds = (l.zoneIds || []).filter(id => id !== d.id);
            }));
          }
          saveLayoutObj(layout);
          renderTab('dessertes');
        }
      }
    ];

    items.forEach(a => {
      const el = document.createElement('div');
      el.className = 'add-menu-item';
      if (a.danger) el.style.color = 'var(--danger)';
      el.innerHTML = `<span style="display:inline-block;width:18px;text-align:center;margin-right:4px;font-size:11px;">${a.icon}</span>${a.label}`;
      el.addEventListener('click', () => { menu.remove(); a.action(); });
      menu.appendChild(el);
    });

    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    const estH = items.length * 34;
    if (event.clientY + estH > window.innerHeight - 10) {
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

  function showPkSubMenuSettings(event, zone) {
    const old = document.getElementById('settings-context-menu');
    if (old) old.remove();

    const layout = getLayout();

    const menu = document.createElement('div');
    menu.id = 'settings-context-menu';
    menu.className = 'add-context-menu';
    menu.style.zIndex = '310';
    menu.style.minWidth = '280px';

    const title = document.createElement('div');
    title.style.cssText = 'padding:6px 12px;font-family:var(--mono);font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);';
    title.textContent = 'PK de ' + zone.nom;
    menu.appendChild(title);

    const linesWithZone = [];
    if (layout.tables) {
      layout.tables.forEach(t => (t.lines || []).forEach(l => {
        if ((l.zoneIds || []).includes(zone.id)) {
          linesWithZone.push({ table: t, line: l });
        }
      }));
    }

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
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
        row.appendChild(input);

        menu.appendChild(row);
      });
    }

    const closeBtn = document.createElement('div');
    closeBtn.className = 'add-menu-item';
    closeBtn.style.cssText = 'text-align:center;color:var(--accent2);border-top:1px solid var(--border);margin-top:4px;';
    closeBtn.textContent = 'Fermer';
    closeBtn.addEventListener('click', () => { menu.remove(); renderTab(activeTab); });
    menu.appendChild(closeBtn);

    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    const estH = (linesWithZone.length + 2) * 36;
    if (event.clientY + estH > window.innerHeight - 10) {
      menu.style.bottom = (window.innerHeight - event.clientY) + 'px';
    } else {
      menu.style.top = event.clientY + 'px';
    }
    document.body.appendChild(menu);

    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        renderTab(activeTab);
        document.removeEventListener('mousedown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  }

  function showAssignTableMenu(event, zone) {
    const old = document.getElementById('settings-context-menu');
    if (old) old.remove();

    const layout = getLayout();
    if (!layout.tables) return;

    const menu = document.createElement('div');
    menu.id = 'settings-context-menu';
    menu.className = 'add-context-menu';
    menu.style.zIndex = '310';
    menu.style.maxHeight = '350px';
    menu.style.overflowY = 'auto';
    menu.style.minWidth = '250px';

    const title = document.createElement('div');
    title.style.cssText = 'padding:6px 12px;font-family:var(--mono);font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);';
    title.textContent = zone.nom + ' → Tables & Lignes';
    menu.appendChild(title);

    layout.tables.forEach(t => {
      // Header table
      const tableHeader = document.createElement('div');
      tableHeader.style.cssText = 'padding:5px 12px 3px;font-family:var(--mono);font-size:9px;letter-spacing:0.8px;text-transform:uppercase;color:var(--accent);font-weight:600;background:var(--surface2);border-top:1px solid var(--border);position:sticky;top:0;';
      tableHeader.textContent = t.nom;
      menu.appendChild(tableHeader);

      if (!t.lines || t.lines.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:4px 12px;font-family:var(--mono);font-size:10px;color:var(--border2);font-style:italic;';
        empty.textContent = 'Aucune ligne';
        menu.appendChild(empty);
      }

      (t.lines || []).forEach(l => {
        const alreadyIn = (l.zoneIds || []).includes(zone.id);
        const item = document.createElement('div');
        item.className = 'add-menu-item';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '6px';
        item.style.paddingLeft = '20px';

        if (alreadyIn) {
          item.innerHTML = `<span style="width:14px;text-align:center;color:var(--accent2);">✓</span><span style="flex:1">${l.nom}</span>`;
        } else {
          item.innerHTML = `<span style="width:14px;text-align:center;color:var(--border2);">○</span><span style="flex:1">${l.nom}</span>`;
        }

        item.addEventListener('click', () => {
          const freshLayout = getLayout();
          freshLayout.tables.forEach(t2 => (t2.lines || []).forEach(l2 => {
            if (l2.id === l.id) {
              if (!l2.zoneIds) l2.zoneIds = [];
              if (alreadyIn) {
                l2.zoneIds = l2.zoneIds.filter(id => id !== zone.id);
              } else {
                if (!l2.zoneIds.includes(zone.id)) l2.zoneIds.push(zone.id);
              }
            }
          }));
          saveLayoutObj(freshLayout);
          menu.remove();
          showAssignTableMenu(event, zone);
        });

        menu.appendChild(item);
      });
    });

    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    if (event.clientY + 350 > window.innerHeight - 10) {
      menu.style.bottom = (window.innerHeight - event.clientY) + 'px';
    } else {
      menu.style.top = event.clientY + 'px';
    }
    document.body.appendChild(menu);

    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        renderTab(activeTab);
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  function showChangeLineMenuSettings(event, zone) {
    const old = document.getElementById('settings-context-menu');
    if (old) old.remove();

    const layout = getLayout();
    if (!layout.tables) return;

    const menu = document.createElement('div');
    menu.id = 'settings-context-menu';
    menu.className = 'add-context-menu';
    menu.style.zIndex = '310';
    menu.style.maxHeight = '300px';
    menu.style.overflowY = 'auto';

    const title = document.createElement('div');
    title.style.cssText = 'padding:6px 12px;font-family:var(--mono);font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);';
    title.textContent = zone.nom + ' → Lignes';
    menu.appendChild(title);

    layout.tables.forEach(t => {
      const group = document.createElement('div');
      group.style.cssText = 'padding:4px 12px 2px;font-family:var(--mono);font-size:8px;letter-spacing:0.8px;text-transform:uppercase;color:var(--accent);background:var(--surface2);border-top:1px solid var(--border);position:sticky;top:0;';
      group.textContent = t.nom;
      menu.appendChild(group);

      (t.lines || []).forEach(l => {
        const alreadyIn = (l.zoneIds || []).includes(zone.id);
        const item = document.createElement('div');
        item.className = 'add-menu-item';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '6px';

        if (alreadyIn) {
          item.innerHTML = `<span style="width:14px;text-align:center;color:var(--accent2);">✓</span>${l.nom}`;
        } else {
          item.innerHTML = `<span style="width:14px;text-align:center;color:var(--border2);">○</span>${l.nom}`;
        }

        item.addEventListener('click', () => {
          const freshLayout = getLayout();
          freshLayout.tables.forEach(t2 => (t2.lines || []).forEach(l2 => {
            if (l2.id === l.id) {
              if (!l2.zoneIds) l2.zoneIds = [];
              if (alreadyIn) {
                l2.zoneIds = l2.zoneIds.filter(id => id !== zone.id);
              } else {
                if (!l2.zoneIds.includes(zone.id)) l2.zoneIds.push(zone.id);
              }
            }
          }));
          saveLayoutObj(freshLayout);
          // Re-render le menu pour refléter le changement
          menu.remove();
          showChangeLineMenuSettings(event, zone);
        });

        menu.appendChild(item);
      });
    });

    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    if (event.clientY + 300 > window.innerHeight - 10) {
      menu.style.bottom = (window.innerHeight - event.clientY) + 'px';
    } else {
      menu.style.top = event.clientY + 'px';
    }
    document.body.appendChild(menu);

    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        renderTab(activeTab);
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  // getDessertePkStatic / setDessertePkStatic supprimés — utiliser Data.getDessertePk / Data.setDessertePk

  function showAssignMenu(zoneId, anchor, allLines) {
    const old = document.getElementById('assign-menu');
    if (old) { old.remove(); return; }

    const menu = document.createElement('div');
    menu.id = 'assign-menu';
    menu.className = 'add-context-menu';
    menu.style.maxHeight = '250px';
    menu.style.overflowY = 'auto';

    let currentTable = '';
    allLines.forEach(({ tableNom, lineId, lineNom, line }) => {
      if (tableNom !== currentTable) {
        currentTable = tableNom;
        const group = document.createElement('div');
        group.className = 'calibrate-dropdown-group';
        group.textContent = tableNom;
        menu.appendChild(group);
      }

      const already = line.zoneIds && line.zoneIds.includes(zoneId);
      const item = document.createElement('div');
      item.className = 'add-menu-item';
      if (already) {
        item.style.opacity = '0.4';
        item.textContent = lineNom + ' ✓';
      } else {
        item.textContent = lineNom;
      }
      item.addEventListener('click', () => {
        if (already) return;
        const layout = getLayout();
        if (layout.tables) {
          layout.tables.forEach(t => (t.lines || []).forEach(l => {
            if (l.id === lineId) {
              if (!l.zoneIds) l.zoneIds = [];
              if (!l.zoneIds.includes(zoneId)) l.zoneIds.push(zoneId);
            }
          }));
        }
        saveLayoutObj(layout);
        menu.remove();
        renderTab('dessertes');
      });
      menu.appendChild(item);
    });

    const rect = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.zIndex = '300';
    menu.style.minWidth = '200px';
    // Positionner au-dessus si pas de place en dessous
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 260) {
      menu.style.bottom = (window.innerHeight - rect.top + 2) + 'px';
    } else {
      menu.style.top = rect.bottom + 2 + 'px';
    }
    menu.style.left = Math.min(rect.left, window.innerWidth - 220) + 'px';
    document.body.appendChild(menu);

    const close = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== anchor) {
        menu.remove();
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  // =========================================
  // PN
  // =========================================

  function getAllPNs() {
    // Dédoublonnage par id ET par position
    const seenIds = new Set();
    const seenPos = new Set();
    const allPNs = [];
    Data.searchElementFuzzy('').forEach(el => {
      if (el.type !== 'pn') return;
      if (seenIds.has(el.id)) return;
      const posKey = Math.round(el.x_pct * 300) + ',' + Math.round(el.y_pct * 300);
      if (seenPos.has(posKey)) return;
      seenIds.add(el.id);
      seenPos.add(posKey);
      allPNs.push(el);
    });
    allPNs.sort((a, b) => {
      const na = parseInt((a.identifiant || '').match(/\d+/)?.[0] || '0');
      const nb = parseInt((b.identifiant || '').match(/\d+/)?.[0] || '0');
      return na - nb;
    });
    return allPNs;
  }

  function renderPN(container) {
    const pns = getAllPNs();
    const gares = Data.getGares();

    // Stats
    const stats = document.createElement('div');
    stats.style.cssText = 'padding:4px 0 8px;font-family:var(--mono);font-size:10px;color:var(--muted);display:flex;gap:12px;';
    const validated = pns.filter(p => p.validated).length;
    stats.innerHTML = `<span>Total: <b style="color:var(--text)">${pns.length}</b></span>` +
      `<span>Validés: <b style="color:var(--accent2)">${validated}</b></span>` +
      `<span>À vérifier: <b style="color:var(--warn)">${pns.length - validated}</b></span>`;
    container.appendChild(stats);

    // Barre de recherche
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Chercher un PN (ex: 11, 24, SAL4...)';
    searchInput.className = 'zone-picker-search';
    searchInput.style.cssText = 'margin-bottom:6px;border:1px solid var(--border);border-radius:3px;';
    container.appendChild(searchInput);

    const listDiv = document.createElement('div');
    container.appendChild(listDiv);

    function renderList(filter) {
      listDiv.innerHTML = '';
      const q = (filter || '').toLowerCase().trim();

      pns.forEach(pn => {
        if (q) {
          const match = pn.identifiant.toLowerCase().includes(q) ||
            (pn.pn_type || '').toLowerCase().includes(q) ||
            (pn.raw_text || '').toLowerCase().includes(q);
          if (!match) return;
        }

        const gare = pn.gare_id ? Data.getGare(pn.gare_id) : null;

        const item = document.createElement('div');
        item.className = 'settings-item';
        item.style.gap = '6px';

        // Indicateur validé
        const dot = document.createElement('span');
        dot.style.cssText = 'font-size:8px;flex-shrink:0;width:8px;';
        dot.style.color = pn.validated ? 'var(--accent2)' : 'var(--warn)';
        dot.textContent = '●';
        dot.title = pn.validated ? 'Validé' : 'À vérifier';
        item.appendChild(dot);

        // Identifiant
        const id = document.createElement('span');
        id.style.cssText = 'font-family:var(--mono);font-size:12px;color:var(--text);font-weight:600;min-width:65px;flex-shrink:0;';
        id.textContent = pn.identifiant;
        item.appendChild(id);

        // Type (SAL2, SAL4, etc.)
        if (pn.pn_type) {
          const type = document.createElement('span');
          type.style.cssText = 'font-family:var(--mono);font-size:9px;padding:1px 5px;border:1px solid var(--border);border-radius:2px;color:var(--muted);flex-shrink:0;';
          type.textContent = pn.pn_type;
          item.appendChild(type);
        }

        // Desserte associée
        const gareName = document.createElement('span');
        gareName.style.cssText = 'font-family:var(--mono);font-size:10px;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        gareName.textContent = gare ? gare.nom : (pn.gare_id ? '?' : '—');
        item.appendChild(gareName);

        // Ligne
        if (pn.ligne) {
          const ligne = document.createElement('span');
          ligne.style.cssText = 'font-family:var(--mono);font-size:9px;color:var(--muted);flex-shrink:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          ligne.textContent = pn.ligne;
          item.appendChild(ligne);
        }

        // Bouton sauvegarder vue
        const pnHasView = Data.hasSavedView(pn.id);
        const saveViewBtn = document.createElement('button');
        saveViewBtn.className = 'zone-item-btn';
        saveViewBtn.textContent = '📌';
        saveViewBtn.title = pnHasView ? 'Vue sauvegardée — clic pour mettre à jour' : 'Sauvegarder la vue actuelle';
        saveViewBtn.style.opacity = pnHasView ? '1' : '0.4';
        saveViewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          Viewer.saveCurrentViewForZone(pn.id);
          saveViewBtn.style.opacity = '1';
          saveViewBtn.textContent = '✓';
          setTimeout(() => { saveViewBtn.textContent = '📌'; }, 1500);
        });
        item.appendChild(saveViewBtn);

        // Clic gauche → naviguer (via vue sauvegardée ou position)
        item.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          listDiv.querySelectorAll('.settings-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
          // Si une vue est sauvegardée, l'utiliser
          if (Data.hasSavedView(pn.id)) {
            Viewer.showZone(pn.id, pn.identifiant);
          } else {
            Viewer.panTo(pn.x_pct, pn.y_pct, 12);
          }
        });

        // Clic droit → menu contextuel
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showPNContextMenu(e, pn, gare);
        });

        listDiv.appendChild(item);
      });
    }

    searchInput.addEventListener('input', () => renderList(searchInput.value));
    renderList('');
  }

  function showPNContextMenu(event, pn, gare) {
    const old = document.getElementById('settings-context-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.id = 'settings-context-menu';
    menu.className = 'add-context-menu';
    menu.style.zIndex = '310';
    menu.style.minWidth = '300px';

    // Même structure que la popup de calibration
    const fields = [
      { label: 'Type', key: 'type', value: pn.type || 'pn',
        options: ['aiguille', 'signal', 'pn', 'cv', 'gare', 'pk', 'poste', 'autre'] },
      { label: 'Identifiant', key: 'identifiant', value: pn.identifiant || '' },
      { label: 'Desserte associée', key: '_gare', value: gare ? gare.nom : '', special: 'gare' },
      { label: 'Ligne', key: 'ligne', value: pn.ligne || '', special: 'ligne' },
      { label: 'PK', key: 'pk', value: pn.pk || '' },
      { label: 'Secteur / Poste', key: 'secteur', value: pn.secteur || '' },
    ];

    const inputs = {};

    fields.forEach(f => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:3px 12px;';

      const label = document.createElement('div');
      label.style.cssText = 'font-family:var(--mono);font-size:8px;letter-spacing:0.5px;text-transform:uppercase;color:var(--muted);margin-bottom:2px;';
      label.textContent = f.label;
      row.appendChild(label);

      if (f.options) {
        const select = document.createElement('select');
        select.style.cssText = 'width:100%;padding:4px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;';
        f.options.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          if (opt === f.value) o.selected = true;
          select.appendChild(o);
        });
        row.appendChild(select);
        inputs[f.key] = select;
      } else if (f.special === 'ligne') {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = f.value;
        input.list = 'calibrate-ligne-list';
        input.style.cssText = 'width:100%;padding:4px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;';
        input.addEventListener('focus', () => input.style.borderColor = 'var(--accent)');
        input.addEventListener('blur', () => input.style.borderColor = 'var(--border)');
        row.appendChild(input);
        inputs[f.key] = input;
      } else if (f.special === 'gare') {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = f.value;
        input.placeholder = 'Tapez pour chercher...';
        input.style.cssText = 'width:100%;padding:4px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;';
        input.addEventListener('focus', () => input.style.borderColor = 'var(--accent)');
        input.addEventListener('blur', () => input.style.borderColor = 'var(--border)');
        row.appendChild(input);
        inputs[f.key] = input;

        // Autocomplétion gares
        const dropdown = document.createElement('div');
        dropdown.className = 'calibrate-dropdown hidden';
        dropdown.style.cssText += 'position:relative;';
        row.appendChild(dropdown);

        input.addEventListener('input', () => {
          const q = normalize(input.value);
          dropdown.innerHTML = '';
          if (q.length < 1) { dropdown.classList.add('hidden'); return; }
          const allDessertes = [...Data.getAllDessertes().values()];
          const matches = allDessertes.filter(d => normalize(d.nom).includes(q)).slice(0, 12);
          if (matches.length === 0) { dropdown.classList.add('hidden'); return; }
          matches.forEach(d => {
            const opt = document.createElement('div');
            opt.className = 'calibrate-dropdown-item';
            opt.textContent = d.nom;
            opt.addEventListener('mousedown', (e) => {
              e.preventDefault();
              input.value = d.nom;
              dropdown.classList.add('hidden');
            });
            dropdown.appendChild(opt);
          });
          dropdown.classList.remove('hidden');
        });
        input.addEventListener('blur', () => setTimeout(() => dropdown.classList.add('hidden'), 150));
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = f.value;
        input.style.cssText = 'width:100%;padding:4px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;';
        input.addEventListener('focus', () => input.style.borderColor = 'var(--accent)');
        input.addEventListener('blur', () => input.style.borderColor = 'var(--border)');
        row.appendChild(input);
        inputs[f.key] = input;
      }

      menu.appendChild(row);
    });

    // Coordonnées (lecture seule)
    const coordRow = document.createElement('div');
    coordRow.style.cssText = 'padding:3px 12px;font-family:var(--mono);font-size:9px;color:var(--border2);';
    coordRow.textContent = `x: ${pn.x_pct.toFixed(6)}  y: ${pn.y_pct.toFixed(6)}`;
    menu.appendChild(coordRow);

    // Boutons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'padding:6px 12px;display:flex;gap:6px;';

    const saveBtn = document.createElement('button');
    saveBtn.style.cssText = 'flex:1;padding:5px;background:var(--accent2);border:none;border-radius:3px;color:var(--bg);font-family:var(--mono);font-size:10px;font-weight:600;cursor:pointer;';
    saveBtn.textContent = 'Enregistrer';
    saveBtn.addEventListener('click', () => {
      // Sauvegarder toutes les modifications
      pn.type = inputs.type.value;
      pn.identifiant = inputs.identifiant.value.trim();
      pn.ligne = inputs.ligne.value.trim();
      pn.pk = inputs.pk.value.trim();
      pn.secteur = inputs.secteur.value.trim();
      pn.validated = true;

      // Résoudre la desserte (chercher dans toutes les dessertes, pas juste les gares PDF)
      const gareName = inputs._gare.value.trim();
      if (gareName) {
        const q = normalize(gareName);
        let found = null;
        // Chercher d'abord une correspondance exacte dans toutes les dessertes
        Data.getAllDessertes().forEach((d, id) => {
          if (!found && normalize(d.nom) === q) found = id;
        });
        // Sinon chercher une correspondance partielle
        if (!found) {
          Data.getAllDessertes().forEach((d, id) => {
            if (!found && normalize(d.nom).includes(q)) found = id;
          });
        }
        // Fallback sur les gares PDF
        if (!found) {
          const matches = Data.searchGare(gareName);
          if (matches.length > 0) found = matches[0].id;
        }
        pn.gare_id = found || pn.gare_id;
      } else {
        pn.gare_id = null;
      }

      Data.saveManualElement(pn);
      menu.remove();
      renderTab('pn');
    });
    btnRow.appendChild(saveBtn);

    const validateBtn = document.createElement('button');
    validateBtn.style.cssText = 'padding:5px 10px;background:none;border:1px solid var(--border);border-radius:3px;color:var(--muted);font-family:var(--mono);font-size:10px;cursor:pointer;';
    validateBtn.textContent = pn.validated ? '○ À vérifier' : '✓ Valider';
    validateBtn.addEventListener('click', () => {
      pn.validated = !pn.validated;
      Data.saveManualElement(pn);
      menu.remove();
      renderTab('pn');
    });
    btnRow.appendChild(validateBtn);

    const pinBtn = document.createElement('button');
    pinBtn.style.cssText = 'padding:5px 10px;background:none;border:1px solid var(--accent2);border-radius:3px;color:var(--accent2);font-family:var(--mono);font-size:10px;cursor:pointer;';
    pinBtn.textContent = '📌 Vue';
    pinBtn.title = 'Sauvegarder la vue actuelle pour ce PN';
    pinBtn.addEventListener('click', () => {
      Viewer.saveCurrentViewForZone(pn.id);
      pinBtn.textContent = '✓ Sauvé';
      setTimeout(() => { pinBtn.textContent = '📌 Vue'; }, 1500);
    });
    btnRow.appendChild(pinBtn);

    const delBtn = document.createElement('button');
    delBtn.style.cssText = 'padding:5px 10px;background:none;border:1px solid var(--danger);border-radius:3px;color:var(--danger);font-family:var(--mono);font-size:10px;cursor:pointer;';
    delBtn.textContent = '✕';
    delBtn.title = 'Supprimer';
    delBtn.addEventListener('click', () => {
      if (!confirm(`Supprimer ${pn.identifiant} ?`)) return;
      Data.deleteManualElement(pn.id);
      menu.remove();
      renderTab('pn');
    });
    btnRow.appendChild(delBtn);

    menu.appendChild(btnRow);

    // Positionner
    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    const estH = 380;
    if (event.clientY + estH > window.innerHeight - 10) {
      menu.style.bottom = (window.innerHeight - event.clientY) + 'px';
    } else {
      menu.style.top = event.clientY + 'px';
    }
    document.body.appendChild(menu);

    // Focus sur le premier champ
    if (inputs.identifiant && inputs.identifiant.focus) inputs.identifiant.focus();

    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove(); document.removeEventListener('mousedown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  }

  function showPNDesserteMenu(event, pn) {
    const old = document.getElementById('settings-context-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.id = 'settings-context-menu';
    menu.className = 'add-context-menu';
    menu.style.zIndex = '310';
    menu.style.maxHeight = '300px';
    menu.style.overflowY = 'auto';

    const title = document.createElement('div');
    title.style.cssText = 'padding:6px 12px;font-family:var(--mono);font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);';
    title.textContent = pn.identifiant + ' → Desserte';
    menu.appendChild(title);

    // Barre de recherche
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Chercher...';
    searchInput.style.cssText = 'width:100%;padding:4px 10px;background:var(--surface);border:none;border-bottom:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;outline:none;';
    menu.appendChild(searchInput);

    const listDiv = document.createElement('div');
    listDiv.style.cssText = 'max-height:220px;overflow-y:auto;';
    menu.appendChild(listDiv);

    const allDessertes = [...Data.getAllDessertes().values()];

    function renderGareList(filter) {
      listDiv.innerHTML = '';
      const q = normalize(filter || '');
      const sorted = [...allDessertes].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

      // Option "Aucune"
      const noneItem = document.createElement('div');
      noneItem.className = 'add-menu-item';
      noneItem.style.color = 'var(--muted)';
      noneItem.textContent = '— Aucune —';
      noneItem.addEventListener('click', () => {
        pn.gare_id = null;
        Data.saveManualElement(pn);
        menu.remove();
        renderTab('pn');
      });
      listDiv.appendChild(noneItem);

      sorted.forEach(d => {
        if (q && !normalize(d.nom).includes(q)) return;
        const item = document.createElement('div');
        item.className = 'add-menu-item';
        if (pn.gare_id === d.id) {
          item.style.color = 'var(--accent2)';
          item.textContent = d.nom + ' ●';
        } else {
          item.textContent = d.nom;
        }
        item.addEventListener('click', () => {
          pn.gare_id = d.id;
          Data.saveManualElement(pn);
          menu.remove();
          renderTab('pn');
        });
        listDiv.appendChild(item);
      });
    }

    searchInput.addEventListener('input', () => renderGareList(searchInput.value));
    renderGareList('');

    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    if (event.clientY + 300 > window.innerHeight - 10) {
      menu.style.bottom = (window.innerHeight - event.clientY) + 'px';
    } else {
      menu.style.top = event.clientY + 'px';
    }
    document.body.appendChild(menu);
    searchInput.focus();

    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove(); document.removeEventListener('mousedown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  }

  // =========================================
  // LIGNES
  // =========================================

  function renderLignes(container) {
    const layout = getLayout();
    if (!layout.tables) return;

    layout.tables.forEach(table => {
      const groupHeader = document.createElement('div');
      groupHeader.className = 'settings-group-header';
      groupHeader.innerHTML = `<span>${table.nom}</span>`;

      const addLineBtn = document.createElement('button');
      addLineBtn.className = 'zone-item-btn';
      addLineBtn.textContent = '+';
      addLineBtn.title = 'Ajouter une ligne';
      addLineBtn.addEventListener('click', () => {
        const n = prompt('Nom de la nouvelle ligne :');
        if (!n || !n.trim()) return;
        const freshLayout = getLayout();
        const t = freshLayout.tables.find(t2 => t2.id === table.id);
        if (t) {
          t.lines.push({ id: 'line-' + Date.now(), nom: n.trim(), zoneIds: [] });
          saveLayoutObj(freshLayout);
          renderTab('lignes');
        }
      });
      groupHeader.appendChild(addLineBtn);
      container.appendChild(groupHeader);

      (table.lines || []).forEach(line => {
        const dessertes = getAllDessertes();
        const dessertesInLine = (line.zoneIds || []).map(id => dessertes.find(d => d.id === id)).filter(Boolean);

        const item = document.createElement('div');
        item.className = 'settings-item';
        item.style.flexWrap = 'wrap';

        const name = document.createElement('span');
        name.className = 'settings-item-name';
        name.textContent = line.nom;
        item.appendChild(name);

        const meta = document.createElement('span');
        meta.className = 'settings-item-meta';
        meta.textContent = dessertesInLine.length + ' desserte' + (dessertesInLine.length > 1 ? 's' : '');
        item.appendChild(meta);

        // Actions
        const actions = document.createElement('span');
        actions.className = 'settings-item-actions';

        const renameBtn = document.createElement('button');
        renameBtn.className = 'zone-item-btn';
        renameBtn.textContent = '✎';
        renameBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const n = prompt('Nom de la ligne :', line.nom);
          if (n && n.trim()) {
            const freshLayout = getLayout();
            freshLayout.tables.forEach(t => (t.lines || []).forEach(l => {
              if (l.id === line.id) l.nom = n.trim();
            }));
            saveLayoutObj(freshLayout);
            renderTab('lignes');
          }
        });
        actions.appendChild(renameBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'zone-item-btn delete';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`Supprimer la ligne "${line.nom}" ?`)) return;
          const freshLayout = getLayout();
          const t = freshLayout.tables.find(t2 => t2.id === table.id);
          if (t) {
            t.lines = t.lines.filter(l => l.id !== line.id);
            saveLayoutObj(freshLayout);
            renderTab('lignes');
          }
        });
        actions.appendChild(delBtn);

        item.appendChild(actions);

        // Liste des dessertes dans cette ligne (sous l'item)
        if (dessertesInLine.length > 0) {
          const chips = document.createElement('div');
          chips.style.cssText = 'width:100%;display:flex;flex-wrap:wrap;gap:2px;margin-top:3px;padding-left:4px;';
          dessertesInLine.forEach(d => {
            const chip = document.createElement('span');
            chip.style.cssText = 'padding:1px 5px;font-size:8px;font-family:var(--mono);background:var(--surface2);border:1px solid var(--border);border-radius:2px;color:var(--muted);display:inline-flex;align-items:center;gap:3px;';
            chip.textContent = d.nom;

            const removeBtn = document.createElement('span');
            removeBtn.textContent = '✕';
            removeBtn.title = 'Retirer de cette ligne (la desserte n\'est pas supprimée)';
            removeBtn.style.cssText = 'cursor:pointer;font-size:7px;color:var(--muted);';
            removeBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              const freshLayout = getLayout();
              freshLayout.tables.forEach(t => (t.lines || []).forEach(l => {
                if (l.id === line.id) {
                  l.zoneIds = (l.zoneIds || []).filter(id => id !== d.id);
                }
              }));
              saveLayoutObj(freshLayout);
              renderTab('lignes');
            });
            chip.appendChild(removeBtn);
            chips.appendChild(chip);
          });
          item.appendChild(chips);
        }

        container.appendChild(item);
      });
    });
  }

  // =========================================
  // TABLES
  // =========================================

  function renderTables(container) {
    const layout = getLayout();
    if (!layout.tables) return;

    layout.tables.forEach(table => {
      const isFixed = ['table-centre', 'table-ouest', 'table-parc'].includes(table.id);
      const lineCount = (table.lines || []).length;

      const item = document.createElement('div');
      item.className = 'settings-item';

      const name = document.createElement('span');
      name.className = 'settings-item-name';
      name.textContent = table.nom;
      if (isFixed) name.style.fontWeight = '600';
      item.appendChild(name);

      const meta = document.createElement('span');
      meta.className = 'settings-item-meta';
      meta.textContent = lineCount + ' ligne' + (lineCount > 1 ? 's' : '');
      item.appendChild(meta);

      if (!isFixed) {
        const actions = document.createElement('span');
        actions.className = 'settings-item-actions';

        const renameBtn = document.createElement('button');
        renameBtn.className = 'zone-item-btn';
        renameBtn.textContent = '✎';
        renameBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const n = prompt('Nom de la table :', table.nom);
          if (n && n.trim()) {
            const freshLayout = getLayout();
            const t = freshLayout.tables.find(t2 => t2.id === table.id);
            if (t) { t.nom = n.trim(); saveLayoutObj(freshLayout); renderTab('tables'); }
          }
        });
        actions.appendChild(renameBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'zone-item-btn delete';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`Supprimer "${table.nom}" ?`)) return;
          const freshLayout = getLayout();
          freshLayout.tables = freshLayout.tables.filter(t => t.id !== table.id);
          saveLayoutObj(freshLayout);
          renderTab('tables');
        });
        actions.appendChild(delBtn);

        item.appendChild(actions);
      }

      container.appendChild(item);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'settings-add-btn';
    addBtn.textContent = '+ Créer une table';
    addBtn.addEventListener('click', () => {
      const n = prompt('Nom de la nouvelle table :');
      if (!n || !n.trim()) return;
      const freshLayout = getLayout();
      freshLayout.tables.push({ id: 'table-' + Date.now(), nom: n.trim(), lines: [] });
      saveLayoutObj(freshLayout);
      renderTab('tables');
    });
    container.appendChild(addBtn);
  }

  // =========================================
  // CRÉATION AUTO DES DESSERTES MANQUANTES
  // =========================================

  // Gares connues de la Ligne H qui devraient exister comme dessertes
  const LIGNE_H_DESSERTES = [
    'Paris-Nord', 'Saint-Denis', 'Épinay-Villetaneuse',
    'Deuil-Montmagny', 'La Barre-Ormesson', 'Enghien-les-Bains',
    'Saint-Gratien', 'Ermont-Eaubonne', 'Groslay', 'Sarcelles',
    'Écouen-Ézanville', 'Domont', 'Bouffémont-Moisselles',
    'Montsoult-Maffliers', 'Villaines', 'Belloy-Saint-Martin',
    'Viarmes', 'Seugy', 'Luzarches',
    'Montigny-Beauchamp', 'Pierrelaye', 'Saint-Ouen-l\'Aumône',
    'Pontoise',
    'Valmondois', 'Mériel', 'L\'Isle-Adam-Parmain',
    'Champagne-sur-Oise', 'Persan-Beaumont',
    'Bruyères-sur-Oise', 'Boran-sur-Oise', 'Précy-sur-Oise',
    'Saint-Leu-d\'Esserent', 'Creil',
  ];

  function ensureAllDessertes() {
    if (Store.getJSON('eic_dessertes_ensured', null) === '1' || Store.get('eic_dessertes_ensured') === '1') return;

    const existingZones = Data.getZones();
    let customZones = [];
    customZones = Store.getJSON('eic_custom_zones', []);

    const allNames = new Set();
    existingZones.forEach(z => allNames.add(normalize(z.nom)));
    customZones.forEach(z => allNames.add(normalize(z.nom)));

    // Aussi vérifier les gares extraites
    Data.getGares().forEach(g => allNames.add(normalize(g.nom)));

    let added = 0;
    LIGNE_H_DESSERTES.forEach(name => {
      if (allNames.has(normalize(name))) return;

      // Cette desserte n'existe pas → la créer comme custom zone
      customZones.push({
        id: 'custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
        nom: name,
        gares: [],
        xMin: 0, xMax: 1, yMin: 0, yMax: 0.20,
      });
      allNames.add(normalize(name));
      added++;
    });

    if (added > 0) {
      Store.set('eic_custom_zones', customZones);
      console.log(`Dessertes créées automatiquement: ${added}`);
    }

    Store.set('eic_dessertes_ensured', '1');
  }

  // =========================================
  // UTILS
  // =========================================

  function normalize(str) {
    return (str || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[-''\.]/g, ' ')
      .replace(/\bsaint\b/g, 'st').replace(/\bsainte\b/g, 'ste')
      .replace(/\s+/g, ' ').trim();
  }

  function getHiddenSet() {
    return new Set(Store.getJSON('eic_hidden_zones', []));
  }

  // hasSavedView supprimé — utiliser Data.hasSavedView

  return { init, renderTab };
})();
